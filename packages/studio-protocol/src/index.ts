import { contentHash } from "../../contracts/src/index.js";
import {
  assertCreatorChangeSet,
  serializeCreatorChangeSet,
} from "../../creator-session/src/index.js";
import {
  assertStudioSnapshotObservation,
  type StudioSnapshotObservation,
} from "../../semantic-map/src/index.js";
import {
  assertRuntimeObservationEnvelope,
  assertStudioExecutionPlan,
  serializeStudioExecutionPlan,
  type RuntimeObservationEnvelope,
  type StudioExecutionBinding,
} from "../../studio-capabilities/src/index.js";
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_CHUNKS = 64;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type PluginMessageType =
  | "PairProject"
  | "UnpairProject"
  | "ProjectObservation"
  | "SnapshotChunk"
  | "RuntimeEvalPlanAccepted"
  | "RuntimeEvalStarted"
  | "RuntimeEvalResult"
  | "RuntimeEvalStopped"
  | "CreatorChangePrepared"
  | "CreatorChangeApplied"
  | "CreatorChangeFinalized"
  | "CreatorCheckpointRolledBack"
  | "PluginError"
  | "Heartbeat";
export type BackendMessageType =
  | "RequestObservation"
  | "ExecuteRuntimeEvalPlan"
  | "PrepareCreatorChangeSet"
  | "ApplyCreatorChangeSet"
  | "FinalizeCreatorChangeSet"
  | "RollbackCreatorCheckpoint";
export interface PluginProjectIdentity {
  name: string;
  placeId: number;
  universeId: number;
}
export type StudioCapability =
  | "snapshot"
  | "snapshot_chunks"
  | "sha256"
  | "stable_identity"
  | "studio_play_mode"
  | "http_polling"
  | "bounded_diagnostics"
  | "runtime_eval"
  | "studio_authoring";

export interface PairProjectPayload {
  pairingToken: string;
  project: PluginProjectIdentity;
  capabilities: StudioCapability[];
}
export interface UnpairProjectPayload {
  reason: "user" | "plugin_unload" | "session_replaced";
}
export type ProjectObservationReason =
  | "pairing"
  | "pre_play"
  | "manual"
  | "pre_apply"
  | "post_apply"
  | "post_rollback";
export interface StudioRevision {
  kind: "StudioRevision";
  observationHash: string;
  identityHash: string;
  capturedAt: string;
}
export interface ProjectObservationPayload {
  project: PluginProjectIdentity;
  revision: StudioRevision;
  observation: StudioSnapshotObservation;
  reason: ProjectObservationReason;
}
export interface SnapshotChunkPayload {
  project: PluginProjectIdentity;
  revision: StudioRevision;
  reason: ProjectObservationReason;
  snapshotId: string;
  index: number;
  total: number;
  encoding: "json";
  payload: string;
  payloadHash: string;
}
export interface PluginErrorPayload {
  code:
    | "INVALID_MESSAGE"
    | "STALE_SNAPSHOT"
    | "WRONG_PROJECT"
    | "UNSUPPORTED_OPERATION"
    | "TRANSPORT_FAILURE"
    | "STUDIO_FAILURE"
    | "SECURITY_REJECTION"
    | "RECOVERY_REQUIRED";
  message: string;
  retryable: boolean;
}
export interface HeartbeatPayload {
  project: PluginProjectIdentity;
  currentSnapshotHash?: string;
}
export interface PairingResponse {
  sessionId: string;
  sessionToken: string;
  projectId: string;
  expiresAt: string;
}
export interface RequestObservationPayload {
  requestId: string;
  reason: ProjectObservationReason;
}

