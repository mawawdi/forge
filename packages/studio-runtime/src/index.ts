import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { contentHash, stableJson, type BuildTrace, type TracePersistence } from "../../contracts/src/index.js";
import { JsonFileTraceSink, FlightRecorder } from "../../flight-recorder/src/index.js";
import { createRuntimeProofBundle, type RuntimeProofBundle } from "../../proofs/src/index.js";
import { createBackendMessage, type StudioBridgeConnection, type StudioBridgeSession } from "../../studio-bridge/src/index.js";
import { STUDIO_PLUGIN_VERSION, type PluginToBackendMessage } from "../../studio-protocol/src/index.js";
import type { StudioSnapshotObservation } from "../../semantic-map/src/index.js";
import {
  assertRuntimeEvalDefinition,
  assertRuntimeEvaluatorConfiguration,
  assertRuntimeObservationEnvelope,
  assertStudioExecutionPlan,
  assertRuntimeEvalPlan,
  gradeRuntimeObservations,
  serializeStudioExecutionPlan,
  type RuntimeAssertionResult,
  type RuntimeEvalDefinition,
  type RuntimeEvalPlan,
  type RuntimeEvaluatorConfiguration,
  type RuntimeObservationEnvelope,
  type StudioExecutionBinding,
  type StudioExecutionPlan,
} from "../../studio-capabilities/src/index.js";

/**
 * Private record of one correlated generic Studio run. Raw observations stay
 * here; RuntimeProofBundle carries only hashes and assertion outcomes.
 */
export interface RuntimeEvaluationRun {
  kind: "RuntimeEvaluationRun";
  schemaVersion: 1;
  id: string;
  hash: string;
  status: "runtime_verified" | "rejected" | "incomplete";
  runtimeEvalPlanId: string;
  runtimeEvalPlanHash: string;
  runtimeEvaluatorConfigurationId: string;
  runtimeEvaluatorConfigurationHash: string;
  session: { id: string; projectId: string; pluginVersion: string; studioVersion: string };
  acceptedAt?: string;
  startedAt?: string;
  endedAt?: string;
  observation?: RuntimeObservationEnvelope;
  assertionResults?: RuntimeAssertionResult[];
  failure?: { classification: RuntimeFailureClassification; detail: string };
}

export type RuntimeFailureClassification =
  | "candidate_behavior"
  | "protocol"
  | "capability"
  | "studio"
  | "timeout"
  | "environment";

export interface RuntimeExecutionOutcome {
  run: RuntimeEvaluationRun;
  proof?: RuntimeProofBundle;
  trace: BuildTrace;
  tracePersistence?: TracePersistence;
}

export interface RuntimeExecutionRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  runtimeEvalPlan: RuntimeEvalPlan;
  definition: RuntimeEvalDefinition;
  configuration: RuntimeEvaluatorConfiguration;
  timeoutMs: number;
  traceDirectory?: string;
  proofDirectory?: string;
  proofInput?: Omit<RuntimeProofBundle, "kind" | "schemaVersion" | "id" | "hash" | "status" | "runtimeEvaluationRunId" | "runtimeEvaluationRunHash" | "assertionResults" | "pluginVersion" | "studioVersion">;
}

/** A non-evaluative capability transport characterization. It never produces proof. */
export interface StudioCapabilityCanaryRun {
  kind: "StudioCapabilityCanaryRun";
  schemaVersion: 1;
  id: string;
  hash: string;
  status: "completed" | "incomplete";
  executionPlanId: string;
  executionPlanHash: string;
  session: { id: string; projectId: string; pluginVersion: string; studioVersion: string };
  observation?: RuntimeObservationEnvelope;
  failure?: { classification: Exclude<RuntimeFailureClassification, "candidate_behavior">; detail: string };
}

export interface StudioCapabilityCanaryRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  executionPlan: StudioExecutionPlan;
  /**
   * A fresh edit-mode fact used only to attest that selected static targets
   * survived into Play Solo unchanged. It is never an evaluator input.
   */
  prePlayObservation: StudioSnapshotObservation;
  /** Explicit static target identities declared by the task-owned canary. */
  staticTargetIds: string[];
  timeoutMs: number;
}

