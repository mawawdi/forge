import { contentHash, stableJson } from "../../contracts/src/index.js";

export interface RuntimeVector3 { x: number; y: number; z: number; }
export interface StudioProjectIdentity { name: string; placeId: number; universeId: number; }

export type StudioCapabilityName = "instance.resolve" | "base_part.position" | "base_part.position_series";
export interface StudioCapabilityDefinition {
  name: StudioCapabilityName;
  version: 1;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface StudioCapabilityPolicy {
  allowedRoots: ["Workspace"];
  maxTargets: number;
  maxCalls: number;
  maxSamplesPerSeries: number;
  minSampleIntervalMs: number;
  maxSampleIntervalMs: number;
  maxExecutionMs: number;
  maxResultBytes: number;
}

export interface StudioCapabilitySet {
  kind: "StudioCapabilitySet";
  schemaVersion: 1;
  id: string;
  hash: string;
  version: "studio-capabilities-v1";
  capabilities: StudioCapabilityDefinition[];
  policy: StudioCapabilityPolicy;
}

export interface StudioRuntimeTarget { id: string; path: string; expectedClass: "BasePart"; }
export type StudioCapabilityCall =
  | { id: string; capability: "instance.resolve"; version: 1; targetId: string }
  | { id: string; capability: "base_part.position"; version: 1; targetId: string }
  | { id: string; capability: "base_part.position_series"; version: 1; targetId: string; sampleCount: number; intervalMs: number };

export interface StudioExecutionBudget { maxExecutionMs: number; maxResultBytes: number; }
export interface StudioExecutionBinding {
  runId: string;
  correlationId: string;
  sessionId: string;
  projectId: string;
  project: StudioProjectIdentity;
  projectSnapshotHash: string;
  /** A canary deliberately has no candidate identity. */
  candidateHash?: string;
}

/** The only object that crosses into the trusted generic Studio runner. */
export interface StudioExecutionPlan {
  kind: "StudioExecutionPlan";
  schemaVersion: 1;
  id: string;
  hash: string;
  purpose: "runtime_evaluation" | "capability_canary";
  capabilitySetId: string;
  capabilitySetHash: string;
  binding: StudioExecutionBinding;
  targets: StudioRuntimeTarget[];
  calls: StudioCapabilityCall[];
  budget: StudioExecutionBudget;
}

export type RuntimeCapabilityResult =
  | { id: string; capability: "instance.resolve"; targetId: string; status: "resolved" | "missing" | "class_mismatch"; path?: string; className?: string }
  | { id: string; capability: "base_part.position"; targetId: string; status: "ok" | "unavailable"; position?: RuntimeVector3; elapsedMs?: number }
  | { id: string; capability: "base_part.position_series"; targetId: string; status: "ok" | "unavailable"; samples?: Array<{ sequence: number; elapsedMs: number; position: RuntimeVector3 }> };

export interface RuntimeObservationEnvelope {
  kind: "RuntimeObservationEnvelope";
  schemaVersion: 1;
  executionPlanId: string;
  executionPlanHash: string;
  binding: StudioExecutionBinding;
  nonce: string;
  nonceCommitment: string;
  authoritative: true;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  results: RuntimeCapabilityResult[];
}

export type RuntimeAssertion =
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "exists"; observationId: string }
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "distinct_positions_at_least"; observationId: string; quantizationStuds: number; minimumDistinctPositions: number }
  | { id: string; requirementId: string; acceptanceAssertionId: string; kind: "ordered_position_visits"; seriesObservationId: string; endpointAObservationId: string; endpointBObservationId: string; toleranceStuds: number; minimumLegMs: number; maximumLegMs: number; acceptedOrders: Array<["A", "B", "A"] | ["B", "A", "B"]> };

export interface RuntimeEvalDefinition {
  kind: "RuntimeEvalDefinition";
  schemaVersion: 1;
  id: string;
  hash: string;
  requirementSetId: string;
  evaluatorViewId: string;
  evaluatorViewHash: string;
  acceptanceSpecId: string;
  provenance: { source: "evaluator" | "benchmark_oracle"; authority: "evaluation_only"; visibility: "evaluator_only" };
  capabilitySetId: string;
  capabilitySetHash: string;
  targets: StudioRuntimeTarget[];
  calls: StudioCapabilityCall[];
  budget: StudioExecutionBudget;
  assertions: RuntimeAssertion[];
}

