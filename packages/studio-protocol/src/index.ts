import { contentHash } from "../../contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioStateRevision,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceProjection,
  serializeStudioEvidenceProjection,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectIdentity,
  type StudioStateRevision,
} from "../../studio-evidence/src/index.js";

export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_CHUNKS = 64;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type StudioEvidenceReason =
  | "pairing"
  | "manual"
  | "pre_play"
  | "pre_apply"
  | "post_apply"
  | "post_cancel"
  | "post_commit"
  | "runtime"
  | "capability_attestation"
  | "recording_recovery";

export type PluginMessageType =
  | "PairProject"
  | "UnpairProject"
  | "StudioEvidenceProduced"
  | "StudioEvidenceChunk"
  | "RuntimeEvalPlanAccepted"
  | "RuntimeEvalStarted"
  | "RuntimeEvalStopped"
  | "CreatorChangePrepared"
  | "CreatorChangePreflighted"
  | "CreatorMutationProvisional"
  | "CreatorMutationFailed"
  | "CreatorChangeFinalized"
  | "CreatorRecordingRecovery"
  | "CreatorClosedRecordingAcknowledged"
  | "CreatorCheckpointRolledBack"
  | "PluginError"
  | "Heartbeat";

export type BackendMessageType =
  | "RequestStudioEvidence"
  | "ExecuteRuntimeEvalPlan"
  | "PrepareCreatorChangeSet"
  | "PreflightCreatorChangeSet"
  | "ApplyCreatorChangeSet"
  | "FinalizeCreatorChangeSet"
  | "RequestCreatorRecordingRecovery"
  | "AcknowledgeClosedCreatorRecording"
  | "CancelInterruptedRecording"
  | "AcknowledgeCreatorChangeFinalization"
  | "RollbackCreatorCheckpoint";

export type PluginProjectIdentity = StudioProjectIdentity;
export type StudioCapability =
  | "studio_evidence"
  | "evidence_chunks"
  | "sha256"
  | "stable_identity"
  | "reflection_attestation"
  | "detached_preflight"
  | "transactional_authoring"
  | "recording_recovery"
  | "studio_play_mode"
  | "bounded_diagnostics"
  | "http_polling";

export interface PairProjectPayload {
  pairingToken: string;
  project: PluginProjectIdentity;
  capabilities: StudioCapability[];
  connectorBuildHash: string;
  manifestHash: string;
}
export interface UnpairProjectPayload { reason: "user" | "plugin_unload" | "session_replaced"; }