/** Request an authoritative pre-play snapshot before binding a plan. */
export async function requestFreshStudioSnapshot(connection: StudioBridgeConnection, session: StudioBridgeSession, timeoutMs: number): Promise<{ revisionHash: string; observation: StudioSnapshotObservation }> {
  const messages: PluginToBackendMessage[] = [];
  const unsubscribe = connection.subscribeWithSession((message, messageSession) => {
    if (messageSession.sessionId === session.sessionId && message.sessionId === session.sessionId) messages.push(message);
  });
  try {
    const requestId = `runtime_snapshot_${randomUUID()}`;
    await connection.send(createBackendMessage("RequestObservation", { requestId, reason: "pre_play" }, session.sessionId, requestId));
    const message = await waitFor(messages, (candidate): candidate is Extract<PluginToBackendMessage, { type: "ProjectObservation" }> => candidate.type === "ProjectObservation" && candidate.payload.reason === "pre_play" && candidate.payload.project.name === session.project.name && candidate.payload.project.placeId === session.project.placeId && candidate.payload.project.universeId === session.project.universeId, timeoutMs, "fresh pre-play Studio observation");
    return { revisionHash: message.payload.revision.observationHash, observation: message.payload.observation };
  } finally {
    unsubscribe();
  }
}

export async function executeRuntimeEvaluation(request: RuntimeExecutionRequest): Promise<RuntimeExecutionOutcome> {
  assertRuntimeEvalPlan(request.runtimeEvalPlan);
  assertRuntimeEvalDefinition(request.definition);
  assertRuntimeEvaluatorConfiguration(request.configuration);
  if (request.session.pluginVersion !== STUDIO_PLUGIN_VERSION) {
    return completeRuntime(request, incompleteRun(request, "environment", `Expected ${STUDIO_PLUGIN_VERSION}; connected plugin is ${request.session.pluginVersion}`));
  }
  if (!request.session.capabilities.includes("runtime_eval_v1")) {
    return completeRuntime(request, incompleteRun(request, "capability", "Connected Studio plugin does not advertise runtime_eval_v1"));
  }
  if (request.runtimeEvalPlan.definitionId !== request.definition.id || request.runtimeEvalPlan.definitionHash !== request.definition.hash) {
    return completeRuntime(request, incompleteRun(request, "protocol", "RuntimeEvalPlan does not bind the supplied RuntimeEvalDefinition"));
  }
  if (request.configuration.runtimeEvalDefinitionId !== request.definition.id || request.configuration.runtimeEvalDefinitionHash !== request.definition.hash) {
    return completeRuntime(request, incompleteRun(request, "protocol", "RuntimeEvaluatorConfiguration does not bind the supplied RuntimeEvalDefinition"));
  }
  const execution = request.runtimeEvalPlan.executionPlan;
  const observed = await executePlan({ connection: request.connection, session: request.session, executionPlan: execution, timeoutMs: request.timeoutMs });
  if (observed.kind === "failure") return completeRuntime(request, incompleteRun(request, observed.classification, observed.detail));
  const assertionResults = gradeRuntimeObservations(request.definition, observed.envelope);
  const status = assertionResults.every((result) => result.status === "pass") ? "runtime_verified" : "rejected";
  const run = createRuntimeEvaluationRun({
    status,
    runtimeEvalPlanId: request.runtimeEvalPlan.id,
    runtimeEvalPlanHash: request.runtimeEvalPlan.hash,
    runtimeEvaluatorConfigurationId: request.configuration.id,
    runtimeEvaluatorConfigurationHash: request.configuration.hash,
    session: sessionSummary(request.session),
    acceptedAt: observed.acceptedAt,
    startedAt: observed.envelope.startedAt,
    endedAt: observed.envelope.endedAt,
    observation: observed.envelope,
    assertionResults,
  });
  return completeRuntime(request, run);
}