export interface RuntimeEvalPlan {
  kind: "RuntimeEvalPlan";
  schemaVersion: 1;
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
  schemaVersion: 1;
  id: string;
  hash: string;
  capabilitySetId: string;
  capabilitySetHash: string;
  assertionEngine: { name: "forge_runtime_assertions"; version: "runtime-assertions-1" };
  runtimeEvalDefinitionId: string;
  runtimeEvalDefinitionHash: string;
  protocolVersion: 12;
  pluginVersion: "forge-studio-plugin-8.0.0";
  executionPolicy: "creator_triggered_play_solo_v1";
  bindingPolicy: "candidate_source_and_world_snapshot_v1";
  maxResultBytes: number;
}

export interface RuntimeAssertionResult {
  id: string;
  requirementId: string;
  acceptanceAssertionId: string;
  status: "pass" | "fail";
  observedHash: string;
}

const CAPABILITIES: StudioCapabilityDefinition[] = [
  {
    name: "instance.resolve",
    version: 1,
    description: "Resolve one explicit Workspace BasePart identity without reading arbitrary properties.",
    inputSchema: { targetId: "StudioRuntimeTarget" },
    outputSchema: { status: ["resolved", "missing", "class_mismatch"], path: "string?", className: "string?" }
  },
  {
    name: "base_part.position",
    version: 1,
    description: "Observe one finite BasePart world position from a resolved target.",
    inputSchema: { targetId: "resolved StudioRuntimeTarget" },
    outputSchema: { status: ["ok", "unavailable"], position: "Vector3?", elapsedMs: "number?" }
  },
  {
    name: "base_part.position_series",
    version: 1,
    description: "Observe a bounded time-stamped series of BasePart world positions from a resolved target.",
    inputSchema: { targetId: "resolved StudioRuntimeTarget", sampleCount: "integer", intervalMs: "integer" },
    outputSchema: { status: ["ok", "unavailable"], samples: "PositionSample[]?" }
  }
];

export const STUDIO_CAPABILITY_SET = createStudioCapabilitySet({
  version: "studio-capabilities-v1",
  capabilities: CAPABILITIES,
  policy: {
    allowedRoots: ["Workspace"],
    maxTargets: 8,
    maxCalls: 16,
    maxSamplesPerSeries: 32,
    minSampleIntervalMs: 100,
    maxSampleIntervalMs: 1000,
    maxExecutionMs: 20_000,
    maxResultBytes: 64 * 1024
  }
});

export function createStudioCapabilitySet(input: Omit<StudioCapabilitySet, "kind" | "schemaVersion" | "id" | "hash">): StudioCapabilitySet {
  const canonical = {
    version: input.version,
    capabilities: [...input.capabilities].map((capability) => ({ ...capability, inputSchema: cloneRecord(capability.inputSchema), outputSchema: cloneRecord(capability.outputSchema) })).sort((left, right) => left.name.localeCompare(right.name)),
    policy: { ...input.policy, allowedRoots: [...input.policy.allowedRoots] as ["Workspace"] }
  };
  const hash = contentHash(stableJson(canonical));
  const value: StudioCapabilitySet = { kind: "StudioCapabilitySet", schemaVersion: 1, id: `studio_capability_set_${hash.slice(0, 24)}`, hash, ...canonical };
  assertStudioCapabilitySet(value);
  return value;
}

export function assertStudioCapabilitySet(value: unknown): asserts value is StudioCapabilitySet {
  if (!isRecord(value) || value.kind !== "StudioCapabilitySet" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || value.version !== "studio-capabilities-v1" || !Array.isArray(value.capabilities) || !isRecord(value.policy)) throw new Error("Invalid StudioCapabilitySet");
  if ((value.capabilities as unknown[]).length !== 3 || !(value.capabilities as unknown[]).every(isCapabilityDefinition)) throw new Error("Invalid StudioCapabilitySet capabilities");
  const names = (value.capabilities as StudioCapabilityDefinition[]).map((capability) => capability.name);
  if (stableJson(names) !== stableJson(["base_part.position", "base_part.position_series", "instance.resolve"])) throw new Error("Invalid StudioCapabilitySet capability order");
  if (!isCapabilityPolicy(value.policy)) throw new Error("Invalid StudioCapabilitySet policy");
  const canonical = { version: value.version, capabilities: value.capabilities, policy: value.policy };
  const expected = contentHash(stableJson(canonical));
  if (value.hash !== expected || value.id !== `studio_capability_set_${expected.slice(0, 24)}`) throw new Error("Invalid StudioCapabilitySet identity");
}

