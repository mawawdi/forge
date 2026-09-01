import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { contentHash, stableJson, type BuildTrace, type TracePersistence } from "../../contracts/src/index.js";
import { JsonFileTraceSink, FlightRecorder } from "../../flight-recorder/src/index.js";
import { createRuntimeProofBundle, type RuntimeProofBundle } from "../../proofs/src/index.js";
import { createBackendMessage, type StudioBridgeConnection, type StudioBridgeSession } from "../../studio-bridge/src/index.js";
import type { PluginToBackendMessage } from "../../studio-protocol/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  assertEvidenceAgainstProjection,
  assertStudioEvidenceEnvelope,
  compileProjectStateProjection,
  projectStateFromEvidence,
  serializeStudioEvidenceProjection,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectState,
  type StudioStateRevision,
} from "../../studio-evidence/src/index.js";
import {
  assertRuntimeEvalDefinition,
  assertRuntimeEvaluatorConfiguration,
  assertStudioExecutionPlan,
  assertRuntimeEvalPlan,
  gradeRuntimeEvidence,
  serializeStudioExecutionPlan,
  type RuntimeAssertionResult,
  type RuntimeEvalDefinition,
  type RuntimeEvalPlan,
  type RuntimeEvaluatorConfiguration,
  type StudioExecutionPlan,
} from "../../studio-capabilities/src/index.js";

export interface RuntimeEvaluationRun {
  kind: "RuntimeEvaluationRun";
  id: string;
  hash: string;
  status: "runtime_verified" | "rejected" | "incomplete";
  runtimeEvalPlanId: string;
  runtimeEvalPlanHash: string;
  runtimeEvaluatorConfigurationId: string;
  runtimeEvaluatorConfigurationHash: string;
  session: { id: string; projectId: string };
  acceptedAt?: string;
  startedAt?: string;
  endedAt?: string;
  evidence?: StudioEvidenceEnvelope;
  assertionResults?: RuntimeAssertionResult[];
  failure?: { classification: RuntimeFailureClassification; detail: string };
}
export type RuntimeFailureClassification = "candidate_behavior" | "protocol" | "capability" | "studio" | "timeout" | "environment";
export interface RuntimeExecutionOutcome { run: RuntimeEvaluationRun; proof?: RuntimeProofBundle; trace: BuildTrace; tracePersistence?: TracePersistence; }
export interface RuntimeExecutionRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  runtimeEvalPlan: RuntimeEvalPlan;
  definition: RuntimeEvalDefinition;
  configuration: RuntimeEvaluatorConfiguration;
  timeoutMs: number;
  traceDirectory?: string;
  proofDirectory?: string;
  proofInput?: Omit<RuntimeProofBundle, "kind" | "id" | "hash" | "status" | "runtimeEvaluationRunId" | "runtimeEvaluationRunHash" | "assertionResults">;
}
export interface FreshStudioEvidence { projection: StudioEvidenceProjection; envelope: StudioEvidenceEnvelope; revision: StudioStateRevision; state: StudioProjectState; }
export interface StudioCapabilityCanaryRun {
  kind: "StudioCapabilityCanaryRun"; id: string; hash: string; status: "completed" | "incomplete";
  executionPlanId: string; executionPlanHash: string; session: { id: string; projectId: string };
  evidence?: StudioEvidenceEnvelope;
  failure?: { classification: Exclude<RuntimeFailureClassification, "candidate_behavior">; detail: string };
}
export interface StudioCapabilityCanaryRequest { connection: StudioBridgeConnection; session: StudioBridgeSession; executionPlan: StudioExecutionPlan; prePlayState: StudioProjectState; staticTargetIds: string[]; timeoutMs: number; }
export interface CreatorVerificationRun { kind: "CreatorVerificationRun"; status: "completed" | "incomplete"; executionPlanId: string; executionPlanHash: string; evidence?: StudioEvidenceEnvelope; failure?: { classification: Exclude<RuntimeFailureClassification, "candidate_behavior">; detail: string }; }
export interface CreatorVerificationRequest { connection: StudioBridgeConnection; session: StudioBridgeSession; executionPlan: StudioExecutionPlan; timeoutMs: number; }

