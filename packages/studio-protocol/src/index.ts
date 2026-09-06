import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  CREATOR_DEFAULT_RESOURCE_POLICY,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceProjection,
  assertCreatorResourcePolicy,
  assertCreatorSourceWriteBlobManifest,
  assertStudioProjectIndexProjection,
  assertStudioProjectRevision,
  serializeStudioEvidenceProjection,
  projectIndexHash,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectIndexManifest,
  type StudioProjectIndexProjection,
  type StudioProjectRevision,
  type CreatorResourcePolicy,
  type CreatorSourceWriteBlobManifest,
  type StudioProjectIdentity,
} from "../../studio-evidence/src/index.js";

/** A typed evidence shard is bounded at four MiB by CreatorResourcePolicy. */
/** Every index artifact is fragmented below this envelope-sized cap. */
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
/**
 * Plugin evidence is a logical protocol message whose canonical JSON may be
 * larger than one HTTP request. Every such message uses the same ordered,
 * hash-bound transport; direct delivery is rejected by the bridge.
 */
export const MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const STUDIO_SEMANTIC_FRAGMENT_BYTES = 256 * 1024;
export const MAX_STUDIO_SEMANTIC_PIECES = 65;
/** Complete project indexes stream bounded canonical-JSON fragments. */
export const MAX_PROJECT_INDEX_PIECES = 4_194_304;
export const PROJECT_INDEX_FRAGMENT_BYTES = 256 * 1024;
/**
 * Prepare is a logical document, not one poll response. Its aggregate bound is
 * the same explicit one-GiB canonical-material policy used by project indexes;
 * every physical command remains below the one-MiB protocol limit.
 */
export const MAX_CREATOR_PREPARE_DOCUMENT_BYTES =
  CREATOR_DEFAULT_RESOURCE_POLICY.maximumCanonicalIndexBytes;
/** Leaves room for two enclosing JSON string-escaping layers in /poll. */
export const BACKEND_COMMAND_FRAGMENT_BYTES = 192 * 1024;
/** A failure receipt retains one bounded, hash-bound diagnostic body. */
export const MAX_CREATOR_FAILURE_DETAIL_BYTES = 4 * 1024;

export type StudioDirection = "plugin_to_backend" | "backend_to_plugin";
export type StudioEvidenceReason =
  "pairing" | "manual" | "pre_play" | "pre_apply" | "runtime" | "capability_attestation";

export type PluginMessageType =
  | "PairProject"
  | "UnpairProject"
  /** Settles one exact hash-bound backend command as executed or rejected. */
  | "StudioCommandSettled"
  | "StudioProjectIndexStarted"
  | "StudioProjectEvidenceShard"
  | "StudioSourceBlobManifest"
  | "StudioSourceBlobChunk"
  | "StudioProjectIndexCompleted"
  | "StudioProjectChangeDetected"
  | "StudioEvidenceProduced"
  | "StudioSemanticMessageStarted"
  | "StudioSemanticMessageChunk"
  | "StudioSemanticMessageCompleted"
  | "CreatorSourceWriteBlobAccepted"
  | "RuntimeEvalPlanAccepted"
  | "RuntimeEvalStarted"
  | "RuntimeEvalStopped"
  | "PassiveRuntimeEvalFinalized"
  | "CreatorChangePrepared"
  | "CreatorChangePreflighted"
  | "CreatorMutationProvisional"
  | "CreatorMutationFailed"
  | "CreatorChangeFinalized"
  | "CreatorRecordingRecovery"
  | "CreatorClosedRecordingAcknowledged"
  | "CreatorCheckpointRolledBack"
  | "StudioProjectIdentityFinalized"
  | "PluginError"
  | "StudioPlaytestObserved"
  | "Heartbeat";

export type BackendMessageType =
  | "CollectStudioProjectIndex"
  | "CreatorSourceWriteBlobStarted"
  | "CreatorSourceWriteBlobChunk"
  | "CreatorSourceWriteBlobCompleted"
  | "RequestStudioEvidence"
  | "ExecuteRuntimeEvalPlan"
  | "FinalizePassiveRuntimeEval"
  | "CreatorChangePrepareStarted"
  | "CreatorChangePrepareChunk"
  | "CreatorChangePrepareCompleted"
  | "PreflightCreatorChangeSet"
  | "ApplyCreatorChangeSet"
  | "FinalizeCreatorChangeSet"
  | "RequestCreatorRecordingRecovery"
  | "AcknowledgeClosedCreatorRecording"
  | "CancelInterruptedRecording"
  | "AcknowledgeCreatorChangeFinalization"
  | "RollbackCreatorCheckpoint"
  | "LinkStudioProject"
  | "ForkStudioProject"
  | "AbandonOpeningStudioProjectIdentity"
  | "CancelInterruptedStudioProjectIdentity"
  | "SettleClosedStudioProjectIdentity"
  | "AcknowledgeStudioProjectIdentityFinalization";

export type PluginProjectIdentity = StudioProjectIdentity;
export type StudioCapability =
  | "studio_evidence"
  | "studio_project_index"
  | "opaque_identity"
  | "project_change_monitor"
  | "semantic_message_stream"
  | "sha256"
  | "stable_identity"
  | "reflection_attestation"
  | "detached_preflight"
  | "transactional_authoring"
  | "recording_recovery"
  | "studio_play_mode"
  | "bounded_diagnostics"
  | "project_identity"
  | "http_polling";

export type StudioProjectIdentityAttributeState =
  | { readonly status: "absent" }
  | { readonly status: "observed"; readonly forgeProjectId: string }
  | { readonly status: "invalid"; readonly valueType: string };

/** Read-only identity observation emitted at pairing and heartbeat boundaries. */
export interface StudioProjectIdentityState {
  readonly kind: "StudioProjectIdentityState";
  readonly project: PluginProjectIdentity;
  readonly platform:
    | { readonly kind: "local" }
    | { readonly kind: "published"; readonly universeId: number; readonly placeId: number };
  readonly reservedAttribute: StudioProjectIdentityAttributeState;
  readonly hash: string;
}

export interface StudioProjectIdentityOperation {
  readonly kind: "StudioProjectIdentityOperation";
  readonly id: string;
  readonly hash: string;
  readonly action: "link" | "fork";
  readonly project: PluginProjectIdentity;
  readonly connectorEpoch: string;
  readonly expectedIdentity: StudioProjectIdentityState;
  readonly assignedForgeProjectId: string;
}

export interface StudioProjectIdentityFinalizationReceipt {
  readonly kind: "StudioProjectIdentityFinalizationReceipt";
  readonly id: string;
  readonly hash: string;
  readonly operation: StudioProjectIdentityOperation;
  readonly action: "link" | "fork";
  readonly beforeIdentity: StudioProjectIdentityState;
  readonly afterIdentity: StudioProjectIdentityState;
  /** Absent only when recovery proves the persisted opening intent never opened any recording. */
  readonly recordingId?: string;
  readonly finalization: "ordinary" | "recovery_abandon" | "recovery_cancel" | "recovery_settle";
  readonly status: "linked" | "forked" | "cancelled";
  readonly completedAt: string;
  readonly failureDetail?: string;
}

export type StudioProjectIdentityTransactionInventory =
  | { readonly status: "none" }
  | {
      readonly status: "pending";
      readonly operation: StudioProjectIdentityOperation;
      readonly phase: "opening" | "open" | "finalizing";
      readonly cursorHash: string;
      readonly recordingState: "open" | "not_open" | "unknown";
      readonly recordingId?: string;
      readonly finalization?: "commit" | "cancel";
      readonly failureDetail?: string;
    }
  | {
      readonly status: "finalized";
      readonly receipt: StudioProjectIdentityFinalizationReceipt;
    };

/**
 * A rejected Link/Fork command carries a direct, command-bound observation of
 * the identity and recording boundary after the handler returned. A rejected
 * command is not itself proof that it made no Studio change.
 */
export type StudioProjectIdentityRejectionEvidence =
  | {
      readonly kind: "StudioProjectIdentityRejectionEvidence";
      readonly operationId: string;
      readonly operationHash: string;
      readonly status: "observed";
      readonly identity: StudioProjectIdentityState;
      readonly transaction: StudioProjectIdentityTransactionInventory;
      readonly recordingState: "open" | "not_open" | "unknown";
    }
  | {
      readonly kind: "StudioProjectIdentityRejectionEvidence";
      readonly operationId: string;
      readonly operationHash: string;
      readonly status: "unavailable";
      readonly detail: string;
    };

export interface StudioProjectIdentityCommandPayload {
  readonly requestId: string;
  readonly operation: StudioProjectIdentityOperation;
  readonly operationHash: string;
}

export interface CancelInterruptedStudioProjectIdentityPayload {
  readonly requestId: string;
  readonly operationId: string;
  readonly operationHash: string;
  readonly transactionCursorHash: string;
  readonly recordingId: string;
  readonly expectedIdentityStateHash: string;
}

/**
 * Creator authority to settle an interrupted pre-recording identity intent.
 * Studio may honor this only while the exact opening cursor and before-state
 * still match and ChangeHistoryService proves that no recording is open.
 */
export interface AbandonOpeningStudioProjectIdentityPayload {
  readonly requestId: string;
  readonly operationId: string;
  readonly operationHash: string;
  readonly transactionCursorHash: string;
  readonly expectedIdentityStateHash: string;
}

export interface AcknowledgeStudioProjectIdentityFinalizationPayload {
  readonly requestId: string;
  readonly receiptId: string;
  readonly receiptHash: string;
}

export interface SettleClosedStudioProjectIdentityPayload {
  readonly requestId: string;
  readonly operationId: string;
  readonly operationHash: string;
  readonly transactionCursorHash: string;
  readonly recordingId: string;
  readonly expectedIdentityStateHash: string;
  readonly expectedFinalization: "commit" | "cancel";
}

export interface StudioProjectIdentityFinalizedPayload {
  readonly requestId: string;
  readonly receipt: StudioProjectIdentityFinalizationReceipt;
}

function canonicalProjectIdentityAttribute(
  value: StudioProjectIdentityAttributeState,
): StudioProjectIdentityAttributeState {
  if (value.status === "absent") {
    if (!hasOnlyKeys(value, ["status"])) fail("StudioProjectIdentityState");
    return { status: "absent" };
  }
  if (value.status === "observed") {
    if (
      !hasOnlyKeys(value, ["forgeProjectId", "status"]) ||
      !isForgeProjectId(value.forgeProjectId)
    )
      fail("StudioProjectIdentityState");
    return { status: "observed", forgeProjectId: value.forgeProjectId };
  }
  if (
    value.status !== "invalid" ||
    !hasOnlyKeys(value, ["status", "valueType"]) ||
    !isBoundedText(value.valueType, 1, 64)
  )
    fail("StudioProjectIdentityState");
  return { status: "invalid", valueType: value.valueType };
}

export function createStudioProjectIdentityState(input: {
  readonly project: PluginProjectIdentity;
  readonly reservedAttribute: StudioProjectIdentityAttributeState;
}): StudioProjectIdentityState {
  if (!isStudioProjectIdentityProject(input.project)) fail("StudioProjectIdentityState");
  const project = {
    name: input.project.name,
    placeId: input.project.placeId,
    universeId: input.project.universeId,
  };
  const platform =
    project.placeId === 0 && project.universeId === 0
      ? ({ kind: "local" } as const)
      : ({
          kind: "published" as const,
          universeId: project.universeId,
          placeId: project.placeId,
        } as const);
  const semantic = {
    kind: "StudioProjectIdentityState" as const,
    project,
    platform,
    reservedAttribute: canonicalProjectIdentityAttribute(input.reservedAttribute),
  };
  return { ...semantic, hash: projectIndexHash(semantic) };
}

export function assertStudioProjectIdentityState(
  value: unknown,
): asserts value is StudioProjectIdentityState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["hash", "kind", "platform", "project", "reservedAttribute"]) ||
    value.kind !== "StudioProjectIdentityState" ||
    !isStudioProjectIdentityProject(value.project) ||
    !hasOnlyKeys(value.project as unknown as Record<string, unknown>, [
      "name",
      "placeId",
      "universeId",
    ]) ||
    !isRecord(value.platform) ||
    !isRecord(value.reservedAttribute) ||
    !isHash(value.hash)
  )
    fail("StudioProjectIdentityState");
  const canonical = createStudioProjectIdentityState({
    project: value.project,
    reservedAttribute: value.reservedAttribute as StudioProjectIdentityAttributeState,
  });
  if (stableJson(canonical) !== stableJson(value)) fail("StudioProjectIdentityState");
}