export function createStudioExecutionPlan(input: Omit<StudioExecutionPlan, "kind" | "schemaVersion" | "id" | "hash">): StudioExecutionPlan {
  const canonical = canonicalExecutionInput(input);
  const hash = contentHash(stableJson(canonical));
  const plan: StudioExecutionPlan = { kind: "StudioExecutionPlan", schemaVersion: 1, id: `studio_execution_plan_${hash.slice(0, 24)}`, hash, ...canonical };
  assertStudioExecutionPlan(plan);
  return plan;
}

export function assertStudioExecutionPlan(value: unknown): asserts value is StudioExecutionPlan {
  if (!isRecord(value) || value.kind !== "StudioExecutionPlan" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || (value.purpose !== "runtime_evaluation" && value.purpose !== "capability_canary") || !isId(value.capabilitySetId) || !isHash(value.capabilitySetHash) || !isExecutionBinding(value.binding) || !Array.isArray(value.targets) || !Array.isArray(value.calls) || !isExecutionBudget(value.budget)) throw new Error("Invalid StudioExecutionPlan");
  assertTargetsAndCalls(value.targets as unknown[], value.calls as unknown[], value.budget as unknown as StudioExecutionBudget);
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const canonical = canonicalExecutionInput(payload as Omit<StudioExecutionPlan, "kind" | "schemaVersion" | "id" | "hash">);
  const expected = contentHash(stableJson(canonical));
  if (value.hash !== expected || value.id !== `studio_execution_plan_${expected.slice(0, 24)}`) throw new Error("Invalid StudioExecutionPlan identity");
}

export function serializeStudioExecutionPlan(plan: StudioExecutionPlan): string {
  assertStudioExecutionPlan(plan);
  return stableJson(plan);
}

export function assertRuntimeObservationEnvelope(value: unknown): asserts value is RuntimeObservationEnvelope {
  if (!isRecord(value) || value.kind !== "RuntimeObservationEnvelope" || value.schemaVersion !== 1 || !isId(value.executionPlanId) || !isHash(value.executionPlanHash) || !isExecutionBinding(value.binding) || !isString(value.nonce) || value.nonce.length < 16 || !isHash(value.nonceCommitment) || value.authoritative !== true || !isString(value.startedAt) || !isString(value.endedAt) || !isNonNegativeFinite(value.durationMs) || !Array.isArray(value.results)) throw new Error("Invalid RuntimeObservationEnvelope");
  const results = value.results as unknown[];
  if (results.length === 0 || new Set(results.map((result) => isRecord(result) ? String(result.id) : "")).size !== results.length || !results.every(isRuntimeCapabilityResult)) throw new Error("Invalid RuntimeObservationEnvelope results");
}

export function createRuntimeEvalDefinition(input: Omit<RuntimeEvalDefinition, "kind" | "schemaVersion" | "id" | "hash">): RuntimeEvalDefinition {
  const canonical = canonicalDefinitionInput(input);
  const hash = contentHash(stableJson(canonical));
  const value: RuntimeEvalDefinition = { kind: "RuntimeEvalDefinition", schemaVersion: 1, id: `runtime_eval_definition_${hash.slice(0, 24)}`, hash, ...canonical };
  assertRuntimeEvalDefinition(value);
  return value;
}