export interface StudioEvidenceProducedPayload {
  project: PluginProjectIdentity;
  reason: StudioEvidenceReason;
  projection: StudioEvidenceProjection;
  envelope: StudioEvidenceEnvelope;
  revision?: StudioStateRevision;
}
/** Chunks contain one canonical JSON StudioEvidenceProducedPayload. */
export interface StudioEvidenceChunkPayload {
  project: PluginProjectIdentity;
  reason: StudioEvidenceReason;
  evidenceId: string;
  index: number;
  total: number;
  encoding: "json";
  payload: string;
  payloadHash: string;
}
export interface PluginErrorPayload {
  code: "INVALID_MESSAGE" | "STALE_EVIDENCE" | "WRONG_PROJECT" | "INCOMPATIBLE_MANIFEST" | "UNSUPPORTED_OPERATION" | "TRANSPORT_FAILURE" | "STUDIO_FAILURE" | "SECURITY_REJECTION" | "RECOVERY_REQUIRED";
  message: string;
  retryable: boolean;
}
export interface RecordingBinding {
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  manifestHash: string;
  beforeRevisionHash: string;
  recordingId: string;
}
export interface HeartbeatPayload {
  project: PluginProjectIdentity;
  manifestHash: string;
  currentRevisionHash?: string;
  activeRecording?: RecordingBinding;
}
export interface PairingResponse {
  sessionId: string;
  sessionToken: string;
  projectId: string;
  manifestHash: string;
  connectorBuildHash: string;
  capabilityAttestationProjectionJson: string;
  capabilityAttestationProjectionJsonHash: string;
  capabilityAttestationProjectionHash: string;
  projectStateProjectionJson: string;
  projectStateProjectionJsonHash: string;
  projectStateProjectionHash: string;
  expiresAt: string;
}
export interface RequestStudioEvidencePayload {
  requestId: string;
  reason: StudioEvidenceReason;
  projectionJson: string;
  projectionJsonHash: string;
  projectionHash: string;
}
/** Canonical plan JSON remains data interpreted by a fixed runner. */
export interface ExecuteRuntimeEvalPlanPayload {
  requestId: string;
  expectedRevision: string;
  executionPlanJson: string;
  executionPlanJsonHash: string;
  evidenceProjectionJson: string;
  evidenceProjectionJsonHash: string;
  evidenceProjectionHash: string;
  startPolicy: "explicit_plugin_action" | "creator_action_already_authorized";
}
export interface RuntimeEvalLifecyclePayload {
  executionPlanId: string;
  executionPlanHash: string;
  projectionId: string;
  projectionHash: string;
  bindingHash: string;
  nonceCommitment: string;
  mode: "play_solo";
  playerCount: number;
  control: "plugin_action" | "creator_action";
}
export interface RuntimeEvalPlanAcceptedPayload extends Omit<RuntimeEvalLifecyclePayload, "mode" | "playerCount" | "control"> {
  callCount: number;
  instruction: string;
}
export interface PrepareCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  expectedRevision: string;
  changeSetJson: string;
  changeSetJsonHash: string;
  changeSetId: string;
  changeSetHash: string;
  approvalHash: string;
  dashboardReviewHash: string;
  manifestHash: string;
  projectionJson: string;
  projectionJsonHash: string;
  projectionHash: string;
  preflightProjectionJson: string;
  preflightProjectionJsonHash: string;
  preflightProjectionHash: string;
  /** The exact complete state projection that produced expectedRevision. */
  beforeStateProjectionJson: string;
  beforeStateProjectionJsonHash: string;
  beforeStateProjectionHash: string;
}
export interface CreatorChangePreparedPayload {
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  preflightProjectionId: string;
  preflightProjectionHash: string;
  manifestHash: string;
  beforeRevisionHash: string;
  status: "prepared";
}
export interface CreatorChangePreflightedPayload {
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  preflightProjectionId: string;
  preflightProjectionHash: string;
  manifestHash: string;
  beforeRevisionHash: string;
  preflightEvidence: StudioEvidenceEnvelope;
  status: "passed" | "failed" | "incomplete";
  failureCode?: string;
}
export interface PreflightCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  preflightProjectionId: string;
  preflightProjectionHash: string;
  manifestHash: string;
  expectedRevision: string;
}
export interface ApplyCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  manifestHash: string;
  expectedRevision: string;
}
export interface CreatorMutationProvisionalPayload extends RecordingBinding {
  directReadbackEvidence: StudioEvidenceEnvelope;
  postApplyStateProjection: StudioEvidenceProjection;
  postApplyStateEvidence: StudioEvidenceEnvelope;
  postApplyRevision: StudioStateRevision;
  status: "provisional";
}
export interface CreatorMutationFailedPayload {
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionHash: string;
  stage: "preflight" | "apply" | "readback" | "post_state" | "cancel" | "commit";
  failureCode: string;
  recordingState: "not_open" | "open" | "unknown";
  cancellationProven?: boolean;
}
export interface FinalizeCreatorChangeSetPayload extends RecordingBinding {
  requestId: string;
  action: "commit" | "cancel";
}
export interface CreatorChangeFinalizedPayload extends RecordingBinding {
  action: "commit" | "cancel";
  status: "committed" | "cancelled" | "recovery_required";
  afterRevision: StudioStateRevision;
  postFinalizeStateProjection: StudioEvidenceProjection;
  postFinalizeStateEvidence: StudioEvidenceEnvelope;
}
/**
 * The backend sends this only after it has persisted the exact finalization
 * receipt.  Until then, the plugin retains and re-emits the receipt across
 * restart; acknowledgement is a notification acknowledgement, never a Studio
 * mutation command.
 */