export function createStudioProjectIdentityOperation(input: {
  readonly action: "link" | "fork";
  readonly project: PluginProjectIdentity;
  readonly connectorEpoch: string;
  readonly expectedIdentity: StudioProjectIdentityState;
  readonly assignedForgeProjectId: string;
}): StudioProjectIdentityOperation {
  assertStudioProjectIdentityState(input.expectedIdentity);
  if (
    !isStudioProjectIdentityProject(input.project) ||
    !sameProject(input.project, input.expectedIdentity.project) ||
    input.project.placeId !== 0 ||
    input.project.universeId !== 0 ||
    !isHash(input.connectorEpoch) ||
    !isForgeProjectId(input.assignedForgeProjectId) ||
    (input.action !== "link" && input.action !== "fork") ||
    (input.action === "link" && input.expectedIdentity.reservedAttribute.status !== "absent") ||
    (input.action === "fork" && input.expectedIdentity.reservedAttribute.status !== "observed") ||
    (input.expectedIdentity.reservedAttribute.status === "observed" &&
      input.expectedIdentity.reservedAttribute.forgeProjectId === input.assignedForgeProjectId)
  )
    fail("StudioProjectIdentityOperation");
  const semantic = {
    kind: "StudioProjectIdentityOperation" as const,
    action: input.action,
    project: {
      name: input.project.name,
      placeId: input.project.placeId,
      universeId: input.project.universeId,
    },
    connectorEpoch: input.connectorEpoch,
    expectedIdentity: input.expectedIdentity,
    assignedForgeProjectId: input.assignedForgeProjectId,
  };
  const hash = projectIndexHash(semantic);
  return {
    ...semantic,
    id: `studio_project_identity_operation_${hash.slice(0, 24)}`,
    hash,
  };
}

export function assertStudioProjectIdentityOperation(
  value: unknown,
): asserts value is StudioProjectIdentityOperation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "action",
      "assignedForgeProjectId",
      "connectorEpoch",
      "expectedIdentity",
      "hash",
      "id",
      "kind",
      "project",
    ]) ||
    value.kind !== "StudioProjectIdentityOperation" ||
    !isRecord(value.expectedIdentity)
  )
    fail("StudioProjectIdentityOperation");
  const canonical = createStudioProjectIdentityOperation({
    action: value.action as "link" | "fork",
    project: value.project as PluginProjectIdentity,
    connectorEpoch: value.connectorEpoch as string,
    expectedIdentity: value.expectedIdentity as unknown as StudioProjectIdentityState,
    assignedForgeProjectId: value.assignedForgeProjectId as string,
  });
  if (stableJson(canonical) !== stableJson(value)) fail("StudioProjectIdentityOperation");
}

export function createStudioProjectIdentityFinalizationReceipt(input: {
  readonly operation: StudioProjectIdentityOperation;
  readonly beforeIdentity: StudioProjectIdentityState;
  readonly afterIdentity: StudioProjectIdentityState;
  readonly recordingId?: string;
  readonly finalization: "ordinary" | "recovery_abandon" | "recovery_cancel" | "recovery_settle";
  readonly status: "linked" | "forked" | "cancelled";
  readonly completedAt: string;
  readonly failureDetail?: string;
}): StudioProjectIdentityFinalizationReceipt {
  assertStudioProjectIdentityOperation(input.operation);
  assertStudioProjectIdentityState(input.beforeIdentity);
  assertStudioProjectIdentityState(input.afterIdentity);
  const successStatus = input.operation.action === "link" ? "linked" : "forked";
  const succeeded = input.status === successStatus;
  if (
    (input.finalization === "recovery_abandon"
      ? input.recordingId !== undefined
      : !isBoundedIdentifier(input.recordingId, 512)) ||
    !isStudioProjectIdentityTimestamp(input.completedAt) ||
    !["ordinary", "recovery_abandon", "recovery_cancel", "recovery_settle"].includes(
      input.finalization,
    ) ||
    (input.failureDetail !== undefined && !isBoundedText(input.failureDetail, 1, 4 * 1024)) ||
    (input.status !== "cancelled" && input.failureDetail !== undefined) ||
    (input.status === "cancelled" &&
      ((input.finalization === "ordinary" && input.failureDetail === undefined) ||
        (["recovery_abandon", "recovery_cancel"].includes(input.finalization) &&
          input.failureDetail !== undefined))) ||
    stableJson(input.beforeIdentity) !== stableJson(input.operation.expectedIdentity) ||
    (input.status !== "cancelled" && !succeeded) ||
    (["recovery_abandon", "recovery_cancel"].includes(input.finalization) &&
      input.status !== "cancelled") ||
    (input.status === "cancelled" &&
      stableJson(input.afterIdentity) !== stableJson(input.beforeIdentity)) ||
    (succeeded &&
      (input.afterIdentity.reservedAttribute.status !== "observed" ||
        input.afterIdentity.reservedAttribute.forgeProjectId !==
          input.operation.assignedForgeProjectId ||
        !sameProject(input.afterIdentity.project, input.operation.project)))
  )
    fail("StudioProjectIdentityFinalizationReceipt");
  const semantic = {
    kind: "StudioProjectIdentityFinalizationReceipt" as const,
    operation: input.operation,
    action: input.operation.action,
    beforeIdentity: input.beforeIdentity,
    afterIdentity: input.afterIdentity,
    ...(input.recordingId === undefined ? {} : { recordingId: input.recordingId }),
    finalization: input.finalization,
    status: input.status,
    completedAt: input.completedAt,
    ...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
  };
  const hash = projectIndexHash(semantic);
  return {
    ...semantic,
    id: `studio_project_identity_receipt_${hash.slice(0, 24)}`,
    hash,
  };
}

export function assertStudioProjectIdentityFinalizationReceipt(
  value: unknown,
): asserts value is StudioProjectIdentityFinalizationReceipt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      value.failureDetail === undefined
        ? [
            "action",
            "afterIdentity",
            "beforeIdentity",
            "completedAt",
            "finalization",
            "hash",
            "id",
            "kind",
            "operation",
            ...(value.recordingId === undefined ? [] : ["recordingId"]),
            "status",
          ]
        : [
            "action",
            "afterIdentity",
            "beforeIdentity",
            "completedAt",
            "failureDetail",
            "finalization",
            "hash",
            "id",
            "kind",
            "operation",
            ...(value.recordingId === undefined ? [] : ["recordingId"]),
            "status",
          ],
    ) ||
    !isRecord(value.operation) ||
    !isRecord(value.beforeIdentity) ||
    !isRecord(value.afterIdentity)
  )
    fail("StudioProjectIdentityFinalizationReceipt");
  const canonical = createStudioProjectIdentityFinalizationReceipt({
    operation: value.operation as unknown as StudioProjectIdentityOperation,
    beforeIdentity: value.beforeIdentity as unknown as StudioProjectIdentityState,
    afterIdentity: value.afterIdentity as unknown as StudioProjectIdentityState,
    ...(value.recordingId === undefined ? {} : { recordingId: value.recordingId as string }),
    finalization: value.finalization as
      "ordinary" | "recovery_abandon" | "recovery_cancel" | "recovery_settle",
    status: value.status as "linked" | "forked" | "cancelled",
    completedAt: value.completedAt as string,
    ...(value.failureDetail === undefined ? {} : { failureDetail: value.failureDetail as string }),
  });
  if (stableJson(canonical) !== stableJson(value)) fail("StudioProjectIdentityFinalizationReceipt");
}

export function assertStudioProjectIdentityTransactionInventory(
  value: unknown,
): asserts value is StudioProjectIdentityTransactionInventory {
  if (!isRecord(value)) fail("StudioProjectIdentityTransactionInventory");
  if (value.status === "none") {
    if (!hasOnlyKeys(value, ["status"])) fail("StudioProjectIdentityTransactionInventory");
    return;
  }
  if (value.status === "finalized") {
    if (!hasOnlyKeys(value, ["receipt", "status"]))
      fail("StudioProjectIdentityTransactionInventory");
    assertStudioProjectIdentityFinalizationReceipt(value.receipt);
    return;
  }
  if (
    value.status !== "pending" ||
    !hasOnlyKeys(
      value,
      value.phase === "opening"
        ? ["cursorHash", "operation", "phase", "recordingState", "status"]
        : value.phase === "open"
          ? ["cursorHash", "operation", "phase", "recordingId", "recordingState", "status"]
          : [
              "cursorHash",
              "finalization",
              ...(value.failureDetail === undefined ? [] : ["failureDetail"]),
              "operation",
              "phase",
              "recordingId",
              "recordingState",
              "status",
            ],
    ) ||
    !isRecord(value.operation) ||
    !["opening", "open", "finalizing"].includes(String(value.phase)) ||
    !["open", "not_open", "unknown"].includes(String(value.recordingState)) ||
    !isHash(value.cursorHash) ||
    (value.recordingId !== undefined && !isBoundedIdentifier(value.recordingId, 512)) ||
    (value.failureDetail !== undefined && !isBoundedText(value.failureDetail, 1, 4 * 1024)) ||
    (value.phase === "opening" &&
      !["not_open", "unknown"].includes(String(value.recordingState))) ||
    (value.failureDetail !== undefined &&
      (value.phase !== "finalizing" || value.finalization !== "cancel")) ||
    (value.phase === "finalizing" && !["commit", "cancel"].includes(String(value.finalization)))
  )
    fail("StudioProjectIdentityTransactionInventory");
  assertStudioProjectIdentityOperation(value.operation);
  const operation = value.operation as StudioProjectIdentityOperation;
  const cursorMaterial = {
    kind: "StudioProjectIdentityTransactionCursor" as const,
    operation,
    beforeIdentity: operation.expectedIdentity,
    phase: value.phase as "opening" | "open" | "finalizing",
    ...(value.recordingId === undefined ? {} : { recordingId: value.recordingId }),
    ...(value.finalization === undefined ? {} : { finalization: value.finalization }),
    ...(value.failureDetail === undefined ? {} : { failureDetail: value.failureDetail }),
  };
  if (projectIndexHash(cursorMaterial) !== value.cursorHash)
    fail("StudioProjectIdentityTransactionInventory");
}

/** Validates the closed observation attached to a rejected Link/Fork command. */
export function assertStudioProjectIdentityRejectionEvidence(
  value: unknown,
): asserts value is StudioProjectIdentityRejectionEvidence {
  if (!isRecord(value)) fail("StudioProjectIdentityRejectionEvidence");
  if (
    value.status === "unavailable" &&
    hasOnlyKeys(value, ["detail", "kind", "operationHash", "operationId", "status"]) &&
    value.kind === "StudioProjectIdentityRejectionEvidence" &&
    isBoundedIdentifier(value.operationId, 512) &&
    isHash(value.operationHash) &&
    isBoundedText(value.detail, 1, MAX_CREATOR_FAILURE_DETAIL_BYTES)
  )
    return;
  if (
    value.status !== "observed" ||
    !hasOnlyKeys(value, [
      "identity",
      "kind",
      "operationHash",
      "operationId",
      "recordingState",
      "status",
      "transaction",
    ]) ||
    value.kind !== "StudioProjectIdentityRejectionEvidence" ||
    !isBoundedIdentifier(value.operationId, 512) ||
    !isHash(value.operationHash) ||
    !isRecord(value.identity) ||
    !isRecord(value.transaction) ||
    !["open", "not_open", "unknown"].includes(String(value.recordingState))
  )
    fail("StudioProjectIdentityRejectionEvidence");
  assertStudioProjectIdentityState(value.identity);
  assertStudioProjectIdentityTransactionInventory(value.transaction);
  const transaction = value.transaction as StudioProjectIdentityTransactionInventory;
  if (
    (transaction.status === "pending" &&
      (transaction.recordingState !== value.recordingState ||
        !sameProject(transaction.operation.project, value.identity.project))) ||
    (transaction.status === "finalized" &&
      (!sameProject(transaction.receipt.operation.project, value.identity.project) ||
        transaction.receipt.afterIdentity.hash !== value.identity.hash))
  )
    fail("StudioProjectIdentityRejectionEvidence");
}

