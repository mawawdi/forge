import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_AUTHORING_ROOTS,
  STUDIO_RESOLVABLE_CLASSES,
  assertEvidenceAgainstProjection,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceProjection,
  compileRuntimeEvidenceProjection,
  runtimeResultsFromEvidence,
  type RuntimeEvidenceResult,
  type StudioEvidenceBinding,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectIdentity,
} from "../../studio-evidence/src/index.js";

export type { StudioProjectIdentity } from "../../studio-evidence/src/index.js";
export { STUDIO_RESOLVABLE_CLASSES } from "../../studio-evidence/src/index.js";
export const STUDIO_INSTANCE_RESOLUTION_ROOTS = STUDIO_AUTHORING_ROOTS;
export type StudioResolvableClass = (typeof STUDIO_RESOLVABLE_CLASSES)[number] | "BasePart";
export type StudioInstanceResolutionRoot = (typeof STUDIO_INSTANCE_RESOLUTION_ROOTS)[number];
export type RuntimeVector3 = { x: number; y: number; z: number };

export type StudioCapabilityName = "instance.resolve" | "base_part.position" | "base_part.position_series" | "instance.property" | "instance.property_series";
export const CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS = 90_000;
export interface StudioRuntimeTarget { id: string; path: string; expectedClass: StudioResolvableClass; }
export type StudioCapabilityCall =
  | { id: string; capability: "instance.resolve"; targetId: string }
  | { id: string; capability: "base_part.position"; targetId: string }
  | { id: string; capability: "base_part.position_series"; targetId: string; sampleCount: number; intervalMs: number }
  | { id: string; capability: "instance.property"; targetId: string; propertyName: string }
  | { id: string; capability: "instance.property_series"; targetId: string; propertyName: string; sampleCount: number; intervalMs: number };
export interface StudioExecutionBudget { maxExecutionMs: number; maxResultBytes: number; }
export interface StudioExecutionBinding {
  runId: string;
  correlationId: string;
  sessionId: string;
  projectId: string;
  project: StudioProjectIdentity;
  projectStateRevisionHash: string;
  candidateHash?: string;
}

/** Canonical runner data plus its exact universal-evidence projection. */
export interface StudioExecutionPlan {
  kind: "StudioExecutionPlan";
  id: string;
  hash: string;
  purpose: "runtime_evaluation" | "capability_canary" | "creator_verification";
  manifestHash: string;
  binding: StudioExecutionBinding;
  targets: StudioRuntimeTarget[];
  calls: StudioCapabilityCall[];
  budget: StudioExecutionBudget;
  /** Minimum total Play Solo time reserved for creator observation. */
  observationWindowMs: number;
  evidenceProjection: StudioEvidenceProjection;
}

export type RuntimeAssertion =
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "exists"; observationId: string }
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "distinct_positions_at_least"; observationId: string; quantizationStuds: number; minimumDistinctPositions: number }
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "ordered_position_visits"; seriesObservationId: string; endpointAObservationId: string; endpointBObservationId: string; toleranceStuds: number; minimumLegMs: number; maximumLegMs: number; acceptedOrders: Array<["A", "B", "A"] | ["B", "A", "B"]> };
export interface RuntimeEvalDefinition {
  kind: "RuntimeEvalDefinition";
  id: string;
  hash: string;
  requirementSetId: string;
  evaluatorViewId: string;
  evaluatorViewHash: string;
  acceptanceSpecId: string;
  provenance: { source: "evaluator" | "benchmark_oracle"; authority: "evaluation_only"; visibility: "evaluator_only" };
  manifestHash: string;
  targets: StudioRuntimeTarget[];
  calls: StudioCapabilityCall[];
  budget: StudioExecutionBudget;
  assertions: RuntimeAssertion[];
}
export interface RuntimeEvalPlan {
  kind: "RuntimeEvalPlan";
  id: string;
  hash: string;
  definitionId: string;
  definitionHash: string;
  candidateArtifactId: string;
  candidateArtifactHash: string;
  agentRunId?: string;
  workspaceDeltaId: string;
  candidateHash: string;
  executionPlan: StudioExecutionPlan;
}
export interface RuntimeEvaluatorConfiguration {
  kind: "RuntimeEvaluatorConfiguration";
  id: string;
  hash: string;
  manifestHash: string;
  assertionEngine: { name: "forge_runtime_assertions" };
  runtimeEvalDefinitionId: string;
  runtimeEvalDefinitionHash: string;
  executionPolicy: "creator_triggered_play_solo";
  bindingPolicy: "candidate_source_and_world_state";
  maxResultBytes: number;
}
export interface RuntimeAssertionResult {
  id: string;
  requirementId: string;
  acceptanceAssertionId: string;
  status: "pass" | "fail";
  observedHash: string;
}

