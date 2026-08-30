import { assertPatchSet, assertStudioAssertion, type PatchSet, type StudioAssertion } from "../../contracts/src/index.js";
import { assertStudioSnapshotObservation, type StudioSnapshotObservation } from "../../semantic-map/src/index.js";

export const STUDIO_PROTOCOL_VERSION = 7 as const;
export const STUDIO_PLUGIN_VERSION = "forge-studio-plugin-3.9.0" as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_CHUNKS = 64;
export const COLLECT_FRUIT_HARNESS_ID = "collect-fruit" as const;
export const COLLECT_FRUIT_HARNESS_VERSION = "collect-fruit-v7" as const;
export const COLLECT_FRUIT_HARNESS_HASH = "984a4ad2ff160f15148cf194dee9c859f12f58f6a7b84dc8b3a7fb6c0c1a5e52" as const;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type PluginMessageType = "PairProject" | "UnpairProject" | "ProjectObservation" | "SnapshotChunk" | "PatchApplied" | "PatchRejected" | "TransactionStarted" | "TransactionCommitted" | "TransactionRolledBack" | "AssertionPlanAccepted" | "PlaytestStarted" | "PlaytestStopped" | "StudioTestResult" | "PluginError" | "Heartbeat";
export type BackendMessageType = "RequestObservation" | "ApplyPatchSet" | "BeginTransaction" | "CommitTransaction" | "RollbackTransaction" | "ExecuteAssertionPlan";

export interface PluginProjectIdentity { name: string; placeId: number; universeId: number; }
export type StudioCapability = "snapshot" | "snapshot_chunks" | "sha256" | "stable_identity" | "typed_patch" | "transaction" | "studio_play_mode" | "http_polling" | "bounded_diagnostics";
export interface PairProjectPayload { pairingToken: string; project: PluginProjectIdentity; pluginVersion: string; studioVersion: string; protocolVersion: 7; capabilities: StudioCapability[]; }
export interface UnpairProjectPayload { reason: "user" | "plugin_unload" | "session_replaced"; }
export type ProjectObservationReason = "pairing" | "pre_patch" | "post_patch" | "pre_play" | "manual" | "rollback";
export interface StudioRevision { kind: "StudioRevision"; schemaVersion: 1; observationHash: string; identityHash: string; capturedAt: string; }
export interface StudioTargetRef { stableId: string; path: string; className: string; sourceHash?: string; }
export interface ProjectObservationPayload { project: PluginProjectIdentity; revision: StudioRevision; observation: StudioSnapshotObservation; reason: ProjectObservationReason; }
export interface SnapshotChunkPayload { project: PluginProjectIdentity; revision: StudioRevision; reason: ProjectObservationReason; snapshotId: string; index: number; total: number; encoding: "json"; payload: string; payloadHash: string; }

export interface StudioPatchPlan { kind: "StudioPatchPlan"; schemaVersion: 1; patchSet: PatchSet; targets: Array<{ opIndex: number; target?: StudioTargetRef }>; }
export interface PatchOperationResult { opId: string; type: string; status: "applied" | "rejected"; target: StudioTargetRef | { path: string; className: string }; expectedBefore?: string | number | boolean; observedBefore?: string | number | boolean; observedAfter?: string | number | boolean; beforeHash?: string; afterHash?: string; error?: string; }
export interface PatchAppliedPayload { patchSetId: string; patchSetHash: string; transactionId?: string; projectSnapshotBefore: string; projectSnapshotAfter: string; operations: PatchOperationResult[]; }
export interface PatchRejectedPayload { patchSetId: string; patchSetHash: string; transactionId?: string; projectSnapshotBefore: string; reason: string; operationResults: PatchOperationResult[]; }
export interface TransactionStatusPayload { transactionId: string; projectSnapshotHash: string; status: "started" | "committed"; }
export interface TransactionRollbackPayload { transactionId: string; projectSnapshotHash: string; status: "rolled_back"; success: boolean; rollback: string; }

export interface StudioRunBinding { projectId: string; sessionId: string; project: PluginProjectIdentity; runId: string; testPlanId: string; correlationId: string; projectSnapshotHash: string; mechanicContractHash: string; nonceCommitment: string; }
/** M3 lifecycle is one user-triggered, plugin-owned Play Solo execution. */
export interface PlaytestPayload extends StudioRunBinding { mode: "play_solo"; playerCount: number; control: "plugin_action"; }
export interface AssertionPlanAcceptedPayload extends StudioRunBinding { assertionCount: number; harnessId: string; harnessVersion: string; instruction: string; }