/**
 * The only no-effect conclusion admitted from a rejected identity command.
 * Callers still need to bind the proof to the exact command settlement.
 */
export function identityRejectionProvesNoEffect(
  operation: StudioProjectIdentityOperation,
  proof: StudioProjectIdentityRejectionEvidence | undefined,
): boolean {
  assertStudioProjectIdentityOperation(operation);
  if (proof === undefined || proof.status !== "observed") return false;
  assertStudioProjectIdentityRejectionEvidence(proof);
  return (
    proof.operationId === operation.id &&
    proof.operationHash === operation.hash &&
    proof.identity.hash === operation.expectedIdentity.hash &&
    proof.transaction.status === "none" &&
    proof.recordingState === "not_open"
  );
}

export interface PairProjectPayload {
  pairingToken: string;
  project: PluginProjectIdentity;
  projectIdentity: StudioProjectIdentityState;
  projectIdentityTransaction: StudioProjectIdentityTransactionInventory;
  capabilities: StudioCapability[];
  connectorBuildHash: string;
  manifestHash: string;
}
export interface UnpairProjectPayload {
  reason: "user" | "plugin_unload" | "session_replaced";
}

/**
 * A bridge-level terminal receipt, deliberately separate from semantic Studio
 * evidence and mutation receipts. It says only whether the plugin command
 * handler completed or rejected; its diagnostic fields never establish a
 * semantic Studio claim. The command hash binds the settlement to the exact
 * command body retained by the bridge.
 */
export type StudioCommandSettledPayload =
  | {
      readonly commandMessageId: string;
      readonly commandHash: string;
      readonly disposition: "executed";
    }
  | {
      readonly commandMessageId: string;
      readonly commandHash: string;
      readonly disposition: "rejected";
      readonly classification: "SECURITY_REJECTION" | "STUDIO_FAILURE" | "RECOVERY_REQUIRED";
      readonly detail: string;
      /** Required by the bridge only for rejected Link/Fork commands. */
      readonly identityRejection?: StudioProjectIdentityRejectionEvidence;
    };

export interface StudioEvidenceProducedPayload {
  project: PluginProjectIdentity;
  reason: StudioEvidenceReason;
  projection: StudioEvidenceProjection;
  envelope: StudioEvidenceEnvelope;
}
/** Project indexing is read-only and streams separately content-addressed leaves. */
export interface CollectStudioProjectIndexPayload {
  requestId: string;
  resourcePolicy: CreatorResourcePolicy;
  projection: StudioProjectIndexProjection;
}
/**
 * Pre-Prepare source-write transport. The logical leaves are exactly the
 * resource-policy chunk size; their canonical JSON is further fragmented for
 * the protocol envelope. No source body may occur in a change set message.
 */
export interface CreatorSourceWriteBlobStartedPayload {
  readonly requestId: string;
  readonly manifest: CreatorSourceWriteBlobManifest;
  readonly pieceCount: number;
}
export interface CreatorSourceWriteBlobChunkPayload {
  readonly requestId: string;
  readonly manifestId: string;
  readonly sequence: number;
  readonly artifact: {
    readonly kind: "CreatorSourceWriteBlobChunk";
    readonly id: string;
    readonly hash: string;
  };
  readonly fragmentOrdinal: number;
  readonly fragmentCount: number;
  readonly encoding: "json";
  readonly payload: string;
  readonly payloadHash: string;
}
export interface CreatorSourceWriteBlobCompletedPayload {
  readonly requestId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly pieceCount: number;
}
export interface CreatorSourceWriteBlobAcceptedPayload {
  readonly requestId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly status: "accepted";
}
export interface StudioProjectIndexStartedPayload {
  project: PluginProjectIdentity;
  captureId: string;
  projection: StudioProjectIndexProjection;
  pieceCount: number;
  expectedShardCount: number;
  expectedSourceManifestCount: number;
  expectedSourceChunkCount: number;
  expectedCanonicalBytes: number;
  /** Change monitor epoch captured immediately before enumeration. */
  detectorEpoch: number;
}
export interface StudioProjectIndexArtifactFragmentPayload {
  project: PluginProjectIdentity;
  captureId: string;
  sequence: number;
  artifact: {
    readonly kind:
      "StudioProjectEvidenceShard" | "StudioSourceBlobManifest" | "StudioSourceBlobChunk";
    readonly id: string;
    readonly hash: string;
  };
  fragmentOrdinal: number;
  fragmentCount: number;
  encoding: "json";
  payload: string;
  payloadHash: string;
}
/** Bounded header; source-manifest hashes are reconstructed from streamed leaves. */
export interface StudioProjectIndexCompletedPayload {
  project: PluginProjectIdentity;
  captureId: string;
  pieceCount: number;
  indexManifest: Omit<StudioProjectIndexManifest, "sourceManifestHashes"> & {
    readonly sourceManifestCount: number;
  };
  revision: StudioProjectRevision;
  captureHash: string;
  /** Must equal Started; a dirty event makes the whole collection unusable. */
  detectorEpoch: number;
}
/**
 * The one closed vocabulary for advisory project-change notifications.
 *
 * Keep runtime validation and every downstream evidence consumer bound to this
 * exported value.  A duplicate local list can accept a valid wire message and
 * then fail after it has already influenced transaction control flow.
 */
export const STUDIO_PROJECT_CHANGE_SOURCES = [
  "attribute",
  "change_history",
  "hierarchy",
  "monitoring_failure",
  "property",
  "script_editor",
  "undo_redo",
] as const;
export type StudioProjectChangeSource = (typeof STUDIO_PROJECT_CHANGE_SOURCES)[number];
/** A dirty signal is deliberately not a Studio revision or a state observation. */
export interface StudioProjectChangeDetectedPayload {
  project: PluginProjectIdentity;
  connectorEpoch: string;
  epoch: number;
  observedAt: string;
  sources: readonly StudioProjectChangeSource[];
}
export type StudioStreamedSemanticType =
  "StudioEvidenceProduced" | "CreatorChangePreflighted" | "CreatorMutationProvisional";
export interface StudioSemanticMessageBoundaryPayload {
  readonly transferId: string;
  readonly documentHash: string;
  readonly utf8Bytes: number;
  readonly pieceCount: number;
  readonly semanticType: StudioStreamedSemanticType;
  readonly semanticMessageId: string;
  readonly semanticRequestId?: string;
}
export interface StudioSemanticMessageChunkPayload {
  readonly transferId: string;
  readonly documentHash: string;
  readonly sequence: number;
  encoding: "json";
  readonly payload: string;
  readonly payloadHash: string;
}
export interface PluginErrorPayload {
  code:
    | "INVALID_MESSAGE"
    | "STALE_EVIDENCE"
    | "WRONG_PROJECT"
    | "INCOMPATIBLE_MANIFEST"
    | "UNSUPPORTED_OPERATION"
    | "TRANSPORT_FAILURE"
    | "STUDIO_FAILURE"
    | "SECURITY_REJECTION"
    | "RECOVERY_REQUIRED";
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
  beforeProjectIndexManifestId: string;
  beforeProjectRevisionHash: string;
  /** Monitor epoch bound to the complete pre-recording project capture. */
  beforeProjectDetectorEpoch: number;
  recordingId: string;
}
export interface HeartbeatPayload {
  project: PluginProjectIdentity;
  projectIdentity: StudioProjectIdentityState;
  manifestHash: string;
  currentProjectIndexManifestId?: string;
  currentProjectRevisionHash?: string;
  activeRecording?: RecordingBinding;
}

/** Advisory server log context from an ordinary creator Play session. No pass/fail authority. */
export interface StudioPlaytestObservation {
  observationId: string;
  projectId: string;
  baselineRevisionHash: string;
  connectorBuildHash: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  diagnostics: Array<{ severity: "error" | "warning"; message: string }>;
  truncated: boolean;
}

