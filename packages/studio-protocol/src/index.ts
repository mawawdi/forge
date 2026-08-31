import { contentHash } from "../../contracts/src/index.js";
import { assertStudioSnapshotObservation, type StudioSnapshotObservation } from "../../semantic-map/src/index.js";
import { assertRuntimeObservationEnvelope, assertStudioExecutionPlan, serializeStudioExecutionPlan, type RuntimeObservationEnvelope, type StudioExecutionBinding } from "../../studio-capabilities/src/index.js";

export const STUDIO_PROTOCOL_VERSION = 12 as const;
export const STUDIO_PLUGIN_VERSION = "forge-studio-plugin-8.0.0" as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_CHUNKS = 64;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type PluginMessageType = "PairProject" | "UnpairProject" | "ProjectObservation" | "SnapshotChunk" | "RuntimeEvalPlanAccepted" | "RuntimeEvalStarted" | "RuntimeEvalResult" | "RuntimeEvalStopped" | "PluginError" | "Heartbeat";
export type BackendMessageType = "RequestObservation" | "ExecuteRuntimeEvalPlan";
export interface PluginProjectIdentity { name: string; placeId: number; universeId: number }
export type StudioCapability = "snapshot" | "snapshot_chunks" | "sha256" | "stable_identity" | "studio_play_mode" | "http_polling" | "bounded_diagnostics" | "runtime_eval_v1";

export interface PairProjectPayload { pairingToken: string; project: PluginProjectIdentity; pluginVersion: typeof STUDIO_PLUGIN_VERSION; studioVersion: string; protocolVersion: typeof STUDIO_PROTOCOL_VERSION; capabilities: StudioCapability[] }
export interface UnpairProjectPayload { reason: "user" | "plugin_unload" | "session_replaced" }
export type ProjectObservationReason = "pairing" | "pre_play" | "manual";
export interface StudioRevision { kind: "StudioRevision"; schemaVersion: 1; observationHash: string; identityHash: string; capturedAt: string }
export interface ProjectObservationPayload { project: PluginProjectIdentity; revision: StudioRevision; observation: StudioSnapshotObservation; reason: ProjectObservationReason }
export interface SnapshotChunkPayload { project: PluginProjectIdentity; revision: StudioRevision; reason: ProjectObservationReason; snapshotId: string; index: number; total: number; encoding: "json"; payload: string; payloadHash: string }
export interface PluginErrorPayload { code: "INVALID_MESSAGE" | "STALE_SNAPSHOT" | "WRONG_PROJECT" | "UNSUPPORTED_OPERATION" | "TRANSPORT_FAILURE" | "STUDIO_FAILURE" | "SECURITY_REJECTION"; message: string; retryable: boolean }
export interface HeartbeatPayload { pluginVersion: typeof STUDIO_PLUGIN_VERSION; studioVersion: string; project: PluginProjectIdentity; currentSnapshotHash?: string }
export interface PairingResponse { sessionId: string; sessionToken: string; projectId: string; expiresAt: string }
export interface RequestObservationPayload { requestId: string; reason: ProjectObservationReason }

/** The canonical plan JSON is data. No plan field is executable source. */
export interface ExecuteRuntimeEvalPlanPayload { requestId: string; expectedRevision: string; executionPlanJson: string; executionPlanJsonHash: string }
export interface RuntimeEvalPlanAcceptedPayload { executionPlanId: string; executionPlanHash: string; binding: StudioExecutionBinding; nonceCommitment: string; callCount: number; instruction: string }
export interface RuntimeEvalLifecyclePayload { executionPlanId: string; executionPlanHash: string; binding: StudioExecutionBinding; nonceCommitment: string; mode: "play_solo"; playerCount: number; control: "plugin_action" }
export type RuntimeEvalResultPayload = RuntimeObservationEnvelope;

interface StudioMessageBase<TDirection extends StudioDirection, TType extends string, TPayload> {
  kind: "StudioProtocolMessage"; schemaVersion: typeof STUDIO_PROTOCOL_VERSION; direction: TDirection; type: TType;
  messageId: string; requestId?: string; correlationId?: string; sessionId?: string; sentAt: string; payload: TPayload;
}

export type PluginToBackendMessage =
  | StudioMessageBase<"plugin_to_backend", "PairProject", PairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "UnpairProject", UnpairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "ProjectObservation", ProjectObservationPayload>
  | StudioMessageBase<"plugin_to_backend", "SnapshotChunk", SnapshotChunkPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalPlanAccepted", RuntimeEvalPlanAcceptedPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStarted", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalResult", RuntimeEvalResultPayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStopped", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;