export interface StudioHarnessEvidence extends StudioRunBinding {
  kind: "StudioHarnessEvidence";
  schemaVersion: 1;
  id: string;
  assertionId: string;
  status: "pass" | "fail" | "not_run" | "unknown";
  expected: string | number | boolean;
  observed: string | number | boolean;
  evidence: Array<{ type: "state" | "remote" | "log" | "error" | "instance"; statement: string; data?: Record<string, string | number | boolean> }>;
  authoritative: boolean;
  durationMs: number;
  emittedAt: string;
  nonce: string;
}
export interface StudioHarnessDiagnostic { context: "server" | "client"; level: "info" | "warning" | "error"; message: string; }
export interface StudioHarnessRunEnvelope extends StudioRunBinding {
  kind: "StudioHarnessRunEnvelope";
  schemaVersion: 1;
  harnessId: string;
  harnessVersion: string;
  harnessHash: string;
  status: "completed" | "failed" | "incomplete";
  authoritative: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  assertions: StudioHarnessEvidence[];
  diagnostics: StudioHarnessDiagnostic[];
  nonce: string;
}
export type StudioTestResultPayload = StudioHarnessRunEnvelope;

export interface PluginErrorPayload { code: "INVALID_MESSAGE" | "STALE_SNAPSHOT" | "WRONG_PROJECT" | "UNSUPPORTED_OPERATION" | "TRANSPORT_FAILURE" | "STUDIO_FAILURE" | "SECURITY_REJECTION"; message: string; retryable: boolean; }
export interface HeartbeatPayload { pluginVersion: string; studioVersion: string; project: PluginProjectIdentity; currentSnapshotHash?: string; }
export interface PairingResponse { sessionId: string; sessionToken: string; projectId: string; expiresAt: string; }
export interface RequestObservationPayload { requestId: string; reason: ProjectObservationReason; }
export interface ApplyPatchSetPayload { requestId: string; transactionId: string; expectedRevision: string; patchSetHash: string; patchPlan: StudioPatchPlan; }
export interface TransactionPayload { requestId: string; transactionId: string; expectedRevision: string; }
export interface ExecuteAssertionPlanPayload extends Omit<StudioRunBinding, "nonceCommitment"> { requestId: string; transactionId: string; expectedRevision: string; assertions: StudioAssertion[]; adversarial: boolean; harnessId: "collect-fruit"; harnessVersion: "collect-fruit-v7"; }

interface StudioMessageBase<TDirection extends StudioDirection, TType extends string, TPayload> { kind: "StudioProtocolMessage"; schemaVersion: 7; direction: TDirection; type: TType; messageId: string; requestId?: string; correlationId?: string; sessionId?: string; sentAt: string; payload: TPayload; }
export type PluginToBackendMessage =
  | StudioMessageBase<"plugin_to_backend", "PairProject", PairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "UnpairProject", UnpairProjectPayload>
  | StudioMessageBase<"plugin_to_backend", "ProjectObservation", ProjectObservationPayload>
  | StudioMessageBase<"plugin_to_backend", "SnapshotChunk", SnapshotChunkPayload>
  | StudioMessageBase<"plugin_to_backend", "PatchApplied", PatchAppliedPayload>
  | StudioMessageBase<"plugin_to_backend", "PatchRejected", PatchRejectedPayload>
  | StudioMessageBase<"plugin_to_backend", "TransactionStarted", TransactionStatusPayload>
  | StudioMessageBase<"plugin_to_backend", "TransactionCommitted", TransactionStatusPayload>
  | StudioMessageBase<"plugin_to_backend", "TransactionRolledBack", TransactionRollbackPayload>
  | StudioMessageBase<"plugin_to_backend", "AssertionPlanAccepted", AssertionPlanAcceptedPayload>
  | StudioMessageBase<"plugin_to_backend", "PlaytestStarted", PlaytestPayload>
  | StudioMessageBase<"plugin_to_backend", "PlaytestStopped", PlaytestPayload>
  | StudioMessageBase<"plugin_to_backend", "StudioTestResult", StudioTestResultPayload>
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;
export type BackendToPluginMessage =
  | StudioMessageBase<"backend_to_plugin", "RequestObservation", RequestObservationPayload>
  | StudioMessageBase<"backend_to_plugin", "ApplyPatchSet", ApplyPatchSetPayload>
  | StudioMessageBase<"backend_to_plugin", "BeginTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "CommitTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "RollbackTransaction", TransactionPayload>
  | StudioMessageBase<"backend_to_plugin", "ExecuteAssertionPlan", ExecuteAssertionPlanPayload>
  ;