export interface AcknowledgeCreatorChangeFinalizationPayload extends RecordingBinding {
  requestId: string;
  action: "commit" | "cancel";
  status: "committed" | "cancelled";
  afterRevisionHash: string;
  postFinalizeProjectionHash: string;
  postFinalizeEvidenceHash: string;
}
export interface RequestCreatorRecordingRecoveryPayload extends RecordingBinding {
  requestId: string;
}
export type CreatorRecordingRecoveryPayload =
  | {
      recordingState: "none";
    }
  | (RecordingBinding & {
  recordingState: "open" | "not_open" | "unknown";
  evidenceProjection: StudioEvidenceProjection;
  evidence: StudioEvidenceEnvelope;
});
export interface AcknowledgeClosedCreatorRecordingPayload extends RecordingBinding {
  requestId: string;
  recoveryProjectionHash: string;
  recoveryEvidenceHash: string;
}
export interface CreatorClosedRecordingAcknowledgedPayload extends RecordingBinding {
  recoveryProjectionHash: string;
  recoveryEvidenceHash: string;
  status: "closed_cursor_cleared";
}
export interface CancelInterruptedRecordingPayload extends RequestCreatorRecordingRecoveryPayload {
  recoveryEvidenceHash: string;
}
export interface RollbackCreatorCheckpointPayload {
  requestId: string;
  creatorSessionId: string;
  checkpointId: string;
  changeSetId: string;
  changeSetHash: string;
  expectedRevision: string;
}
export interface CreatorCheckpointRolledBackPayload {
  creatorSessionId: string;
  checkpointId: string;
  changeSetId: string;
  changeSetHash: string;
  beforeRevisionHash: string;
  afterRevision: StudioStateRevision;
  evidenceProjection: StudioEvidenceProjection;
  evidence: StudioEvidenceEnvelope;
  status: "rolled_back";
}

interface StudioMessageBase<TDirection extends StudioDirection, TType extends string, TPayload> {
  kind: "StudioProtocolMessage";
  direction: TDirection;
  type: TType;
  messageId: string;
  requestId?: string;
  correlationId?: string;
  sessionId?: string;
  sentAt: string;
  payload: TPayload;
}

export type PluginToBackendMessage =
  | StudioMessageBase<"plugin_to_backend", "PairProject", PairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "UnpairProject", UnpairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "StudioEvidenceProduced", StudioEvidenceProducedPayload>
  | StudioMessageBase<"plugin_to_backend", "StudioEvidenceChunk", StudioEvidenceChunkPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalPlanAccepted", RuntimeEvalPlanAcceptedPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStarted", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStopped", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorChangePrepared", CreatorChangePreparedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorChangePreflighted", CreatorChangePreflightedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorMutationProvisional", CreatorMutationProvisionalPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorMutationFailed", CreatorMutationFailedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorChangeFinalized", CreatorChangeFinalizedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorRecordingRecovery", CreatorRecordingRecoveryPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorClosedRecordingAcknowledged", CreatorClosedRecordingAcknowledgedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorCheckpointRolledBack", CreatorCheckpointRolledBackPayload>
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;
export type BackendToPluginMessage =
  | StudioMessageBase<"backend_to_plugin", "RequestStudioEvidence", RequestStudioEvidencePayload>
  | StudioMessageBase<"backend_to_plugin", "ExecuteRuntimeEvalPlan", ExecuteRuntimeEvalPlanPayload>
  | StudioMessageBase<"backend_to_plugin", "PrepareCreatorChangeSet", PrepareCreatorChangeSetPayload>
  | StudioMessageBase<"backend_to_plugin", "PreflightCreatorChangeSet", PreflightCreatorChangeSetPayload>
  | StudioMessageBase<"backend_to_plugin", "ApplyCreatorChangeSet", ApplyCreatorChangeSetPayload>
  | StudioMessageBase<"backend_to_plugin", "FinalizeCreatorChangeSet", FinalizeCreatorChangeSetPayload>
  | StudioMessageBase<"backend_to_plugin", "RequestCreatorRecordingRecovery", RequestCreatorRecordingRecoveryPayload>
  | StudioMessageBase<"backend_to_plugin", "AcknowledgeClosedCreatorRecording", AcknowledgeClosedCreatorRecordingPayload>
  | StudioMessageBase<"backend_to_plugin", "CancelInterruptedRecording", CancelInterruptedRecordingPayload>
  | StudioMessageBase<"backend_to_plugin", "AcknowledgeCreatorChangeFinalization", AcknowledgeCreatorChangeFinalizationPayload>
  | StudioMessageBase<"backend_to_plugin", "RollbackCreatorCheckpoint", RollbackCreatorCheckpointPayload>;