/** The canonical plan JSON is data. No plan field is executable source. */
export interface ExecuteRuntimeEvalPlanPayload {
  requestId: string;
  expectedRevision: string;
  executionPlanJson: string;
  executionPlanJsonHash: string;
  startPolicy: "explicit_plugin_action" | "creator_action_already_authorized";
}
export interface RuntimeEvalPlanAcceptedPayload {
  executionPlanId: string;
  executionPlanHash: string;
  binding: StudioExecutionBinding;
  nonceCommitment: string;
  callCount: number;
  instruction: string;
}
export interface RuntimeEvalLifecyclePayload {
  executionPlanId: string;
  executionPlanHash: string;
  binding: StudioExecutionBinding;
  nonceCommitment: string;
  mode: "play_solo";
  playerCount: number;
  control: "plugin_action" | "creator_action";
}
export type RuntimeEvalResultPayload = RuntimeObservationEnvelope;

export interface CreatorChangeLifecyclePayload {
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  recordingId: string;
  beforeRevisionHash: string;
  afterRevisionHash?: string;
  inverseMaterialHash?: string;
  action?: "commit" | "cancel";
  status:
    "prepared" | "applied" | "committed" | "cancelled" | "recovery_required";
}

export interface PrepareCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  expectedRevision: string;
  changeSetJson: string;
  changeSetJsonHash: string;
}
export interface ApplyCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  expectedRevision: string;
}
export interface FinalizeCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  recordingId: string;
  action: "commit" | "cancel";
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
  afterRevisionHash: string;
  status: "rolled_back";
}

interface StudioMessageBase<
  TDirection extends StudioDirection,
  TType extends string,
  TPayload,
> {
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
  | StudioMessageBase<
      "plugin_to_backend",
      "UnpairProject",
      UnpairProjectPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "ProjectObservation",
      ProjectObservationPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "SnapshotChunk",
      SnapshotChunkPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "RuntimeEvalPlanAccepted",
      RuntimeEvalPlanAcceptedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "RuntimeEvalStarted",
      RuntimeEvalLifecyclePayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "RuntimeEvalResult",
      RuntimeEvalResultPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "RuntimeEvalStopped",
      RuntimeEvalLifecyclePayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorChangePrepared",
      CreatorChangeLifecyclePayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorChangeApplied",
      CreatorChangeLifecyclePayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorChangeFinalized",
      CreatorChangeLifecyclePayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorCheckpointRolledBack",
      CreatorCheckpointRolledBackPayload
    >
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;

export type BackendToPluginMessage =
  | StudioMessageBase<
      "backend_to_plugin",
      "RequestObservation",
      RequestObservationPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "ExecuteRuntimeEvalPlan",
      ExecuteRuntimeEvalPlanPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "PrepareCreatorChangeSet",
      PrepareCreatorChangeSetPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "ApplyCreatorChangeSet",
      ApplyCreatorChangeSetPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "FinalizeCreatorChangeSet",
      FinalizeCreatorChangeSetPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "RollbackCreatorCheckpoint",
      RollbackCreatorCheckpointPayload
    >;

export type StudioProtocolMessage =
  PluginToBackendMessage | BackendToPluginMessage;
export interface StudioTransport {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribe(
    handler: (message: PluginToBackendMessage) => void | Promise<void>,
  ): () => void;
}

const PLUGIN_MESSAGE_TYPES = new Set<PluginMessageType>([
  "PairProject",
  "UnpairProject",
  "ProjectObservation",
  "SnapshotChunk",
  "RuntimeEvalPlanAccepted",
  "RuntimeEvalStarted",
  "RuntimeEvalResult",
  "RuntimeEvalStopped",
  "CreatorChangePrepared",
  "CreatorChangeApplied",
  "CreatorChangeFinalized",
  "CreatorCheckpointRolledBack",
  "PluginError",
  "Heartbeat",
]);
const BACKEND_MESSAGE_TYPES = new Set<BackendMessageType>([
  "RequestObservation",
  "ExecuteRuntimeEvalPlan",
  "PrepareCreatorChangeSet",
  "ApplyCreatorChangeSet",
  "FinalizeCreatorChangeSet",
  "RollbackCreatorCheckpoint",
]);
const CAPABILITIES: readonly StudioCapability[] = [
  "snapshot",
  "snapshot_chunks",
  "sha256",
  "stable_identity",
  "studio_play_mode",
  "http_polling",
  "bounded_diagnostics",
  "runtime_eval",
  "studio_authoring",
];

export function assertStudioProtocolMessage(
  value: unknown,
): asserts value is StudioProtocolMessage {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProtocolMessage" ||
    !isString(value.type) ||
    !isId(value.messageId) ||
    !isString(value.sentAt) ||
    !isRecord(value.payload)
  )
    throw new Error("Invalid StudioProtocolMessage envelope");
  if (value.direction === "plugin_to_backend") {
    if (!PLUGIN_MESSAGE_TYPES.has(value.type as PluginMessageType))
      throw new Error(`Invalid plugin message type: ${value.type}`);
  } else if (value.direction === "backend_to_plugin") {
    if (!BACKEND_MESSAGE_TYPES.has(value.type as BackendMessageType))
      throw new Error(`Invalid backend message type: ${value.type}`);
  } else throw new Error("Invalid StudioProtocolMessage direction");
  if (value.sessionId !== undefined && !isId(value.sessionId))
    throw new Error("Invalid StudioProtocolMessage sessionId");
  validatePayload(value.type, value.payload);
}