export function assertRuntimeEvalDefinition(value: unknown): asserts value is RuntimeEvalDefinition {
  if (!isRecord(value) || value.kind !== "RuntimeEvalDefinition" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !isId(value.requirementSetId) || !isId(value.evaluatorViewId) || !isHash(value.evaluatorViewHash) || !isId(value.acceptanceSpecId) || !isEvaluatorProvenance(value.provenance) || !isId(value.capabilitySetId) || !isHash(value.capabilitySetHash) || !Array.isArray(value.targets) || !Array.isArray(value.calls) || !isExecutionBudget(value.budget) || !Array.isArray(value.assertions)) throw new Error("Invalid RuntimeEvalDefinition");
  assertTargetsAndCalls(value.targets as unknown[], value.calls as unknown[], value.budget as unknown as StudioExecutionBudget);
  const assertions = value.assertions as unknown[];
  if (assertions.length === 0 || !assertions.every(isRuntimeAssertion) || !isCanonicalIds(assertions.map((assertion) => (assertion as RuntimeAssertion).id))) throw new Error("Invalid RuntimeEvalDefinition assertions");
  const callIds = new Set((value.calls as StudioCapabilityCall[]).map((call) => call.id));
  for (const assertion of assertions as RuntimeAssertion[]) {
    if (assertion.kind === "exists" && !callIds.has(assertion.observationId)) throw new Error("Runtime exists assertion references an unknown observation");
    if (assertion.kind === "distinct_positions_at_least" && !callIds.has(assertion.observationId)) throw new Error("Runtime distinct-position assertion references an unknown observation");
    if (assertion.kind === "ordered_position_visits" && (![assertion.seriesObservationId, assertion.endpointAObservationId, assertion.endpointBObservationId].every((id) => callIds.has(id)))) throw new Error("Runtime ordered-visits assertion references an unknown observation");
  }
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(canonicalDefinitionInput(payload as Omit<RuntimeEvalDefinition, "kind" | "schemaVersion" | "id" | "hash">)));
  if (value.hash !== expected || value.id !== `runtime_eval_definition_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvalDefinition identity");
}

export function createRuntimeEvalPlan(input: Omit<RuntimeEvalPlan, "kind" | "schemaVersion" | "id" | "hash">): RuntimeEvalPlan {
  assertStudioExecutionPlan(input.executionPlan);
  const payload = { ...input, ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}) };
  const hash = contentHash(stableJson(payload));
  const value: RuntimeEvalPlan = { kind: "RuntimeEvalPlan", schemaVersion: 1, id: `runtime_eval_plan_${hash.slice(0, 24)}`, hash, ...payload };
  assertRuntimeEvalPlan(value);
  return value;
}

export function assertRuntimeEvalPlan(value: unknown): asserts value is RuntimeEvalPlan {
  if (!isRecord(value) || value.kind !== "RuntimeEvalPlan" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !isId(value.definitionId) || !isHash(value.definitionHash) || !isId(value.candidateArtifactId) || !isHash(value.candidateArtifactHash) || (value.agentRunId !== undefined && !isId(value.agentRunId)) || !isId(value.workspaceDeltaId) || !isHash(value.candidateHash) || !isRecord(value.executionPlan)) throw new Error("Invalid RuntimeEvalPlan");
  assertStudioExecutionPlan(value.executionPlan);
  if (value.executionPlan.purpose !== "runtime_evaluation" || value.executionPlan.binding.candidateHash !== value.candidateHash) throw new Error("RuntimeEvalPlan execution binding mismatch");
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `runtime_eval_plan_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvalPlan identity");
}

export function createRuntimeEvaluatorConfiguration(input: Omit<RuntimeEvaluatorConfiguration, "kind" | "schemaVersion" | "id" | "hash">): RuntimeEvaluatorConfiguration {
  const canonical = { ...input, assertionEngine: { ...input.assertionEngine } };
  const hash = contentHash(stableJson(canonical));
  const value: RuntimeEvaluatorConfiguration = { kind: "RuntimeEvaluatorConfiguration", schemaVersion: 1, id: `runtime_evaluator_configuration_${hash.slice(0, 24)}`, hash, ...canonical };
  assertRuntimeEvaluatorConfiguration(value);
  return value;
}