export type StudioProtocolMessage = PluginToBackendMessage | BackendToPluginMessage;
export interface StudioTransport {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void;
}

const PLUGIN_MESSAGE_TYPES = new Set<PluginMessageType>([
  "PairProject", "UnpairProject", "StudioEvidenceProduced", "StudioEvidenceChunk",
  "RuntimeEvalPlanAccepted", "RuntimeEvalStarted", "RuntimeEvalStopped",
  "CreatorChangePrepared", "CreatorChangePreflighted", "CreatorMutationProvisional",
  "CreatorMutationFailed", "CreatorChangeFinalized", "CreatorRecordingRecovery", "CreatorClosedRecordingAcknowledged",
  "CreatorCheckpointRolledBack", "PluginError", "Heartbeat",
]);
const BACKEND_MESSAGE_TYPES = new Set<BackendMessageType>([
  "RequestStudioEvidence", "ExecuteRuntimeEvalPlan", "PrepareCreatorChangeSet",
  "PreflightCreatorChangeSet", "ApplyCreatorChangeSet", "FinalizeCreatorChangeSet", "RequestCreatorRecordingRecovery", "AcknowledgeClosedCreatorRecording",
  "CancelInterruptedRecording", "AcknowledgeCreatorChangeFinalization", "RollbackCreatorCheckpoint",
]);
const CAPABILITIES: readonly StudioCapability[] = [
  "studio_evidence", "evidence_chunks", "sha256", "stable_identity",
  "reflection_attestation", "detached_preflight", "transactional_authoring",
  "recording_recovery", "studio_play_mode", "bounded_diagnostics", "http_polling",
];

export function assertStudioProtocolMessage(value: unknown): asserts value is StudioProtocolMessage {
  if (!isRecord(value) || value.kind !== "StudioProtocolMessage" || !isString(value.type) || !isId(value.messageId) || !isIso(value.sentAt) || !isRecord(value.payload)) throw new Error("Invalid StudioProtocolMessage envelope");
  if (value.direction === "plugin_to_backend") {
    if (!PLUGIN_MESSAGE_TYPES.has(value.type as PluginMessageType)) throw new Error(`Invalid plugin message type: ${value.type}`);
  } else if (value.direction === "backend_to_plugin") {
    if (!BACKEND_MESSAGE_TYPES.has(value.type as BackendMessageType)) throw new Error(`Invalid backend message type: ${value.type}`);
  } else throw new Error("Invalid StudioProtocolMessage direction");
  if (value.sessionId !== undefined && !isId(value.sessionId)) throw new Error("Invalid StudioProtocolMessage sessionId");
  validatePayload(value.type, value.payload);
}
export function assertPluginToBackendMessage(value: unknown): asserts value is PluginToBackendMessage {
  assertStudioProtocolMessage(value);
  if (value.direction !== "plugin_to_backend") throw new Error("Expected plugin_to_backend message");
}
export function assertBackendToPluginMessage(value: unknown): asserts value is BackendToPluginMessage {
  assertStudioProtocolMessage(value);
  if (value.direction !== "backend_to_plugin") throw new Error("Expected backend_to_plugin message");
}