export async function executeStudioCapabilityCanary(request: StudioCapabilityCanaryRequest): Promise<StudioCapabilityCanaryRun> {
  assertStudioExecutionPlan(request.executionPlan);
  if (request.executionPlan.purpose !== "capability_canary") throw new Error("Studio capability canary requires a capability_canary execution plan");
  if (!Array.isArray(request.staticTargetIds) || request.staticTargetIds.length === 0 || new Set(request.staticTargetIds).size !== request.staticTargetIds.length || request.staticTargetIds.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("Studio capability canary requires distinct static target IDs");
  let canary: StudioCapabilityCanaryRun;
  if (request.session.pluginVersion !== STUDIO_PLUGIN_VERSION) {
    canary = createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), failure: { classification: "environment", detail: `Expected ${STUDIO_PLUGIN_VERSION}; connected plugin is ${request.session.pluginVersion}` } });
  } else if (!request.session.capabilities.includes("runtime_eval_v1")) {
    canary = createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), failure: { classification: "capability", detail: "Connected Studio plugin does not advertise runtime_eval_v1" } });
  } else {
    const observed = await executePlan({ connection: request.connection, session: request.session, executionPlan: request.executionPlan, timeoutMs: request.timeoutMs });
    canary = observed.kind === "failure"
      ? createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), failure: { classification: observed.classification, detail: observed.detail } })
      : (() => {
        const integrityFailure = canaryStaticPositionIntegrityFailure(request.executionPlan, request.prePlayObservation, request.staticTargetIds, observed.envelope);
        return integrityFailure
          ? createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), observation: observed.envelope, failure: { classification: "capability", detail: integrityFailure } })
          : createStudioCapabilityCanaryRun({ status: "completed", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), observation: observed.envelope });
      })();
  }
  return canary;
}

/**
 * A canary is transport-only, but it must reject a runner that turns known
 * static pre-play facts into different runtime readings. This check is not
 * part of RuntimeEvalDefinition or candidate grading; it is an integrity gate
 * for the execution substrate itself.
 */
function canaryStaticPositionIntegrityFailure(plan: StudioExecutionPlan, prePlayObservation: StudioSnapshotObservation, staticTargetIds: string[], envelope: RuntimeObservationEnvelope): string | undefined {
  for (const targetId of staticTargetIds) {
    const target = plan.targets.find((candidate) => candidate.id === targetId);
    if (!target) return `Canary static target ${targetId} is not declared by the execution plan`;
    const prePlay = prePlayObservation.instances.find((instance) => instance.path === target.path);
    if (!prePlay?.position) return `Canary static target ${target.path} lacks a finite pre-play BasePart position`;
    const runtime = envelope.results.find((result): result is Extract<RuntimeObservationEnvelope["results"][number], { capability: "base_part.position" }> => result.capability === "base_part.position" && result.targetId === targetId);
    if (runtime?.status !== "ok" || !runtime.position) return `Canary static target ${target.path} lacks a successful runtime position observation`;
    if (!samePosition(prePlay.position, runtime.position)) return `Canary static target ${target.path} changed between pre-play observation and runtime capability output`;
  }
  return undefined;
}