export type StudioProtocolMessage = PluginToBackendMessage | BackendToPluginMessage;
export interface StudioTransport { send(message: BackendToPluginMessage): Promise<void>; subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void; }

export function assertStudioProtocolMessage(value: unknown): asserts value is StudioProtocolMessage {
  if (!isRecord(value) || value.kind !== "StudioProtocolMessage" || value.schemaVersion !== STUDIO_PROTOCOL_VERSION || !isString(value.type) || !isString(value.messageId) || !isString(value.sentAt) || !isRecord(value.payload)) throw new Error("Invalid StudioProtocolMessage envelope");
  if (value.direction !== "plugin_to_backend" && value.direction !== "backend_to_plugin") throw new Error("Invalid StudioProtocolMessage direction");
  if (!MESSAGE_TYPES.has(value.type)) throw new Error(`Unsupported StudioProtocolMessage type: ${value.type}`);
  if (value.direction === "plugin_to_backend" && !PLUGIN_MESSAGE_TYPES.has(value.type)) throw new Error(`Invalid plugin message type: ${value.type}`);
  if (value.direction === "backend_to_plugin" && !BACKEND_MESSAGE_TYPES.has(value.type)) throw new Error(`Invalid backend message type: ${value.type}`);
  if (value.sessionId !== undefined && !isString(value.sessionId)) throw new Error("Invalid StudioProtocolMessage sessionId");
  validatePayload(value.type, value.payload);
}
export function assertPluginToBackendMessage(value: unknown): asserts value is PluginToBackendMessage { assertStudioProtocolMessage(value); if (value.direction !== "plugin_to_backend") throw new Error("Expected plugin_to_backend message"); }
export function assertBackendToPluginMessage(value: unknown): asserts value is BackendToPluginMessage { assertStudioProtocolMessage(value); if (value.direction !== "backend_to_plugin") throw new Error("Expected backend_to_plugin message"); }