/** Request one complete, projection-bound edit-mode state observation. */
export async function requestFreshStudioEvidence(connection: StudioBridgeConnection, session: StudioBridgeSession, timeoutMs: number, reason: "manual" | "pre_play" | "pre_apply" = "manual", requestedProjection?: StudioEvidenceProjection): Promise<FreshStudioEvidence> {
  const projection = requestedProjection ?? compileProjectStateProjection({
    id: `studio_project_state_${session.sessionId}`,
    project: session.project,
    binding: { sessionId: session.sessionId, projectId: session.projectId, buildHash: session.connectorBuildHash },
  });
  const messages: PluginToBackendMessage[] = [];
  const unsubscribe = connection.subscribeWithSession((message, messageSession) => {
    if (messageSession.sessionId === session.sessionId && message.sessionId === session.sessionId) messages.push(message);
  });
  try {
    const requestId = `studio_evidence_${randomUUID()}`;
    const projectionJson = serializeStudioEvidenceProjection(projection);
    await connection.send(createBackendMessage("RequestStudioEvidence", { requestId, reason, projectionJson, projectionJsonHash: contentHash(projectionJson), projectionHash: projection.contentHash }, session.sessionId, requestId));
    const terminal = await waitFor(messages, (candidate): candidate is Extract<PluginToBackendMessage, { type: "StudioEvidenceProduced" | "PluginError" }> =>
      candidate.type === "PluginError" && candidate.requestId === requestId || candidate.type === "StudioEvidenceProduced" && candidate.requestId === requestId && candidate.payload.reason === reason,
    timeoutMs, "fresh Studio evidence");
    if (terminal.type === "PluginError") throw new Error(`Studio plugin ${terminal.payload.code}: ${terminal.payload.message}`);
    if (!terminal.payload.revision) throw new Error("Studio state evidence did not include a state revision");
    assertEvidenceAgainstProjection(terminal.payload.envelope, projection);
    if (terminal.payload.envelope.completion !== "complete") throw new Error("Studio state evidence is incomplete");
    return { projection, envelope: terminal.payload.envelope, revision: terminal.payload.revision, state: projectStateFromEvidence(terminal.payload.envelope, projection) };
  } finally { unsubscribe(); }
}

export async function executeRuntimeEvaluation(request: RuntimeExecutionRequest): Promise<RuntimeExecutionOutcome> {
  assertRuntimeEvalPlan(request.runtimeEvalPlan); assertRuntimeEvalDefinition(request.definition); assertRuntimeEvaluatorConfiguration(request.configuration);
  if (!request.session.capabilities.includes("studio_play_mode") || !request.session.capabilities.includes("studio_evidence")) return completeRuntime(request, incompleteRun(request, "capability", "Connected Studio connector lacks play-mode evidence capability"));
  if (request.runtimeEvalPlan.definitionId !== request.definition.id || request.runtimeEvalPlan.definitionHash !== request.definition.hash) return completeRuntime(request, incompleteRun(request, "protocol", "RuntimeEvalPlan does not bind the supplied RuntimeEvalDefinition"));
  if (request.configuration.runtimeEvalDefinitionId !== request.definition.id || request.configuration.runtimeEvalDefinitionHash !== request.definition.hash || request.configuration.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH) return completeRuntime(request, incompleteRun(request, "protocol", "Runtime evaluator configuration binding mismatch"));
  const observed = await executePlan({ connection: request.connection, session: request.session, executionPlan: request.runtimeEvalPlan.executionPlan, timeoutMs: request.timeoutMs });
  if (observed.kind === "failure") return completeRuntime(request, incompleteRun(request, observed.classification, observed.detail));
  const assertionResults = gradeRuntimeEvidence(request.definition, observed.envelope, request.runtimeEvalPlan.executionPlan.evidenceProjection);
  const status = assertionResults.every((result) => result.status === "pass") ? "runtime_verified" : "rejected";
  return completeRuntime(request, createRuntimeEvaluationRun({ status, runtimeEvalPlanId: request.runtimeEvalPlan.id, runtimeEvalPlanHash: request.runtimeEvalPlan.hash, runtimeEvaluatorConfigurationId: request.configuration.id, runtimeEvaluatorConfigurationHash: request.configuration.hash, session: sessionSummary(request.session), acceptedAt: observed.acceptedAt, startedAt: observed.envelope.startedAt, endedAt: observed.envelope.endedAt, evidence: observed.envelope, assertionResults }));
}