export function assertRuntimeEvaluatorConfiguration(value: unknown): asserts value is RuntimeEvaluatorConfiguration {
  if (!isRecord(value) || value.kind !== "RuntimeEvaluatorConfiguration" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !isId(value.capabilitySetId) || !isHash(value.capabilitySetHash) || !isRecord(value.assertionEngine) || value.assertionEngine.name !== "forge_runtime_assertions" || value.assertionEngine.version !== "runtime-assertions-1" || !isId(value.runtimeEvalDefinitionId) || !isHash(value.runtimeEvalDefinitionHash) || value.protocolVersion !== 12 || value.pluginVersion !== "forge-studio-plugin-8.0.0" || value.executionPolicy !== "creator_triggered_play_solo_v1" || value.bindingPolicy !== "candidate_source_and_world_snapshot_v1" || !isPositiveInteger(value.maxResultBytes)) throw new Error("Invalid RuntimeEvaluatorConfiguration");
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `runtime_evaluator_configuration_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvaluatorConfiguration identity");
}

export function gradeRuntimeObservations(definition: RuntimeEvalDefinition, envelope: RuntimeObservationEnvelope): RuntimeAssertionResult[] {
  assertRuntimeEvalDefinition(definition);
  assertRuntimeObservationEnvelope(envelope);
  const results = new Map(envelope.results.map((result) => [result.id, result]));
  return definition.assertions.map((assertion) => {
    const passed = gradeAssertion(assertion, results);
    const observed = observationsForAssertion(assertion, results);
    return { id: assertion.id, requirementId: assertion.requirementId, acceptanceAssertionId: assertion.acceptanceAssertionId, status: passed ? "pass" : "fail", observedHash: contentHash(stableJson(observed)) };
  });
}

function gradeAssertion(assertion: RuntimeAssertion, results: Map<string, RuntimeCapabilityResult>): boolean {
  if (assertion.kind === "exists") return results.get(assertion.observationId)?.capability === "instance.resolve" && results.get(assertion.observationId)?.status === "resolved";
  if (assertion.kind === "distinct_positions_at_least") {
    const result = results.get(assertion.observationId);
    if (!result || result.capability !== "base_part.position_series" || result.status !== "ok" || !result.samples) return false;
    const positions = new Set(result.samples.map((sample) => `${Math.round(sample.position.x / assertion.quantizationStuds)},${Math.round(sample.position.y / assertion.quantizationStuds)},${Math.round(sample.position.z / assertion.quantizationStuds)}`));
    return positions.size >= assertion.minimumDistinctPositions;
  }
  const series = results.get(assertion.seriesObservationId);
  const endpointA = results.get(assertion.endpointAObservationId);
  const endpointB = results.get(assertion.endpointBObservationId);
  if (!series || series.capability !== "base_part.position_series" || series.status !== "ok" || !series.samples || !endpointA || endpointA.capability !== "base_part.position" || endpointA.status !== "ok" || !endpointA.position || !endpointB || endpointB.capability !== "base_part.position" || endpointB.status !== "ok" || !endpointB.position) return false;
  const visits: Array<{ label: "A" | "B"; elapsedMs: number }> = [];
  for (const sample of series.samples) {
    const distanceA = distance(sample.position, endpointA.position);
    const distanceB = distance(sample.position, endpointB.position);
    const label = distanceA <= assertion.toleranceStuds && distanceB > assertion.toleranceStuds ? "A" : distanceB <= assertion.toleranceStuds && distanceA > assertion.toleranceStuds ? "B" : undefined;
    if (label && visits.at(-1)?.label !== label) visits.push({ label, elapsedMs: sample.elapsedMs });
  }
  return assertion.acceptedOrders.some((order) => visits.some((visit, index) => {
    const second = visits[index + 1]; const third = visits[index + 2];
    return visit.label === order[0] && second?.label === order[1] && third?.label === order[2]
      && inLegWindow(second.elapsedMs - visit.elapsedMs, assertion)
      && inLegWindow(third.elapsedMs - second.elapsedMs, assertion);
  }));
}

function observationsForAssertion(assertion: RuntimeAssertion, results: Map<string, RuntimeCapabilityResult>): RuntimeCapabilityResult[] {
  const ids = assertion.kind === "exists" || assertion.kind === "distinct_positions_at_least"
    ? [assertion.observationId]
    : [assertion.seriesObservationId, assertion.endpointAObservationId, assertion.endpointBObservationId];
  return ids.map((id) => results.get(id)).filter((value): value is RuntimeCapabilityResult => value !== undefined);
}

function inLegWindow(durationMs: number, assertion: Extract<RuntimeAssertion, { kind: "ordered_position_visits" }>): boolean { return durationMs >= assertion.minimumLegMs && durationMs <= assertion.maximumLegMs; }
function distance(left: RuntimeVector3, right: RuntimeVector3): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }

function canonicalExecutionInput(input: Omit<StudioExecutionPlan, "kind" | "schemaVersion" | "id" | "hash">): Omit<StudioExecutionPlan, "kind" | "schemaVersion" | "id" | "hash"> {
  return { ...input, binding: { ...input.binding, project: { ...input.binding.project }, ...(input.binding.candidateHash ? { candidateHash: input.binding.candidateHash } : {}) }, targets: [...input.targets].map((target) => ({ ...target })).sort((left, right) => left.id.localeCompare(right.id)), calls: [...input.calls].map((call) => ({ ...call })).sort((left, right) => left.id.localeCompare(right.id)), budget: { ...input.budget } };
}

function canonicalDefinitionInput(input: Omit<RuntimeEvalDefinition, "kind" | "schemaVersion" | "id" | "hash">): Omit<RuntimeEvalDefinition, "kind" | "schemaVersion" | "id" | "hash"> {
  return { ...input, provenance: { ...input.provenance }, targets: [...input.targets].map((target) => ({ ...target })).sort((left, right) => left.id.localeCompare(right.id)), calls: [...input.calls].map((call) => ({ ...call })).sort((left, right) => left.id.localeCompare(right.id)), budget: { ...input.budget }, assertions: [...input.assertions].map((assertion) => assertion.kind === "ordered_position_visits" ? { ...assertion, acceptedOrders: [...assertion.acceptedOrders].map((order) => [...order] as typeof order).sort((left, right) => left.join("").localeCompare(right.join(""))) } : { ...assertion }).sort((left, right) => left.id.localeCompare(right.id)) };
}

function assertTargetsAndCalls(targets: unknown[], calls: unknown[], budget: StudioExecutionBudget): void {
  if (targets.length === 0 || targets.length > STUDIO_CAPABILITY_SET.policy.maxTargets || !targets.every(isTarget) || !isCanonicalIds(targets.map((target) => (target as StudioRuntimeTarget).id))) throw new Error("Invalid Studio runtime targets");
  if (calls.length === 0 || calls.length > STUDIO_CAPABILITY_SET.policy.maxCalls || !calls.every(isCapabilityCall) || !isCanonicalIds(calls.map((call) => (call as StudioCapabilityCall).id))) throw new Error("Invalid Studio runtime calls");
  if (budget.maxExecutionMs > STUDIO_CAPABILITY_SET.policy.maxExecutionMs || budget.maxResultBytes > STUDIO_CAPABILITY_SET.policy.maxResultBytes) throw new Error("Studio runtime budget exceeds capability policy");
  const targetIds = new Set(targets.map((target) => (target as StudioRuntimeTarget).id));
  const resolved = new Set<string>();
  for (const call of calls as StudioCapabilityCall[]) {
    if (!targetIds.has(call.targetId)) throw new Error("Studio runtime call references an unknown target");
    if (call.capability === "instance.resolve") resolved.add(call.targetId);
    else if (!resolved.has(call.targetId)) throw new Error("Studio runtime observation requires a prior instance.resolve call");
    if (call.capability === "base_part.position_series" && (call.sampleCount > STUDIO_CAPABILITY_SET.policy.maxSamplesPerSeries || call.intervalMs < STUDIO_CAPABILITY_SET.policy.minSampleIntervalMs || call.intervalMs > STUDIO_CAPABILITY_SET.policy.maxSampleIntervalMs)) throw new Error("Studio runtime position series exceeds capability policy");
  }
}

function isCapabilityDefinition(value: unknown): value is StudioCapabilityDefinition { return isRecord(value) && ["instance.resolve", "base_part.position", "base_part.position_series"].includes(String(value.name)) && value.version === 1 && isString(value.description) && isRecord(value.inputSchema) && isRecord(value.outputSchema); }
function isCapabilityPolicy(value: unknown): value is StudioCapabilityPolicy { return isRecord(value) && Array.isArray(value.allowedRoots) && value.allowedRoots.length === 1 && value.allowedRoots[0] === "Workspace" && isPositiveInteger(value.maxTargets) && isPositiveInteger(value.maxCalls) && isPositiveInteger(value.maxSamplesPerSeries) && isPositiveInteger(value.minSampleIntervalMs) && isPositiveInteger(value.maxSampleIntervalMs) && value.minSampleIntervalMs <= value.maxSampleIntervalMs && isPositiveInteger(value.maxExecutionMs) && isPositiveInteger(value.maxResultBytes); }
function isTarget(value: unknown): value is StudioRuntimeTarget { return isRecord(value) && isId(value.id) && isWorkspacePath(value.path) && value.expectedClass === "BasePart"; }
function isCapabilityCall(value: unknown): value is StudioCapabilityCall { if (!isRecord(value) || !isId(value.id) || value.version !== 1 || !isId(value.targetId)) return false; if (value.capability === "instance.resolve" || value.capability === "base_part.position") return true; return value.capability === "base_part.position_series" && isPositiveInteger(value.sampleCount) && isPositiveInteger(value.intervalMs); }
function isRuntimeCapabilityResult(value: unknown): value is RuntimeCapabilityResult { if (!isRecord(value) || !isId(value.id) || !isId(value.targetId)) return false; if (value.capability === "instance.resolve") return ["resolved", "missing", "class_mismatch"].includes(String(value.status)) && (value.path === undefined || isWorkspacePath(value.path)) && (value.className === undefined || isString(value.className)); if (value.capability === "base_part.position") return ["ok", "unavailable"].includes(String(value.status)) && (value.position === undefined || isVector3(value.position)) && (value.elapsedMs === undefined || isNonNegativeFinite(value.elapsedMs)); return value.capability === "base_part.position_series" && ["ok", "unavailable"].includes(String(value.status)) && (value.samples === undefined || (Array.isArray(value.samples) && value.samples.length <= STUDIO_CAPABILITY_SET.policy.maxSamplesPerSeries && value.samples.every((sample, index) => isRecord(sample) && sample.sequence === index + 1 && isNonNegativeFinite(sample.elapsedMs) && isVector3(sample.position)))); }
function isRuntimeAssertion(value: unknown): value is RuntimeAssertion { if (!isRecord(value) || !isId(value.id) || !isId(value.requirementId) || !isId(value.acceptanceAssertionId)) return false; if (value.kind === "exists") return isId(value.observationId); if (value.kind === "distinct_positions_at_least") return isId(value.observationId) && isPositiveFinite(value.quantizationStuds) && isPositiveInteger(value.minimumDistinctPositions); return value.kind === "ordered_position_visits" && isId(value.seriesObservationId) && isId(value.endpointAObservationId) && isId(value.endpointBObservationId) && isPositiveFinite(value.toleranceStuds) && isPositiveInteger(value.minimumLegMs) && isPositiveInteger(value.maximumLegMs) && value.minimumLegMs <= value.maximumLegMs && Array.isArray(value.acceptedOrders) && value.acceptedOrders.length > 0 && value.acceptedOrders.every((order) => Array.isArray(order) && order.length === 3 && ((order[0] === "A" && order[1] === "B" && order[2] === "A") || (order[0] === "B" && order[1] === "A" && order[2] === "B"))); }
function isExecutionBinding(value: unknown): value is StudioExecutionBinding { return isRecord(value) && isId(value.runId) && isId(value.correlationId) && isId(value.sessionId) && isId(value.projectId) && isProjectIdentity(value.project) && isHash(value.projectSnapshotHash) && (value.candidateHash === undefined || isHash(value.candidateHash)); }
function isProjectIdentity(value: unknown): value is StudioProjectIdentity { return isRecord(value) && isString(value.name) && isNonNegativeInteger(value.placeId) && isNonNegativeInteger(value.universeId); }
function isExecutionBudget(value: unknown): value is StudioExecutionBudget { return isRecord(value) && isPositiveInteger(value.maxExecutionMs) && isPositiveInteger(value.maxResultBytes); }
function isEvaluatorProvenance(value: unknown): value is RuntimeEvalDefinition["provenance"] { return isRecord(value) && (value.source === "evaluator" || value.source === "benchmark_oracle") && value.authority === "evaluation_only" && value.visibility === "evaluator_only"; }
function isCanonicalIds(ids: string[]): boolean { return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]!.localeCompare(id) < 0); }
function isWorkspacePath(value: unknown): value is string { return isString(value) && value.startsWith("Workspace/") && !value.includes("\\0") && !value.split("/").includes("..") && value.split("/").every((part) => part.length > 0); }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isPositiveFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function isNonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isVector3(value: unknown): value is RuntimeVector3 { return isRecord(value) && isNonNegativeOrNegativeFinite(value.x) && isNonNegativeOrNegativeFinite(value.y) && isNonNegativeOrNegativeFinite(value.z); }
function isNonNegativeOrNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function cloneRecord(value: Record<string, unknown>): Record<string, unknown> { return JSON.parse(stableJson(value)) as Record<string, unknown>; }