export function assertPluginToBackendMessage(
  value: unknown,
): asserts value is PluginToBackendMessage {
  assertStudioProtocolMessage(value);
  if (value.direction !== "plugin_to_backend")
    throw new Error("Expected plugin_to_backend message");
}
export function assertBackendToPluginMessage(
  value: unknown,
): asserts value is BackendToPluginMessage {
  assertStudioProtocolMessage(value);
  if (value.direction !== "backend_to_plugin")
    throw new Error("Expected backend_to_plugin message");
}

function validatePayload(type: string, payload: Record<string, unknown>): void {
  if (type === "PairProject") {
    if (
      !isString(payload.pairingToken) ||
      !isProjectIdentity(payload.project) ||
      !isExactCapabilities(payload.capabilities)
    )
      throw new Error("Invalid PairProject payload");
    return;
  }
  if (type === "UnpairProject") {
    if (
      !["user", "plugin_unload", "session_replaced"].includes(
        String(payload.reason),
      )
    )
      throw new Error("Invalid UnpairProject payload");
    return;
  }
  if (type === "ProjectObservation") {
    if (
      !isProjectIdentity(payload.project) ||
      !isStudioRevision(payload.revision) ||
      !isObservationReason(payload.reason) ||
      !isRecord(payload.observation)
    )
      throw new Error("Invalid ProjectObservation payload");
    assertStudioSnapshotObservation(payload.observation);
    const observation = payload.observation as StudioSnapshotObservation;
    const project = payload.project as unknown as PluginProjectIdentity;
    const revision = payload.revision as unknown as StudioRevision;
    if (
      observation.project.name !== project.name ||
      observation.project.placeId !== project.placeId ||
      observation.project.universeId !== project.universeId ||
      observation.capturedAt !== revision.capturedAt
    )
      throw new Error("ProjectObservation identity or capture time mismatch");
    return;
  }
  if (type === "SnapshotChunk") {
    if (
      !isProjectIdentity(payload.project) ||
      !isStudioRevision(payload.revision) ||
      !isObservationReason(payload.reason) ||
      !isId(payload.snapshotId) ||
      !isNonNegativeInteger(payload.index) ||
      !isPositiveInteger(payload.total) ||
      payload.total > MAX_SNAPSHOT_CHUNKS ||
      payload.index >= payload.total ||
      payload.encoding !== "json" ||
      !isString(payload.payload) ||
      !isHash(payload.payloadHash) ||
      contentHash(payload.payload) !== payload.payloadHash
    )
      throw new Error("Invalid SnapshotChunk payload");
    return;
  }
  if (type === "Heartbeat") {
    if (
      !isProjectIdentity(payload.project) ||
      (payload.currentSnapshotHash !== undefined &&
        !isHash(payload.currentSnapshotHash))
    )
      throw new Error("Invalid Heartbeat payload");
    return;
  }
  if (type === "PluginError") {
    if (
      ![
        "INVALID_MESSAGE",
        "STALE_SNAPSHOT",
        "WRONG_PROJECT",
        "UNSUPPORTED_OPERATION",
        "TRANSPORT_FAILURE",
        "STUDIO_FAILURE",
        "SECURITY_REJECTION",
        "RECOVERY_REQUIRED",
      ].includes(String(payload.code)) ||
      !isString(payload.message) ||
      typeof payload.retryable !== "boolean"
    )
      throw new Error("Invalid PluginError payload");
    return;
  }
  if (type === "RequestObservation") {
    if (!isId(payload.requestId) || !isObservationReason(payload.reason))
      throw new Error("Invalid RequestObservation payload");
    return;
  }
  if (type === "ExecuteRuntimeEvalPlan") {
    assertExecuteRuntimeEvalPlanPayload(payload);
    return;
  }
  if (type === "RuntimeEvalPlanAccepted") {
    if (
      !isId(payload.executionPlanId) ||
      !isHash(payload.executionPlanHash) ||
      !isExecutionBinding(payload.binding) ||
      !isHash(payload.nonceCommitment) ||
      !isPositiveInteger(payload.callCount) ||
      !isString(payload.instruction)
    )
      throw new Error("Invalid RuntimeEvalPlanAccepted payload");
    return;
  }
  if (type === "RuntimeEvalStarted" || type === "RuntimeEvalStopped") {
    if (
      !isId(payload.executionPlanId) ||
      !isHash(payload.executionPlanHash) ||
      !isExecutionBinding(payload.binding) ||
      !isHash(payload.nonceCommitment) ||
      payload.mode !== "play_solo" ||
      !isNonNegativeInteger(payload.playerCount) ||
      !["plugin_action", "creator_action"].includes(String(payload.control))
    )
      throw new Error(`Invalid ${type} payload`);
    return;
  }
  if (type === "RuntimeEvalResult") {
    assertRuntimeObservationEnvelope(payload);
    return;
  }
  if (
    type === "CreatorChangePrepared" ||
    type === "CreatorChangeApplied" ||
    type === "CreatorChangeFinalized"
  ) {
    assertCreatorLifecycle(payload);
    return;
  }
  if (type === "PrepareCreatorChangeSet") {
    assertPrepareChangeSet(payload);
    return;
  }
  if (type === "ApplyCreatorChangeSet") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.creatorSessionId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isHash(payload.expectedRevision)
    )
      throw new Error("Invalid ApplyCreatorChangeSet payload");
    return;
  }
  if (type === "FinalizeCreatorChangeSet") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.creatorSessionId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isId(payload.recordingId) ||
      !["commit", "cancel"].includes(String(payload.action))
    )
      throw new Error("Invalid FinalizeCreatorChangeSet payload");
    return;
  }
  if (type === "RollbackCreatorCheckpoint") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.creatorSessionId) ||
      !isId(payload.checkpointId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isHash(payload.expectedRevision)
    )
      throw new Error("Invalid RollbackCreatorCheckpoint payload");
    return;
  }
  if (type === "CreatorCheckpointRolledBack") {
    if (
      !isId(payload.creatorSessionId) ||
      !isId(payload.checkpointId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isHash(payload.beforeRevisionHash) ||
      !isHash(payload.afterRevisionHash) ||
      payload.status !== "rolled_back"
    )
      throw new Error("Invalid CreatorCheckpointRolledBack payload");
    return;
  }
  throw new Error(`Unsupported StudioProtocolMessage type: ${type}`);
}