export async function executeStudioCapabilityCanary(request: StudioCapabilityCanaryRequest): Promise<StudioCapabilityCanaryRun> {
  assertStudioExecutionPlan(request.executionPlan);
  if (request.executionPlan.purpose !== "capability_canary") throw new Error("Studio capability canary requires a capability_canary execution plan");
  if (request.staticTargetIds.length === 0 || new Set(request.staticTargetIds).size !== request.staticTargetIds.length) throw new Error("Studio capability canary requires distinct static target IDs");
  if (!request.session.capabilities.includes("studio_play_mode")) return createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), failure: { classification: "capability", detail: "Connected Studio connector lacks play-mode capability" } });
  const observed = await executePlan(request);
  if (observed.kind === "failure") return createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), failure: { classification: observed.classification, detail: observed.detail } });
  const integrityFailure = canaryStaticPositionIntegrityFailure(request.executionPlan, request.prePlayState, request.staticTargetIds, observed.envelope);
  return integrityFailure ? createStudioCapabilityCanaryRun({ status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), evidence: observed.envelope, failure: { classification: "capability", detail: integrityFailure } }) : createStudioCapabilityCanaryRun({ status: "completed", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, session: sessionSummary(request.session), evidence: observed.envelope });
}

export async function executeCreatorVerificationPlan(request: CreatorVerificationRequest): Promise<CreatorVerificationRun> {
  assertStudioExecutionPlan(request.executionPlan);
  if (request.executionPlan.purpose !== "creator_verification") throw new Error("Creator verification requires a creator_verification execution plan");
  if (!request.session.capabilities.includes("studio_play_mode")) return { kind: "CreatorVerificationRun", status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, failure: { classification: "capability", detail: "Connected Studio connector lacks play-mode capability" } };
  const observed = await executePlan(request);
  return observed.kind === "success" ? { kind: "CreatorVerificationRun", status: "completed", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, evidence: observed.envelope } : { kind: "CreatorVerificationRun", status: "incomplete", executionPlanId: request.executionPlan.id, executionPlanHash: request.executionPlan.hash, failure: { classification: observed.classification, detail: observed.detail } };
}

function canaryStaticPositionIntegrityFailure(plan: StudioExecutionPlan, prePlayState: StudioProjectState, staticTargetIds: string[], envelope: StudioEvidenceEnvelope): string | undefined {
  for (const targetId of staticTargetIds) {
    const target = plan.targets.find((candidate) => candidate.id === targetId);
    if (!target) return `Canary static target ${targetId} is not declared by the execution plan`;
    const prePlay = prePlayState.instances.find((instance) => instance.path === target.path);
    if (!prePlay?.position) return `Canary static target ${target.path} lacks a finite pre-play BasePart position`;
    const call = plan.calls.find((candidate) => candidate.targetId === targetId && candidate.capability === "base_part.position");
    const fact = call ? envelope.facts.find((candidate) => candidate.kind === "position" && candidate.callId === call.id) : undefined;
    if (!fact || fact.kind !== "position" || fact.result.status !== "observed") return `Canary static target ${target.path} lacks a successful runtime position observation`;
    if (prePlay.position.x !== fact.result.value.x || prePlay.position.y !== fact.result.value.y || prePlay.position.z !== fact.result.value.z) return `Canary static target ${target.path} changed between pre-play state and runtime evidence`;
  }
  return undefined;
}