type StudioExecutionPlanInput = Omit<StudioExecutionPlan, "kind" | "id" | "hash" | "manifestHash" | "evidenceProjection">;
export function createStudioExecutionPlan(input: StudioExecutionPlanInput): StudioExecutionPlan {
  assertExecutionBinding(input.binding);
  const canonicalTargets = input.targets.map((target) => ({ ...target })).sort((left, right) => left.id.localeCompare(right.id));
  const canonicalCalls = canonicalizeStudioRuntimeCalls(input.calls);
  const observationWindowMs = input.observationWindowMs;
  assertTargetsAndCalls(canonicalTargets, canonicalCalls, input.budget, observationWindowMs);
  assertCreatorObservationCoverage(input.purpose, canonicalCalls, observationWindowMs);
  const targetById = new Map(canonicalTargets.map((target) => [target.id, target]));
  const evidenceBinding: StudioEvidenceBinding = {
    sessionId: input.binding.sessionId,
    revisionHash: input.binding.projectStateRevisionHash,
    runId: input.binding.runId,
    correlationId: input.binding.correlationId,
    ...(input.binding.candidateHash ? { candidateHash: input.binding.candidateHash } : {}),
  };
  const evidenceProjection = compileRuntimeEvidenceProjection({
    id: `studio_runtime_evidence_${input.binding.runId}`,
    project: input.binding.project,
    binding: evidenceBinding,
    calls: canonicalCalls.map((call) => {
      const target = targetById.get(call.targetId);
      if (!target) throw new Error("Studio runtime call references an unknown target");
      return {
        id: call.id,
        targetId: call.targetId,
        target: { kind: "instance" as const, stableId: target.id, path: target.path, className: target.expectedClass },
        capability: call.capability,
        ...("propertyName" in call ? { propertyName: call.propertyName } : {}),
      };
    }),
    purpose: input.purpose === "creator_verification" ? "creator_verification" : "runtime_evaluation",
  });
  const canonical = canonicalExecutionInput({ ...input, targets: canonicalTargets, calls: canonicalCalls, observationWindowMs, manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, evidenceProjection });
  const hash = contentHash(stableJson(canonical));
  const plan: StudioExecutionPlan = { kind: "StudioExecutionPlan", id: `studio_execution_plan_${hash.slice(0, 24)}`, hash, ...canonical };
  assertStudioExecutionPlan(plan);
  return plan;
}