export function assertStudioPlaytestObservation(
  value: unknown,
): asserts value is StudioPlaytestObservation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "observationId",
      "projectId",
      "baselineRevisionHash",
      "connectorBuildHash",
      "startedAt",
      "endedAt",
      "durationMs",
      "diagnostics",
      "truncated",
    ]) ||
    !isId(value.observationId) ||
    !isId(value.projectId) ||
    !isHash(value.baselineRevisionHash) ||
    !isHash(value.connectorBuildHash) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.endedAt !== "string" ||
    !Number.isFinite(Date.parse(value.endedAt)) ||
    Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 86_400_000 ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 32 ||
    !value.diagnostics.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["severity", "message"]) &&
        ["error", "warning"].includes(String(entry.severity)) &&
        typeof entry.message === "string" &&
        entry.message.length <= 512,
    ) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error("Invalid Studio Play observation");
}
export interface PairingResponse {
  sessionId: string;
  sessionToken: string;
  projectId: string;
  conversationProjectId: string;
  projectIdentity: StudioProjectIdentityState;
  projectIdentityTransaction: StudioProjectIdentityTransactionInventory;
  manifestHash: string;
  connectorBuildHash: string;
  capabilityAttestationProjectionJson: string;
  capabilityAttestationProjectionJsonHash: string;
  capabilityAttestationProjectionHash: string;
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
  expectedProjectRevisionHash: string;
  executionPlanJson: string;
  executionPlanJsonHash: string;
  evidenceProjectionJson: string;
  evidenceProjectionJsonHash: string;
  evidenceProjectionHash: string;
  startPolicy: "explicit_plugin_action" | "observe_next_creator_play";
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
export interface RuntimeEvalPlanAcceptedPayload extends Omit<
  RuntimeEvalLifecyclePayload,
  "mode" | "playerCount" | "control"
> {
  callCount: number;
  instruction: string;
}
export interface FinalizePassiveRuntimeEvalPayload extends Omit<
  RuntimeEvalLifecyclePayload,
  "mode" | "playerCount" | "control"
> {
  requestId: string;
}
export interface PassiveRuntimeEvalFinalizedPayload extends Omit<
  RuntimeEvalLifecyclePayload,
  "mode" | "playerCount" | "control"
> {
  status: "cleared";
}
/**
 * Exact logical input to Studio's pure Prepare phase. This document is
 * canonicalized and hash-bound before it is split into settled commands.
 */
export interface CreatorChangePrepareDocument {
  requestId: string;
  creatorSessionId: string;
  expectedProjectRevisionHash: string;
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
  /** Immutable project-index capture that produced the expected revision. */
  beforeProjectIndexManifestId: string;
  beforeProjectRevisionHash: string;
  beforeProjectDetectorEpoch: number;
}
export interface CreatorChangePrepareStartedPayload {
  readonly requestId: string;
  readonly transferId: string;
  readonly documentHash: string;
  readonly utf8Bytes: number;
  readonly pieceCount: number;
}
export interface CreatorChangePrepareChunkPayload {
  readonly requestId: string;
  readonly transferId: string;
  readonly documentHash: string;
  readonly sequence: number;
  readonly encoding: "json";
  readonly payload: string;
  readonly payloadHash: string;
}
export interface CreatorChangePrepareCompletedPayload {
  readonly requestId: string;
  readonly transferId: string;
  readonly documentHash: string;
  readonly utf8Bytes: number;
  readonly pieceCount: number;
}
export interface CreatorChangePrepareTransfer {
  readonly transferId: string;
  readonly documentHash: string;
  readonly utf8Bytes: number;
  readonly fragments: readonly {
    readonly sequence: number;
    readonly payload: string;
    readonly payloadHash: string;
  }[];
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
  beforeProjectIndexManifestId: string;
  beforeProjectRevisionHash: string;
  beforeProjectDetectorEpoch: number;
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
  beforeProjectIndexManifestId: string;
  beforeProjectRevisionHash: string;
  beforeProjectDetectorEpoch: number;
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
  expectedProjectRevisionHash: string;
  beforeProjectIndexManifestId: string;
  beforeProjectDetectorEpoch: number;
}
export interface ApplyCreatorChangeSetPayload {
  requestId: string;
  creatorSessionId: string;
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  manifestHash: string;
  expectedProjectRevisionHash: string;
  beforeProjectIndexManifestId: string;
  beforeProjectDetectorEpoch: number;
}
export interface CreatorMutationProvisionalPayload extends RecordingBinding {
  directReadbackEvidence: StudioEvidenceEnvelope;
  postApplyProjectIndexManifestId: string;
  postApplyProjectRevisionHash: string;
  /** Monitor epoch sampled with the complete post-Apply project index. */
  postApplyProjectDetectorEpoch: number;
  status: "provisional";
}
/**
 * A finalization is legal only against the exact complete project capture
 * observed by the host immediately before it issued the command.  The monitor
 * epoch is an ingress ordering fence, not a revision claim.
 */
export interface CreatorFinalizationGate extends RecordingBinding {
  action: "commit" | "cancel";
  /** Distinguishes an ordinary finalization from an explicit recovery cancel. */
  finalizationKind: "ordinary" | "recovery_cancel";
  /** Exact displaced intent action; absent when cancellation starts from an open cursor. */
  replacesAction?: "commit" | "cancel";
  expectedCurrentProjectIndexManifestId: string;
  expectedCurrentProjectRevisionHash: string;
  expectedCurrentProjectDetectorEpoch: number;
}
export interface CreatorMutationFailedPayload extends Omit<RecordingBinding, "recordingId"> {
  /** The detached preflight projection is part of the same sealed transaction. */
  preflightProjectionId: string;
  preflightProjectionHash: string;
  /** Present only after Studio has durably opened the exact recording. */
  recordingId?: string;
  stage: "preflight" | "apply" | "readback" | "post_state" | "cancel" | "commit";
  failureCode: string;
  /** Exact bounded diagnostic from the plugin failure boundary. */
  failureDetail: string;
  /** SHA-256 of failureDetail's exact UTF-8 bytes. */
  failureDetailHash: string;
  recordingState: "not_open" | "open" | "finalizing" | "unknown";
  cancellationProven?: boolean;
}
export interface FinalizeCreatorChangeSetPayload extends CreatorFinalizationGate {
  requestId: string;
  finalizationKind: "ordinary";
}
export interface CreatorChangeFinalizedPayload extends CreatorFinalizationGate {
  status: "committed" | "cancelled" | "recovery_required";
  afterProjectIndexManifestId: string;
  afterProjectRevisionHash: string;
  /** Monitor epoch sampled with the complete post-finalization capture. */
  afterProjectDetectorEpoch: number;
}
/**
 * The backend sends this only after it has persisted the exact finalization
 * receipt.  Until then, the plugin retains and re-emits the receipt across
 * restart; acknowledgement is a notification acknowledgement, never a Studio
 * mutation command.
 */
export interface AcknowledgeCreatorChangeFinalizationPayload extends CreatorFinalizationGate {
  requestId: string;
  status: "committed" | "cancelled";
  afterProjectIndexManifestId: string;
  afterProjectRevisionHash: string;
  afterProjectDetectorEpoch: number;
}
export interface RequestCreatorRecordingRecoveryPayload extends RecordingBinding {
  requestId: string;
}
export type CreatorRecordingCancellationAuthority =
  { kind: "open" } | { kind: "replace_intent"; action: "commit" | "cancel" };
export type CreatorRecordingRecoveryPayload =
  | {
      recordingState: "none";
      /**
       * Present only when this inventory report is the plugin's durable
       * confirmation that it consumed the exact finalization acknowledgement.
       */
      finalizationRequestId?: string;
    }
  | (RecordingBinding & {
      recordingState: "open" | "not_open" | "finalizing" | "unknown";
      recoveryProjectIndexManifestId: string;
      recoveryProjectRevisionHash: string;
      /** Monitor epoch sampled with the complete recovery project index. */
      recoveryProjectDetectorEpoch: number;
      /** Exact currently available cancellation authority; absent after an uncertain recovery Finish. */
      cancellation?: CreatorRecordingCancellationAuthority;
      finalizationRequestId?: string;
    });
export interface AcknowledgeClosedCreatorRecordingPayload extends RecordingBinding {
  requestId: string;
  recoveryProjectIndexManifestId: string;
  recoveryProjectRevisionHash: string;
  recoveryProjectDetectorEpoch: number;
}
export interface CreatorClosedRecordingAcknowledgedPayload extends RecordingBinding {
  recoveryProjectIndexManifestId: string;
  recoveryProjectRevisionHash: string;
  recoveryProjectDetectorEpoch: number;
  status: "closed_cursor_cleared";
}
export interface CancelInterruptedRecordingPayload extends CreatorFinalizationGate {
  requestId: string;
  action: "cancel";
  finalizationKind: "recovery_cancel";
}
export interface RollbackCreatorCheckpointPayload {
  requestId: string;
  creatorSessionId: string;
  checkpointId: string;
  changeSetId: string;
  changeSetHash: string;
  expectedProjectRevisionHash: string;
}
export interface CreatorCheckpointRolledBackPayload {
  creatorSessionId: string;
  checkpointId: string;
  changeSetId: string;
  changeSetHash: string;
  beforeProjectRevisionHash: string;
  afterProjectIndexManifestId: string;
  afterProjectRevisionHash: string;
  afterProjectDetectorEpoch: number;
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
  | StudioMessageBase<"plugin_to_backend", "StudioCommandSettled", StudioCommandSettledPayload>
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioProjectIndexStarted",
      StudioProjectIndexStartedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioProjectEvidenceShard",
      StudioProjectIndexArtifactFragmentPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioSourceBlobManifest",
      StudioProjectIndexArtifactFragmentPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioSourceBlobChunk",
      StudioProjectIndexArtifactFragmentPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioProjectIndexCompleted",
      StudioProjectIndexCompletedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioProjectChangeDetected",
      StudioProjectChangeDetectedPayload
    >
  | StudioMessageBase<"plugin_to_backend", "StudioEvidenceProduced", StudioEvidenceProducedPayload>
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioSemanticMessageStarted",
      StudioSemanticMessageBoundaryPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioSemanticMessageChunk",
      StudioSemanticMessageChunkPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioSemanticMessageCompleted",
      StudioSemanticMessageBoundaryPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorSourceWriteBlobAccepted",
      CreatorSourceWriteBlobAcceptedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "RuntimeEvalPlanAccepted",
      RuntimeEvalPlanAcceptedPayload
    >
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStarted", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<"plugin_to_backend", "RuntimeEvalStopped", RuntimeEvalLifecyclePayload>
  | StudioMessageBase<
      "plugin_to_backend",
      "PassiveRuntimeEvalFinalized",
      PassiveRuntimeEvalFinalizedPayload
    >
  | StudioMessageBase<"plugin_to_backend", "CreatorChangePrepared", CreatorChangePreparedPayload>
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorChangePreflighted",
      CreatorChangePreflightedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorMutationProvisional",
      CreatorMutationProvisionalPayload
    >
  | StudioMessageBase<"plugin_to_backend", "CreatorMutationFailed", CreatorMutationFailedPayload>
  | StudioMessageBase<"plugin_to_backend", "CreatorChangeFinalized", CreatorChangeFinalizedPayload>
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorRecordingRecovery",
      CreatorRecordingRecoveryPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorClosedRecordingAcknowledged",
      CreatorClosedRecordingAcknowledgedPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "CreatorCheckpointRolledBack",
      CreatorCheckpointRolledBackPayload
    >
  | StudioMessageBase<
      "plugin_to_backend",
      "StudioProjectIdentityFinalized",
      StudioProjectIdentityFinalizedPayload
    >
  | StudioMessageBase<"plugin_to_backend", "PluginError", PluginErrorPayload>
  | StudioMessageBase<"plugin_to_backend", "StudioPlaytestObserved", StudioPlaytestObservation>
  | StudioMessageBase<"plugin_to_backend", "Heartbeat", HeartbeatPayload>;
export type BackendToPluginMessage =
  | StudioMessageBase<
      "backend_to_plugin",
      "CollectStudioProjectIndex",
      CollectStudioProjectIndexPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorSourceWriteBlobStarted",
      CreatorSourceWriteBlobStartedPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorSourceWriteBlobChunk",
      CreatorSourceWriteBlobChunkPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorSourceWriteBlobCompleted",
      CreatorSourceWriteBlobCompletedPayload
    >
  | StudioMessageBase<"backend_to_plugin", "RequestStudioEvidence", RequestStudioEvidencePayload>
  | StudioMessageBase<"backend_to_plugin", "ExecuteRuntimeEvalPlan", ExecuteRuntimeEvalPlanPayload>
  | StudioMessageBase<
      "backend_to_plugin",
      "FinalizePassiveRuntimeEval",
      FinalizePassiveRuntimeEvalPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorChangePrepareStarted",
      CreatorChangePrepareStartedPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorChangePrepareChunk",
      CreatorChangePrepareChunkPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CreatorChangePrepareCompleted",
      CreatorChangePrepareCompletedPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "PreflightCreatorChangeSet",
      PreflightCreatorChangeSetPayload
    >
  | StudioMessageBase<"backend_to_plugin", "ApplyCreatorChangeSet", ApplyCreatorChangeSetPayload>
  | StudioMessageBase<
      "backend_to_plugin",
      "FinalizeCreatorChangeSet",
      FinalizeCreatorChangeSetPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "RequestCreatorRecordingRecovery",
      RequestCreatorRecordingRecoveryPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "AcknowledgeClosedCreatorRecording",
      AcknowledgeClosedCreatorRecordingPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CancelInterruptedRecording",
      CancelInterruptedRecordingPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "AcknowledgeCreatorChangeFinalization",
      AcknowledgeCreatorChangeFinalizationPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "RollbackCreatorCheckpoint",
      RollbackCreatorCheckpointPayload
    >
  | StudioMessageBase<"backend_to_plugin", "LinkStudioProject", StudioProjectIdentityCommandPayload>
  | StudioMessageBase<"backend_to_plugin", "ForkStudioProject", StudioProjectIdentityCommandPayload>
  | StudioMessageBase<
      "backend_to_plugin",
      "AbandonOpeningStudioProjectIdentity",
      AbandonOpeningStudioProjectIdentityPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "CancelInterruptedStudioProjectIdentity",
      CancelInterruptedStudioProjectIdentityPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "SettleClosedStudioProjectIdentity",
      SettleClosedStudioProjectIdentityPayload
    >
  | StudioMessageBase<
      "backend_to_plugin",
      "AcknowledgeStudioProjectIdentityFinalization",
      AcknowledgeStudioProjectIdentityFinalizationPayload
    >;
export type StudioProtocolMessage = PluginToBackendMessage | BackendToPluginMessage;
export type StudioStreamedSemanticMessage = Extract<
  PluginToBackendMessage,
  { type: StudioStreamedSemanticType }
>;
export interface StudioSemanticMessageTransfer {
  readonly transferId: string;
  readonly documentHash: string;
  readonly utf8Bytes: number;
  readonly semanticType: StudioStreamedSemanticType;
  readonly semanticMessageId: string;
  readonly semanticRequestId?: string;
  readonly fragments: readonly {
    readonly sequence: number;
    readonly payload: string;
    readonly payloadHash: string;
  }[];
}
export interface StudioTransport {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void;
}

const PLUGIN_MESSAGE_TYPES = new Set<PluginMessageType>([
  "PairProject",
  "UnpairProject",
  "StudioCommandSettled",
  "StudioProjectIndexStarted",
  "StudioProjectEvidenceShard",
  "StudioSourceBlobManifest",
  "StudioSourceBlobChunk",
  "StudioProjectIndexCompleted",
  "StudioProjectChangeDetected",
  "StudioEvidenceProduced",
  "StudioSemanticMessageStarted",
  "StudioSemanticMessageChunk",
  "StudioSemanticMessageCompleted",
  "CreatorSourceWriteBlobAccepted",
  "RuntimeEvalPlanAccepted",
  "RuntimeEvalStarted",
  "RuntimeEvalStopped",
  "PassiveRuntimeEvalFinalized",
  "CreatorChangePrepared",
  "CreatorChangePreflighted",
  "CreatorMutationProvisional",
  "CreatorMutationFailed",
  "CreatorChangeFinalized",
  "CreatorRecordingRecovery",
  "CreatorClosedRecordingAcknowledged",
  "CreatorCheckpointRolledBack",
  "StudioProjectIdentityFinalized",
  "PluginError",
  "StudioPlaytestObserved",
  "Heartbeat",
]);
const BACKEND_MESSAGE_TYPES = new Set<BackendMessageType>([
  "CollectStudioProjectIndex",
  "CreatorSourceWriteBlobStarted",
  "CreatorSourceWriteBlobChunk",
  "CreatorSourceWriteBlobCompleted",
  "RequestStudioEvidence",
  "ExecuteRuntimeEvalPlan",
  "FinalizePassiveRuntimeEval",
  "CreatorChangePrepareStarted",
  "CreatorChangePrepareChunk",
  "CreatorChangePrepareCompleted",
  "PreflightCreatorChangeSet",
  "ApplyCreatorChangeSet",
  "FinalizeCreatorChangeSet",
  "RequestCreatorRecordingRecovery",
  "AcknowledgeClosedCreatorRecording",
  "CancelInterruptedRecording",
  "AcknowledgeCreatorChangeFinalization",
  "RollbackCreatorCheckpoint",
  "LinkStudioProject",
  "ForkStudioProject",
  "AbandonOpeningStudioProjectIdentity",
  "CancelInterruptedStudioProjectIdentity",
  "SettleClosedStudioProjectIdentity",
  "AcknowledgeStudioProjectIdentityFinalization",
]);
const CAPABILITIES: readonly StudioCapability[] = [
  "studio_evidence",
  "studio_project_index",
  "opaque_identity",
  "project_change_monitor",
  "semantic_message_stream",
  "sha256",
  "stable_identity",
  "reflection_attestation",
  "detached_preflight",
  "transactional_authoring",
  "recording_recovery",
  "studio_play_mode",
  "bounded_diagnostics",
  "project_identity",
  "http_polling",
];

export function assertStudioProtocolMessage(
  value: unknown,
): asserts value is StudioProtocolMessage {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProtocolMessage" ||
    !isString(value.type) ||
    !isId(value.messageId) ||
    !isIso(value.sentAt) ||
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
  // Request-bearing payloads and their transport envelope name one authority
  // domain.  Keeping two independently-valid identifiers would let a command
  // mutate state under payload request A while its receipt is routed to waiter
  // B.  Retain the inner identifier because it is part of the canonical
  // command body consumed by Luau, but require exact equality at the protocol
  // boundary in both directions.
  if (Object.hasOwn(value.payload, "requestId")) {
    if (!isId(value.requestId) || value.requestId !== value.payload.requestId)
      throw new Error("StudioProtocolMessage requestId binding mismatch");
  }
  if (
    (value.type === "StudioSemanticMessageStarted" ||
      value.type === "StudioSemanticMessageCompleted") &&
    value.requestId !== value.payload.semanticRequestId
  )
    throw new Error("Studio semantic transport requestId binding mismatch");
  if (
    value.type === "CreatorRecordingRecovery" &&
    value.payload.finalizationRequestId !== undefined &&
    value.requestId !== value.payload.finalizationRequestId
  )
    throw new Error("Invalid CreatorRecordingRecovery acknowledgement correlation");
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

export function creatorChangePrepareTransferId(documentHash: string): string {
  if (!isHash(documentHash)) throw new Error("Creator Prepare document hash is invalid");
  return `creator_prepare_transfer_${documentHash.slice(0, 24)}`;
}

export function studioSemanticTransferId(documentHash: string): string {
  if (!isHash(documentHash)) throw new Error("Studio semantic document hash is invalid");
  return `studio_semantic_transfer_${documentHash.slice(0, 24)}`;
}

/** Canonical test/host implementation of the plugin's one semantic transport. */
export function createStudioSemanticMessageTransfer(
  message: StudioStreamedSemanticMessage,
): StudioSemanticMessageTransfer {
  assertPluginToBackendMessage(message);
  if (!isStudioStreamedSemanticType(message.type))
    throw new Error("Studio semantic transport received an unsupported logical message");
  const serialized = stableJson(message);
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES)
    throw new Error("Studio semantic document exceeds its aggregate byte bound");
  const documentHash = contentHash(serialized);
  const fragments: Array<{ sequence: number; payload: string; payloadHash: string }> = [];
  for (let start = 0; start < encoded.byteLength;) {
    let end = Math.min(encoded.byteLength, start + STUDIO_SEMANTIC_FRAGMENT_BYTES);
    while (end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start)
      throw new Error("Studio semantic document could not be split at a UTF-8 boundary");
    const payload = new TextDecoder().decode(encoded.subarray(start, end));
    fragments.push({
      sequence: fragments.length,
      payload,
      payloadHash: contentHash(payload),
    });
    start = end;
  }
  if (fragments.length < 1 || fragments.length > MAX_STUDIO_SEMANTIC_PIECES)
    throw new Error("Studio semantic fragment count exceeds its protocol bound");
  return {
    transferId: studioSemanticTransferId(documentHash),
    documentHash,
    utf8Bytes: encoded.byteLength,
    semanticType: message.type,
    semanticMessageId: message.messageId,
    ...(message.requestId ? { semanticRequestId: message.requestId } : {}),
    fragments,
  };
}

export function assertCreatorChangePrepareDocument(
  value: unknown,
): asserts value is CreatorChangePrepareDocument {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "approvalHash",
      "beforeProjectDetectorEpoch",
      "beforeProjectIndexManifestId",
      "beforeProjectRevisionHash",
      "changeSetHash",
      "changeSetId",
      "changeSetJson",
      "changeSetJsonHash",
      "creatorSessionId",
      "dashboardReviewHash",
      "expectedProjectRevisionHash",
      "manifestHash",
      "preflightProjectionHash",
      "preflightProjectionJson",
      "preflightProjectionJsonHash",
      "projectionHash",
      "projectionJson",
      "projectionJsonHash",
      "requestId",
    ]) ||
    !isId(value.requestId) ||
    !isId(value.creatorSessionId) ||
    !isHash(value.expectedProjectRevisionHash) ||
    !isString(value.changeSetJson) ||
    !isHash(value.changeSetJsonHash) ||
    contentHash(value.changeSetJson) !== value.changeSetJsonHash ||
    !isId(value.changeSetId) ||
    !isHash(value.changeSetHash) ||
    !isHash(value.approvalHash) ||
    !isHash(value.dashboardReviewHash) ||
    value.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
    !isId(value.beforeProjectIndexManifestId) ||
    !isHash(value.beforeProjectRevisionHash) ||
    !isNonNegativeInteger(value.beforeProjectDetectorEpoch) ||
    value.beforeProjectRevisionHash !== value.expectedProjectRevisionHash
  )
    throw new Error("Invalid CreatorChangePrepareDocument");
  assertProjectionJson(
    value.requestId,
    undefined,
    value.projectionJson,
    value.projectionJsonHash,
    value.projectionHash,
  );
  assertProjectionJson(
    value.requestId,
    undefined,
    value.preflightProjectionJson,
    value.preflightProjectionJsonHash,
    value.preflightProjectionHash,
  );
}