function validatePayload(type: string, payload: Record<string, unknown>): void {
  if (type === "PairProject" && (!isString(payload.pairingToken) || !isProjectIdentity(payload.project) || payload.pluginVersion !== STUDIO_PLUGIN_VERSION || !isString(payload.studioVersion) || payload.protocolVersion !== STUDIO_PROTOCOL_VERSION || !hasRequiredCapabilities(payload.capabilities))) throw new Error("Invalid PairProject payload");
  if (type === "UnpairProject" && !["user", "plugin_unload", "session_replaced"].includes(String(payload.reason))) throw new Error("Invalid UnpairProject payload");
  if (type === "ProjectObservation") {
    if (!isProjectIdentity(payload.project) || !isStudioRevision(payload.revision) || !isObservationReason(payload.reason) || !isRecord(payload.observation)) throw new Error("Invalid ProjectObservation payload");
    assertStudioSnapshotObservation(payload.observation);
    const observation = payload.observation as StudioSnapshotObservation;
    if (observation.project.name !== payload.project.name || observation.project.placeId !== payload.project.placeId || observation.project.universeId !== payload.project.universeId || observation.capturedAt !== (payload.revision as unknown as StudioRevision).capturedAt) throw new Error("ProjectObservation identity or capture time mismatch");
  }
  if (type === "SnapshotChunk" && (!isProjectIdentity(payload.project) || !isStudioRevision(payload.revision) || !isObservationReason(payload.reason) || !isString(payload.snapshotId) || !isNonNegativeInteger(payload.index) || !isPositiveInteger(payload.total) || payload.total > MAX_SNAPSHOT_CHUNKS || payload.index >= payload.total || payload.encoding !== "json" || !isString(payload.payload) || !isString(payload.payloadHash))) throw new Error("Invalid SnapshotChunk payload");
  if (type === "Heartbeat" && (!isProjectIdentity(payload.project) || !isString(payload.pluginVersion) || !isString(payload.studioVersion))) throw new Error("Invalid Heartbeat payload");
  if (type === "PatchApplied" && (!isString(payload.patchSetId) || !isString(payload.patchSetHash) || !isString(payload.projectSnapshotBefore) || !isString(payload.projectSnapshotAfter) || !Array.isArray(payload.operations) || !payload.operations.every(isPatchOperationResult))) throw new Error("Invalid PatchApplied payload");
  if (type === "PatchRejected" && (!isString(payload.patchSetId) || !isString(payload.patchSetHash) || !isString(payload.projectSnapshotBefore) || !isString(payload.reason) || !Array.isArray(payload.operationResults) || !payload.operationResults.every(isPatchOperationResult))) throw new Error("Invalid PatchRejected payload");
  if (["TransactionStarted", "TransactionCommitted"].includes(type) && (!isString(payload.transactionId) || !isString(payload.projectSnapshotHash) || !["started", "committed"].includes(String(payload.status)))) throw new Error(`Invalid ${type} payload`);
  if (type === "TransactionRolledBack" && (!isString(payload.transactionId) || !isString(payload.projectSnapshotHash) || payload.status !== "rolled_back" || typeof payload.success !== "boolean" || !isString(payload.rollback))) throw new Error("Invalid TransactionRolledBack payload");
  if (type === "AssertionPlanAccepted" && (!isRunBinding(payload) || !isPositiveInteger(payload.assertionCount) || !isString(payload.harnessId) || !isString(payload.harnessVersion) || !isString(payload.instruction))) throw new Error("Invalid AssertionPlanAccepted payload");
  if (["PlaytestStarted", "PlaytestStopped"].includes(type) && (!isRunBinding(payload) || payload.mode !== "play_solo" || payload.control !== "plugin_action" || !isNonNegativeInteger(payload.playerCount))) throw new Error(`Invalid ${type} payload`);
  if (type === "StudioTestResult" && !isHarnessRunEnvelope(payload)) throw new Error("Invalid StudioTestResult payload");
  if (type === "PluginError" && (!isString(payload.code) || !isString(payload.message) || typeof payload.retryable !== "boolean")) throw new Error("Invalid PluginError payload");
  if (type === "RequestObservation" && (!isString(payload.requestId) || !isObservationReason(payload.reason))) throw new Error("Invalid RequestObservation payload");
  if (type === "ApplyPatchSet" && (!isString(payload.requestId) || !isString(payload.transactionId) || !isString(payload.expectedRevision) || !isString(payload.patchSetHash) || !isStudioPatchPlan(payload.patchPlan))) throw new Error("Invalid ApplyPatchSet payload");
  if (["BeginTransaction", "CommitTransaction", "RollbackTransaction"].includes(type) && (!isString(payload.requestId) || !isString(payload.transactionId) || !isString(payload.expectedRevision))) throw new Error(`Invalid ${type} payload`);
  if (type === "ExecuteAssertionPlan" && (!isString(payload.requestId) || !isString(payload.transactionId) || !isRunBindingWithoutNonce(payload) || !isString(payload.expectedRevision) || !Array.isArray(payload.assertions) || payload.assertions.length < 1 || payload.harnessId !== COLLECT_FRUIT_HARNESS_ID || payload.harnessVersion !== COLLECT_FRUIT_HARNESS_VERSION || typeof payload.adversarial !== "boolean")) throw new Error("Invalid ExecuteAssertionPlan payload");
  if (type === "ExecuteAssertionPlan") for (const assertion of payload.assertions as unknown[]) assertStudioAssertion(assertion);
}

