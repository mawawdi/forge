import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  contentHash,
  stableJson,
  type BuildTrace,
  type TracePersistence,
} from "../../contracts/src/index.js";
import { JsonFileTraceSink, FlightRecorder } from "../../flight-recorder/src/index.js";
import { createRuntimeProofBundle, type RuntimeProofBundle } from "../../proofs/src/index.js";
import {
  createBackendMessage,
  type StudioBridgeConnection,
  type StudioBridgeSession,
} from "../../studio-bridge/src/index.js";
import type { PluginToBackendMessage } from "../../studio-protocol/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  assertEvidenceAgainstProjection,
  assertStudioProjectIndexCapture,
  assertStudioProjectRevision,
  createStudioProjectIndexProjection,
  CREATOR_DEFAULT_RESOURCE_POLICY,
  assertStudioEvidenceEnvelope,
  serializeStudioEvidenceProjection,
  studioProjectIndexView,
  type StudioEvidenceEnvelope,
  type StudioProjectIndexCapture,
  type StudioProjectIndexProjection,
  type StudioProjectEvidenceShard,
  type StudioSourceBlobManifest,
  type StudioSourceBlobChunk,
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
export type RuntimeFailureClassification =
  "candidate_behavior" | "protocol" | "capability" | "studio" | "timeout" | "environment";
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
  proofInput?: Omit<
    RuntimeProofBundle,
    | "kind"
    | "id"
    | "hash"
    | "status"
    | "runtimeEvaluationRunId"
    | "runtimeEvaluationRunHash"
    | "assertionResults"
  >;
}
export interface StudioProjectIndexRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  connectorEpoch: string;
  timeoutMs: number;
}

/**
 * Request the universal read-only project index. Unlike a mutation snapshot,
 * this covers unknown classes and carries script bodies as separately hashed
 * SourceBlob chunks. It cannot grant write authority by itself.
 */
export async function requestStudioProjectIndex(
  request: StudioProjectIndexRequest,
): Promise<StudioProjectIndexCapture> {
  if (
    !request.session.capabilities.includes("studio_project_index") ||
    !request.session.capabilities.includes("opaque_identity")
  )
    throw new Error("Connected Studio connector lacks complete project-index capability");
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project: request.session.project,
    connectorEpoch: request.connectorEpoch,
    purpose: "creator_project_index",
    roots: [
      "Lighting",
      "ReplicatedFirst",
      "ReplicatedStorage",
      "ServerScriptService",
      "ServerStorage",
      "SoundService",
      "StarterGui",
      "StarterPack",
      "StarterPlayer",
      "Teams",
      "Workspace",
    ],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const requestId = `studio_project_index_${randomUUID()}`;
  const receiver = new StudioProjectIndexStreamReceiver(requestId, projection);
  const unsubscribe = request.connection.subscribeWithSession((message, session) => {
    if (
      session.sessionId === request.session.sessionId &&
      message.sessionId === request.session.sessionId
    )
      receiver.observe(message);
  });
  try {
    await request.connection.send(
      createBackendMessage(
        "CollectStudioProjectIndex",
        { requestId, resourcePolicy: CREATOR_DEFAULT_RESOURCE_POLICY, projection },
        request.session.sessionId,
        requestId,
      ),
    );
    return await receiver.wait(request.timeoutMs, "Studio project index");
  } finally {
    unsubscribe();
  }
}

function assertProjectIndexCaptureForRequest(
  capture: unknown,
  projection: StudioProjectIndexProjection,
): StudioProjectIndexCapture {
  assertStudioProjectIndexCapture(capture);
  assertStudioProjectRevision(capture.revision);
  if (capture.projection.hash !== projection.hash)
    throw new Error("Studio project index projection binding mismatch");
  return capture;
}
export interface StudioCapabilityCanaryRun {
  kind: "StudioCapabilityCanaryRun";
  id: string;
  hash: string;
  status: "completed" | "incomplete";
  executionPlanId: string;
  executionPlanHash: string;
  session: { id: string; projectId: string };
  evidence?: StudioEvidenceEnvelope;
  failure?: {
    classification: Exclude<RuntimeFailureClassification, "candidate_behavior">;
    detail: string;
  };
}
/**
 * Capability canaries compare their direct runtime observations against a
 * complete, content-addressed project index. A partial snapshot is never an
 * acceptable pre-Play baseline.
 */
export interface StudioCapabilityCanaryRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  executionPlan: StudioExecutionPlan;
  prePlayCapture: StudioProjectIndexCapture;
  staticTargetIds: string[];
  timeoutMs: number;
}
export interface CreatorVerificationRun {
  kind: "CreatorVerificationRun";
  status: "completed" | "incomplete";
  executionPlanId: string;
  executionPlanHash: string;
  evidence?: StudioEvidenceEnvelope;
  failure?: {
    classification: Exclude<RuntimeFailureClassification, "candidate_behavior">;
    detail: string;
  };
}
/**
 * This is a presentation-only signal. It is delivered only after the
 * request-bound lifecycle message has passed the same validation as the
 * evidence path, so a stale plugin message cannot make the dashboard claim
 * that the current creator Play session is being observed.
 */
export type CreatorVerificationLifecycleEvent = "started" | "stopped";
export interface CreatorVerificationRequest {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  executionPlan: StudioExecutionPlan;
  timeoutMs: number;
  onLifecycle?: (event: CreatorVerificationLifecycleEvent) => void | Promise<void>;
}