/**
 * Canonicalize and fragment the complete logical Prepare document. The
 * returned leaf hashes are independent of command-envelope hashes; the plugin
 * must verify both each leaf and the reassembled document.
 */
export function createCreatorChangePrepareTransfer(
  document: CreatorChangePrepareDocument,
): CreatorChangePrepareTransfer {
  assertCreatorChangePrepareDocument(document);
  const serialized = stableJson(document);
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.byteLength > MAX_CREATOR_PREPARE_DOCUMENT_BYTES)
    throw new Error("Creator Prepare document exceeds its aggregate byte bound");
  const documentHash = contentHash(serialized);
  const fragments: Array<{ sequence: number; payload: string; payloadHash: string }> = [];
  for (let start = 0; start < encoded.byteLength;) {
    let end = Math.min(encoded.byteLength, start + BACKEND_COMMAND_FRAGMENT_BYTES);
    while (end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start)
      throw new Error("Creator Prepare document could not be split at a UTF-8 boundary");
    const payload = new TextDecoder().decode(encoded.subarray(start, end));
    fragments.push({
      sequence: fragments.length,
      payload,
      payloadHash: contentHash(payload),
    });
    start = end;
  }
  if (fragments.length < 1 || fragments.length > MAX_PROJECT_INDEX_PIECES)
    throw new Error("Creator Prepare fragment count exceeds its protocol bound");
  return {
    transferId: creatorChangePrepareTransferId(documentHash),
    documentHash,
    utf8Bytes: encoded.byteLength,
    fragments,
  };
}

/** Validates a terminal transport receipt independently of its envelope. */
export function assertStudioCommandSettledPayload(
  value: unknown,
): asserts value is StudioCommandSettledPayload {
  if (!isRecord(value)) fail("StudioCommandSettled");
  const commonValid = isId(value.commandMessageId) && isHash(value.commandHash);
  if (value.disposition === "executed") {
    if (!commonValid || !hasOnlyKeys(value, ["commandHash", "commandMessageId", "disposition"]))
      fail("StudioCommandSettled");
    return;
  }
  if (
    value.disposition !== "rejected" ||
    !commonValid ||
    !hasOnlyKeys(value, [
      "classification",
      "commandHash",
      "commandMessageId",
      "detail",
      "disposition",
      ...(value.identityRejection === undefined ? [] : ["identityRejection"]),
    ]) ||
    !["SECURITY_REJECTION", "STUDIO_FAILURE", "RECOVERY_REQUIRED"].includes(
      String(value.classification),
    ) ||
    !isBoundedText(value.detail, 1, MAX_CREATOR_FAILURE_DETAIL_BYTES)
  )
    fail("StudioCommandSettled");
  if (value.identityRejection !== undefined)
    assertStudioProjectIdentityRejectionEvidence(value.identityRejection);
}

