import type { PatchSet, ProofBundle, StudioAssertion } from "../../contracts/src/index.js";
import type { ProjectSnapshot, StudioSnapshotObservation } from "../../semantic-map/src/index.js";

export const STUDIO_PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type PluginMessageType = "PluginHello" | "ProjectConnected" | "ProjectSnapshot" | "ProjectDelta" | "PatchApplied" | "PatchRejected" | "PlaytestStarted" | "PlaytestStopped" | "AssertionResult" | "RuntimeEvidence" | "StudioOutput" | "PluginError" | "Heartbeat";
export type BackendMessageType = "PairProject" | "RequestSnapshot" | "ApplyPatchSet" | "BeginTransaction" | "CommitTransaction" | "RollbackTransaction" | "StartPlaytest" | "StopPlaytest" | "ExecuteAssertionPlan" | "RequestRuntimeState" | "PairAccepted" | "PairRejected";

export interface PluginProjectIdentity {
  name: string;
  placeId: number;
  universeId: number;
}

export interface PluginHelloPayload {
  pluginVersion: string;
  studioVersion: string;
  supportedProtocolVersions: [1];
  capabilities: Array<"snapshot" | "patch" | "transaction" | "playtest" | "assertions" | "runtime_state" | "http_polling">;
}

export interface PairProjectPayload {
  pairingToken: string;
  project: PluginProjectIdentity;
  pluginVersion: string;
  studioVersion: string;
}

export interface ProjectConnectedPayload {
  project: PluginProjectIdentity;
  sessionId: string;
  snapshot: ProjectSnapshot;
}

export interface ProjectSnapshotPayload {
  project: PluginProjectIdentity;
  snapshot: ProjectSnapshot;
  observation: StudioSnapshotObservation;
}

export interface ProjectDeltaPayload {
  baseSnapshotHash: string;
  afterSnapshotHash: string;
  changes: Array<{ type: "InstanceCreated" | "InstanceRemoved" | "InstanceMoved" | "PropertyChanged" | "AttributeChanged" | "ScriptSourceChanged"; path: string; detail: string }>;
}

export interface PatchOperationResult {
  opId: string;
  status: "applied" | "rejected";
  target: string;
  beforeHash?: string;
  afterHash?: string;
  error?: string;
}

export interface PatchAppliedPayload {
  patchSetId: string;
  transactionId?: string;
  projectSnapshotBefore: string;
  projectSnapshotAfter: string;
  operations: PatchOperationResult[];
}

export interface PatchRejectedPayload {
  patchSetId: string;
  transactionId?: string;
  projectSnapshotBefore: string;
  reason: string;
  operationResults: PatchOperationResult[];
}

export interface PlaytestPayload {
  runId: string;
  mode: "play" | "run" | "multiplayer";
  playerCount: number;
  studioTestResult?: string;
}

export interface AssertionResultPayload {
  id: string;
  runId: string;
  testPlanId: string;
  assertionId: string;
  status: "pass" | "fail" | "not_run" | "unknown";
  expected: string | number | boolean;
  observed: string | number | boolean;
  evidence: Array<{ type: "state" | "remote" | "log" | "error" | "instance"; statement: string; data?: Record<string, string | number | boolean> }>;
  authoritative: boolean;
  durationMs: number;
}

export interface RuntimeEvidencePayload {
  runId: string;
  testPlanId: string;
  projectSnapshotHash: string;
  instances: Array<{ path: string; className: string; properties: Record<string, string | number | boolean>; attributes: Record<string, string | number | boolean> }>;
  logs: string[];
  errors: string[];
  serverAuthorityObserved: boolean;
}

export interface StudioOutputPayload {
  runId?: string;
  stream: "output" | "warning" | "error";
  text: string;
  occurredAt: string;
}

export interface PluginErrorPayload {
  code: "INVALID_MESSAGE" | "STALE_SNAPSHOT" | "WRONG_PROJECT" | "UNSUPPORTED_OPERATION" | "TRANSPORT_FAILURE" | "STUDIO_FAILURE" | "SECURITY_REJECTION";
  message: string;
  retryable: boolean;
}