function samePosition(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

type ExecutePlanResult =
  | { kind: "success"; acceptedAt: string; envelope: RuntimeObservationEnvelope }
  | { kind: "failure"; classification: Exclude<RuntimeFailureClassification, "candidate_behavior">; detail: string };

async function executePlan(input: { connection: StudioBridgeConnection; session: StudioBridgeSession; executionPlan: StudioExecutionPlan; timeoutMs: number }): Promise<ExecutePlanResult> {
  const { connection, session, executionPlan } = input;
  const messages: PluginToBackendMessage[] = [];
  let duplicateResult = false;
  const unsubscribe = connection.subscribeWithSession((message, messageSession) => {
    if (messageSession.sessionId !== session.sessionId || message.sessionId !== session.sessionId) return;
    if (message.type === "RuntimeEvalResult" && messages.some((prior) => prior.type === "RuntimeEvalResult" && prior.payload.executionPlanId === message.payload.executionPlanId)) duplicateResult = true;
    messages.push(message);
  });
  try {
    const requestId = `runtime_request_${randomUUID()}`;
    const executionPlanJson = serializeStudioExecutionPlan(executionPlan);
    await connection.send(createBackendMessage("ExecuteRuntimeEvalPlan", { requestId, expectedRevision: executionPlan.binding.projectSnapshotHash, executionPlanJson, executionPlanJsonHash: contentHash(executionPlanJson) }, session.sessionId, requestId));
    const accepted = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalPlanAccepted" }> => message.type === "RuntimeEvalPlanAccepted" && sameRuntimeMessage(message, executionPlan, session), input.timeoutMs, "runtime plan acceptance");
    if (accepted.payload.callCount !== executionPlan.calls.length) return { kind: "failure", classification: "protocol", detail: "Studio accepted a different runtime call count" };
    const started = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStarted" }> => message.type === "RuntimeEvalStarted" && sameRuntimeMessage(message, executionPlan, session) && message.payload.nonceCommitment === accepted.payload.nonceCommitment, input.timeoutMs, "runtime start");
    if (started.payload.control !== "plugin_action" || started.payload.mode !== "play_solo") return { kind: "failure", classification: "protocol", detail: "Studio runtime execution did not use plugin-owned Play Solo" };
    const terminal = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalResult" | "PluginError" }> =>
      (message.type === "RuntimeEvalResult" && sameRuntimeMessage(message, executionPlan, session))
      || (message.type === "PluginError" && message.requestId === requestId), input.timeoutMs, "runtime result");
    if (terminal.type === "PluginError") {
      return { kind: "failure", classification: runtimePluginErrorClassification(terminal.payload.code), detail: `Studio plugin ${terminal.payload.code}: ${terminal.payload.message}` };
    }
    const result = terminal;
    const stopped = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStopped" }> => message.type === "RuntimeEvalStopped" && sameRuntimeMessage(message, executionPlan, session) && message.payload.nonceCommitment === accepted.payload.nonceCommitment, input.timeoutMs, "runtime stop");
    if (duplicateResult) return { kind: "failure", classification: "protocol", detail: "Studio emitted duplicate runtime results" };
    const envelope = result.payload;
    assertRuntimeObservationEnvelope(envelope);
    if (envelope.executionPlanId !== executionPlan.id || envelope.executionPlanHash !== executionPlan.hash || !sameBinding(envelope.binding, executionPlan.binding) || envelope.nonceCommitment !== accepted.payload.nonceCommitment || contentHash(envelope.nonce) !== envelope.nonceCommitment) return { kind: "failure", classification: "protocol", detail: "Studio runtime result binding or nonce commitment mismatch" };
    if (stopped.payload.nonceCommitment !== envelope.nonceCommitment) return { kind: "failure", classification: "protocol", detail: "Studio runtime stop nonce commitment mismatch" };
    if (Buffer.byteLength(stableJson(envelope), "utf8") > executionPlan.budget.maxResultBytes) return { kind: "failure", classification: "capability", detail: "Studio runtime result exceeds plan output bound" };
    return { kind: "success", acceptedAt: accepted.sentAt, envelope };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "failure", classification: /Timed out/i.test(detail) ? "timeout" : "studio", detail };
  } finally {
    unsubscribe();
  }
}

function runtimePluginErrorClassification(code: Extract<PluginToBackendMessage, { type: "PluginError" }> ["payload"]["code"]): Exclude<RuntimeFailureClassification, "candidate_behavior"> {
  if (code === "SECURITY_REJECTION" || code === "STALE_SNAPSHOT" || code === "WRONG_PROJECT" || code === "INVALID_MESSAGE" || code === "UNSUPPORTED_OPERATION") return "protocol";
  if (code === "TRANSPORT_FAILURE") return "environment";
  return "studio";
}

function sameRuntimeMessage(message: Extract<PluginToBackendMessage, { type: "RuntimeEvalPlanAccepted" | "RuntimeEvalStarted" | "RuntimeEvalResult" | "RuntimeEvalStopped" }>, plan: StudioExecutionPlan, session: StudioBridgeSession): boolean {
  const payload = message.payload;
  return payload.executionPlanId === plan.id && payload.executionPlanHash === plan.hash && sameBinding(payload.binding, plan.binding) && payload.binding.sessionId === session.sessionId;
}

function sameBinding(left: StudioExecutionBinding, right: StudioExecutionBinding): boolean {
  return stableJson(left) === stableJson(right);
}