type ExecutePlanResult = { kind: "success"; acceptedAt: string; envelope: StudioEvidenceEnvelope } | { kind: "failure"; classification: Exclude<RuntimeFailureClassification, "candidate_behavior">; detail: string };
class RuntimePluginFailure extends Error {
  constructor(readonly pluginError: Extract<PluginToBackendMessage, { type: "PluginError" }>) {
    super(`Studio plugin ${pluginError.payload.code}: ${pluginError.payload.message}`);
  }
}
async function executePlan(input: { connection: StudioBridgeConnection; session: StudioBridgeSession; executionPlan: StudioExecutionPlan; timeoutMs: number }): Promise<ExecutePlanResult> {
  const { connection, session, executionPlan } = input;
  const messages: PluginToBackendMessage[] = []; let duplicateEvidence = false;
  const unsubscribe = connection.subscribeWithSession((message, messageSession) => {
    if (messageSession.sessionId !== session.sessionId || message.sessionId !== session.sessionId) return;
    if (message.type === "StudioEvidenceProduced" && message.payload.reason === "runtime" && messages.some((prior) => prior.type === "StudioEvidenceProduced" && prior.payload.reason === "runtime" && prior.payload.envelope.projectionHash === message.payload.envelope.projectionHash)) duplicateEvidence = true;
    messages.push(message);
  });
  try {
    const requestId = `runtime_request_${randomUUID()}`;
    const executionPlanJson = serializeStudioExecutionPlan(executionPlan);
    const projectionJson = serializeStudioEvidenceProjection(executionPlan.evidenceProjection);
    await connection.send(createBackendMessage("ExecuteRuntimeEvalPlan", { requestId, expectedRevision: executionPlan.binding.projectStateRevisionHash, executionPlanJson, executionPlanJsonHash: contentHash(executionPlanJson), evidenceProjectionJson: projectionJson, evidenceProjectionJsonHash: contentHash(projectionJson), evidenceProjectionHash: executionPlan.evidenceProjection.contentHash, startPolicy: executionPlan.purpose === "creator_verification" ? "creator_action_already_authorized" : "explicit_plugin_action" }, session.sessionId, requestId));
    const accepted = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalPlanAccepted" }> => message.type === "RuntimeEvalPlanAccepted" && sameRuntimeMessage(message, executionPlan), input.timeoutMs, "runtime plan acceptance", requestId);
    if (accepted.payload.callCount !== executionPlan.calls.length) return { kind: "failure", classification: "protocol", detail: "Studio accepted a different runtime call count" };
    const started = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStarted" }> => message.type === "RuntimeEvalStarted" && sameRuntimeMessage(message, executionPlan) && message.payload.nonceCommitment === accepted.payload.nonceCommitment, input.timeoutMs, "runtime start", requestId);
    const expectedControl = executionPlan.purpose === "creator_verification" ? "creator_action" : "plugin_action";
    if (started.payload.control !== expectedControl || started.payload.mode !== "play_solo") return { kind: "failure", classification: "protocol", detail: "Studio runtime execution used the wrong creator-control boundary" };
    const terminal = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "StudioEvidenceProduced" }> => message.type === "StudioEvidenceProduced" && message.payload.reason === "runtime" && message.payload.envelope.projectionHash === executionPlan.evidenceProjection.contentHash, input.timeoutMs, "runtime evidence", requestId);
    const stopped = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStopped" }> => message.type === "RuntimeEvalStopped" && sameRuntimeMessage(message, executionPlan) && message.payload.nonceCommitment === accepted.payload.nonceCommitment, input.timeoutMs, "runtime stop", requestId);
    if (duplicateEvidence) return { kind: "failure", classification: "protocol", detail: "Studio emitted duplicate runtime evidence" };
    assertEvidenceAgainstProjection(terminal.payload.envelope, executionPlan.evidenceProjection);
    if (terminal.payload.envelope.completion !== "complete") return { kind: "failure", classification: "capability", detail: "Studio runtime evidence is incomplete" };
    if (accepted.payload.bindingHash !== executionPlan.evidenceProjection.bindingHash || started.payload.bindingHash !== accepted.payload.bindingHash || stopped.payload.bindingHash !== accepted.payload.bindingHash) return { kind: "failure", classification: "protocol", detail: "Studio runtime lifecycle binding mismatch" };
    if (Buffer.byteLength(stableJson(terminal.payload.envelope), "utf8") > executionPlan.budget.maxResultBytes) return { kind: "failure", classification: "capability", detail: "Studio runtime evidence exceeds plan output bound" };
    return { kind: "success", acceptedAt: accepted.sentAt, envelope: terminal.payload.envelope };
  } catch (error) {
    if (error instanceof RuntimePluginFailure) return { kind: "failure", classification: runtimePluginErrorClassification(error.pluginError.payload.code), detail: error.message };
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "failure", classification: /Timed out/i.test(detail) ? "timeout" : /Invalid Studio evidence|binding|projection/i.test(detail) ? "protocol" : "studio", detail };
  } finally { unsubscribe(); }
}

function sameRuntimeMessage(message: Extract<PluginToBackendMessage, { type: "RuntimeEvalPlanAccepted" | "RuntimeEvalStarted" | "RuntimeEvalStopped" }>, plan: StudioExecutionPlan): boolean { return message.payload.executionPlanId === plan.id && message.payload.executionPlanHash === plan.hash && message.payload.projectionId === plan.evidenceProjection.id && message.payload.projectionHash === plan.evidenceProjection.contentHash; }
function runtimePluginErrorClassification(code: Extract<PluginToBackendMessage, { type: "PluginError" }>["payload"]["code"]): Exclude<RuntimeFailureClassification, "candidate_behavior"> { if (["SECURITY_REJECTION", "STALE_EVIDENCE", "WRONG_PROJECT", "INVALID_MESSAGE", "INCOMPATIBLE_MANIFEST", "UNSUPPORTED_OPERATION"].includes(code)) return "protocol"; return code === "TRANSPORT_FAILURE" ? "environment" : "studio"; }
function incompleteRun(request: RuntimeExecutionRequest, classification: Exclude<RuntimeFailureClassification, "candidate_behavior">, detail: string): RuntimeEvaluationRun { return createRuntimeEvaluationRun({ status: "incomplete", runtimeEvalPlanId: request.runtimeEvalPlan.id, runtimeEvalPlanHash: request.runtimeEvalPlan.hash, runtimeEvaluatorConfigurationId: request.configuration.id, runtimeEvaluatorConfigurationHash: request.configuration.hash, session: sessionSummary(request.session), failure: { classification, detail } }); }