export function assertStudioExecutionPlan(
  value: unknown,
  expectedManifestHash: string = STUDIO_CAPABILITY_MANIFEST_HASH,
): asserts value is StudioExecutionPlan {
  if (!isRecord(value) || value.kind !== "StudioExecutionPlan" || !isId(value.id) || !isHash(value.hash) || !["runtime_evaluation", "capability_canary", "creator_verification"].includes(String(value.purpose)) || value.manifestHash !== expectedManifestHash || !isRecord(value.binding) || !Array.isArray(value.targets) || !Array.isArray(value.calls) || !isRecord(value.budget) || !isNonNegativeInteger(value.observationWindowMs) || !isRecord(value.evidenceProjection)) throw new Error("Invalid StudioExecutionPlan");
  assertExecutionBinding(value.binding);
  assertTargetsAndCalls(value.targets as StudioRuntimeTarget[], value.calls as StudioCapabilityCall[], value.budget as unknown as StudioExecutionBudget, value.observationWindowMs);
  assertCreatorObservationCoverage(value.purpose as StudioExecutionPlan["purpose"], value.calls as StudioCapabilityCall[], value.observationWindowMs);
  assertStudioEvidenceProjection(value.evidenceProjection);
  const projection = value.evidenceProjection;
  const expectedProjectionPurpose = value.purpose === "creator_verification" ? "creator_verification" : "runtime_evaluation";
  if (projection.manifestHash !== value.manifestHash || projection.purpose !== expectedProjectionPurpose) throw new Error("StudioExecutionPlan evidence binding mismatch");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(canonicalExecutionInput(payload as Omit<StudioExecutionPlan, "kind" | "id" | "hash">)));
  if (value.hash !== expected || value.id !== `studio_execution_plan_${expected.slice(0, 24)}`) throw new Error("Invalid StudioExecutionPlan identity");
}
export function serializeStudioExecutionPlan(plan: StudioExecutionPlan): string { assertStudioExecutionPlan(plan); return stableJson(plan); }

type RuntimeEvalDefinitionInput = Omit<RuntimeEvalDefinition, "kind" | "id" | "hash" | "manifestHash">;
export function createRuntimeEvalDefinition(input: RuntimeEvalDefinitionInput): RuntimeEvalDefinition {
  const canonical = canonicalDefinitionInput({ ...input, manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH });
  const hash = contentHash(stableJson(canonical));
  const value: RuntimeEvalDefinition = { kind: "RuntimeEvalDefinition", id: `runtime_eval_definition_${hash.slice(0, 24)}`, hash, ...canonical };
  assertRuntimeEvalDefinition(value);
  return value;
}
export function assertRuntimeEvalDefinition(value: unknown): asserts value is RuntimeEvalDefinition {
  if (!isRecord(value) || value.kind !== "RuntimeEvalDefinition" || !isId(value.id) || !isHash(value.hash) || !isId(value.requirementSetId) || !isId(value.evaluatorViewId) || !isHash(value.evaluatorViewHash) || !isId(value.acceptanceSpecId) || !isEvaluatorProvenance(value.provenance) || value.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH || !Array.isArray(value.targets) || !Array.isArray(value.calls) || !isRecord(value.budget) || !Array.isArray(value.assertions)) throw new Error("Invalid RuntimeEvalDefinition");
  assertTargetsAndCalls(value.targets as StudioRuntimeTarget[], value.calls as StudioCapabilityCall[], value.budget as unknown as StudioExecutionBudget);
  const assertions = value.assertions as RuntimeAssertion[];
  if (assertions.length === 0 || !assertions.every(isRuntimeAssertion) || !canonicalIds(assertions.map((entry) => entry.id))) throw new Error("Invalid RuntimeEvalDefinition assertions");
  const callIds = new Set((value.calls as StudioCapabilityCall[]).map((call) => call.id));
  for (const assertion of assertions) {
    const ids = assertion.kind === "ordered_position_visits" ? [assertion.seriesObservationId, assertion.endpointAObservationId, assertion.endpointBObservationId] : [assertion.observationId];
    if (!ids.every((id) => callIds.has(id))) throw new Error("Runtime assertion references an unknown observation");
  }
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(canonicalDefinitionInput(payload as Omit<RuntimeEvalDefinition, "kind" | "id" | "hash">)));
  if (value.hash !== expected || value.id !== `runtime_eval_definition_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvalDefinition identity");
}

export function createRuntimeEvalPlan(input: Omit<RuntimeEvalPlan, "kind" | "id" | "hash">): RuntimeEvalPlan {
  assertStudioExecutionPlan(input.executionPlan);
  const payload = { ...input, ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}) };
  const hash = contentHash(stableJson(payload));
  const value: RuntimeEvalPlan = { kind: "RuntimeEvalPlan", id: `runtime_eval_plan_${hash.slice(0, 24)}`, hash, ...payload };
  assertRuntimeEvalPlan(value);
  return value;
}
export function assertRuntimeEvalPlan(value: unknown): asserts value is RuntimeEvalPlan {
  if (!isRecord(value) || value.kind !== "RuntimeEvalPlan" || !isId(value.id) || !isHash(value.hash) || !isId(value.definitionId) || !isHash(value.definitionHash) || !isId(value.candidateArtifactId) || !isHash(value.candidateArtifactHash) || (value.agentRunId !== undefined && !isId(value.agentRunId)) || !isId(value.workspaceDeltaId) || !isHash(value.candidateHash) || !isRecord(value.executionPlan)) throw new Error("Invalid RuntimeEvalPlan");
  assertStudioExecutionPlan(value.executionPlan);
  if (value.executionPlan.purpose !== "runtime_evaluation" || value.executionPlan.binding.candidateHash !== value.candidateHash) throw new Error("RuntimeEvalPlan execution binding mismatch");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `runtime_eval_plan_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvalPlan identity");
}