function isProjectIdentity(value: unknown): value is PluginProjectIdentity { return isRecord(value) && isString(value.name) && isNonNegativeInteger(value.placeId) && isNonNegativeInteger(value.universeId); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isPrimitive(value: unknown): value is string | number | boolean { return isString(value) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)); }
function hasRequiredCapabilities(value: unknown): value is StudioCapability[] { return Array.isArray(value) && ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"].every((capability) => value.includes(capability)); }
function isStudioRevision(value: unknown): value is StudioRevision { return isRecord(value) && value.kind === "StudioRevision" && value.schemaVersion === 1 && isSha256(value.observationHash) && isSha256(value.identityHash) && isString(value.capturedAt); }
function isStudioTargetRef(value: unknown): boolean { return isRecord(value) && isString(value.stableId) && isString(value.path) && isString(value.className) && (value.sourceHash === undefined || isString(value.sourceHash)); }
function isStudioPatchPlan(value: unknown): boolean { if (!isRecord(value) || value.kind !== "StudioPatchPlan" || value.schemaVersion !== 1 || !isRecord(value.patchSet) || !Array.isArray(value.targets)) return false; try { assertPatchSet(value.patchSet); } catch { return false; } const patchSet = value.patchSet as PatchSet; return value.targets.every((target) => isRecord(target) && isNonNegativeInteger(target.opIndex) && target.opIndex < patchSet.operations.length && (target.target === undefined || isStudioTargetRef(target.target))); }
function isRunBinding(value: Record<string, unknown>): boolean { return isRunBindingWithoutNonce(value) && isString(value.nonceCommitment) && value.nonceCommitment.length >= 32; }
function isRunBindingWithoutNonce(value: Record<string, unknown>): boolean { return isString(value.projectId) && isString(value.sessionId) && isProjectIdentity(value.project) && isString(value.runId) && isString(value.testPlanId) && isString(value.correlationId) && isString(value.projectSnapshotHash) && isString(value.mechanicContractHash); }
function isAssertionEvidence(value: unknown): boolean { return isRecord(value) && ["state", "remote", "log", "error", "instance"].includes(String(value.type)) && isString(value.statement) && (value.data === undefined || (isRecord(value.data) && Object.values(value.data).every(isPrimitive))); }
function isHarnessEvidence(value: unknown): value is StudioHarnessEvidence { return isRecord(value) && value.kind === "StudioHarnessEvidence" && value.schemaVersion === 1 && isRunBinding(value) && isString(value.nonce) && value.nonce.length >= 16 && isString(value.id) && isString(value.assertionId) && ["pass", "fail", "not_run", "unknown"].includes(String(value.status)) && isPrimitive(value.expected) && isPrimitive(value.observed) && Array.isArray(value.evidence) && value.evidence.every(isAssertionEvidence) && value.authoritative === true && isNonNegativeNumber(value.durationMs) && isString(value.emittedAt); }
function isHarnessRunEnvelope(value: unknown): value is StudioHarnessRunEnvelope { return isRecord(value) && value.kind === "StudioHarnessRunEnvelope" && value.schemaVersion === 1 && isRunBinding(value) && isString(value.nonce) && value.nonce.length >= 16 && isString(value.harnessId) && isString(value.harnessVersion) && isString(value.harnessHash) && ["completed", "failed", "incomplete"].includes(String(value.status)) && value.authoritative === true && isString(value.startedAt) && isString(value.endedAt) && isNonNegativeNumber(value.durationMs) && Array.isArray(value.assertions) && value.assertions.length > 0 && value.assertions.length <= 64 && value.assertions.every(isHarnessEvidence) && value.assertions.every((assertion) => assertion.nonce === value.nonce) && Array.isArray(value.diagnostics) && value.diagnostics.length <= 128 && value.diagnostics.every(isDiagnostic); }
function isDiagnostic(value: unknown): boolean { return isRecord(value) && ["server", "client"].includes(String(value.context)) && ["info", "warning", "error"].includes(String(value.level)) && isString(value.message) && value.message.length <= 4000; }
function isNonNegativeNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isSha256(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isObservationReason(value: unknown): value is ProjectObservationReason { return ["pairing", "pre_patch", "post_patch", "pre_play", "manual", "rollback"].includes(String(value)); }
function isPatchOperationResult(value: unknown): boolean { return isRecord(value) && isString(value.opId) && isString(value.type) && (value.status === "applied" || value.status === "rejected") && (isStudioTargetRef(value.target) || (isRecord(value.target) && isString(value.target.path) && isString(value.target.className))) && (value.expectedBefore === undefined || isPrimitive(value.expectedBefore)) && (value.observedBefore === undefined || isPrimitive(value.observedBefore)) && (value.observedAfter === undefined || isPrimitive(value.observedAfter)) && (value.beforeHash === undefined || isString(value.beforeHash)) && (value.afterHash === undefined || isString(value.afterHash)) && (value.error === undefined || isString(value.error)); }

const PLUGIN_MESSAGE_TYPES = new Set<string>(["PairProject", "UnpairProject", "ProjectObservation", "SnapshotChunk", "PatchApplied", "PatchRejected", "TransactionStarted", "TransactionCommitted", "TransactionRolledBack", "AssertionPlanAccepted", "PlaytestStarted", "PlaytestStopped", "StudioTestResult", "PluginError", "Heartbeat"]);
const BACKEND_MESSAGE_TYPES = new Set<string>(["RequestObservation", "ApplyPatchSet", "BeginTransaction", "CommitTransaction", "RollbackTransaction", "ExecuteAssertionPlan"]);
const MESSAGE_TYPES = new Set<string>([...PLUGIN_MESSAGE_TYPES, ...BACKEND_MESSAGE_TYPES]);