function validatePayload(type: string, payload: Record<string, unknown>): void {
  if (type === "PairProject") {
    // Shape validation and build compatibility are separate boundaries.  A
    // connector carrying a well-formed but stale manifest is a valid protocol
    // message; StudioBridgeServer.pair owns the exact compatibility decision
    // and returns a descriptive 409.  Rejecting it here incorrectly reports a
    // stale connector as a malformed PairProject payload (HTTP 400).
    if (!isString(payload.pairingToken) || !isProject(payload.project) || !isExactCapabilities(payload.capabilities) || !isHash(payload.connectorBuildHash) || !isHash(payload.manifestHash)) fail(type);
    return;
  }
  if (type === "UnpairProject") {
    if (!["user", "plugin_unload", "session_replaced"].includes(String(payload.reason))) fail(type);
    return;
  }
  if (type === "StudioEvidenceProduced") { assertEvidenceProduced(payload); return; }
  if (type === "StudioEvidenceChunk") {
    if (!isProject(payload.project) || !isEvidenceReason(payload.reason) || !isId(payload.evidenceId) || !isNonNegativeInteger(payload.index) || !isPositiveInteger(payload.total) || Number(payload.total) > MAX_EVIDENCE_CHUNKS || Number(payload.index) >= Number(payload.total) || payload.encoding !== "json" || !isString(payload.payload) || !isHash(payload.payloadHash) || contentHash(payload.payload) !== payload.payloadHash) fail(type);
    return;
  }
  if (type === "Heartbeat") {
    if (!isProject(payload.project) || payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH || (payload.currentRevisionHash !== undefined && !isHash(payload.currentRevisionHash)) || (payload.activeRecording !== undefined && !isRecordingBinding(payload.activeRecording))) fail(type);
    return;
  }
  if (type === "PluginError") {
    if (!["INVALID_MESSAGE", "STALE_EVIDENCE", "WRONG_PROJECT", "INCOMPATIBLE_MANIFEST", "UNSUPPORTED_OPERATION", "TRANSPORT_FAILURE", "STUDIO_FAILURE", "SECURITY_REJECTION", "RECOVERY_REQUIRED"].includes(String(payload.code)) || !isString(payload.message) || typeof payload.retryable !== "boolean") fail(type);
    return;
  }
  if (type === "RequestStudioEvidence") { assertProjectionJson(payload.requestId, payload.reason, payload.projectionJson, payload.projectionJsonHash, payload.projectionHash); return; }
  if (type === "ExecuteRuntimeEvalPlan") {
    if (!isId(payload.requestId) || !isHash(payload.expectedRevision) || !isString(payload.executionPlanJson) || !isHash(payload.executionPlanJsonHash) || contentHash(payload.executionPlanJson) !== payload.executionPlanJsonHash || !["explicit_plugin_action", "creator_action_already_authorized"].includes(String(payload.startPolicy))) fail(type);
    assertProjectionJson(payload.requestId, "runtime", payload.evidenceProjectionJson, payload.evidenceProjectionJsonHash, payload.evidenceProjectionHash);
    return;
  }
  if (type === "RuntimeEvalPlanAccepted") {
    if (!isRuntimeBase(payload) || !isPositiveInteger(payload.callCount) || !isString(payload.instruction)) fail(type);
    return;
  }
  if (type === "RuntimeEvalStarted" || type === "RuntimeEvalStopped") {
    if (!isRuntimeBase(payload) || payload.mode !== "play_solo" || !isNonNegativeInteger(payload.playerCount) || !["plugin_action", "creator_action"].includes(String(payload.control))) fail(type);
    return;
  }
  if (type === "PrepareCreatorChangeSet") {
    if (!isId(payload.requestId) || !isId(payload.creatorSessionId) || !isHash(payload.expectedRevision) || !isString(payload.changeSetJson) || !isHash(payload.changeSetJsonHash) || contentHash(payload.changeSetJson) !== payload.changeSetJsonHash || !isId(payload.changeSetId) || !isHash(payload.changeSetHash) || !isHash(payload.approvalHash) || !isHash(payload.dashboardReviewHash) || payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH) fail(type);
    assertProjectionJson(payload.requestId, undefined, payload.projectionJson, payload.projectionJsonHash, payload.projectionHash);
    assertProjectionJson(payload.requestId, undefined, payload.preflightProjectionJson, payload.preflightProjectionJsonHash, payload.preflightProjectionHash);
    assertProjectionJson(payload.requestId, undefined, payload.beforeStateProjectionJson, payload.beforeStateProjectionJsonHash, payload.beforeStateProjectionHash);
    return;
  }
  if (type === "CreatorChangePrepared") {
    if (!isChangeBinding(payload) || !isPreflightBinding(payload) || !isHash(payload.beforeRevisionHash) || payload.status !== "prepared") fail(type);
    return;
  }
  if (type === "CreatorChangePreflighted") {
    if (!isChangeBinding(payload) || !isPreflightBinding(payload) || !isHash(payload.beforeRevisionHash) || !["passed", "failed", "incomplete"].includes(String(payload.status)) || (payload.failureCode !== undefined && !isId(payload.failureCode))) fail(type);
    assertStudioEvidenceEnvelope(payload.preflightEvidence);
    if ((payload.preflightEvidence as StudioEvidenceEnvelope).projectionHash !== payload.preflightProjectionHash) fail(type);
    return;
  }
  if (type === "PreflightCreatorChangeSet" || type === "ApplyCreatorChangeSet") {
    if (!isId(payload.requestId) || !isChangeBinding(payload) || (type === "PreflightCreatorChangeSet" && !isPreflightBinding(payload)) || !isHash(payload.expectedRevision)) fail(type);
    return;
  }
  if (type === "CreatorMutationProvisional") {
    if (!isRecordingBinding(payload) || payload.status !== "provisional") fail(type);
    assertStudioEvidenceEnvelope(payload.directReadbackEvidence);
    if ((payload.directReadbackEvidence as StudioEvidenceEnvelope).manifestHash !== payload.manifestHash || (payload.directReadbackEvidence as StudioEvidenceEnvelope).projectionId !== payload.projectionId || (payload.directReadbackEvidence as StudioEvidenceEnvelope).projectionHash !== payload.projectionHash) fail(type);
    assertStudioEvidenceProjection(payload.postApplyStateProjection);
    assertStudioEvidenceEnvelope(payload.postApplyStateEvidence, payload.postApplyStateProjection as StudioEvidenceProjection);
    assertRevisionForEvidence(payload.postApplyRevision, payload.postApplyStateEvidence as StudioEvidenceEnvelope, payload.postApplyStateProjection as StudioEvidenceProjection);
    return;
  }
  if (type === "CreatorMutationFailed") {
    if (!isId(payload.creatorSessionId) || !isId(payload.changeSetId) || !isHash(payload.changeSetHash) || !isHash(payload.projectionHash) || !["preflight", "apply", "readback", "post_state", "cancel", "commit"].includes(String(payload.stage)) || !isId(payload.failureCode) || !["not_open", "open", "unknown"].includes(String(payload.recordingState)) || (payload.cancellationProven !== undefined && typeof payload.cancellationProven !== "boolean")) fail(type);
    return;
  }
  if (type === "FinalizeCreatorChangeSet") {
    if (!isId(payload.requestId) || !isRecordingBinding(payload) || !["commit", "cancel"].includes(String(payload.action))) fail(type);
    return;
  }
  if (type === "AcknowledgeCreatorChangeFinalization") {
    if (!isId(payload.requestId) || !isRecordingBinding(payload) || !["commit", "cancel"].includes(String(payload.action)) || !["committed", "cancelled"].includes(String(payload.status)) || !isHash(payload.afterRevisionHash) || !isHash(payload.postFinalizeProjectionHash) || !isHash(payload.postFinalizeEvidenceHash)) fail(type);
    return;
  }
  if (type === "CreatorChangeFinalized") {
    if (!isRecordingBinding(payload) || !["commit", "cancel"].includes(String(payload.action)) || !["committed", "cancelled", "recovery_required"].includes(String(payload.status))) fail(type);
    assertRevision(payload.afterRevision);
    assertStudioEvidenceProjection(payload.postFinalizeStateProjection);
    assertStudioEvidenceEnvelope(payload.postFinalizeStateEvidence, payload.postFinalizeStateProjection as StudioEvidenceProjection);
    assertRevisionForEvidence(payload.afterRevision, payload.postFinalizeStateEvidence as StudioEvidenceEnvelope, payload.postFinalizeStateProjection as StudioEvidenceProjection);
    return;
  }
  if (type === "RequestCreatorRecordingRecovery") { assertRecoveryRequest(payload, false); return; }
  if (type === "AcknowledgeClosedCreatorRecording") {
    if (!isId(payload.requestId) || !isRecordingBinding(payload) || !isHash(payload.recoveryProjectionHash) || !isHash(payload.recoveryEvidenceHash)) fail(type);
    return;
  }
  if (type === "CancelInterruptedRecording") { assertRecoveryRequest(payload, true); return; }
  if (type === "CreatorRecordingRecovery") {
    if (payload.recordingState === "none") {
      if (Object.keys(payload).length !== 1) fail(type);
      return;
    }
    if (!isRecordingBinding(payload) || !["open", "not_open", "unknown"].includes(String(payload.recordingState))) fail(type);
    assertStudioEvidenceProjection(payload.evidenceProjection);
    if ((payload.evidenceProjection as StudioEvidenceProjection).purpose !== "project_state" || (payload.evidenceProjection as StudioEvidenceProjection).scope.mode !== "project_state") fail(type);
    assertStudioEvidenceEnvelope(payload.evidence, payload.evidenceProjection as StudioEvidenceProjection);
    return;
  }
  if (type === "CreatorClosedRecordingAcknowledged") {
    if (!isRecordingBinding(payload) || !isHash(payload.recoveryProjectionHash) || !isHash(payload.recoveryEvidenceHash) || payload.status !== "closed_cursor_cleared") fail(type);
    return;
  }
  if (type === "RollbackCreatorCheckpoint") {
    if (!isId(payload.requestId) || !isId(payload.creatorSessionId) || !isId(payload.checkpointId) || !isId(payload.changeSetId) || !isHash(payload.changeSetHash) || !isHash(payload.expectedRevision)) fail(type);
    return;
  }
  if (type === "CreatorCheckpointRolledBack") {
    if (!isId(payload.creatorSessionId) || !isId(payload.checkpointId) || !isId(payload.changeSetId) || !isHash(payload.changeSetHash) || !isHash(payload.beforeRevisionHash) || payload.status !== "rolled_back") fail(type);
    assertRevision(payload.afterRevision);
    assertStudioEvidenceProjection(payload.evidenceProjection);
    assertStudioEvidenceEnvelope(payload.evidence, payload.evidenceProjection as StudioEvidenceProjection);
    assertRevisionForEvidence(payload.afterRevision, payload.evidence as StudioEvidenceEnvelope, payload.evidenceProjection as StudioEvidenceProjection);
    return;
  }
  throw new Error(`Unsupported StudioProtocolMessage type: ${type}`);
}