function incompleteRun(request: RuntimeExecutionRequest, classification: Exclude<RuntimeFailureClassification, "candidate_behavior">, detail: string): RuntimeEvaluationRun {
  return createRuntimeEvaluationRun({ status: "incomplete", runtimeEvalPlanId: request.runtimeEvalPlan.id, runtimeEvalPlanHash: request.runtimeEvalPlan.hash, runtimeEvaluatorConfigurationId: request.configuration.id, runtimeEvaluatorConfigurationHash: request.configuration.hash, session: sessionSummary(request.session), failure: { classification, detail } });
}

async function completeRuntime(request: RuntimeExecutionRequest, run: RuntimeEvaluationRun): Promise<RuntimeExecutionOutcome> {
  const proof = request.proofInput
    ? createRuntimeProofBundle({ ...request.proofInput, status: run.status, runtimeEvaluationRunId: run.id, runtimeEvaluationRunHash: run.hash, pluginVersion: request.session.pluginVersion, studioVersion: request.session.studioVersion, assertionResults: (run.assertionResults ?? []).map((result) => ({ id: result.id, status: result.status, evidenceHash: result.observedHash })) })
    : undefined;
  const recorder = new FlightRecorder({ projectId: run.session.projectId, references: {
    ...(request.proofInput ? { agentRunId: request.proofInput.agentRunId, requirementSetId: request.proofInput.requirementSetId, requirementViewId: request.proofInput.requirementViewId, workspaceDeltaId: request.proofInput.workspaceDeltaId, harnessConfigurationId: request.proofInput.harnessConfigurationId, harnessConfigurationHash: request.proofInput.harnessConfigurationHash, workspaceCandidateArtifactId: request.proofInput.workspaceCandidateArtifactId, workspaceCandidateArtifactHash: request.proofInput.workspaceCandidateArtifactHash } : {}),
    runtimeEvalPlanId: request.runtimeEvalPlan.id, runtimeEvalPlanHash: request.runtimeEvalPlan.hash, studioCapabilitySetId: request.configuration.capabilitySetId, studioCapabilitySetHash: request.configuration.capabilitySetHash, runtimeEvaluatorConfigurationId: request.configuration.id, runtimeEvaluatorConfigurationHash: request.configuration.hash, runtimeEvaluationRunId: run.id, ...(proof ? { runtimeProofId: proof.id } : {})
  }, components: { studio: { name: "forge-studio-plugin", version: request.session.pluginVersion }, toolchain: [], verifiers: [] } });
  recorder.recordSpan("forge.studio.assert", run.status === "incomplete" ? "error" : "ok", { "forge.runtime.status": run.status });
  const passed = run.assertionResults?.filter((result) => result.status === "pass").length ?? 0;
  const total = run.assertionResults?.length ?? 0;
  const trace = recorder.complete(
    { status: run.status, localGate: "eligible", runtimeGate: run.status, assertions: { total, passed }, modelUsage: { calls: 0, inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: { total: 0, ...(run.observation ? { studio: run.observation.durationMs } : {}) }, issueCounts: { critical: 0, info: 0, warning: 0, error: run.status === "runtime_verified" ? 0 : 1 } },
    { ...(proof ? { runtimeProofId: proof.id } : {}), issues: [] },
    { level: run.status === "incomplete" ? "none" : "semantic_reproduction", reasons: [run.status === "incomplete" ? "Studio evidence was insufficient for runtime grading." : "The exact runtime definition, capability configuration, and observed result are linked by hash."], randomSeeds: {} }
  );
  const tracePersistence = request.traceDirectory ? await new JsonFileTraceSink(request.traceDirectory).persist(trace) : undefined;
  if (proof && request.proofDirectory) await persistRuntimeProof(proof, request.proofDirectory);
  return { run, ...(proof ? { proof } : {}), trace, ...(tracePersistence ? { tracePersistence } : {}) };
}

export function createRuntimeEvaluationRun(input: Omit<RuntimeEvaluationRun, "kind" | "schemaVersion" | "id" | "hash">): RuntimeEvaluationRun {
  const canonical = canonicalRun(input);
  const hash = contentHash(stableJson(canonical));
  const run: RuntimeEvaluationRun = { kind: "RuntimeEvaluationRun", schemaVersion: 1, id: `runtime_evaluation_run_${hash.slice(0, 24)}`, hash, ...canonical };
  assertRuntimeEvaluationRun(run);
  return run;
}

export function assertRuntimeEvaluationRun(value: unknown): asserts value is RuntimeEvaluationRun {
  if (!isRecord(value) || value.kind !== "RuntimeEvaluationRun" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !["runtime_verified", "rejected", "incomplete"].includes(String(value.status)) || !isId(value.runtimeEvalPlanId) || !isHash(value.runtimeEvalPlanHash) || !isId(value.runtimeEvaluatorConfigurationId) || !isHash(value.runtimeEvaluatorConfigurationHash) || !isSessionSummary(value.session)) throw new Error("Invalid RuntimeEvaluationRun");
  if (value.observation !== undefined) assertRuntimeObservationEnvelope(value.observation);
  if (value.assertionResults !== undefined && (!Array.isArray(value.assertionResults) || !value.assertionResults.every(isAssertionResult))) throw new Error("Invalid RuntimeEvaluationRun assertion results");
  if (value.status === "runtime_verified" && (!value.observation || !value.assertionResults || value.assertionResults.some((result) => result.status !== "pass"))) throw new Error("runtime_verified requires complete passing factual observations");
  if (value.status === "rejected" && (!value.observation || !value.assertionResults || !value.assertionResults.some((result) => result.status === "fail"))) throw new Error("rejected requires an authoritative failed assertion");
  if (value.status === "incomplete" && (!isRecord(value.failure) || !["protocol", "capability", "studio", "timeout", "environment"].includes(String(value.failure.classification)) || !isString(value.failure.detail))) throw new Error("incomplete requires a precise non-candidate failure");
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(canonicalRun(payload as Omit<RuntimeEvaluationRun, "kind" | "schemaVersion" | "id" | "hash">)));
  if (value.hash !== expected || value.id !== `runtime_evaluation_run_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvaluationRun identity");
}

export function createStudioCapabilityCanaryRun(input: Omit<StudioCapabilityCanaryRun, "kind" | "schemaVersion" | "id" | "hash">): StudioCapabilityCanaryRun {
  const canonical = { ...input, session: { ...input.session } };
  const hash = contentHash(stableJson(canonical));
  const run: StudioCapabilityCanaryRun = { kind: "StudioCapabilityCanaryRun", schemaVersion: 1, id: `studio_capability_canary_${hash.slice(0, 24)}`, hash, ...canonical };
  if (run.status === "completed" && !run.observation) throw new Error("Completed Studio capability canary requires observations");
  if (run.status === "incomplete" && !run.failure) throw new Error("Incomplete Studio capability canary requires a precise failure");
  return run;
}

async function persistRuntimeProof(proof: RuntimeProofBundle, directory: string): Promise<void> {
  await mkdir(resolve(directory), { recursive: true });
  const destination = join(resolve(directory), `${proof.id}.json`);
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(proof)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}

function canonicalRun(input: Omit<RuntimeEvaluationRun, "kind" | "schemaVersion" | "id" | "hash">): Omit<RuntimeEvaluationRun, "kind" | "schemaVersion" | "id" | "hash"> {
  return {
    ...input,
    session: { ...input.session },
    ...(input.observation ? { observation: JSON.parse(stableJson(input.observation)) as RuntimeObservationEnvelope } : {}),
    ...(input.assertionResults ? { assertionResults: [...input.assertionResults].map((result) => ({ ...result })).sort((left, right) => left.id.localeCompare(right.id)) } : {}),
    ...(input.failure ? { failure: { ...input.failure } } : {}),
  };
}

function sessionSummary(session: StudioBridgeSession): RuntimeEvaluationRun["session"] { return { id: session.sessionId, projectId: session.projectId, pluginVersion: session.pluginVersion, studioVersion: session.studioVersion }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isSessionSummary(value: unknown): boolean { return isRecord(value) && isId(value.id) && isId(value.projectId) && isString(value.pluginVersion) && isString(value.studioVersion); }
function isAssertionResult(value: unknown): value is RuntimeAssertionResult { return isRecord(value) && isId(value.id) && isId(value.requirementId) && isId(value.acceptanceAssertionId) && (value.status === "pass" || value.status === "fail") && isHash(value.observedHash); }

async function waitFor<T extends PluginToBackendMessage>(messages: PluginToBackendMessage[], predicate: (message: PluginToBackendMessage) => message is T, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