function validatePayload(type: string, payload: Record<string, unknown>): void {
  if (type === "PairProject") {
    // Shape validation and build compatibility are separate boundaries.  A
    // connector carrying a well-formed but stale manifest is a valid protocol
    // message; StudioBridgeServer.pair owns the exact compatibility decision
    // and returns a descriptive 409.  Rejecting it here incorrectly reports a
    // stale connector as a malformed PairProject payload (HTTP 400).
    if (
      !hasOnlyKeys(payload, [
        "capabilities",
        "connectorBuildHash",
        "manifestHash",
        "pairingToken",
        "project",
        "projectIdentity",
        "projectIdentityTransaction",
      ]) ||
      !isString(payload.pairingToken) ||
      !isProject(payload.project) ||
      !isExactCapabilities(payload.capabilities) ||
      !isHash(payload.connectorBuildHash) ||
      !isHash(payload.manifestHash)
    )
      fail(type);
    assertStudioProjectIdentityState(payload.projectIdentity);
    assertStudioProjectIdentityTransactionInventory(payload.projectIdentityTransaction);
    if (!sameProject(payload.project, payload.projectIdentity.project)) fail(type);
    const identityTransaction =
      payload.projectIdentityTransaction as StudioProjectIdentityTransactionInventory;
    if (
      identityTransaction.status === "pending" &&
      !sameProject(payload.project, identityTransaction.operation.project)
    )
      fail(type);
    if (
      identityTransaction.status === "finalized" &&
      (!sameProject(payload.project, identityTransaction.receipt.operation.project) ||
        identityTransaction.receipt.afterIdentity.hash !==
          (payload.projectIdentity as unknown as StudioProjectIdentityState).hash)
    )
      fail(type);
    return;
  }
  if (type === "UnpairProject") {
    if (!["user", "plugin_unload", "session_replaced"].includes(String(payload.reason))) fail(type);
    return;
  }
  if (type === "StudioCommandSettled") {
    assertStudioCommandSettledPayload(payload);
    return;
  }
  if (type === "CollectStudioProjectIndex") {
    if (!isId(payload.requestId)) fail(type);
    assertCreatorResourcePolicy(payload.resourcePolicy);
    if (stableJson(payload.resourcePolicy) !== stableJson(CREATOR_DEFAULT_RESOURCE_POLICY))
      fail(type);
    assertStudioProjectIndexProjection(payload.projection);
    const projection = payload.projection as StudioProjectIndexProjection;
    if (stableJson(projection.bounds) !== stableJson(payload.resourcePolicy)) fail(type);
    return;
  }
  if (type === "CreatorSourceWriteBlobStarted") {
    if (
      !isId(payload.requestId) ||
      !isPositiveInteger(payload.pieceCount) ||
      Number(payload.pieceCount) > MAX_PROJECT_INDEX_PIECES
    )
      fail(type);
    assertCreatorSourceWriteBlobManifest(payload.manifest);
    if (Number(payload.pieceCount) < payload.manifest.chunkHashes.length) fail(type);
    return;
  }
  if (type === "CreatorSourceWriteBlobChunk") {
    if (!isCreatorSourceWriteFragment(payload)) fail(type);
    return;
  }
  if (type === "CreatorSourceWriteBlobCompleted") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.manifestId) ||
      !isHash(payload.manifestHash) ||
      !isHash(payload.sourceHash) ||
      !isNonNegativeInteger(payload.utf8Bytes) ||
      !isPositiveInteger(payload.pieceCount) ||
      Number(payload.pieceCount) > MAX_PROJECT_INDEX_PIECES
    )
      fail(type);
    return;
  }
  if (type === "StudioProjectIndexStarted") {
    if (
      !isProject(payload.project) ||
      !isId(payload.captureId) ||
      !isPositiveInteger(payload.pieceCount) ||
      Number(payload.pieceCount) > MAX_PROJECT_INDEX_PIECES ||
      !isNonNegativeInteger(payload.expectedShardCount) ||
      !isNonNegativeInteger(payload.expectedSourceManifestCount) ||
      !isNonNegativeInteger(payload.expectedSourceChunkCount) ||
      !isNonNegativeInteger(payload.expectedCanonicalBytes) ||
      !isNonNegativeInteger(payload.detectorEpoch)
    )
      fail(type);
    // pieceCount counts transport fragments, whereas the expected counts are
    // logical immutable artifacts. Large shards/source chunks therefore
    // legitimately consume more than one piece; fewer would omit evidence.
    if (
      Number(payload.pieceCount) <
      Number(payload.expectedShardCount) +
        Number(payload.expectedSourceManifestCount) +
        Number(payload.expectedSourceChunkCount)
    )
      fail(type);
    assertStudioProjectIndexProjection(payload.projection);
    const projection = payload.projection as StudioProjectIndexProjection;
    if (!sameProject(payload.project as PluginProjectIdentity, projection.project)) fail(type);
    return;
  }
  if (
    type === "StudioProjectEvidenceShard" ||
    type === "StudioSourceBlobManifest" ||
    type === "StudioSourceBlobChunk"
  ) {
    if (!isProjectIndexArtifactFragment(payload) || payload.artifact.kind !== type) fail(type);
    return;
  }
  if (type === "StudioProjectIndexCompleted") {
    if (
      !isProject(payload.project) ||
      !isId(payload.captureId) ||
      !isPositiveInteger(payload.pieceCount) ||
      Number(payload.pieceCount) > MAX_PROJECT_INDEX_PIECES ||
      !isProjectIndexManifestHeader(payload.indexManifest) ||
      !isHash(payload.captureHash) ||
      !isNonNegativeInteger(payload.detectorEpoch)
    )
      fail(type);
    assertStudioProjectRevision(payload.revision);
    const manifest = payload.indexManifest;
    const revision = payload.revision as StudioProjectRevision;
    if (
      !sameProject(payload.project as PluginProjectIdentity, manifest.project) ||
      !sameProject(payload.project as PluginProjectIdentity, revision.project) ||
      manifest.hash !== revision.indexManifestHash ||
      manifest.projectionHash !== revision.projectionHash ||
      manifest.manifestHash !== revision.manifestHash ||
      manifest.connectorEpoch !== revision.connectorEpoch
    )
      fail(type);
    return;
  }
  if (type === "StudioProjectChangeDetected") {
    if (
      !isProject(payload.project) ||
      !isId(payload.connectorEpoch) ||
      !isNonNegativeInteger(payload.epoch) ||
      !isIso(payload.observedAt) ||
      !Array.isArray(payload.sources) ||
      payload.sources.length === 0 ||
      payload.sources.length > 4 ||
      !isSortedStrings(payload.sources) ||
      payload.sources.some(
        (source) =>
          !STUDIO_PROJECT_CHANGE_SOURCES.includes(String(source) as StudioProjectChangeSource),
      )
    )
      fail(type);
    return;
  }
  if (type === "CreatorSourceWriteBlobAccepted") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.manifestId) ||
      !isHash(payload.manifestHash) ||
      !isHash(payload.sourceHash) ||
      !isNonNegativeInteger(payload.utf8Bytes) ||
      payload.status !== "accepted"
    )
      fail(type);
    return;
  }
  if (type === "StudioEvidenceProduced") {
    assertEvidenceProduced(payload);
    return;
  }
  if (type === "StudioSemanticMessageStarted" || type === "StudioSemanticMessageCompleted") {
    if (!isStudioSemanticMessageBoundary(payload)) fail(type);
    return;
  }
  if (type === "StudioSemanticMessageChunk") {
    if (!isStudioSemanticMessageChunk(payload)) fail(type);
    return;
  }
  if (type === "Heartbeat") {
    if (
      !isProject(payload.project) ||
      !isRecord(payload.projectIdentity) ||
      payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
      (payload.currentProjectIndexManifestId !== undefined &&
        !isId(payload.currentProjectIndexManifestId)) ||
      (payload.currentProjectRevisionHash !== undefined &&
        !isHash(payload.currentProjectRevisionHash)) ||
      (payload.activeRecording !== undefined && !isRecordingBinding(payload.activeRecording))
    )
      fail(type);
    assertStudioProjectIdentityState(payload.projectIdentity);
    if (!sameProject(payload.project, payload.projectIdentity.project)) fail(type);
    return;
  }
  if (type === "StudioPlaytestObserved") {
    assertStudioPlaytestObservation(payload);
    return;
  }
  if (type === "StudioProjectIdentityFinalized") {
    if (!hasOnlyKeys(payload, ["receipt", "requestId"]) || !isId(payload.requestId)) fail(type);
    assertStudioProjectIdentityFinalizationReceipt(payload.receipt);
    return;
  }
  if (type === "LinkStudioProject" || type === "ForkStudioProject") {
    if (
      !hasOnlyKeys(payload, ["operation", "operationHash", "requestId"]) ||
      !isId(payload.requestId) ||
      !isRecord(payload.operation) ||
      !isHash(payload.operationHash)
    )
      fail(type);
    assertStudioProjectIdentityOperation(payload.operation);
    const operation = payload.operation as StudioProjectIdentityOperation;
    if (
      payload.operationHash !== operation.hash ||
      operation.action !== (type === "LinkStudioProject" ? "link" : "fork")
    )
      fail(type);
    return;
  }
  if (type === "AbandonOpeningStudioProjectIdentity") {
    if (
      !hasOnlyKeys(payload, [
        "expectedIdentityStateHash",
        "operationHash",
        "operationId",
        "requestId",
        "transactionCursorHash",
      ]) ||
      !isId(payload.requestId) ||
      !isId(payload.operationId) ||
      !isHash(payload.operationHash) ||
      !isHash(payload.transactionCursorHash) ||
      !isHash(payload.expectedIdentityStateHash)
    )
      fail(type);
    return;
  }
  if (type === "CancelInterruptedStudioProjectIdentity") {
    if (
      !hasOnlyKeys(payload, [
        "expectedIdentityStateHash",
        "operationHash",
        "operationId",
        "recordingId",
        "requestId",
        "transactionCursorHash",
      ]) ||
      !isId(payload.requestId) ||
      !isId(payload.operationId) ||
      !isHash(payload.operationHash) ||
      !isHash(payload.transactionCursorHash) ||
      !isBoundedIdentifier(payload.recordingId, 512) ||
      !isHash(payload.expectedIdentityStateHash)
    )
      fail(type);
    return;
  }
  if (type === "SettleClosedStudioProjectIdentity") {
    if (
      !hasOnlyKeys(payload, [
        "expectedFinalization",
        "expectedIdentityStateHash",
        "operationHash",
        "operationId",
        "recordingId",
        "requestId",
        "transactionCursorHash",
      ]) ||
      !isId(payload.requestId) ||
      !isId(payload.operationId) ||
      !isHash(payload.operationHash) ||
      !isHash(payload.transactionCursorHash) ||
      !isBoundedIdentifier(payload.recordingId, 512) ||
      !isHash(payload.expectedIdentityStateHash) ||
      !["commit", "cancel"].includes(String(payload.expectedFinalization))
    )
      fail(type);
    return;
  }
  if (type === "AcknowledgeStudioProjectIdentityFinalization") {
    if (
      !hasOnlyKeys(payload, ["receiptHash", "receiptId", "requestId"]) ||
      !isId(payload.requestId) ||
      !isId(payload.receiptId) ||
      !isHash(payload.receiptHash)
    )
      fail(type);
    return;
  }
  if (type === "PluginError") {
    if (
      ![
        "INVALID_MESSAGE",
        "STALE_EVIDENCE",
        "WRONG_PROJECT",
        "INCOMPATIBLE_MANIFEST",
        "UNSUPPORTED_OPERATION",
        "TRANSPORT_FAILURE",
        "STUDIO_FAILURE",
        "SECURITY_REJECTION",
        "RECOVERY_REQUIRED",
      ].includes(String(payload.code)) ||
      !isString(payload.message) ||
      typeof payload.retryable !== "boolean"
    )
      fail(type);
    return;
  }
  if (type === "RequestStudioEvidence") {
    assertProjectionJson(
      payload.requestId,
      payload.reason,
      payload.projectionJson,
      payload.projectionJsonHash,
      payload.projectionHash,
    );
    return;
  }
  if (type === "ExecuteRuntimeEvalPlan") {
    if (
      !isId(payload.requestId) ||
      !isHash(payload.expectedProjectRevisionHash) ||
      !isString(payload.executionPlanJson) ||
      !isHash(payload.executionPlanJsonHash) ||
      contentHash(payload.executionPlanJson) !== payload.executionPlanJsonHash ||
      !["explicit_plugin_action", "observe_next_creator_play"].includes(String(payload.startPolicy))
    )
      fail(type);
    assertProjectionJson(
      payload.requestId,
      "runtime",
      payload.evidenceProjectionJson,
      payload.evidenceProjectionJsonHash,
      payload.evidenceProjectionHash,
    );
    return;
  }
  if (type === "RuntimeEvalPlanAccepted") {
    if (
      !isRuntimeBase(payload) ||
      !isPositiveInteger(payload.callCount) ||
      !isString(payload.instruction)
    )
      fail(type);
    return;
  }
  if (type === "RuntimeEvalStarted" || type === "RuntimeEvalStopped") {
    if (
      !isRuntimeBase(payload) ||
      payload.mode !== "play_solo" ||
      !isNonNegativeInteger(payload.playerCount) ||
      !["plugin_action", "creator_action"].includes(String(payload.control))
    )
      fail(type);
    return;
  }
  if (type === "FinalizePassiveRuntimeEval") {
    if (!isId(payload.requestId) || !isRuntimeBase(payload)) fail(type);
    return;
  }
  if (type === "PassiveRuntimeEvalFinalized") {
    if (!isRuntimeBase(payload) || payload.status !== "cleared") fail(type);
    return;
  }
  if (type === "CreatorChangePrepareStarted") {
    if (!isCreatorChangePrepareTransferBoundary(payload)) fail(type);
    return;
  }
  if (type === "CreatorChangePrepareChunk") {
    if (!isCreatorChangePrepareFragment(payload)) fail(type);
    return;
  }
  if (type === "CreatorChangePrepareCompleted") {
    if (!isCreatorChangePrepareTransferBoundary(payload)) fail(type);
    return;
  }
  if (type === "CreatorChangePrepared") {
    if (
      !isChangeBinding(payload) ||
      !isPreflightBinding(payload) ||
      !isId(payload.beforeProjectIndexManifestId) ||
      !isHash(payload.beforeProjectRevisionHash) ||
      !isNonNegativeInteger(payload.beforeProjectDetectorEpoch) ||
      payload.status !== "prepared"
    )
      fail(type);
    return;
  }
  if (type === "CreatorChangePreflighted") {
    if (
      !isChangeBinding(payload) ||
      !isPreflightBinding(payload) ||
      !isId(payload.beforeProjectIndexManifestId) ||
      !isHash(payload.beforeProjectRevisionHash) ||
      !isNonNegativeInteger(payload.beforeProjectDetectorEpoch) ||
      !["passed", "failed", "incomplete"].includes(String(payload.status)) ||
      (payload.failureCode !== undefined && !isId(payload.failureCode))
    )
      fail(type);
    assertStudioEvidenceEnvelope(payload.preflightEvidence);
    if (
      (payload.preflightEvidence as StudioEvidenceEnvelope).projectionHash !==
      payload.preflightProjectionHash
    )
      fail(type);
    return;
  }
  if (type === "PreflightCreatorChangeSet" || type === "ApplyCreatorChangeSet") {
    if (
      !isId(payload.requestId) ||
      !isChangeBinding(payload) ||
      (type === "PreflightCreatorChangeSet" && !isPreflightBinding(payload)) ||
      !isHash(payload.expectedProjectRevisionHash) ||
      !isId(payload.beforeProjectIndexManifestId) ||
      !isNonNegativeInteger(payload.beforeProjectDetectorEpoch)
    )
      fail(type);
    return;
  }
  if (type === "CreatorMutationProvisional") {
    if (!isRecordingBinding(payload) || payload.status !== "provisional") fail(type);
    assertStudioEvidenceEnvelope(payload.directReadbackEvidence);
    if (
      (payload.directReadbackEvidence as StudioEvidenceEnvelope).manifestHash !==
        payload.manifestHash ||
      (payload.directReadbackEvidence as StudioEvidenceEnvelope).projectionId !==
        payload.projectionId ||
      (payload.directReadbackEvidence as StudioEvidenceEnvelope).projectionHash !==
        payload.projectionHash
    )
      fail(type);
    if (
      !isId(payload.postApplyProjectIndexManifestId) ||
      !isHash(payload.postApplyProjectRevisionHash) ||
      !isNonNegativeInteger(payload.postApplyProjectDetectorEpoch)
    )
      fail(type);
    return;
  }
  if (type === "CreatorMutationFailed") {
    const hasRecordingId = payload.recordingId !== undefined;
    const noRecordingFailure =
      payload.stage === "preflight" || (payload.stage === "apply" && !hasRecordingId);
    if (
      !isRecordingBinding({ ...payload, recordingId: payload.recordingId ?? "not_open" }) ||
      !isId(payload.preflightProjectionId) ||
      !isHash(payload.preflightProjectionHash) ||
      (payload.recordingId !== undefined && !isId(payload.recordingId)) ||
      !["preflight", "apply", "readback", "post_state", "cancel", "commit"].includes(
        String(payload.stage),
      ) ||
      !isId(payload.failureCode) ||
      !isString(payload.failureDetail) ||
      utf8ByteLength(payload.failureDetail) < 1 ||
      utf8ByteLength(payload.failureDetail) > MAX_CREATOR_FAILURE_DETAIL_BYTES ||
      !isHash(payload.failureDetailHash) ||
      contentHash(payload.failureDetail) !== payload.failureDetailHash ||
      !["not_open", "open", "finalizing", "unknown"].includes(String(payload.recordingState)) ||
      (payload.cancellationProven !== undefined &&
        typeof payload.cancellationProven !== "boolean") ||
      // A preflight is detached by definition. A report without an exact
      // recording id is otherwise legal only for Apply's pre-TryBegin boundary.
      // This keeps an uncorrelated or stale failure from being interpreted as
      // proof that no recording exists.
      (!hasRecordingId && !noRecordingFailure) ||
      (!hasRecordingId && payload.recordingState !== "not_open") ||
      (payload.stage === "preflight" &&
        (hasRecordingId || payload.cancellationProven !== undefined)) ||
      // A cancellation proof is meaningful only for a named recording that
      // Studio has directly observed closed. It cannot authorize a no-recording
      // terminal classification.
      (payload.cancellationProven === true &&
        (!hasRecordingId || payload.recordingState !== "not_open"))
    )
      fail(type);
    return;
  }
  if (type === "FinalizeCreatorChangeSet") {
    if (
      !isId(payload.requestId) ||
      !isCreatorFinalizationGate(payload) ||
      payload.finalizationKind !== "ordinary"
    )
      fail(type);
    return;
  }
  if (type === "AcknowledgeCreatorChangeFinalization") {
    if (
      !isId(payload.requestId) ||
      !isCreatorFinalizationGate(payload) ||
      !["committed", "cancelled"].includes(String(payload.status)) ||
      !isFinalizationStatusConsistent({ action: payload.action, status: payload.status }) ||
      !isId(payload.afterProjectIndexManifestId) ||
      !isHash(payload.afterProjectRevisionHash) ||
      !isNonNegativeInteger(payload.afterProjectDetectorEpoch)
    )
      fail(type);
    return;
  }
  if (type === "CreatorChangeFinalized") {
    if (
      !isCreatorFinalizationGate(payload) ||
      !["committed", "cancelled", "recovery_required"].includes(String(payload.status))
    )
      fail(type);
    if (
      payload.status !== "recovery_required" &&
      !isFinalizationStatusConsistent({ action: payload.action, status: payload.status })
    )
      fail(type);
    if (
      !isId(payload.afterProjectIndexManifestId) ||
      !isHash(payload.afterProjectRevisionHash) ||
      !isNonNegativeInteger(payload.afterProjectDetectorEpoch)
    )
      fail(type);
    return;
  }
  if (type === "RequestCreatorRecordingRecovery") {
    assertRecoveryRequest(payload, false);
    return;
  }
  if (type === "AcknowledgeClosedCreatorRecording") {
    if (
      !isId(payload.requestId) ||
      !isRecordingBinding(payload) ||
      !isId(payload.recoveryProjectIndexManifestId) ||
      !isHash(payload.recoveryProjectRevisionHash) ||
      !isNonNegativeInteger(payload.recoveryProjectDetectorEpoch)
    )
      fail(type);
    return;
  }
  if (type === "CancelInterruptedRecording") {
    assertRecoveryRequest(payload, true);
    return;
  }
  if (type === "CreatorRecordingRecovery") {
    assertCreatorRecordingRecoveryPayload(payload);
    return;
  }
  if (type === "CreatorClosedRecordingAcknowledged") {
    if (
      !isRecordingBinding(payload) ||
      !isId(payload.recoveryProjectIndexManifestId) ||
      !isHash(payload.recoveryProjectRevisionHash) ||
      !isNonNegativeInteger(payload.recoveryProjectDetectorEpoch) ||
      payload.status !== "closed_cursor_cleared"
    )
      fail(type);
    return;
  }
  if (type === "RollbackCreatorCheckpoint") {
    if (
      !isId(payload.requestId) ||
      !isId(payload.creatorSessionId) ||
      !isId(payload.checkpointId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isHash(payload.expectedProjectRevisionHash)
    )
      fail(type);
    return;
  }
  if (type === "CreatorCheckpointRolledBack") {
    if (
      !isId(payload.creatorSessionId) ||
      !isId(payload.checkpointId) ||
      !isId(payload.changeSetId) ||
      !isHash(payload.changeSetHash) ||
      !isHash(payload.beforeProjectRevisionHash) ||
      !isId(payload.afterProjectIndexManifestId) ||
      !isHash(payload.afterProjectRevisionHash) ||
      !isNonNegativeInteger(payload.afterProjectDetectorEpoch) ||
      payload.status !== "rolled_back"
    )
      fail(type);
    return;
  }
  throw new Error(`Unsupported StudioProtocolMessage type: ${type}`);
}