export async function executeRuntimeEvaluation(
  request: RuntimeExecutionRequest,
): Promise<RuntimeExecutionOutcome> {
  assertRuntimeEvalPlan(request.runtimeEvalPlan);
  assertRuntimeEvalDefinition(request.definition);
  assertRuntimeEvaluatorConfiguration(request.configuration);
  if (
    !request.session.capabilities.includes("studio_play_mode") ||
    !request.session.capabilities.includes("studio_evidence")
  )
    return completeRuntime(
      request,
      incompleteRun(
        request,
        "capability",
        "Connected Studio connector lacks play-mode evidence capability",
      ),
    );
  if (
    request.runtimeEvalPlan.definitionId !== request.definition.id ||
    request.runtimeEvalPlan.definitionHash !== request.definition.hash
  )
    return completeRuntime(
      request,
      incompleteRun(
        request,
        "protocol",
        "RuntimeEvalPlan does not bind the supplied RuntimeEvalDefinition",
      ),
    );
  if (
    request.configuration.runtimeEvalDefinitionId !== request.definition.id ||
    request.configuration.runtimeEvalDefinitionHash !== request.definition.hash ||
    request.configuration.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH
  )
    return completeRuntime(
      request,
      incompleteRun(request, "protocol", "Runtime evaluator configuration binding mismatch"),
    );
  const observed = await executePlan({
    connection: request.connection,
    session: request.session,
    executionPlan: request.runtimeEvalPlan.executionPlan,
    timeoutMs: request.timeoutMs,
  });
  if (observed.kind === "failure")
    return completeRuntime(
      request,
      incompleteRun(request, observed.classification, observed.detail),
    );
  const assertionResults = gradeRuntimeEvidence(
    request.definition,
    observed.envelope,
    request.runtimeEvalPlan.executionPlan.evidenceProjection,
  );
  const status = assertionResults.every((result) => result.status === "pass")
    ? "runtime_verified"
    : "rejected";
  return completeRuntime(
    request,
    createRuntimeEvaluationRun({
      status,
      runtimeEvalPlanId: request.runtimeEvalPlan.id,
      runtimeEvalPlanHash: request.runtimeEvalPlan.hash,
      runtimeEvaluatorConfigurationId: request.configuration.id,
      runtimeEvaluatorConfigurationHash: request.configuration.hash,
      session: sessionSummary(request.session),
      acceptedAt: observed.acceptedAt,
      startedAt: observed.envelope.startedAt,
      endedAt: observed.envelope.endedAt,
      evidence: observed.envelope,
      assertionResults,
    }),
  );
}

export async function executeStudioCapabilityCanary(
  request: StudioCapabilityCanaryRequest,
): Promise<StudioCapabilityCanaryRun> {
  assertStudioExecutionPlan(request.executionPlan);
  assertStudioProjectIndexCapture(request.prePlayCapture);
  assertStudioProjectRevision(request.prePlayCapture.revision);
  if (request.executionPlan.purpose !== "capability_canary")
    throw new Error("Studio capability canary requires a capability_canary execution plan");
  if (
    request.staticTargetIds.length === 0 ||
    new Set(request.staticTargetIds).size !== request.staticTargetIds.length
  )
    throw new Error("Studio capability canary requires distinct static target IDs");
  if (request.prePlayCapture.revision.hash !== request.executionPlan.binding.projectRevisionHash)
    return createStudioCapabilityCanaryRun({
      status: "incomplete",
      executionPlanId: request.executionPlan.id,
      executionPlanHash: request.executionPlan.hash,
      session: sessionSummary(request.session),
      failure: {
        classification: "protocol",
        detail:
          "Studio capability canary pre-Play project revision does not bind the execution plan",
      },
    });
  if (
    stableJson(request.prePlayCapture.revision.project) !==
    stableJson(request.executionPlan.binding.project)
  )
    return createStudioCapabilityCanaryRun({
      status: "incomplete",
      executionPlanId: request.executionPlan.id,
      executionPlanHash: request.executionPlan.hash,
      session: sessionSummary(request.session),
      failure: {
        classification: "protocol",
        detail: "Studio capability canary pre-Play project does not bind the execution plan",
      },
    });
  if (!request.session.capabilities.includes("studio_play_mode"))
    return createStudioCapabilityCanaryRun({
      status: "incomplete",
      executionPlanId: request.executionPlan.id,
      executionPlanHash: request.executionPlan.hash,
      session: sessionSummary(request.session),
      failure: {
        classification: "capability",
        detail: "Connected Studio connector lacks play-mode capability",
      },
    });
  const observed = await executePlan(request);
  if (observed.kind === "failure")
    return createStudioCapabilityCanaryRun({
      status: "incomplete",
      executionPlanId: request.executionPlan.id,
      executionPlanHash: request.executionPlan.hash,
      session: sessionSummary(request.session),
      failure: { classification: observed.classification, detail: observed.detail },
    });
  const integrityFailure = canaryStaticPositionIntegrityFailure(
    request.executionPlan,
    request.prePlayCapture,
    request.staticTargetIds,
    observed.envelope,
  );
  return integrityFailure
    ? createStudioCapabilityCanaryRun({
        status: "incomplete",
        executionPlanId: request.executionPlan.id,
        executionPlanHash: request.executionPlan.hash,
        session: sessionSummary(request.session),
        evidence: observed.envelope,
        failure: { classification: "capability", detail: integrityFailure },
      })
    : createStudioCapabilityCanaryRun({
        status: "completed",
        executionPlanId: request.executionPlan.id,
        executionPlanHash: request.executionPlan.hash,
        session: sessionSummary(request.session),
        evidence: observed.envelope,
      });
}