type RuntimeEvaluatorConfigurationInput = Omit<RuntimeEvaluatorConfiguration, "kind" | "id" | "hash" | "manifestHash">;
export function createRuntimeEvaluatorConfiguration(input: RuntimeEvaluatorConfigurationInput): RuntimeEvaluatorConfiguration {
  const canonical = { ...input, manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, assertionEngine: { ...input.assertionEngine } };
  const hash = contentHash(stableJson(canonical));
  const value: RuntimeEvaluatorConfiguration = { kind: "RuntimeEvaluatorConfiguration", id: `runtime_evaluator_configuration_${hash.slice(0, 24)}`, hash, ...canonical };
  assertRuntimeEvaluatorConfiguration(value);
  return value;
}
export function assertRuntimeEvaluatorConfiguration(value: unknown): asserts value is RuntimeEvaluatorConfiguration {
  if (!isRecord(value) || value.kind !== "RuntimeEvaluatorConfiguration" || !isId(value.id) || !isHash(value.hash) || value.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH || !isRecord(value.assertionEngine) || value.assertionEngine.name !== "forge_runtime_assertions" || !isId(value.runtimeEvalDefinitionId) || !isHash(value.runtimeEvalDefinitionHash) || value.executionPolicy !== "creator_triggered_play_solo" || value.bindingPolicy !== "candidate_source_and_world_state" || !isPositiveInteger(value.maxResultBytes)) throw new Error("Invalid RuntimeEvaluatorConfiguration");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `runtime_evaluator_configuration_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvaluatorConfiguration identity");
}

export function gradeRuntimeEvidence(definition: RuntimeEvalDefinition, envelope: StudioEvidenceEnvelope, projection: StudioEvidenceProjection): RuntimeAssertionResult[] {
  assertRuntimeEvalDefinition(definition);
  assertStudioEvidenceEnvelope(envelope, projection);
  const results = new Map(runtimeResultsFromEvidence(envelope, projection).map((result) => [result.id, result]));
  return definition.assertions.map((assertion) => {
    const passed = gradeAssertion(assertion, results);
    const observed = observationsForAssertion(assertion, results);
    return { id: assertion.id, requirementId: assertion.requirementId, acceptanceAssertionId: assertion.acceptanceAssertionId, status: passed ? "pass" : "fail", observedHash: contentHash(stableJson(observed)) };
  });
}
export function assertRuntimeEvidence(plan: StudioExecutionPlan, envelope: StudioEvidenceEnvelope): void {
  assertStudioExecutionPlan(plan);
  assertEvidenceAgainstProjection(envelope, plan.evidenceProjection);
}

function gradeAssertion(assertion: RuntimeAssertion, results: Map<string, RuntimeEvidenceResult>): boolean {
  if (assertion.kind === "exists") return results.get(assertion.observationId)?.capability === "instance.resolve" && results.get(assertion.observationId)?.status === "resolved";
  if (assertion.kind === "distinct_positions_at_least") {
    const result = results.get(assertion.observationId);
    if (!result || result.capability !== "base_part.position_series" || result.status !== "ok" || !result.samples) return false;
    return new Set(result.samples.map((sample) => `${Math.round(sample.value.x / assertion.quantizationStuds)},${Math.round(sample.value.y / assertion.quantizationStuds)},${Math.round(sample.value.z / assertion.quantizationStuds)}`)).size >= assertion.minimumDistinctPositions;
  }
  const series = results.get(assertion.seriesObservationId);
  const endpointA = results.get(assertion.endpointAObservationId);
  const endpointB = results.get(assertion.endpointBObservationId);
  if (!series || series.capability !== "base_part.position_series" || series.status !== "ok" || !series.samples || !endpointA || endpointA.capability !== "base_part.position" || endpointA.status !== "ok" || !endpointA.position || !endpointB || endpointB.capability !== "base_part.position" || endpointB.status !== "ok" || !endpointB.position) return false;
  const visits: Array<{ label: "A" | "B"; elapsedMs: number }> = [];
  for (const sample of series.samples) {
    const distanceA = distance(sample.value, endpointA.position);
    const distanceB = distance(sample.value, endpointB.position);
    const label = distanceA <= assertion.toleranceStuds && distanceB > assertion.toleranceStuds ? "A" : distanceB <= assertion.toleranceStuds && distanceA > assertion.toleranceStuds ? "B" : undefined;
    if (label && visits.at(-1)?.label !== label) visits.push({ label, elapsedMs: sample.elapsedMs });
  }
  return assertion.acceptedOrders.some((order) => visits.some((visit, index) => {
    const second = visits[index + 1]; const third = visits[index + 2];
    return visit.label === order[0] && second?.label === order[1] && third?.label === order[2] && inLegWindow(second.elapsedMs - visit.elapsedMs, assertion) && inLegWindow(third.elapsedMs - second.elapsedMs, assertion);
  }));
}
function observationsForAssertion(assertion: RuntimeAssertion, results: Map<string, RuntimeEvidenceResult>): RuntimeEvidenceResult[] {
  const ids = assertion.kind === "ordered_position_visits" ? [assertion.seriesObservationId, assertion.endpointAObservationId, assertion.endpointBObservationId] : [assertion.observationId];
  return ids.map((id) => results.get(id)).filter((entry): entry is RuntimeEvidenceResult => entry !== undefined);
}

function canonicalExecutionInput(input: Omit<StudioExecutionPlan, "kind" | "id" | "hash">): Omit<StudioExecutionPlan, "kind" | "id" | "hash"> {
  return { ...input, binding: { ...input.binding, project: { ...input.binding.project }, ...(input.binding.candidateHash ? { candidateHash: input.binding.candidateHash } : {}) }, targets: input.targets.map((entry) => ({ ...entry })).sort((a, b) => a.id.localeCompare(b.id)), calls: canonicalizeStudioRuntimeCalls(input.calls), budget: { ...input.budget }, evidenceProjection: JSON.parse(stableJson(input.evidenceProjection)) as StudioEvidenceProjection };
}
function canonicalDefinitionInput(input: Omit<RuntimeEvalDefinition, "kind" | "id" | "hash">): Omit<RuntimeEvalDefinition, "kind" | "id" | "hash"> {
  return { ...input, provenance: { ...input.provenance }, targets: input.targets.map((entry) => ({ ...entry })).sort((a, b) => a.id.localeCompare(b.id)), calls: canonicalizeStudioRuntimeCalls(input.calls), budget: { ...input.budget }, assertions: input.assertions.map((entry) => entry.kind === "ordered_position_visits" ? { ...entry, acceptedOrders: entry.acceptedOrders.map((order) => [...order] as typeof order).sort((a, b) => a.join("").localeCompare(b.join(""))) } : { ...entry }).sort((a, b) => a.id.localeCompare(b.id)) };
}
export function canonicalizeStudioRuntimeCalls(calls: readonly StudioCapabilityCall[]): StudioCapabilityCall[] {
  const rank: Record<StudioCapabilityName, number> = {
    "instance.resolve": 0,
    "base_part.position": 1,
    "base_part.position_series": 2,
    "instance.property": 3,
    "instance.property_series": 4,
  };
  return calls.map((call) => ({ ...call })).sort((left, right) =>
    rank[left.capability] - rank[right.capability] ||
    left.targetId.localeCompare(right.targetId) ||
    left.id.localeCompare(right.id));
}
function assertTargetsAndCalls(targets: StudioRuntimeTarget[], calls: StudioCapabilityCall[], budget: StudioExecutionBudget, observationWindowMs = 0): void {
  const limits = STUDIO_CAPABILITY_MANIFEST.limits;
  if (targets.length === 0 || targets.length > limits.maximumRuntimeTargets || !targets.every(isTarget) || !canonicalIds(targets.map((entry) => entry.id))) throw new Error("Invalid Studio runtime targets");
  if (calls.length === 0 || calls.length > limits.maximumRuntimeCalls || !calls.every(isCapabilityCall) || new Set(calls.map((entry) => entry.id)).size !== calls.length || stableJson(calls) !== stableJson(canonicalizeStudioRuntimeCalls(calls))) throw new Error("Invalid Studio runtime calls");
  if (!isExecutionBudget(budget) || budget.maxExecutionMs > limits.maximumRuntimeMs || budget.maxResultBytes > limits.maximumRuntimeResultBytes) throw new Error("Studio runtime budget exceeds manifest");
  if (!isNonNegativeInteger(observationWindowMs) || observationWindowMs > budget.maxExecutionMs) throw new Error("Studio runtime observation window exceeds execution budget");
  const scheduledWaitMs = calls.reduce((total, call) =>
    total + (call.capability === "base_part.position_series" || call.capability === "instance.property_series" ? (call.sampleCount - 1) * call.intervalMs : 0), 0);
  if (Math.max(scheduledWaitMs, observationWindowMs) > budget.maxExecutionMs) throw new Error("Studio runtime call schedule exceeds execution budget");
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const resolved = new Set<string>();
  const positionSeries = STUDIO_CAPABILITY_MANIFEST.runtimeCapabilities.find((entry) => entry.name === "base_part.position_series");
  const propertySeries = STUDIO_CAPABILITY_MANIFEST.runtimeCapabilities.find((entry) => entry.name === "instance.property_series");
  for (const call of calls) {
    const target = targetById.get(call.targetId);
    if (!target) throw new Error("Studio runtime call references an unknown target");
    if (call.capability === "instance.resolve") resolved.add(call.targetId);
    else if (!resolved.has(call.targetId)) throw new Error("Studio runtime observation requires a prior instance.resolve call");
    if ((call.capability === "base_part.position" || call.capability === "base_part.position_series") && target.expectedClass !== "BasePart") throw new Error("BasePart observations require a BasePart runtime target");
    if ((call.capability === "base_part.position" || call.capability === "base_part.position_series") && !target.path.startsWith("Workspace/")) throw new Error("BasePart observations are restricted to Workspace targets");
    if (call.capability === "base_part.position_series" && (!positionSeries || call.sampleCount > (positionSeries.maximumSamples ?? 0) || call.intervalMs < (positionSeries.minimumIntervalMs ?? 0) || call.intervalMs > (positionSeries.maximumIntervalMs ?? 0))) throw new Error("Studio runtime position series exceeds manifest");
    if (call.capability === "instance.property" || call.capability === "instance.property_series") {
      const metadata = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === target.expectedClass)?.properties.find((property) => property.name === call.propertyName);
      if (!metadata || metadata.codec === "instance_ref") throw new Error("Studio runtime manifest property is not observable");
      if (call.capability === "instance.property_series" && (!propertySeries || call.sampleCount > (propertySeries.maximumSamples ?? 0) || call.intervalMs < (propertySeries.minimumIntervalMs ?? 0) || call.intervalMs > (propertySeries.maximumIntervalMs ?? 0))) throw new Error("Studio runtime property series exceeds manifest");
    }
  }
}
function assertCreatorObservationCoverage(purpose: StudioExecutionPlan["purpose"], calls: StudioCapabilityCall[], observationWindowMs: number): void {
  if (purpose !== "creator_verification" || observationWindowMs === 0) return;
  const shortSeries = calls.find((call) =>
    (call.capability === "base_part.position_series" || call.capability === "instance.property_series") &&
    (call.sampleCount - 1) * call.intervalMs < observationWindowMs);
  if (shortSeries)
    throw new Error("Creator runtime position series ends before the creator observation window");
}
function assertExecutionBinding(value: unknown): asserts value is StudioExecutionBinding { if (!isRecord(value) || !isId(value.runId) || !isId(value.correlationId) || !isId(value.sessionId) || !isId(value.projectId) || !isProject(value.project) || !isHash(value.projectStateRevisionHash) || (value.candidateHash !== undefined && !isHash(value.candidateHash))) throw new Error("Invalid Studio execution binding"); }
function isTarget(value: unknown): value is StudioRuntimeTarget { return isRecord(value) && isId(value.id) && isStudioPath(value.path) && (value.expectedClass === "BasePart" || STUDIO_RESOLVABLE_CLASSES.includes(value.expectedClass as never)); }
function isCapabilityCall(value: unknown): value is StudioCapabilityCall { if (!isRecord(value) || !isId(value.id) || !isId(value.targetId)) return false; return value.capability === "instance.resolve" || value.capability === "base_part.position" || value.capability === "base_part.position_series" && isPositiveInteger(value.sampleCount) && isPositiveInteger(value.intervalMs) || value.capability === "instance.property" && isId(value.propertyName) || value.capability === "instance.property_series" && isId(value.propertyName) && isPositiveInteger(value.sampleCount) && isPositiveInteger(value.intervalMs); }
function isExecutionBudget(value: unknown): value is StudioExecutionBudget { return isRecord(value) && isPositiveInteger(value.maxExecutionMs) && isPositiveInteger(value.maxResultBytes); }
function isRuntimeAssertion(value: unknown): value is RuntimeAssertion { if (!isRecord(value) || !isId(value.id) || !isId(value.requirementId) || !isId(value.acceptanceAssertionId)) return false; if (value.kind === "exists") return isId(value.observationId); if (value.kind === "distinct_positions_at_least") return isId(value.observationId) && isPositiveFinite(value.quantizationStuds) && isPositiveInteger(value.minimumDistinctPositions); return value.kind === "ordered_position_visits" && isId(value.seriesObservationId) && isId(value.endpointAObservationId) && isId(value.endpointBObservationId) && isPositiveFinite(value.toleranceStuds) && isPositiveInteger(value.minimumLegMs) && isPositiveInteger(value.maximumLegMs) && Number(value.minimumLegMs) <= Number(value.maximumLegMs) && Array.isArray(value.acceptedOrders) && value.acceptedOrders.length > 0; }
function isEvaluatorProvenance(value: unknown): boolean { return isRecord(value) && ["evaluator", "benchmark_oracle"].includes(String(value.source)) && value.authority === "evaluation_only" && value.visibility === "evaluator_only"; }
function isProject(value: unknown): value is StudioProjectIdentity { return isRecord(value) && isString(value.name) && isNonNegativeInteger(value.placeId) && isNonNegativeInteger(value.universeId); }
function isStudioPath(value: unknown): value is string { if (!isString(value) || value.includes("\0")) return false; const parts = value.split("/"); return parts.length >= 2 && STUDIO_INSTANCE_RESOLUTION_ROOTS.includes(parts[0] as never) && parts.every((part) => part.length > 0 && part !== "." && part !== ".."); }
function canonicalIds(ids: string[]): boolean { return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]!.localeCompare(id) < 0); }
function distance(left: RuntimeVector3, right: RuntimeVector3): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function inLegWindow(durationMs: number, assertion: Extract<RuntimeAssertion, { kind: "ordered_position_visits" }>): boolean { return durationMs >= assertion.minimumLegMs && durationMs <= assertion.maximumLegMs; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isPositiveFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