function assertEvidenceProduced(payload: Record<string, unknown>): void {
  if (!isProject(payload.project) || !isEvidenceReason(payload.reason))
    fail("StudioEvidenceProduced");
  assertStudioEvidenceProjection(payload.projection);
  assertStudioEvidenceEnvelope(payload.envelope, payload.projection as StudioEvidenceProjection);
  const projection = payload.projection as StudioEvidenceProjection;
  if (!sameProject(payload.project as unknown as PluginProjectIdentity, projection.project))
    fail("StudioEvidenceProduced");
}
/**
 * The completed stream carries a bounded index-manifest header.  Its source
 * hashes are deliberately not accepted here: they are reconstructed from the
 * typed source-manifest leaves and checked by assertStudioProjectIndexCapture
 * in studio-runtime.  This prevents a header from standing in for evidence.
 */
function isProjectIndexManifestHeader(
  value: unknown,
): value is StudioProjectIndexCompletedPayload["indexManifest"] {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectIndexManifest" ||
    !hasOnlyKeys(value, [
      "kind",
      "id",
      "hash",
      "manifestHash",
      "projectionHash",
      "project",
      "connectorEpoch",
      "rootShardHashes",
      "allShardHashes",
      "instanceCount",
      "canonicalBytes",
      "completedAt",
      "sourceManifestCount",
    ]) ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isHash(value.manifestHash) ||
    !isHash(value.projectionHash) ||
    !isProject(value.project) ||
    !isId(value.connectorEpoch) ||
    !Array.isArray(value.rootShardHashes) ||
    !Array.isArray(value.allShardHashes) ||
    !isNonNegativeInteger(value.instanceCount) ||
    !isNonNegativeInteger(value.canonicalBytes) ||
    !isIso(value.completedAt) ||
    !isNonNegativeInteger(value.sourceManifestCount)
  )
    return false;
  const rootShardHashes = value.rootShardHashes as unknown[];
  const allShardHashes = value.allShardHashes as unknown[];
  if (
    rootShardHashes.some(
      (entry) =>
        !isRecord(entry) ||
        !hasOnlyKeys(entry, ["root", "hash"]) ||
        !isId(entry.root) ||
        !isHash(entry.hash),
    )
  )
    return false;
  if (
    allShardHashes.some((hash) => !isHash(hash)) ||
    new Set(allShardHashes).size !== allShardHashes.length
  )
    return false;
  return rootShardHashes.every(
    (entry, index) =>
      index === 0 ||
      String((rootShardHashes[index - 1] as Record<string, unknown>).root) <
        String((entry as Record<string, unknown>).root),
  );
}
function isProjectIndexArtifactFragment(
  value: unknown,
): value is StudioProjectIndexArtifactFragmentPayload {
  if (
    !isRecord(value) ||
    !isProject(value.project) ||
    !isId(value.captureId) ||
    !isNonNegativeInteger(value.sequence) ||
    Number(value.sequence) >= MAX_PROJECT_INDEX_PIECES ||
    !isRecord(value.artifact) ||
    !["StudioProjectEvidenceShard", "StudioSourceBlobManifest", "StudioSourceBlobChunk"].includes(
      String(value.artifact.kind),
    ) ||
    !isId(value.artifact.id) ||
    !isHash(value.artifact.hash) ||
    !isNonNegativeInteger(value.fragmentOrdinal) ||
    !isPositiveInteger(value.fragmentCount) ||
    Number(value.fragmentCount) > 256 ||
    Number(value.fragmentOrdinal) >= Number(value.fragmentCount) ||
    value.encoding !== "json" ||
    !isString(value.payload) ||
    utf8ByteLength(value.payload) > PROJECT_INDEX_FRAGMENT_BYTES ||
    !isHash(value.payloadHash) ||
    contentHash(value.payload) !== value.payloadHash
  )
    return false;
  return true;
}
function isCreatorSourceWriteFragment(value: unknown): value is CreatorSourceWriteBlobChunkPayload {
  if (
    !isRecord(value) ||
    !isId(value.requestId) ||
    !isId(value.manifestId) ||
    !isNonNegativeInteger(value.sequence) ||
    Number(value.sequence) >= MAX_PROJECT_INDEX_PIECES ||
    !isRecord(value.artifact) ||
    value.artifact.kind !== "CreatorSourceWriteBlobChunk" ||
    !isId(value.artifact.id) ||
    !isHash(value.artifact.hash) ||
    !isNonNegativeInteger(value.fragmentOrdinal) ||
    !isPositiveInteger(value.fragmentCount) ||
    Number(value.fragmentCount) > 256 ||
    Number(value.fragmentOrdinal) >= Number(value.fragmentCount) ||
    value.encoding !== "json" ||
    !isString(value.payload) ||
    utf8ByteLength(value.payload) < 1 ||
    utf8ByteLength(value.payload) > BACKEND_COMMAND_FRAGMENT_BYTES ||
    !isHash(value.payloadHash) ||
    contentHash(value.payload) !== value.payloadHash
  )
    return false;
  return true;
}
function isStudioStreamedSemanticType(value: unknown): value is StudioStreamedSemanticType {
  return [
    "StudioEvidenceProduced",
    "CreatorChangePreflighted",
    "CreatorMutationProvisional",
  ].includes(String(value));
}
function isStudioSemanticMessageBoundary(
  value: unknown,
): value is StudioSemanticMessageBoundaryPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      value.semanticRequestId === undefined
        ? [
            "documentHash",
            "pieceCount",
            "semanticMessageId",
            "semanticType",
            "transferId",
            "utf8Bytes",
          ]
        : [
            "documentHash",
            "pieceCount",
            "semanticMessageId",
            "semanticRequestId",
            "semanticType",
            "transferId",
            "utf8Bytes",
          ],
    ) ||
    !isHash(value.documentHash) ||
    value.transferId !== studioSemanticTransferId(value.documentHash) ||
    !isPositiveInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) > MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES ||
    !isPositiveInteger(value.pieceCount) ||
    Number(value.pieceCount) > MAX_STUDIO_SEMANTIC_PIECES ||
    Number(value.pieceCount) <
      Math.ceil(Number(value.utf8Bytes) / STUDIO_SEMANTIC_FRAGMENT_BYTES) ||
    Number(value.pieceCount) >
      Math.ceil(Number(value.utf8Bytes) / (STUDIO_SEMANTIC_FRAGMENT_BYTES - 3)) ||
    !isStudioStreamedSemanticType(value.semanticType) ||
    !isId(value.semanticMessageId) ||
    (value.semanticRequestId !== undefined && !isId(value.semanticRequestId))
  )
    return false;
  return true;
}
function isStudioSemanticMessageChunk(value: unknown): value is StudioSemanticMessageChunkPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "documentHash",
      "encoding",
      "payload",
      "payloadHash",
      "sequence",
      "transferId",
    ]) &&
    isHash(value.documentHash) &&
    value.transferId === studioSemanticTransferId(value.documentHash) &&
    isNonNegativeInteger(value.sequence) &&
    Number(value.sequence) < MAX_STUDIO_SEMANTIC_PIECES &&
    value.encoding === "json" &&
    isString(value.payload) &&
    utf8ByteLength(value.payload) >= 1 &&
    utf8ByteLength(value.payload) <= STUDIO_SEMANTIC_FRAGMENT_BYTES &&
    isHash(value.payloadHash) &&
    contentHash(value.payload) === value.payloadHash
  );
}
function isCreatorChangePrepareTransferBoundary(
  value: unknown,
): value is CreatorChangePrepareStartedPayload | CreatorChangePrepareCompletedPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["documentHash", "pieceCount", "requestId", "transferId", "utf8Bytes"]) ||
    !isId(value.requestId) ||
    !isHash(value.documentHash) ||
    value.transferId !== creatorChangePrepareTransferId(value.documentHash) ||
    !isPositiveInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) > MAX_CREATOR_PREPARE_DOCUMENT_BYTES ||
    !isPositiveInteger(value.pieceCount) ||
    Number(value.pieceCount) > MAX_PROJECT_INDEX_PIECES ||
    Number(value.pieceCount) <
      Math.ceil(Number(value.utf8Bytes) / BACKEND_COMMAND_FRAGMENT_BYTES) ||
    Number(value.pieceCount) >
      Math.ceil(Number(value.utf8Bytes) / (BACKEND_COMMAND_FRAGMENT_BYTES - 3))
  )
    return false;
  return true;
}
function isCreatorChangePrepareFragment(value: unknown): value is CreatorChangePrepareChunkPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "documentHash",
      "encoding",
      "payload",
      "payloadHash",
      "requestId",
      "sequence",
      "transferId",
    ]) ||
    !isId(value.requestId) ||
    !isHash(value.documentHash) ||
    value.transferId !== creatorChangePrepareTransferId(value.documentHash) ||
    !isNonNegativeInteger(value.sequence) ||
    Number(value.sequence) >= MAX_PROJECT_INDEX_PIECES ||
    value.encoding !== "json" ||
    !isString(value.payload) ||
    utf8ByteLength(value.payload) < 1 ||
    utf8ByteLength(value.payload) > BACKEND_COMMAND_FRAGMENT_BYTES ||
    !isHash(value.payloadHash) ||
    contentHash(value.payload) !== value.payloadHash
  )
    return false;
  return true;
}
function assertProjectionJson(
  requestId: unknown,
  reason: unknown,
  json: unknown,
  jsonHash: unknown,
  projectionHash: unknown,
): void {
  if (
    !isId(requestId) ||
    !isString(json) ||
    !isHash(jsonHash) ||
    contentHash(json) !== jsonHash ||
    !isHash(projectionHash)
  )
    fail("projection JSON");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail("projection JSON");
  }
  assertStudioEvidenceProjection(value);
  if (serializeStudioEvidenceProjection(value) !== json || value.contentHash !== projectionHash)
    fail("projection JSON");
  if (
    reason !== undefined &&
    (!isEvidenceReason(reason) ||
      (reason === "runtime" &&
        !["runtime_evaluation", "creator_verification"].includes(value.purpose)))
  )
    fail("projection reason");
}
function assertRecoveryRequest(payload: Record<string, unknown>, cancel: boolean): void {
  if (!isId(payload.requestId) || !isRecordingBinding(payload))
    fail(cancel ? "CancelInterruptedRecording" : "RequestCreatorRecordingRecovery");
  if (
    cancel &&
    (!isCreatorFinalizationGate(payload) ||
      payload.finalizationKind !== "recovery_cancel" ||
      payload.action !== "cancel")
  )
    fail("CancelInterruptedRecording");
}
function isRuntimeBase(payload: Record<string, unknown>): boolean {
  return (
    isId(payload.executionPlanId) &&
    isHash(payload.executionPlanHash) &&
    isId(payload.projectionId) &&
    isHash(payload.projectionHash) &&
    isHash(payload.bindingHash) &&
    isHash(payload.nonceCommitment)
  );
}
function isChangeBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    isId(value.creatorSessionId) &&
    isId(value.changeSetId) &&
    isHash(value.changeSetHash) &&
    isId(value.projectionId) &&
    isHash(value.projectionHash) &&
    value.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH
  );
}
function isRecordingBinding(value: unknown): boolean {
  return (
    isChangeBinding(value) &&
    isRecord(value) &&
    isId(value.beforeProjectIndexManifestId) &&
    isHash(value.beforeProjectRevisionHash) &&
    isNonNegativeInteger(value.beforeProjectDetectorEpoch) &&
    isId(value.recordingId)
  );
}
export function assertCreatorRecordingRecoveryPayload(
  value: unknown,
): asserts value is CreatorRecordingRecoveryPayload {
  if (!isRecord(value)) fail("CreatorRecordingRecovery");
  const payload = value;
  if (payload.finalizationRequestId !== undefined && !isId(payload.finalizationRequestId))
    fail("CreatorRecordingRecovery");
  if (payload.recordingState === "none") {
    const expectedKeys = payload.finalizationRequestId === undefined ? 1 : 2;
    if (Object.keys(payload).length !== expectedKeys) fail("CreatorRecordingRecovery");
    return;
  }
  if (
    !isRecordingBinding(payload) ||
    !["open", "not_open", "finalizing", "unknown"].includes(String(payload.recordingState)) ||
    !isId(payload.recoveryProjectIndexManifestId) ||
    !isHash(payload.recoveryProjectRevisionHash) ||
    !isNonNegativeInteger(payload.recoveryProjectDetectorEpoch) ||
    payload.replacesAction !== undefined ||
    (payload.cancellation !== undefined &&
      (payload.recordingState !== "open" ||
        !isCreatorRecordingCancellationAuthority(payload.cancellation)))
  )
    fail("CreatorRecordingRecovery");
}
export function isCreatorRecordingCancellationAuthority(
  value: unknown,
): value is CreatorRecordingCancellationAuthority {
  return (
    isRecord(value) &&
    ((value.kind === "open" && Object.keys(value).length === 1) ||
      (value.kind === "replace_intent" &&
        Object.keys(value).length === 2 &&
        (value.action === "commit" || value.action === "cancel")))
  );
}
function isCreatorFinalizationGate(value: unknown): value is CreatorFinalizationGate {
  const recoveryCancel = isRecord(value) && value.finalizationKind === "recovery_cancel";
  return (
    isRecordingBinding(value) &&
    isRecord(value) &&
    (recoveryCancel
      ? value.action === "cancel" &&
        (value.replacesAction === undefined ||
          value.replacesAction === "commit" ||
          value.replacesAction === "cancel")
      : ["commit", "cancel"].includes(String(value.action)) &&
        value.finalizationKind === "ordinary" &&
        value.replacesAction === undefined) &&
    isId(value.expectedCurrentProjectIndexManifestId) &&
    isHash(value.expectedCurrentProjectRevisionHash) &&
    isNonNegativeInteger(value.expectedCurrentProjectDetectorEpoch)
  );
}
function isFinalizationStatusConsistent(value: {
  readonly action: unknown;
  readonly status: unknown;
}): boolean {
  return (
    (value.action === "commit" && value.status === "committed") ||
    (value.action === "cancel" && value.status === "cancelled")
  );
}
function isPreflightBinding(value: unknown): boolean {
  return (
    isRecord(value) && isId(value.preflightProjectionId) && isHash(value.preflightProjectionHash)
  );
}
function isExactCapabilities(value: unknown): value is StudioCapability[] {
  return (
    Array.isArray(value) &&
    value.length === CAPABILITIES.length &&
    new Set(value).size === value.length &&
    CAPABILITIES.every((capability) => value.includes(capability))
  );
}
function isEvidenceReason(value: unknown): value is StudioEvidenceReason {
  return [
    "pairing",
    "manual",
    "pre_play",
    "pre_apply",
    "runtime",
    "capability_attestation",
  ].includes(String(value));
}
function isProject(value: unknown): value is PluginProjectIdentity {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isNonNegativeInteger(value.placeId) &&
    isNonNegativeInteger(value.universeId)
  );
}
function isStudioProjectIdentityProject(value: unknown): value is PluginProjectIdentity {
  return (
    isProject(value) &&
    hasOnlyKeys(value as unknown as Record<string, unknown>, ["name", "placeId", "universeId"]) &&
    isBoundedText(value.name, 1, 512) &&
    Number.isSafeInteger(value.placeId) &&
    Number.isSafeInteger(value.universeId)
  );
}
function sameProject(left: PluginProjectIdentity, right: PluginProjectIdentity): boolean {
  return (
    left.name === right.name &&
    left.placeId === right.placeId &&
    left.universeId === right.universeId
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoundedText(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  return (
    isString(value) &&
    utf8ByteLength(value) >= minimumBytes &&
    utf8ByteLength(value) <= maximumBytes
  );
}
function isForgeProjectId(value: unknown): value is string {
  return isString(value) && /^forge_project_[0-9a-f]{32}$/.test(value);
}
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function isId(value: unknown): value is string {
  return isString(value) && value.length > 0 && !/\s/.test(value);
}
function isBoundedIdentifier(value: unknown, maximumBytes: number): value is string {
  return isBoundedText(value, 1, maximumBytes) && !/\s/.test(value);
}
function isHash(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{64}$/.test(value);
}
function isIso(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}
function isStudioProjectIdentityTimestamp(value: unknown): value is string {
  return (
    isString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isSortedStrings(value: readonly unknown[]): value is readonly string[] {
  return (
    value.every((entry) => typeof entry === "string") &&
    value.every((entry, index) => index === 0 || String(value[index - 1]) < String(entry))
  );
}
function fail(scope: string): never {
  throw new Error(`Invalid ${scope} payload`);
}