export interface HeartbeatPayload {
  pluginVersion: string;
  studioVersion: string;
  project: PluginProjectIdentity;
  currentSnapshotHash?: string;
}

export interface PairAcceptedPayload {
  sessionId: string;
  sessionToken: string;
  projectId: string;
  expiresAt: string;
}

export interface PairProjectCommandPayload {
  projectId: string;
  pairingToken: string;
  expiresAt: string;
}

export interface PairRejectedPayload {
  reason: string;
  retryable: boolean;
}

export interface RequestSnapshotPayload { requestId: string; reason: "pairing" | "pre_patch" | "post_patch" | "manual"; }
export interface ApplyPatchSetPayload { requestId: string; transactionId: string; expectedSnapshotHash: string; patchSet: PatchSet; }
export interface TransactionPayload { requestId: string; transactionId: string; expectedSnapshotHash: string; }
export interface StartPlaytestPayload { requestId: string; runId: string; mode: "play" | "run" | "multiplayer"; playerCount: number; args: Record<string, string | number | boolean>; }
export interface StopPlaytestPayload { requestId: string; runId: string; }
export interface ExecuteAssertionPlanPayload { requestId: string; runId: string; testPlanId: string; assertions: StudioAssertion[]; adversarial: boolean; }
export interface RequestRuntimeStatePayload { requestId: string; runId: string; paths: string[]; }