function assertExecuteRuntimeEvalPlanPayload(
  payload: Record<string, unknown>,
): void {
  if (
    !isId(payload.requestId) ||
    !isHash(payload.expectedRevision) ||
    !isString(payload.executionPlanJson) ||
    !isHash(payload.executionPlanJsonHash) ||
    contentHash(payload.executionPlanJson) !== payload.executionPlanJsonHash ||
    !["explicit_plugin_action", "creator_action_already_authorized"].includes(
      String(payload.startPolicy),
    )
  )
    throw new Error("Invalid ExecuteRuntimeEvalPlan payload");
  let plan: unknown;
  try {
    plan = JSON.parse(payload.executionPlanJson);
  } catch {
    throw new Error("ExecuteRuntimeEvalPlan plan is not JSON");
  }
  assertStudioExecutionPlan(plan);
  if (serializeStudioExecutionPlan(plan) !== payload.executionPlanJson)
    throw new Error(
      "ExecuteRuntimeEvalPlan requires one canonical plan JSON string",
    );
  if (plan.binding.projectSnapshotHash !== payload.expectedRevision)
    throw new Error("ExecuteRuntimeEvalPlan revision mismatch");
  if (
    (plan.purpose === "creator_verification") !==
    (payload.startPolicy === "creator_action_already_authorized")
  )
    throw new Error(
      "ExecuteRuntimeEvalPlan start policy does not match its purpose",
    );
}
function assertPrepareChangeSet(payload: Record<string, unknown>): void {
  if (
    !isId(payload.requestId) ||
    !isId(payload.creatorSessionId) ||
    !isHash(payload.expectedRevision) ||
    !isString(payload.changeSetJson) ||
    !isHash(payload.changeSetJsonHash) ||
    contentHash(payload.changeSetJson) !== payload.changeSetJsonHash
  )
    throw new Error("Invalid PrepareCreatorChangeSet payload");
  let changeSet: unknown;
  try {
    changeSet = JSON.parse(payload.changeSetJson);
  } catch {
    throw new Error("Creator change set is not JSON");
  }
  assertCreatorChangeSet(changeSet);
  if (
    serializeCreatorChangeSet(changeSet) !== payload.changeSetJson ||
    changeSet.sessionId !== payload.creatorSessionId ||
    changeSet.expectedRevisionHash !== payload.expectedRevision
  )
    throw new Error("PrepareCreatorChangeSet binding mismatch");
}
function assertCreatorLifecycle(payload: Record<string, unknown>): void {
  if (
    !isId(payload.creatorSessionId) ||
    !isId(payload.changeSetId) ||
    !isHash(payload.changeSetHash) ||
    !isId(payload.recordingId) ||
    !isHash(payload.beforeRevisionHash) ||
    (payload.afterRevisionHash !== undefined &&
      !isHash(payload.afterRevisionHash)) ||
    (payload.inverseMaterialHash !== undefined &&
      !isHash(payload.inverseMaterialHash)) ||
    ![
      "prepared",
      "applied",
      "committed",
      "cancelled",
      "recovery_required",
    ].includes(String(payload.status)) ||
    (payload.action !== undefined &&
      !["commit", "cancel"].includes(String(payload.action)))
  )
    throw new Error("Invalid creator change lifecycle payload");
}
function isExactCapabilities(value: unknown): value is StudioCapability[] {
  return (
    Array.isArray(value) &&
    value.length === CAPABILITIES.length &&
    new Set(value).size === value.length &&
    CAPABILITIES.every((capability) => value.includes(capability))
  );
}
function isProjectIdentity(value: unknown): value is PluginProjectIdentity {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isNonNegativeInteger(value.placeId) &&
    isNonNegativeInteger(value.universeId)
  );
}
function isStudioRevision(value: unknown): value is StudioRevision {
  return (
    isRecord(value) &&
    value.kind === "StudioRevision" &&
    isHash(value.observationHash) &&
    isHash(value.identityHash) &&
    isString(value.capturedAt)
  );
}
function isObservationReason(
  value: unknown,
): value is ProjectObservationReason {
  return (
    value === "pairing" ||
    value === "pre_play" ||
    value === "manual" ||
    value === "pre_apply" ||
    value === "post_apply" ||
    value === "post_rollback"
  );
}
function isExecutionBinding(value: unknown): value is StudioExecutionBinding {
  return (
    isRecord(value) &&
    isId(value.runId) &&
    isId(value.correlationId) &&
    isId(value.sessionId) &&
    isId(value.projectId) &&
    isProjectIdentity(value.project) &&
    isHash(value.projectSnapshotHash) &&
    (value.candidateHash === undefined || isHash(value.candidateHash))
  );
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
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