async function completeRuntime(request: RuntimeExecutionRequest, run: RuntimeEvaluationRun): Promise<RuntimeExecutionOutcome> {
  const proof = request.proofInput ? createRuntimeProofBundle({ ...request.proofInput, status: run.status, runtimeEvaluationRunId: run.id, runtimeEvaluationRunHash: run.hash, assertionResults: (run.assertionResults ?? []).map((result) => ({ id: result.id, status: result.status, evidenceHash: result.observedHash })) }) : undefined;
  const recorder = new FlightRecorder({ projectId: run.session.projectId, references: {
    ...(request.proofInput ? { agentRunId: request.proofInput.agentRunId, experimentRegistrationId: request.proofInput.experimentRegistrationId, experimentRegistrationHash: request.proofInput.experimentRegistrationHash, requirementSetId: request.proofInput.requirementSetId, requirementViewId: request.proofInput.requirementViewId, workspaceDeltaId: request.proofInput.workspaceDeltaId, harnessConfigurationId: request.proofInput.harnessConfigurationId, harnessConfigurationHash: request.proofInput.harnessConfigurationHash, workspaceCandidateArtifactId: request.proofInput.workspaceCandidateArtifactId, workspaceCandidateArtifactHash: request.proofInput.workspaceCandidateArtifactHash } : {}),
    runtimeEvalPlanId: request.runtimeEvalPlan.id, runtimeEvalPlanHash: request.runtimeEvalPlan.hash, studioManifestHash: request.configuration.manifestHash, studioEvidenceProjectionHash: request.runtimeEvalPlan.executionPlan.evidenceProjection.contentHash, runtimeEvaluatorConfigurationId: request.configuration.id, runtimeEvaluatorConfigurationHash: request.configuration.hash, runtimeEvaluationRunId: run.id, ...(proof ? { runtimeProofId: proof.id } : {}),
  }, components: { studio: { name: "forge-studio-plugin", configHash: request.configuration.manifestHash }, toolchain: [], verifiers: [] } });
  recorder.recordSpan("forge.studio.assert", run.status === "incomplete" ? "error" : "ok", { "forge.runtime.status": run.status });
  const passed = run.assertionResults?.filter((result) => result.status === "pass").length ?? 0; const total = run.assertionResults?.length ?? 0;
  const studioMs = run.evidence ? Date.parse(run.evidence.endedAt) - Date.parse(run.evidence.startedAt) : 0;
  const trace = recorder.complete({ status: run.status, localGate: "eligible", runtimeGate: run.status, assertions: { total, passed }, modelUsage: { calls: 0, inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: { total: studioMs, ...(run.evidence ? { studio: studioMs } : {}) }, issueCounts: { critical: 0, info: 0, warning: 0, error: run.status === "runtime_verified" ? 0 : 1 } }, { ...(proof ? { runtimeProofId: proof.id } : {}), issues: [] }, { level: run.status === "incomplete" ? "none" : "semantic_reproduction", reasons: [run.status === "incomplete" ? "Studio evidence was insufficient for runtime grading." : "The exact runtime definition, manifest, evidence projection, configuration, and evidence envelope are linked by hash."], randomSeeds: {} });
  const tracePersistence = request.traceDirectory ? await new JsonFileTraceSink(request.traceDirectory).persist(trace) : undefined;
  if (proof && request.proofDirectory) await persistRuntimeProof(proof, request.proofDirectory);
  return { run, ...(proof ? { proof } : {}), trace, ...(tracePersistence ? { tracePersistence } : {}) };
}

export function createRuntimeEvaluationRun(input: Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">): RuntimeEvaluationRun { const canonical = canonicalRun(input); const hash = contentHash(stableJson(canonical)); const run: RuntimeEvaluationRun = { kind: "RuntimeEvaluationRun", id: `runtime_evaluation_run_${hash.slice(0, 24)}`, hash, ...canonical }; assertRuntimeEvaluationRun(run); return run; }
export function assertRuntimeEvaluationRun(value: unknown): asserts value is RuntimeEvaluationRun {
  if (!isRecord(value) || value.kind !== "RuntimeEvaluationRun" || !isId(value.id) || !isHash(value.hash) || !["runtime_verified", "rejected", "incomplete"].includes(String(value.status)) || !isId(value.runtimeEvalPlanId) || !isHash(value.runtimeEvalPlanHash) || !isId(value.runtimeEvaluatorConfigurationId) || !isHash(value.runtimeEvaluatorConfigurationHash) || !isSessionSummary(value.session)) throw new Error("Invalid RuntimeEvaluationRun");
  if (value.evidence !== undefined) assertStudioEvidenceEnvelope(value.evidence);
  if (value.assertionResults !== undefined && (!Array.isArray(value.assertionResults) || !value.assertionResults.every(isAssertionResult))) throw new Error("Invalid RuntimeEvaluationRun assertion results");
  if (value.status === "runtime_verified" && (!value.evidence || !value.assertionResults || value.assertionResults.some((result) => result.status !== "pass"))) throw new Error("runtime_verified requires complete passing factual evidence");
  if (value.status === "rejected" && (!value.evidence || !value.assertionResults || !value.assertionResults.some((result) => result.status === "fail"))) throw new Error("rejected requires an authoritative failed assertion");
  if (value.status === "incomplete" && (!isRecord(value.failure) || !["protocol", "capability", "studio", "timeout", "environment"].includes(String(value.failure.classification)) || !isString(value.failure.detail))) throw new Error("incomplete requires a precise non-candidate failure");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value; const expected = contentHash(stableJson(canonicalRun(payload as Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">))); if (value.hash !== expected || value.id !== `runtime_evaluation_run_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeEvaluationRun identity");
}
export function createStudioCapabilityCanaryRun(input: Omit<StudioCapabilityCanaryRun, "kind" | "id" | "hash">): StudioCapabilityCanaryRun { const canonical = { ...input, session: { ...input.session } }; const hash = contentHash(stableJson(canonical)); const run: StudioCapabilityCanaryRun = { kind: "StudioCapabilityCanaryRun", id: `studio_capability_canary_${hash.slice(0, 24)}`, hash, ...canonical }; if (run.status === "completed" && !run.evidence) throw new Error("Completed Studio capability canary requires evidence"); if (run.status === "incomplete" && !run.failure) throw new Error("Incomplete Studio capability canary requires a precise failure"); return run; }
async function persistRuntimeProof(proof: RuntimeProofBundle, directory: string): Promise<void> { await mkdir(resolve(directory), { recursive: true }); const destination = join(resolve(directory), `${proof.id}.json`); const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`); await writeFile(temporary, `${stableJson(proof)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, destination); }
function canonicalRun(input: Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">): Omit<RuntimeEvaluationRun, "kind" | "id" | "hash"> { return { ...input, session: { ...input.session }, ...(input.evidence ? { evidence: JSON.parse(stableJson(input.evidence)) as StudioEvidenceEnvelope } : {}), ...(input.assertionResults ? { assertionResults: [...input.assertionResults].map((result) => ({ ...result })).sort((left, right) => left.id.localeCompare(right.id)) } : {}), ...(input.failure ? { failure: { ...input.failure } } : {}) }; }
function sessionSummary(session: StudioBridgeSession): RuntimeEvaluationRun["session"] { return { id: session.sessionId, projectId: session.projectId }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isSessionSummary(value: unknown): boolean { return isRecord(value) && isId(value.id) && isId(value.projectId); }
function isAssertionResult(value: unknown): value is RuntimeAssertionResult { return isRecord(value) && isId(value.id) && isId(value.requirementId) && isId(value.acceptanceAssertionId) && (value.status === "pass" || value.status === "fail") && isHash(value.observedHash); }
async function waitFor<T extends PluginToBackendMessage>(messages: PluginToBackendMessage[], predicate: (message: PluginToBackendMessage) => message is T, timeoutMs: number, label: string, pluginErrorRequestId?: string): Promise<T> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const found = messages.find(predicate); if (found) return found; if (pluginErrorRequestId) { const pluginError = messages.find((message): message is Extract<PluginToBackendMessage, { type: "PluginError" }> => message.type === "PluginError" && message.requestId === pluginErrorRequestId); if (pluginError) throw new RuntimePluginFailure(pluginError); } await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } throw new Error(`Timed out waiting for ${label}`); }