export type BackendToPluginMessage =
  | StudioMessageBase<"backend_to_plugin", "RequestObservation", RequestObservationPayload>
  | StudioMessageBase<"backend_to_plugin", "ExecuteRuntimeEvalPlan", ExecuteRuntimeEvalPlanPayload>;

export type StudioProtocolMessage = PluginToBackendMessage | BackendToPluginMessage;
export interface StudioTransport { send(message: BackendToPluginMessage): Promise<void>; subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void }

const PLUGIN_MESSAGE_TYPES = new Set<PluginMessageType>(["PairProject", "UnpairProject", "ProjectObservation", "SnapshotChunk", "RuntimeEvalPlanAccepted", "RuntimeEvalStarted", "RuntimeEvalResult", "RuntimeEvalStopped", "PluginError", "Heartbeat"]);
const BACKEND_MESSAGE_TYPES = new Set<BackendMessageType>(["RequestObservation", "ExecuteRuntimeEvalPlan"]);
const CAPABILITIES: readonly StudioCapability[] = ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "studio_play_mode", "http_polling", "bounded_diagnostics", "runtime_eval_v1"];

export function assertStudioProtocolMessage(value: unknown): asserts value is StudioProtocolMessage {
  if (!isRecord(value) || value.kind !== "StudioProtocolMessage" || value.schemaVersion !== STUDIO_PROTOCOL_VERSION || !isString(value.type) || !isId(value.messageId) || !isString(value.sentAt) || !isRecord(value.payload)) throw new Error("Invalid StudioProtocolMessage envelope");
  if (value.direction === "plugin_to_backend") {
    if (!PLUGIN_MESSAGE_TYPES.has(value.type as PluginMessageType)) throw new Error(`Invalid plugin message type: ${value.type}`);
  } else if (value.direction === "backend_to_plugin") {
    if (!BACKEND_MESSAGE_TYPES.has(value.type as BackendMessageType)) throw new Error(`Invalid backend message type: ${value.type}`);
  } else throw new Error("Invalid StudioProtocolMessage direction");
  if (value.sessionId !== undefined && !isId(value.sessionId)) throw new Error("Invalid StudioProtocolMessage sessionId");
  validatePayload(value.type, value.payload);
}

export function assertPluginToBackendMessage(value: unknown): asserts value is PluginToBackendMessage { assertStudioProtocolMessage(value); if (value.direction !== "plugin_to_backend") throw new Error("Expected plugin_to_backend message"); }
export function assertBackendToPluginMessage(value: unknown): asserts value is BackendToPluginMessage { assertStudioProtocolMessage(value); if (value.direction !== "backend_to_plugin") throw new Error("Expected backend_to_plugin message"); }