export async function executeCreatorVerificationPlan(
  request: CreatorVerificationRequest,
): Promise<CreatorVerificationRun> {
  assertStudioExecutionPlan(request.executionPlan);
  if (request.executionPlan.purpose !== "creator_verification")
    throw new Error("Creator verification requires a creator_verification execution plan");
  if (!request.session.capabilities.includes("studio_play_mode"))
    return {
      kind: "CreatorVerificationRun",
      status: "incomplete",
      executionPlanId: request.executionPlan.id,
      executionPlanHash: request.executionPlan.hash,
      failure: {
        classification: "capability",
        detail: "Connected Studio connector lacks play-mode capability",
      },
    };
  const observed = await executePlan(request);
  return observed.kind === "success"
    ? {
        kind: "CreatorVerificationRun",
        status: "completed",
        executionPlanId: request.executionPlan.id,
        executionPlanHash: request.executionPlan.hash,
        evidence: observed.envelope,
      }
    : {
        kind: "CreatorVerificationRun",
        status: "incomplete",
        executionPlanId: request.executionPlan.id,
        executionPlanHash: request.executionPlan.hash,
        ...(observed.envelope ? { evidence: observed.envelope } : {}),
        failure: { classification: observed.classification, detail: observed.detail },
      };
}

function canaryStaticPositionIntegrityFailure(
  plan: StudioExecutionPlan,
  prePlayCapture: StudioProjectIndexCapture,
  staticTargetIds: string[],
  envelope: StudioEvidenceEnvelope,
): string | undefined {
  const prePlay = studioProjectIndexView(prePlayCapture);
  for (const targetId of staticTargetIds) {
    const target = plan.targets.find((candidate) => candidate.id === targetId);
    if (!target) return `Canary static target ${targetId} is not declared by the execution plan`;
    const prePlayTarget = prePlay.instances.find((instance) => instance.path === target.path);
    if (!prePlayTarget?.position)
      return `Canary static target ${target.path} lacks a finite pre-play BasePart position in the project index`;
    const call = plan.calls.find(
      (candidate) =>
        candidate.targetId === targetId && candidate.capability === "base_part.position",
    );
    const fact = call
      ? envelope.facts.find(
          (candidate) => candidate.kind === "position" && candidate.callId === call.id,
        )
      : undefined;
    if (!fact || fact.kind !== "position" || fact.result.status !== "observed")
      return `Canary static target ${target.path} lacks a successful runtime position observation`;
    if (
      prePlayTarget.position.x !== fact.result.value.x ||
      prePlayTarget.position.y !== fact.result.value.y ||
      prePlayTarget.position.z !== fact.result.value.z
    )
      return `Canary static target ${target.path} changed between pre-play project index and runtime evidence`;
  }
  return undefined;
}

type ExecutePlanResult =
  | { kind: "success"; acceptedAt: string; envelope: StudioEvidenceEnvelope }
  | {
      kind: "failure";
      classification: Exclude<RuntimeFailureClassification, "candidate_behavior">;
      detail: string;
      envelope?: StudioEvidenceEnvelope;
    };