function assertEvidenceProduced(payload: Record<string, unknown>): void {
  if (!isProject(payload.project) || !isEvidenceReason(payload.reason)) fail("StudioEvidenceProduced");
  assertStudioEvidenceProjection(payload.projection);
  assertStudioEvidenceEnvelope(payload.envelope, payload.projection as StudioEvidenceProjection);
  const projection = payload.projection as StudioEvidenceProjection;
  if (!sameProject(payload.project as unknown as PluginProjectIdentity, projection.project)) fail("StudioEvidenceProduced");
  if (payload.revision !== undefined) assertRevisionForEvidence(payload.revision, payload.envelope as StudioEvidenceEnvelope, projection);
}
function assertProjectionJson(requestId: unknown, reason: unknown, json: unknown, jsonHash: unknown, projectionHash: unknown): void {
  if (!isId(requestId) || !isString(json) || !isHash(jsonHash) || contentHash(json) !== jsonHash || !isHash(projectionHash)) fail("projection JSON");
  let value: unknown;
  try { value = JSON.parse(json); } catch { fail("projection JSON"); }
  assertStudioEvidenceProjection(value);
  if (serializeStudioEvidenceProjection(value) !== json || value.contentHash !== projectionHash) fail("projection JSON");
  if (reason !== undefined && (!isEvidenceReason(reason) || (reason === "runtime" && !["runtime_evaluation", "creator_verification"].includes(value.purpose)))) fail("projection reason");
}
function assertRecoveryRequest(payload: Record<string, unknown>, cancel: boolean): void {
  if (!isId(payload.requestId) || !isRecordingBinding(payload)) fail(cancel ? "CancelInterruptedRecording" : "RequestCreatorRecordingRecovery");
  if (cancel && !isHash(payload.recoveryEvidenceHash)) fail("CancelInterruptedRecording");
}
function isRuntimeBase(payload: Record<string, unknown>): boolean {
  return isId(payload.executionPlanId) && isHash(payload.executionPlanHash) && isId(payload.projectionId) && isHash(payload.projectionHash) && isHash(payload.bindingHash) && isHash(payload.nonceCommitment);
}
function isChangeBinding(value: unknown): boolean {
  return isRecord(value) && isId(value.creatorSessionId) && isId(value.changeSetId) && isHash(value.changeSetHash) && isId(value.projectionId) && isHash(value.projectionHash) && value.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH;
}
function isRecordingBinding(value: unknown): boolean {
  return isChangeBinding(value) && isRecord(value) && isHash(value.beforeRevisionHash) && isId(value.recordingId);
}
function isPreflightBinding(value: unknown): boolean {
  return isRecord(value) && isId(value.preflightProjectionId) && isHash(value.preflightProjectionHash);
}
function assertRevision(value: unknown): asserts value is StudioStateRevision {
  if (!isRecord(value) || value.kind !== "StudioStateRevision" || value.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH || !isHash(value.projectionHash) || !isHash(value.stateDomainHash) || !isHash(value.stateHash) || !isIso(value.capturedAt)) fail("StudioStateRevision");
}
function assertRevisionForEvidence(value: unknown, envelope: StudioEvidenceEnvelope, projection: StudioEvidenceProjection): void {
  assertRevision(value);
  const revision = value as StudioStateRevision;
  const recomputed = createStudioStateRevision(envelope, projection, revision.capturedAt);
  if (recomputed.manifestHash !== revision.manifestHash || recomputed.projectionHash !== revision.projectionHash || recomputed.stateDomainHash !== revision.stateDomainHash || recomputed.stateHash !== revision.stateHash) fail("StudioStateRevision evidence binding");
}
function isExactCapabilities(value: unknown): value is StudioCapability[] {
  return Array.isArray(value) && value.length === CAPABILITIES.length && new Set(value).size === value.length && CAPABILITIES.every((capability) => value.includes(capability));
}
function isEvidenceReason(value: unknown): value is StudioEvidenceReason {
  return ["pairing", "manual", "pre_play", "pre_apply", "post_apply", "post_cancel", "post_commit", "runtime", "capability_attestation", "recording_recovery"].includes(String(value));
}
function isProject(value: unknown): value is PluginProjectIdentity {
  return isRecord(value) && isString(value.name) && isNonNegativeInteger(value.placeId) && isNonNegativeInteger(value.universeId);
}
function sameProject(left: PluginProjectIdentity, right: PluginProjectIdentity): boolean {
  return left.name === right.name && left.placeId === right.placeId && left.universeId === right.universeId;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isIso(value: unknown): value is string { return isString(value) && Number.isFinite(Date.parse(value)); }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function fail(scope: string): never { throw new Error(`Invalid ${scope} payload`); }