function validatePayload(type: string, payload: Record<string, unknown>): void {
  if (type === "PairProject") {
    if (!isString(payload.pairingToken) || !isProjectIdentity(payload.project) || payload.pluginVersion !== STUDIO_PLUGIN_VERSION || !isString(payload.studioVersion) || payload.protocolVersion !== STUDIO_PROTOCOL_VERSION || !isExactCapabilities(payload.capabilities)) throw new Error("Invalid PairProject payload");
    return;
  }
  if (type === "UnpairProject") { if (!["user", "plugin_unload", "session_replaced"].includes(String(payload.reason))) throw new Error("Invalid UnpairProject payload"); return; }
  if (type === "ProjectObservation") {
    if (!isProjectIdentity(payload.project) || !isStudioRevision(payload.revision) || !isObservationReason(payload.reason) || !isRecord(payload.observation)) throw new Error("Invalid ProjectObservation payload");
    assertStudioSnapshotObservation(payload.observation);
    const observation = payload.observation as StudioSnapshotObservation;
    const project = payload.project as unknown as PluginProjectIdentity;
    const revision = payload.revision as unknown as StudioRevision;
    if (observation.project.name !== project.name || observation.project.placeId !== project.placeId || observation.project.universeId !== project.universeId || observation.capturedAt !== revision.capturedAt) throw new Error("ProjectObservation identity or capture time mismatch");
    return;
  }
  if (type === "SnapshotChunk") { if (!isProjectIdentity(payload.project) || !isStudioRevision(payload.revision) || !isObservationReason(payload.reason) || !isId(payload.snapshotId) || !isNonNegativeInteger(payload.index) || !isPositiveInteger(payload.total) || payload.total > MAX_SNAPSHOT_CHUNKS || payload.index >= payload.total || payload.encoding !== "json" || !isString(payload.payload) || !isHash(payload.payloadHash) || contentHash(payload.payload) !== payload.payloadHash) throw new Error("Invalid SnapshotChunk payload"); return; }
  if (type === "Heartbeat") { if (!isProjectIdentity(payload.project) || payload.pluginVersion !== STUDIO_PLUGIN_VERSION || !isString(payload.studioVersion) || (payload.currentSnapshotHash !== undefined && !isHash(payload.currentSnapshotHash))) throw new Error("Invalid Heartbeat payload"); return; }
  if (type === "PluginError") { if (!["INVALID_MESSAGE", "STALE_SNAPSHOT", "WRONG_PROJECT", "UNSUPPORTED_OPERATION", "TRANSPORT_FAILURE", "STUDIO_FAILURE", "SECURITY_REJECTION"].includes(String(payload.code)) || !isString(payload.message) || typeof payload.retryable !== "boolean") throw new Error("Invalid PluginError payload"); return; }
  if (type === "RequestObservation") { if (!isId(payload.requestId) || !isObservationReason(payload.reason)) throw new Error("Invalid RequestObservation payload"); return; }
  if (type === "ExecuteRuntimeEvalPlan") { assertExecuteRuntimeEvalPlanPayload(payload); return; }
  if (type === "RuntimeEvalPlanAccepted") { if (!isId(payload.executionPlanId) || !isHash(payload.executionPlanHash) || !isExecutionBinding(payload.binding) || !isHash(payload.nonceCommitment) || !isPositiveInteger(payload.callCount) || !isString(payload.instruction)) throw new Error("Invalid RuntimeEvalPlanAccepted payload"); return; }
  if (type === "RuntimeEvalStarted" || type === "RuntimeEvalStopped") { if (!isId(payload.executionPlanId) || !isHash(payload.executionPlanHash) || !isExecutionBinding(payload.binding) || !isHash(payload.nonceCommitment) || payload.mode !== "play_solo" || !isNonNegativeInteger(payload.playerCount) || payload.control !== "plugin_action") throw new Error(`Invalid ${type} payload`); return; }
  if (type === "RuntimeEvalResult") { assertRuntimeObservationEnvelope(payload); return; }
  throw new Error(`Unsupported StudioProtocolMessage type: ${type}`);
}

function assertExecuteRuntimeEvalPlanPayload(payload: Record<string, unknown>): void {
  if (!isId(payload.requestId) || !isHash(payload.expectedRevision) || !isString(payload.executionPlanJson) || !isHash(payload.executionPlanJsonHash) || contentHash(payload.executionPlanJson) !== payload.executionPlanJsonHash) throw new Error("Invalid ExecuteRuntimeEvalPlan payload");
  let plan: unknown;
  try { plan = JSON.parse(payload.executionPlanJson); } catch { throw new Error("ExecuteRuntimeEvalPlan plan is not JSON"); }
  assertStudioExecutionPlan(plan);
  if (serializeStudioExecutionPlan(plan) !== payload.executionPlanJson) throw new Error("ExecuteRuntimeEvalPlan requires one canonical plan JSON string");
  if (plan.binding.projectSnapshotHash !== payload.expectedRevision) throw new Error("ExecuteRuntimeEvalPlan revision mismatch");
}

function isExactCapabilities(value: unknown): value is StudioCapability[] { return Array.isArray(value) && value.length === CAPABILITIES.length && new Set(value).size === value.length && CAPABILITIES.every((capability) => value.includes(capability)); }
function isProjectIdentity(value: unknown): value is PluginProjectIdentity { return isRecord(value) && isString(value.name) && isNonNegativeInteger(value.placeId) && isNonNegativeInteger(value.universeId); }
function isStudioRevision(value: unknown): value is StudioRevision { return isRecord(value) && value.kind === "StudioRevision" && value.schemaVersion === 1 && isHash(value.observationHash) && isHash(value.identityHash) && isString(value.capturedAt); }
function isObservationReason(value: unknown): value is ProjectObservationReason { return value === "pairing" || value === "pre_play" || value === "manual"; }
function isExecutionBinding(value: unknown): value is StudioExecutionBinding { return isRecord(value) && isId(value.runId) && isId(value.correlationId) && isId(value.sessionId) && isId(value.projectId) && isProjectIdentity(value.project) && isHash(value.projectSnapshotHash) && (value.candidateHash === undefined || isHash(value.candidateHash)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