class RuntimePluginFailure extends Error {
  constructor(readonly pluginError: Extract<PluginToBackendMessage, { type: "PluginError" }>) {
    super(`Studio plugin ${pluginError.payload.code}: ${pluginError.payload.message}`);
  }
}
async function executePlan(input: {
  connection: StudioBridgeConnection;
  session: StudioBridgeSession;
  executionPlan: StudioExecutionPlan;
  timeoutMs: number;
  onLifecycle?: (event: CreatorVerificationLifecycleEvent) => void | Promise<void>;
}): Promise<ExecutePlanResult> {
  const { connection, session, executionPlan } = input;
  const creatorControlled = executionPlan.purpose === "creator_verification";
  const messages: PluginToBackendMessage[] = [];
  let duplicateEvidence = false;
  // Keep only an envelope that has passed the exact projection check. If the
  // subsequent durable-clear acknowledgement is lost, the caller can still
  // persist what Studio actually sealed while treating observer state as
  // recovery-required. Evidence retention and transaction cleanup are
  // separate facts.
  let validatedEnvelope: StudioEvidenceEnvelope | undefined;
  // Generate before subscribing so that every message retained by this run is
  // either the exact command response or an UnpairProject terminal signal.
  // A re-arm intentionally uses the same sealed plan, so plan hashes alone
  // are not sufficient to distinguish a late prior execution from this one.
  const requestId = `runtime_request_${randomUUID()}`;
  const unsubscribe = connection.subscribeWithSession((message, messageSession) => {
    if (messageSession.sessionId !== session.sessionId || message.sessionId !== session.sessionId)
      return;
    if (message.type !== "UnpairProject" && message.requestId !== requestId) return;
    if (
      message.type === "StudioEvidenceProduced" &&
      message.payload.reason === "runtime" &&
      messages.some(
        (prior) =>
          prior.type === "StudioEvidenceProduced" &&
          prior.requestId === requestId &&
          prior.payload.reason === "runtime" &&
          prior.payload.envelope.projectionHash === message.payload.envelope.projectionHash,
      )
    )
      duplicateEvidence = true;
    messages.push(message);
  });
  try {
    const executionPlanJson = serializeStudioExecutionPlan(executionPlan);
    const projectionJson = serializeStudioEvidenceProjection(executionPlan.evidenceProjection);
    await connection.send(
      createBackendMessage(
        "ExecuteRuntimeEvalPlan",
        {
          requestId,
          expectedProjectRevisionHash: executionPlan.binding.projectRevisionHash,
          executionPlanJson,
          executionPlanJsonHash: contentHash(executionPlanJson),
          evidenceProjectionJson: projectionJson,
          evidenceProjectionJsonHash: contentHash(projectionJson),
          evidenceProjectionHash: executionPlan.evidenceProjection.contentHash,
          startPolicy:
            executionPlan.purpose === "creator_verification"
              ? "observe_next_creator_play"
              : "explicit_plugin_action",
        },
        session.sessionId,
        requestId,
      ),
    );
    const accepted = await waitFor(
      messages,
      (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalPlanAccepted" }> =>
        message.type === "RuntimeEvalPlanAccepted" &&
        message.requestId === requestId &&
        sameRuntimeMessage(message, executionPlan),
      input.timeoutMs,
      "runtime plan acceptance",
      requestId,
    );
    if (accepted.payload.callCount !== executionPlan.calls.length)
      return {
        kind: "failure",
        classification: "protocol",
        detail: "Studio accepted a different runtime call count",
      };
    // Plan acceptance is a connector round trip; creator Play is human
    // authority and has no transport timeout. Disconnect/unpair and exact
    // plugin errors still terminate the wait. Once Play begins, the sealed
    // execution budget becomes the machine deadline.
    const started = await waitFor(
      messages,
      (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStarted" }> =>
        message.type === "RuntimeEvalStarted" &&
        message.requestId === requestId &&
        sameRuntimeMessage(message, executionPlan) &&
        message.payload.nonceCommitment === accepted.payload.nonceCommitment,
      creatorControlled ? undefined : input.timeoutMs,
      "runtime start",
      requestId,
    );
    const expectedControl =
      executionPlan.purpose === "creator_verification" ? "creator_action" : "plugin_action";
    if (started.payload.control !== expectedControl || started.payload.mode !== "play_solo")
      return {
        kind: "failure",
        classification: "protocol",
        detail: "Studio runtime execution used the wrong creator-control boundary",
      };
    notifyLifecycle(input, "started");
    const executionTimeoutMs = creatorControlled
      ? executionPlan.budget.maxExecutionMs + 15_000
      : input.timeoutMs;
    // Evidence and Stop form one bounded post-start operation. Do not give the
    // second half a fresh full timeout, which would silently extend a sealed
    // execution budget by up to another complete window.
    const executionDeadline = Date.now() + executionTimeoutMs;
    const terminal = await waitFor(
      messages,
      (message): message is Extract<PluginToBackendMessage, { type: "StudioEvidenceProduced" }> =>
        message.type === "StudioEvidenceProduced" &&
        message.requestId === requestId &&
        message.payload.reason === "runtime" &&
        message.payload.envelope.projectionHash === executionPlan.evidenceProjection.contentHash,
      remainingTimeout(executionDeadline),
      "runtime evidence",
      requestId,
    );
    const stopped = await waitFor(
      messages,
      (message): message is Extract<PluginToBackendMessage, { type: "RuntimeEvalStopped" }> =>
        message.type === "RuntimeEvalStopped" &&
        message.requestId === requestId &&
        sameRuntimeMessage(message, executionPlan) &&
        message.payload.nonceCommitment === accepted.payload.nonceCommitment,
      remainingTimeout(executionDeadline),
      "runtime stop",
      requestId,
    );
    if (stopped.payload.control !== expectedControl || stopped.payload.mode !== "play_solo")
      return {
        kind: "failure",
        classification: "protocol",
        detail: "Studio runtime stop used the wrong creator-control boundary",
      };
    if (
      accepted.payload.bindingHash !== executionPlan.evidenceProjection.bindingHash ||
      started.payload.bindingHash !== accepted.payload.bindingHash ||
      stopped.payload.bindingHash !== accepted.payload.bindingHash
    )
      return {
        kind: "failure",
        classification: "protocol",
        detail: "Studio runtime lifecycle binding mismatch",
      };
    assertEvidenceAgainstProjection(terminal.payload.envelope, executionPlan.evidenceProjection);
    validatedEnvelope = terminal.payload.envelope;
    if (creatorControlled) {
      const identity = {
        requestId,
        executionPlanId: executionPlan.id,
        executionPlanHash: executionPlan.hash,
        projectionId: executionPlan.evidenceProjection.id,
        projectionHash: executionPlan.evidenceProjection.contentHash,
        bindingHash: executionPlan.evidenceProjection.bindingHash,
        nonceCommitment: accepted.payload.nonceCommitment,
      };
      await connection.send(
        createBackendMessage("FinalizePassiveRuntimeEval", identity, session.sessionId, requestId),
      );
      const finalized = await waitFor(
        messages,
        (
          message,
        ): message is Extract<PluginToBackendMessage, { type: "PassiveRuntimeEvalFinalized" }> =>
          message.type === "PassiveRuntimeEvalFinalized" &&
          message.requestId === requestId &&
          sameRuntimeMessage(message, executionPlan) &&
          message.payload.nonceCommitment === accepted.payload.nonceCommitment,
        input.timeoutMs,
        "passive runtime finalization",
        requestId,
      );
      if (
        finalized.payload.status !== "cleared" ||
        finalized.payload.bindingHash !== accepted.payload.bindingHash
      )
        return {
          kind: "failure",
          classification: "protocol",
          detail: "Studio did not clear the exact passive runtime arm",
          envelope: validatedEnvelope,
        };
    }
    notifyLifecycle(input, "stopped");
    if (duplicateEvidence)
      return {
        kind: "failure",
        classification: "protocol",
        detail: "Studio emitted duplicate runtime evidence",
        envelope: validatedEnvelope,
      };
    if (validatedEnvelope.completion !== "complete")
      return {
        kind: "failure",
        classification: "capability",
        detail: "Studio runtime evidence is incomplete",
        envelope: validatedEnvelope,
      };
    if (
      Buffer.byteLength(stableJson(validatedEnvelope), "utf8") > executionPlan.budget.maxResultBytes
    )
      return {
        kind: "failure",
        classification: "capability",
        detail: "Studio runtime evidence exceeds plan output bound",
        envelope: validatedEnvelope,
      };
    return { kind: "success", acceptedAt: accepted.sentAt, envelope: validatedEnvelope };
  } catch (error) {
    if (error instanceof RuntimePluginFailure)
      return {
        kind: "failure",
        classification: runtimePluginErrorClassification(error.pluginError.payload.code),
        detail: error.message,
        ...(validatedEnvelope ? { envelope: validatedEnvelope } : {}),
      };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "failure",
      classification: /Timed out/i.test(detail)
        ? "timeout"
        : /Invalid Studio evidence|binding|projection/i.test(detail)
          ? "protocol"
          : "studio",
      detail,
      ...(validatedEnvelope ? { envelope: validatedEnvelope } : {}),
    };
  } finally {
    unsubscribe();
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function notifyLifecycle(
  input: { onLifecycle?: (event: CreatorVerificationLifecycleEvent) => void | Promise<void> },
  event: CreatorVerificationLifecycleEvent,
): void {
  // Dashboard rendering is not evidence production. A failed render or a
  // disconnected browser cannot change the Studio verdict or keep the
  // request alive. The coordinator still clears its ephemeral phase after
  // executePlan returns.
  if (!input.onLifecycle) return;
  void Promise.resolve(input.onLifecycle(event)).catch(() => undefined);
}

function sameRuntimeMessage(
  message: Extract<
    PluginToBackendMessage,
    {
      type:
        | "RuntimeEvalPlanAccepted"
        | "RuntimeEvalStarted"
        | "RuntimeEvalStopped"
        | "PassiveRuntimeEvalFinalized";
    }
  >,
  plan: StudioExecutionPlan,
): boolean {
  return (
    message.payload.executionPlanId === plan.id &&
    message.payload.executionPlanHash === plan.hash &&
    message.payload.projectionId === plan.evidenceProjection.id &&
    message.payload.projectionHash === plan.evidenceProjection.contentHash
  );
}
function runtimePluginErrorClassification(
  code: Extract<PluginToBackendMessage, { type: "PluginError" }>["payload"]["code"],
): Exclude<RuntimeFailureClassification, "candidate_behavior"> {
  if (
    [
      "SECURITY_REJECTION",
      "STALE_EVIDENCE",
      "WRONG_PROJECT",
      "INVALID_MESSAGE",
      "INCOMPATIBLE_MANIFEST",
      "UNSUPPORTED_OPERATION",
    ].includes(code)
  )
    return "protocol";
  return code === "TRANSPORT_FAILURE" ? "environment" : "studio";
}
function incompleteRun(
  request: RuntimeExecutionRequest,
  classification: Exclude<RuntimeFailureClassification, "candidate_behavior">,
  detail: string,
): RuntimeEvaluationRun {
  return createRuntimeEvaluationRun({
    status: "incomplete",
    runtimeEvalPlanId: request.runtimeEvalPlan.id,
    runtimeEvalPlanHash: request.runtimeEvalPlan.hash,
    runtimeEvaluatorConfigurationId: request.configuration.id,
    runtimeEvaluatorConfigurationHash: request.configuration.hash,
    session: sessionSummary(request.session),
    failure: { classification, detail },
  });
}

async function completeRuntime(
  request: RuntimeExecutionRequest,
  run: RuntimeEvaluationRun,
): Promise<RuntimeExecutionOutcome> {
  const proof = request.proofInput
    ? createRuntimeProofBundle({
        ...request.proofInput,
        status: run.status,
        runtimeEvaluationRunId: run.id,
        runtimeEvaluationRunHash: run.hash,
        assertionResults: (run.assertionResults ?? []).map((result) => ({
          id: result.id,
          status: result.status,
          evidenceHash: result.observedHash,
        })),
      })
    : undefined;
  const recorder = new FlightRecorder({
    projectId: run.session.projectId,
    references: {
      ...(request.proofInput
        ? {
            agentRunId: request.proofInput.agentRunId,
            experimentRegistrationId: request.proofInput.experimentRegistrationId,
            experimentRegistrationHash: request.proofInput.experimentRegistrationHash,
            requirementSetId: request.proofInput.requirementSetId,
            requirementViewId: request.proofInput.requirementViewId,
            workspaceDeltaId: request.proofInput.workspaceDeltaId,
            harnessConfigurationId: request.proofInput.harnessConfigurationId,
            harnessConfigurationHash: request.proofInput.harnessConfigurationHash,
            workspaceCandidateArtifactId: request.proofInput.workspaceCandidateArtifactId,
            workspaceCandidateArtifactHash: request.proofInput.workspaceCandidateArtifactHash,
          }
        : {}),
      runtimeEvalPlanId: request.runtimeEvalPlan.id,
      runtimeEvalPlanHash: request.runtimeEvalPlan.hash,
      studioManifestHash: request.configuration.manifestHash,
      studioEvidenceProjectionHash:
        request.runtimeEvalPlan.executionPlan.evidenceProjection.contentHash,
      runtimeEvaluatorConfigurationId: request.configuration.id,
      runtimeEvaluatorConfigurationHash: request.configuration.hash,
      runtimeEvaluationRunId: run.id,
      ...(proof ? { runtimeProofId: proof.id } : {}),
    },
    components: {
      studio: { name: "forge-studio-plugin", configHash: request.configuration.manifestHash },
      toolchain: [],
      verifiers: [],
    },
  });
  recorder.recordSpan("forge.studio.assert", run.status === "incomplete" ? "error" : "ok", {
    "forge.runtime.status": run.status,
  });
  const passed = run.assertionResults?.filter((result) => result.status === "pass").length ?? 0;
  const total = run.assertionResults?.length ?? 0;
  const studioMs = run.evidence
    ? Date.parse(run.evidence.endedAt) - Date.parse(run.evidence.startedAt)
    : 0;
  const trace = recorder.complete(
    {
      status: run.status,
      localGate: "eligible",
      runtimeGate: run.status,
      assertions: { total, passed },
      modelUsage: { calls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      latencyMs: { total: studioMs, ...(run.evidence ? { studio: studioMs } : {}) },
      issueCounts: {
        critical: 0,
        info: 0,
        warning: 0,
        error: run.status === "runtime_verified" ? 0 : 1,
      },
    },
    { ...(proof ? { runtimeProofId: proof.id } : {}), issues: [] },
    {
      level: run.status === "incomplete" ? "none" : "semantic_reproduction",
      reasons: [
        run.status === "incomplete"
          ? "Studio evidence was insufficient for runtime grading."
          : "The exact runtime definition, manifest, evidence projection, configuration, and evidence envelope are linked by hash.",
      ],
      randomSeeds: {},
    },
  );
  const tracePersistence = request.traceDirectory
    ? await new JsonFileTraceSink(request.traceDirectory).persist(trace)
    : undefined;
  if (proof && request.proofDirectory) await persistRuntimeProof(proof, request.proofDirectory);
  return {
    run,
    ...(proof ? { proof } : {}),
    trace,
    ...(tracePersistence ? { tracePersistence } : {}),
  };
}

export function createRuntimeEvaluationRun(
  input: Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">,
): RuntimeEvaluationRun {
  const canonical = canonicalRun(input);
  const hash = contentHash(stableJson(canonical));
  const run: RuntimeEvaluationRun = {
    kind: "RuntimeEvaluationRun",
    id: `runtime_evaluation_run_${hash.slice(0, 24)}`,
    hash,
    ...canonical,
  };
  assertRuntimeEvaluationRun(run);
  return run;
}
export function assertRuntimeEvaluationRun(value: unknown): asserts value is RuntimeEvaluationRun {
  if (
    !isRecord(value) ||
    value.kind !== "RuntimeEvaluationRun" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !["runtime_verified", "rejected", "incomplete"].includes(String(value.status)) ||
    !isId(value.runtimeEvalPlanId) ||
    !isHash(value.runtimeEvalPlanHash) ||
    !isId(value.runtimeEvaluatorConfigurationId) ||
    !isHash(value.runtimeEvaluatorConfigurationHash) ||
    !isSessionSummary(value.session)
  )
    throw new Error("Invalid RuntimeEvaluationRun");
  if (value.evidence !== undefined) assertStudioEvidenceEnvelope(value.evidence);
  if (
    value.assertionResults !== undefined &&
    (!Array.isArray(value.assertionResults) || !value.assertionResults.every(isAssertionResult))
  )
    throw new Error("Invalid RuntimeEvaluationRun assertion results");
  const assertionResults = value.assertionResults as RuntimeAssertionResult[] | undefined;
  if (
    value.status === "runtime_verified" &&
    (!value.evidence ||
      !assertionResults ||
      assertionResults.some((result) => result.status !== "pass"))
  )
    throw new Error("runtime_verified requires complete passing factual evidence");
  if (
    value.status === "rejected" &&
    (!value.evidence ||
      !assertionResults ||
      !assertionResults.some((result) => result.status === "fail"))
  )
    throw new Error("rejected requires an authoritative failed assertion");
  if (
    value.status === "incomplete" &&
    (!isRecord(value.failure) ||
      !["protocol", "capability", "studio", "timeout", "environment"].includes(
        String(value.failure.classification),
      ) ||
      !isString(value.failure.detail))
  )
    throw new Error("incomplete requires a precise non-candidate failure");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(
    stableJson(canonicalRun(payload as Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">)),
  );
  if (value.hash !== expected || value.id !== `runtime_evaluation_run_${expected.slice(0, 24)}`)
    throw new Error("Invalid RuntimeEvaluationRun identity");
}
export function createStudioCapabilityCanaryRun(
  input: Omit<StudioCapabilityCanaryRun, "kind" | "id" | "hash">,
): StudioCapabilityCanaryRun {
  const canonical = { ...input, session: { ...input.session } };
  const hash = contentHash(stableJson(canonical));
  const run: StudioCapabilityCanaryRun = {
    kind: "StudioCapabilityCanaryRun",
    id: `studio_capability_canary_${hash.slice(0, 24)}`,
    hash,
    ...canonical,
  };
  if (run.status === "completed" && !run.evidence)
    throw new Error("Completed Studio capability canary requires evidence");
  if (run.status === "incomplete" && !run.failure)
    throw new Error("Incomplete Studio capability canary requires a precise failure");
  return run;
}
async function persistRuntimeProof(proof: RuntimeProofBundle, directory: string): Promise<void> {
  await mkdir(resolve(directory), { recursive: true });
  const destination = join(resolve(directory), `${proof.id}.json`);
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(proof)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}
function canonicalRun(
  input: Omit<RuntimeEvaluationRun, "kind" | "id" | "hash">,
): Omit<RuntimeEvaluationRun, "kind" | "id" | "hash"> {
  return {
    ...input,
    session: { ...input.session },
    ...(input.evidence
      ? { evidence: JSON.parse(stableJson(input.evidence)) as StudioEvidenceEnvelope }
      : {}),
    ...(input.assertionResults
      ? {
          assertionResults: [...input.assertionResults]
            .map((result) => ({ ...result }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
    ...(input.failure ? { failure: { ...input.failure } } : {}),
  };
}
function sessionSummary(session: StudioBridgeSession): RuntimeEvaluationRun["session"] {
  return { id: session.sessionId, projectId: session.projectId };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isId(value: unknown): value is string {
  return isString(value) && value.length > 0 && !/\s/.test(value);
}
function isHash(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{64}$/.test(value);
}
function isSessionSummary(value: unknown): boolean {
  return isRecord(value) && isId(value.id) && isId(value.projectId);
}
function isAssertionResult(value: unknown): value is RuntimeAssertionResult {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.requirementId) &&
    isId(value.acceptanceAssertionId) &&
    (value.status === "pass" || value.status === "fail") &&
    isHash(value.observedHash)
  );
}
async function waitFor<T extends PluginToBackendMessage>(
  messages: PluginToBackendMessage[],
  predicate: (message: PluginToBackendMessage) => message is T,
  timeoutMs: number | undefined,
  label: string,
  pluginErrorRequestId?: string,
): Promise<T> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (deadline === undefined || Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    const unpaired = messages.find((message) => message.type === "UnpairProject");
    if (unpaired) throw new Error(`Studio disconnected while waiting for ${label}`);
    if (pluginErrorRequestId) {
      const pluginError = messages.find(
        (message): message is Extract<PluginToBackendMessage, { type: "PluginError" }> =>
          message.type === "PluginError" && message.requestId === pluginErrorRequestId,
      );
      if (pluginError) throw new RuntimePluginFailure(pluginError);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type StudioProjectIndexStreamMessage =
  | Extract<PluginToBackendMessage, { type: "StudioProjectIndexStarted" }>
  | Extract<PluginToBackendMessage, { type: "StudioProjectEvidenceShard" }>
  | Extract<PluginToBackendMessage, { type: "StudioSourceBlobManifest" }>
  | Extract<PluginToBackendMessage, { type: "StudioSourceBlobChunk" }>
  | Extract<PluginToBackendMessage, { type: "StudioProjectIndexCompleted" }>;

export function isStudioProjectIndexStreamMessage(
  message: PluginToBackendMessage,
): message is StudioProjectIndexStreamMessage {
  return (
    message.type === "StudioProjectIndexStarted" ||
    message.type === "StudioProjectEvidenceShard" ||
    message.type === "StudioSourceBlobManifest" ||
    message.type === "StudioSourceBlobChunk" ||
    message.type === "StudioProjectIndexCompleted"
  );
}

type StudioProjectIndexArtifactMessage = Extract<
  StudioProjectIndexStreamMessage,
  {
    type: "StudioProjectEvidenceShard" | "StudioSourceBlobManifest" | "StudioSourceBlobChunk";
  }
>;

interface PendingProjectIndexArtifact {
  readonly type: StudioProjectIndexArtifactMessage["type"];
  readonly kind: StudioProjectIndexArtifactMessage["payload"]["artifact"]["kind"];
  readonly id: string;
  readonly hash: string;
  readonly fragmentCount: number;
  readonly fragments: string[];
}

/**
 * Incremental host-side receiver. It retains only the final typed leaves plus
 * one in-progress artifact, never a second full stream of protocol messages.
 */
class StudioProjectIndexStreamReceiver {
  private started?: Extract<PluginToBackendMessage, { type: "StudioProjectIndexStarted" }>;
  private pending: PendingProjectIndexArtifact | undefined;
  private readonly shards: StudioProjectEvidenceShard[] = [];
  private readonly sourceManifests: StudioSourceBlobManifest[] = [];
  private readonly sourceChunks: StudioSourceBlobChunk[] = [];
  private nextSequence = 0;
  private result?: StudioProjectIndexCapture;
  private failure?: Error;

  constructor(
    private readonly requestId: string | undefined,
    private readonly projection?: StudioProjectIndexProjection,
  ) {}

  completedCapture(): StudioProjectIndexCapture | undefined {
    if (this.failure) throw this.failure;
    return this.result;
  }

  observe(message: PluginToBackendMessage): boolean {
    if (this.failure) return false;
    if (this.result) {
      if (isStudioProjectIndexStreamMessage(message) && message.requestId === this.requestId) {
        this.failure = new Error("Studio project index request emitted more than one stream");
        return true;
      }
      return false;
    }
    if (message.type === "UnpairProject") {
      this.failure = new Error("Studio disconnected while waiting for Studio project index");
      return true;
    }
    if (message.type === "PluginError" && message.requestId === this.requestId) {
      this.failure = new RuntimePluginFailure(message);
      return true;
    }
    if (!isStudioProjectIndexStreamMessage(message) || message.requestId !== this.requestId)
      return false;
    try {
      this.ingest(message);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
    return true;
  }

  async wait(timeoutMs: number, label: string): Promise<StudioProjectIndexCapture> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.result) return this.result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(25, remaining)));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  private ingest(message: StudioProjectIndexStreamMessage): void {
    if (message.type === "StudioProjectIndexStarted") {
      if (this.started || this.nextSequence !== 0 || this.pending)
        throw new Error("Studio project index stream lifecycle is malformed");
      if (this.projection && message.payload.projection.hash !== this.projection.hash)
        throw new Error("Studio project index projection binding mismatch");
      this.started = message;
      return;
    }
    const started = this.started;
    if (!started || message.payload.captureId !== started.payload.captureId)
      throw new Error("Studio project index stream included an unrelated capture");
    if (message.type === "StudioProjectIndexCompleted") {
      if (
        this.pending ||
        this.nextSequence !== started.payload.pieceCount ||
        message.payload.pieceCount !== started.payload.pieceCount ||
        message.payload.detectorEpoch !== started.payload.detectorEpoch
      )
        throw new Error("Studio project index stream binding or detector epoch mismatch");
      this.finish(message, started);
      return;
    }
    this.ingestArtifact(message);
  }

  private ingestArtifact(message: StudioProjectIndexArtifactMessage): void {
    const fragment = message.payload;
    if (fragment.sequence !== this.nextSequence)
      throw new Error("Studio project index stream has missing, duplicate, or reordered fragments");
    if (!this.pending) {
      if (fragment.fragmentOrdinal !== 0)
        throw new Error("Studio project index artifact fragments are incomplete or interleaved");
      this.pending = {
        type: message.type,
        kind: fragment.artifact.kind,
        id: fragment.artifact.id,
        hash: fragment.artifact.hash,
        fragmentCount: fragment.fragmentCount,
        fragments: [],
      };
    }
    const pending = this.pending;
    if (
      message.type !== pending.type ||
      fragment.artifact.kind !== pending.kind ||
      fragment.artifact.id !== pending.id ||
      fragment.artifact.hash !== pending.hash ||
      fragment.fragmentCount !== pending.fragmentCount ||
      fragment.fragmentOrdinal !== pending.fragments.length
    )
      throw new Error("Studio project index artifact fragments are incomplete or interleaved");
    if (contentHash(fragment.payload) !== fragment.payloadHash)
      throw new Error("Studio project index artifact fragment hash mismatch");
    pending.fragments.push(fragment.payload);
    this.nextSequence += 1;
    if (pending.fragments.length !== pending.fragmentCount) return;
    let value: unknown;
    try {
      value = JSON.parse(pending.fragments.join(""));
    } catch {
      throw new Error("Studio project index artifact fragment JSON is invalid");
    }
    const artifact = value as {
      readonly kind?: unknown;
      readonly id?: unknown;
      readonly hash?: unknown;
    };
    if (
      artifact.kind !== pending.kind ||
      artifact.id !== pending.id ||
      artifact.hash !== pending.hash
    )
      throw new Error("Studio project index artifact fragment binding mismatch");
    if (pending.type === "StudioProjectEvidenceShard")
      this.shards.push(value as StudioProjectEvidenceShard);
    else if (pending.type === "StudioSourceBlobManifest")
      this.sourceManifests.push(value as StudioSourceBlobManifest);
    else this.sourceChunks.push(value as StudioSourceBlobChunk);
    this.pending = undefined;
  }

  private finish(
    completed: Extract<PluginToBackendMessage, { type: "StudioProjectIndexCompleted" }>,
    started: Extract<PluginToBackendMessage, { type: "StudioProjectIndexStarted" }>,
  ): void {
    if (
      this.shards.length !== started.payload.expectedShardCount ||
      this.sourceManifests.length !== started.payload.expectedSourceManifestCount ||
      this.sourceChunks.length !== started.payload.expectedSourceChunkCount ||
      completed.payload.indexManifest.sourceManifestCount !== this.sourceManifests.length
    )
      throw new Error("Studio project index stream artifact counts mismatch");
    const { sourceManifestCount: _sourceManifestCount, ...indexManifestHeader } =
      completed.payload.indexManifest;
    const capture: StudioProjectIndexCapture = {
      kind: "StudioProjectIndexCapture",
      detectorEpoch: started.payload.detectorEpoch,
      projection: started.payload.projection,
      indexManifest: {
        ...indexManifestHeader,
        sourceManifestHashes: this.sourceManifests.map((manifest) => manifest.hash).sort(),
      },
      revision: completed.payload.revision,
      shards: this.shards,
      sourceManifests: this.sourceManifests,
      sourceChunks: this.sourceChunks,
      hash: completed.payload.captureHash,
    };
    if (capture.indexManifest.canonicalBytes !== started.payload.expectedCanonicalBytes)
      throw new Error("Studio project index stream byte expectation mismatch");
    this.result = assertProjectIndexCaptureForRequest(
      capture,
      this.projection ?? started.payload.projection,
    );
  }
}

/** Routes transaction-scoped index fragments without retaining them in the
 * coordinator's general protocol-event array. */
export class StudioProjectIndexStreamRouter {
  private readonly receivers = new Map<string | undefined, StudioProjectIndexStreamReceiver>();

  observe(message: PluginToBackendMessage): boolean {
    if (message.type === "UnpairProject") {
      for (const receiver of this.receivers.values()) receiver.observe(message);
      return false;
    }
    if (message.type === "PluginError") {
      if (message.requestId) this.receiver(message.requestId).observe(message);
      return false;
    }
    if (!isStudioProjectIndexStreamMessage(message)) return false;
    this.receiver(message.requestId).observe(message);
    return true;
  }

  /**
   * Return and release a synchronously completed capture. This is used for the
   * connector's unsolicited pairing/recovery stream, whose lack of requestId
   * is itself part of the protocol binding.
   */
  takeCompleted(requestId?: string): StudioProjectIndexCapture | undefined {
    const receiver = this.receivers.get(requestId);
    if (!receiver) return undefined;
    const capture = receiver.completedCapture();
    if (capture) this.receivers.delete(requestId);
    return capture;
  }

  async wait(input: {
    readonly requestId: string;
    readonly manifestId: string;
    readonly revisionHash: string;
    readonly detectorEpoch: number;
    readonly timeoutMs: number;
    readonly label: string;
  }): Promise<StudioProjectIndexCapture> {
    const capture = await this.receiver(input.requestId).wait(input.timeoutMs, input.label);
    if (
      capture.indexManifest.id !== input.manifestId ||
      capture.revision.hash !== input.revisionHash ||
      capture.detectorEpoch !== input.detectorEpoch
    )
      throw new Error(`${input.label} binding mismatch`);
    return capture;
  }

  private receiver(requestId: string | undefined): StudioProjectIndexStreamReceiver {
    let receiver = this.receivers.get(requestId);
    if (!receiver) {
      receiver = new StudioProjectIndexStreamReceiver(requestId);
      this.receivers.set(requestId, receiver);
    }
    return receiver;
  }
}

async function collectStudioProjectIndexStream(
  messages: PluginToBackendMessage[],
  timeoutMs: number,
  requestId: string,
  projection?: StudioProjectIndexProjection,
): Promise<StudioProjectIndexCapture> {
  const receiver = new StudioProjectIndexStreamReceiver(requestId, projection);
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    while (cursor < messages.length) receiver.observe(messages[cursor++]!);
    try {
      return await receiver.wait(1, "Studio project index stream");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Timed out waiting")) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for Studio project index stream");
}

/** Reassemble an index streamed as part of an already-running transaction. */
export async function waitForStudioProjectIndexCapture(input: {
  readonly messages: PluginToBackendMessage[];
  readonly requestId: string;
  readonly manifestId: string;
  readonly revisionHash: string;
  readonly detectorEpoch: number;
  readonly timeoutMs: number;
  readonly label: string;
}): Promise<StudioProjectIndexCapture> {
  const capture = await collectStudioProjectIndexStream(
    input.messages,
    input.timeoutMs,
    input.requestId,
  );
  if (
    capture.indexManifest.id !== input.manifestId ||
    capture.revision.hash !== input.revisionHash ||
    capture.detectorEpoch !== input.detectorEpoch
  )
    throw new Error(`${input.label} binding mismatch`);
  return capture;
}