interface StudioMessageBase<TDirection extends StudioDirection, TType extends string, TPayload> {
  kind: "StudioProtocolMessage";
  schemaVersion: 1;
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
  | StudioMessageBase<"plugin_to_backend", "PluginHello", PluginHelloPayload>
  | StudioMessageBase<"plugin_to_backend", "PairProject", PairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "ProjectConnected", ProjectConnectedPayload>
  | StudioMessageBase<"plugin_to_backend", "ProjectSnapshot", ProjectSnapshotPayload>
  | StudioMessageBase<"plugin_to_backend", "ProjectDelta", ProjectDeltaPayload>
  | StudioMessageBase<"plugin_to_backend", "PatchApplied", PatchAppliedPayload>
  | StudioMessageBase<"plugin_to_backend", "PatchRejected", PatchRejectedPayload>
  | StudioMessageBase<"plugin_to_backend", "PlaytestStarted", PlaytestPayload>
  | StudioMessageBase<"plugin_to_backend", "PlaytestStopped", PlaytestPayload>
  | StudioMessageBase<"plugin_to_backend", "AssertionResult", AssertionResultPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvidence", RuntimeEvidencePayload>
  | StudioMessageBase<"plugin_to_backend", "StudioOutput", StudioOutputPayload>
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;

export type BackendToPluginMessage =
  | StudioMessageBase<"backend_to_plugin", "PairProject", PairProjectCommandPayload>
  | StudioMessageBase<"backend_to_plugin", "PairAccepted", PairAcceptedPayload>
  | StudioMessageBase<"backend_to_plugin", "PairRejected", PairRejectedPayload>
  | StudioMessageBase<"backend_to_plugin", "RequestSnapshot", RequestSnapshotPayload>
  | StudioMessageBase<"backend_to_plugin", "ApplyPatchSet", ApplyPatchSetPayload>
  | StudioMessageBase<"backend_to_plugin", "BeginTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "CommitTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "RollbackTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "StartPlaytest", StartPlaytestPayload>
  | StudioMessageBase<"backend_to_plugin", "StopPlaytest", StopPlaytestPayload>
  | StudioMessageBase<"backend_to_plugin", "ExecuteAssertionPlan", ExecuteAssertionPlanPayload>
  | StudioMessageBase<"backend_to_plugin", "RequestRuntimeState", RequestRuntimeStatePayload>;

export type StudioProtocolMessage = PluginToBackendMessage | BackendToPluginMessage;

export interface StudioTransport {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void;
}

export function assertStudioProtocolMessage(value: unknown): asserts value is StudioProtocolMessage {
  if (!isRecord(value) || value.kind !== "StudioProtocolMessage" || value.schemaVersion !== 1 || !isString(value.type) || !isString(value.messageId) || !isString(value.sentAt) || !isRecord(value.payload)) throw new Error("Invalid StudioProtocolMessage envelope");
  if (value.direction !== "plugin_to_backend" && value.direction !== "backend_to_plugin") throw new Error("Invalid StudioProtocolMessage direction");
  if (!MESSAGE_TYPES.has(value.type)) throw new Error(`Unsupported StudioProtocolMessage type: ${value.type}`);
  if (value.direction === "plugin_to_backend" && !PLUGIN_MESSAGE_TYPES.has(value.type)) throw new Error(`Invalid plugin message type: ${value.type}`);
  if (value.direction === "backend_to_plugin" && !BACKEND_MESSAGE_TYPES.has(value.type)) throw new Error(`Invalid backend message type: ${value.type}`);
  if (value.sessionId !== undefined && !isString(value.sessionId)) throw new Error("Invalid StudioProtocolMessage sessionId");
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
  if (type === "PluginHello" && (!isString(payload.pluginVersion) || !isString(payload.studioVersion) || !Array.isArray(payload.supportedProtocolVersions) || !payload.supportedProtocolVersions.includes(1))) throw new Error("Invalid PluginHello payload");
  if (type === "PairProject" && (!isString(payload.pairingToken) || !isProjectIdentity(payload.project))) throw new Error("Invalid PairProject payload");
  if (type === "ProjectSnapshot" && (!isProjectIdentity(payload.project) || !isRecord(payload.snapshot) || !isRecord(payload.observation))) throw new Error("Invalid ProjectSnapshot payload");
  if (type === "Heartbeat" && (!isProjectIdentity(payload.project) || !isString(payload.pluginVersion) || !isString(payload.studioVersion))) throw new Error("Invalid Heartbeat payload");
  if ((type === "PatchApplied" || type === "PatchRejected") && !isString(payload.patchSetId)) throw new Error(`Invalid ${type} payload`);
  if (type === "AssertionResult" && (!isString(payload.id) || !isString(payload.runId) || !isString(payload.testPlanId) || !isString(payload.assertionId) || typeof payload.authoritative !== "boolean")) throw new Error("Invalid AssertionResult payload");
  if (type === "RuntimeEvidence" && (!isString(payload.runId) || !isString(payload.testPlanId))) throw new Error("Invalid RuntimeEvidence payload");
  if (type === "StudioOutput" && (!isString(payload.text) || !isString(payload.stream))) throw new Error("Invalid StudioOutput payload");
  if (type === "PluginError" && (!isString(payload.code) || !isString(payload.message) || typeof payload.retryable !== "boolean")) throw new Error("Invalid PluginError payload");
  if (type === "PairAccepted" && (!isString(payload.sessionId) || !isString(payload.sessionToken) || !isString(payload.projectId) || !isString(payload.expiresAt))) throw new Error("Invalid PairAccepted payload");
  if (type === "PairRejected" && (!isString(payload.reason) || typeof payload.retryable !== "boolean")) throw new Error("Invalid PairRejected payload");
}

function isProjectIdentity(value: unknown): value is PluginProjectIdentity { return isRecord(value) && isString(value.name) && typeof value.placeId === "number" && typeof value.universeId === "number"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }

const PLUGIN_MESSAGE_TYPES = new Set<string>(["PluginHello", "PairProject", "ProjectConnected", "ProjectSnapshot", "ProjectDelta", "PatchApplied", "PatchRejected", "PlaytestStarted", "PlaytestStopped", "AssertionResult", "RuntimeEvidence", "StudioOutput", "PluginError", "Heartbeat"]);
const BACKEND_MESSAGE_TYPES = new Set<string>(["PairProject", "PairAccepted", "PairRejected", "RequestSnapshot", "ApplyPatchSet", "BeginTransaction", "CommitTransaction", "RollbackTransaction", "StartPlaytest", "StopPlaytest", "ExecuteAssertionPlan", "RequestRuntimeState"]);
const MESSAGE_TYPES = new Set<string>([...PLUGIN_MESSAGE_TYPES, ...BACKEND_MESSAGE_TYPES]);
