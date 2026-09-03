import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z, type ZodRawShape } from "zod";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentExecutionJournalSink,
  AgentExecutionJournalResume,
  AgentToolCompletionStatus,
  AgentToolDefinition,
  AgentToolHost,
  BudgetPolicy,
  CreatorPhaseFinalization,
  ToolBatchDecision,
  ToolResult,
} from "../../agent-runtime/src/index.js";
import {
  DEFAULT_AGENT_BUDGETS,
  assertAgentRun,
  assertCreatorPhaseOutcome,
  verifyAgentRunExecutionJournal,
} from "../../agent-runtime/src/index.js";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  serializeCanonicalJson,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson, type VerificationIssue } from "../../contracts/src/index.js";
import {
  compileCreatorOrientation,
  type AgentOrientation,
} from "../../context-compiler/src/index.js";
import {
  analyzeStudioSourcesWithRobloxLuau,
  type StudioLuauAnalysisNode,
  type StudioLuauAnalysisSource,
} from "../../luau-toolchain/src/index.js";
import type { ModelToolCall } from "../../model-client/src/contracts.js";
import {
  SourceConsultationRecorder,
  assertProductionStudioSourceIndex,
  assertCreatorSourceConsultation,
  assertStudioSourceIndex,
  readStudioSource,
  type CreatorSourceConsultation,
  type PinnedSourceAnalysisArtifact,
  type StudioSourceIndex,
  type VerifiedSourceResolver,
} from "../../source-intelligence/src/index.js";
import {
  assertProjectAuthorityManifest,
  assertProjectAuthorityMap,
  assertRojoMutationAttempt,
  assertRojoSourceChangeSet,
  assertRojoSourceRevert,
  assertRojoSourceRevertSyncProof,
  assertRojoSyncProof,
  type ProjectAuthorityManifest,
} from "../../project-authority/src/index.js";
import {
  CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
  STUDIO_RESOLVABLE_CLASSES,
  type StudioResolvableClass,
} from "../../studio-capabilities/src/index.js";
import {
  STUDIO_AUTHORING_CONTAINERS,
  STUDIO_AUTHORING_ROOTS,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CODECS,
  STUDIO_SCRIPT_CLASSES,
  STUDIO_WRITABLE_CLASSES,
  CREATOR_DEFAULT_RESOURCE_POLICY,
  assertCreatorSourceWriteBlobCapture,
  assertStudioValue,
  assertStudioValueForProperty,
  canonicalStudioValue,
  createCreatorSourceWriteBlobCapture,
  isRobloxClassAssignableTo,
  lookupRobloxApiCatalog,
  studioObjectIdentityKey,
  type StudioCapabilityAttestationGrade,
  type StudioCodec,
  type CreatorSourceWriteBlobCapture as StudioSourceWriteBlobCapture,
  type StudioEvidenceTarget,
  type StudioIdentityEnrollment,
  type StudioObjectIdentity,
  type StudioProjectIndexMetadataView,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import {
  assertCreatorProjectChangeNotice,
  assertCreatorProjectDelta,
  assertCreatorProjectRefresh,
  assertCreatorTransactionProjectChangeConfirmation,
  creatorProjectIndexArtifactReferences,
  readCreatorProjectIndexArtifacts,
} from "./project-refresh.js";
import {
  creatorSourceWriteArtifactReferences,
  readCreatorSourceWriteArtifacts,
  type CreatorSourceWriteArtifactBinding,
} from "./source-write.js";
import { compileCreatorTransactionTopology } from "./transaction-topology.js";

export * from "./mutation-evidence.js";
export * from "./project-refresh.js";
export * from "./source-write.js";
export * from "./transaction-topology.js";

export const CREATOR_SESSION_POLICY = "prompt_first_studio_authoring" as const;
export const CREATOR_MODEL = "openai/gpt-5.6-luna" as const;
export const CREATOR_MAX_REPAIRS = 2;
export const CREATOR_MAX_INSPECTION_PATHS = 64;
export const CREATOR_MAX_PLAN_STEPS = 32;
export const CREATOR_MAX_CHARTER_CLAUSES = 128;
export const CREATOR_MAX_CHANGES = STUDIO_CAPABILITY_MANIFEST.limits.maximumOperations;

export type StudioWritableClass = (typeof STUDIO_WRITABLE_CLASSES)[number];
export type StudioScriptClass = (typeof STUDIO_SCRIPT_CLASSES)[number];
export const STUDIO_NON_SCRIPT_WRITABLE_CLASSES = STUDIO_WRITABLE_CLASSES.filter(
  (className): className is Exclude<StudioWritableClass, StudioScriptClass> =>
    !STUDIO_SCRIPT_CLASSES.includes(className as StudioScriptClass),
);
export type StudioNonScriptWritableClass = Exclude<StudioWritableClass, StudioScriptClass>;
/** The only in-memory Studio observation shape accepted by creator logic. */
export type CreatorProjectIndexView = StudioProjectIndexMetadataView;
export type StudioInstanceTarget = Extract<StudioEvidenceTarget, { readonly kind: "instance" }>;
export type StudioMutationParent =
  | StudioInstanceTarget
  | {
      readonly kind: "engine_container";
      readonly path: string;
      readonly className: string;
    };
/** Exactly one persistent writer domain is selected for each sealed change set. */
export type ProjectWriteAuthority = "studio_document" | "rojo_source";
export type StudioOwner = ProjectWriteAuthority;

export type CreatorSessionStatus =
  | "indexing"
  | "planning"
  | "awaiting_clarification"
  | "refining_plan"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_change_approval"
  | "preflighting"
  | "applying"
  | "awaiting_verification"
  | "verifying"
  | "awaiting_verification_retry"
  | "cancelling"
  | "committing"
  | "repairing"
  | "refresh_required"
  | "refreshing"
  | "superseded"
  | "awaiting_source_sync"
  | "awaiting_review"
  | "answered"
  | "creator_accepted"
  | "creator_rejected"
  | "rolled_back"
  | "incomplete"
  | "recovery_required";

export interface StudioOwnershipMap {
  kind: "StudioOwnershipMap";
  id: string;
  hash: string;
  projectId: string;
  revisionHash: string;
  /** Writer domains that a later sealed change set may select. */
  availableAuthorities: ProjectWriteAuthority[];
  /** The private manifest is retained by the host; evidence binds only its hash. */
  authorityManifestHash?: string;
  entries: Array<{
    objectId: string;
    path: string;
    className: string;
    owner: StudioOwner;
  }>;
  policy: "per_change_set_single_writer";
}

export type VerificationCharterClause =
  | { id: string; kind: "local_check"; check: "luau_syntax"; statement: string }
  | {
      id: string;
      kind: "studio_check";
      check: "instance_exists";
      statement: string;
      path: string;
      expectedClass: StudioResolvableClass;
    }
  | {
      id: string;
      kind: "studio_check";
      check: "position_series";
      statement: string;
      path: string;
      expectedClass: "BasePart";
      sampleCount: number;
      intervalMs: number;
      quantizationStuds: number;
      minimumDistinctPositions: number;
    }
  | {
      id: string;
      kind: "studio_check";
      check: "playtest_diagnostics";
      statement: string;
      maximumErrors: number;
      maximumWarnings: number;
    }
  | {
      id: string;
      kind: "snapshot_check";
      check: "subtree_unchanged";
      statement: string;
      path: string;
      expectedClass: StudioResolvableClass;
      baselineHash: string;
    }
  | { id: string; kind: "creator_review"; statement: string };

export type VerificationCharterProposalClause =
  | { id: string; kind: "local_check"; check: "luau_syntax" }
  | {
      id: string;
      kind: "studio_check";
      check: "instance_exists";
      path: string;
      expectedClass: StudioResolvableClass;
    }
  | {
      id: string;
      kind: "studio_check";
      check: "position_series";
      path: string;
      expectedClass: "BasePart";
      sampleCount: number;
      intervalMs: number;
      quantizationStuds: number;
      minimumDistinctPositions: number;
    }
  | {
      id: string;
      kind: "studio_check";
      check: "playtest_diagnostics";
      maximumErrors: number;
      maximumWarnings: number;
    }
  | {
      id: string;
      kind: "snapshot_check";
      check: "subtree_unchanged";
      path: string;
      expectedClass: StudioResolvableClass;
    }
  | { id: string; kind: "creator_review"; statement: string };

export type CreatorPlanChange =
  | {
      id: string;
      kind: "create";
      path: string;
      parent: StudioMutationParent;
      className: StudioScriptClass;
      initialization: "inline_source_required";
    }
  | {
      id: string;
      kind: "create";
      path: string;
      parent: StudioMutationParent;
      className: StudioNonScriptWritableClass;
      initialization: "initial_properties";
    }
  | {
      id: string;
      kind: "update";
      target: StudioInstanceTarget;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "move";
      target: StudioInstanceTarget;
      toPath: string;
      parent: StudioMutationParent;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "delete";
      target: StudioInstanceTarget;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "edit_source";
      target: StudioInstanceTarget;
      expectedClass: "Script" | "LocalScript" | "ModuleScript";
    };

export interface VerificationCharter {
  kind: "VerificationCharter";
  id: string;
  hash: string;
  visibility: "creator_visible";
  authority: "creator_approved_hypothesis";
  clauses: VerificationCharterClause[];
}

export interface CreatorPlan {
  kind: "CreatorPlan";
  id: string;
  hash: string;
  sessionId: string;
  promptHash: string;
  projectRevisionHash: string;
  /** Exact complete project-index capture, including the detector epoch. */
  projectCaptureHash: string;
  ownershipMapId: string;
  ownershipMapHash: string;
  sourceIndexId: string;
  sourceIndexHash: string;
  sourceConsultationId: string;
  sourceConsultationHash: string;
  /** Derived from the complete typed plan and immutable ownership map. */
  mutationAuthority: ProjectWriteAuthority;
  /** This is the exact trimmed creator request, never model-authored. */
  goal: string;
  /** Explicit initial-snapshot facts the approved builder may inspect. */
  inspectionPaths: string[];
  steps: Array<{ id: string; statement: string; changeIds: string[] }>;
  changes: CreatorPlanChange[];
  charter: VerificationCharter;
}

/**
 * Model-facing property input. Forge resolves these natural JSON values against
 * the approved per-class property policy, then emits the tagged StudioValue
 * representation only across the trusted Forge-to-Studio boundary.
 */
export type CreatorPropertyInput =
  | null
  | boolean
  | number
  | string
  | { x: number; y: number }
  | { x: number; y: number; z: number }
  | { r: number; g: number; b: number }
  | {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
    }
  | { scale: number; offset: number }
  | {
      x: { scale: number; offset: number };
      y: { scale: number; offset: number };
    }
  | { min: { x: number; y: number }; max: { x: number; y: number } }
  | { min: number; max: number }
  | {
      keypoints: readonly { time: number; value: number; envelope: number }[];
    }
  | {
      keypoints: readonly {
        time: number;
        color: { r: number; g: number; b: number };
      }[];
    }
  | { name: string }
  | { family: string; weight: string; style: string }
  | {
      density: number;
      friction: number;
      elasticity: number;
      frictionWeight: number;
      elasticityWeight: number;
    }
  | { x: boolean; y: boolean; z: boolean }
  | {
      top: boolean;
      bottom: boolean;
      left: boolean;
      right: boolean;
      front: boolean;
      back: boolean;
    }
  | {
      origin: { x: number; y: number; z: number };
      direction: { x: number; y: number; z: number };
    }
  | {
      identity: StudioObjectIdentity;
      path: string;
      className: string;
    };

export type StudioChangeOperation =
  | {
      id: string;
      planChangeId: string;
      kind: "create";
      tempId: string;
      target: StudioInstanceTarget;
      parent: StudioMutationParent;
      className: StudioWritableClass;
      name: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      sourceBlob?: CreatorSourceWriteBlobBinding;
    }
  | {
      id: string;
      planChangeId: string;
      kind: "update";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      removedAttributes: string[];
    }
  | {
      id: string;
      planChangeId: string;
      kind: "move";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
      parent: StudioMutationParent;
      name: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      removedAttributes: string[];
    }
  | {
      id: string;
      planChangeId: string;
      kind: "delete";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
    }
  | {
      id: string;
      planChangeId: string;
      kind: "edit_source";
      target: StudioInstanceTarget & {
        readonly className: "Script" | "LocalScript" | "ModuleScript";
      };
      enrollment?: StudioIdentityEnrollment;
      beforeSourceHash: string;
      edits: CreatorSourceEdit[];
      finalSourceHash: string;
      finalByteCount: number;
    };

export interface CreatorSourceEdit {
  startByte: number;
  endByte: number;
  replacementBlob: CreatorSourceWriteBlobBinding;
}

/**
 * A sealed operation refers only to immutable source-write metadata. The
 * body bytes live in separately persisted chunk artifacts and are streamed to
 * Studio before Prepare; they never re-enter the change-set JSON transport.
 */
export interface CreatorSourceWriteBlobBinding {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
}

/** Host-only builder output that is persisted as immutable manifest/chunk leaves. */
export type CreatorSourceWriteBlobCapture = StudioSourceWriteBlobCapture;

export function creatorSourceWriteBlobBinding(
  capture: CreatorSourceWriteBlobCapture,
): CreatorSourceWriteBlobBinding {
  assertCreatorSourceWriteBlobCapture(capture, CREATOR_DEFAULT_RESOURCE_POLICY);
  const { manifest } = capture;
  return {
    manifestId: manifest.id,
    manifestHash: manifest.hash,
    sourceHash: manifest.sourceHash,
    utf8Bytes: manifest.utf8Bytes,
  };
}

export function assertCreatorSourceWriteBlobBinding(
  value: unknown,
): asserts value is CreatorSourceWriteBlobBinding {
  if (
    !isRecord(value) ||
    !isId(value.manifestId) ||
    !isHash(value.manifestHash) ||
    !isHash(value.sourceHash) ||
    !Number.isSafeInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) < 0 ||
    Number(value.utf8Bytes) > CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes
  )
    throw new Error("Invalid CreatorSourceWriteBlob binding");
}

/**
 * The immutable, content-addressed execution boundary between an approved plan
 * and the builder.  The model receives this object verbatim but can only send
 * the creative portions of a staged change back to Forge.
 */
export interface CreatorBuildContract {
  kind: "CreatorBuildContract";
  id: string;
  hash: string;
  sessionId: string;
  promptHash: string;
  planId: string;
  planHash: string;
  planApprovalId: string;
  planApprovalHash: string;
  ownershipMapId: string;
  ownershipMapHash: string;
  sourceIndexId: string;
  sourceIndexHash: string;
  sourceConsultationId: string;
  sourceConsultationHash: string;
  mutationAuthority: ProjectWriteAuthority;
  initialRevisionHash: string;
  initialInspectionPaths: string[];
  propertyPolicies: Record<StudioWritableClass, CreatorPropertyPolicy>;
  changes: CreatorBuildContractChange[];
}

export interface CreatorPropertyPolicy {
  allowedProperties: Array<{
    name: string;
    valueKinds: StudioCodec[];
    /** Mirrors the exact manifest row; sharing a codec never grants nil. */
    nullable: boolean;
    constraints?: CreatorPropertyConstraints;
  }>;
  attributes: "primitive" | "none";
  source: "required" | "forbidden";
}

export interface CreatorPropertyConstraints {
  minimum?: number;
  maximum?: number;
  minimumExclusive?: number;
  maximumAbsolute?: number;
  cframeTranslationMaximumAbsolute?: number;
  cframeRotationMaximumAbsolute?: number;
  minimumUtf8Bytes?: number;
  maximumUtf8Bytes?: number;
  maximumEntries?: number;
  referenceClass?: string;
  allowedStrings?: string[];
}

export type CreatorBuildContractChange =
  | {
      planChangeId: string;
      operationId: string;
      kind: "create";
      path: string;
      target: StudioInstanceTarget;
      parent: StudioMutationParent;
      name: string;
      className: StudioWritableClass;
      tempId: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "update";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "move";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
      parent: StudioMutationParent;
      name: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "delete";
      target: StudioInstanceTarget;
      enrollment?: StudioIdentityEnrollment;
      beforeHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "edit_source";
      target: StudioInstanceTarget & { readonly className: StudioScriptClass };
      enrollment?: StudioIdentityEnrollment;
      beforeSourceHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    };

export interface CreatorStagePayload {
  planChangeId: string;
  properties?: Record<string, CreatorPropertyInput>;
  attributes?: Record<string, string | number | boolean>;
  removedAttributes?: string[];
  source?: string;
  /** Raw model input. It is converted to immutable blob bindings before an
   * operation can be sealed. */
  sourceEdits?: CreatorStageSourceEdit[];
}

export interface CreatorStageSourceEdit {
  startByte: number;
  endByte: number;
  replacement: string;
}

export interface CreatorChangeSet {
  kind: "CreatorChangeSet";
  id: string;
  hash: string;
  sessionId: string;
  attempt: number;
  promptHash: string;
  planId: string;
  planHash: string;
  charterId: string;
  charterHash: string;
  planApprovalId: string;
  planApprovalHash: string;
  buildContractId: string;
  buildContractHash: string;
  ownershipMapId: string;
  ownershipMapHash: string;
  mutationAuthority: ProjectWriteAuthority;
  expectedRevisionHash: string;
  operations: StudioChangeOperation[];
  /** Every source blob referenced by an operation, sorted by manifest hash. */
  sourceWriteBlobs: CreatorSourceWriteBlobBinding[];
  localGate: {
    status: "eligible" | "rejected" | "incomplete";
    issueHashes: string[];
  };
}

export interface CreatorApproval {
  kind: "CreatorApproval";
  id: string;
  hash: string;
  sessionId: string;
  artifactKind: "plan" | "change_set";
  artifactId: string;
  artifactHash: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  authority: "creator";
}

export interface CreatorCheckpoint {
  kind: "CreatorCheckpoint";
  id: string;
  hash: string;
  sessionId: string;
  changeSetId: string;
  changeSetHash: string;
  beforeRevisionHash: string;
  afterRevisionHash: string;
  mutationAttemptId: string;
  mutationAttemptHash: string;
  status: "committed" | "rolled_back" | "recovery_required";
}

export interface CreatorReviewReport {
  kind: "CreatorReviewReport";
  id: string;
  hash: string;
  sessionId: string;
  changeSetId: string;
  changeSetHash: string;
  charterId: string;
  charterHash: string;
  decision: "accepted" | "rejected";
  report: string;
  reviewedObservationHash: string;
  authority: "creator";
  reviewedAt: string;
}

export interface CreatorVerificationRecord {
  kind: "CreatorVerificationRecord";
  id: string;
  hash: string;
  sessionId: string;
  changeSetId: string;
  changeSetHash: string;
  charterId: string;
  charterHash: string;
  stateRevisionHash: string;
  stateEvidenceHash: string;
  mutationAttempt: {
    id: string;
    hash: string;
    reconciliationHash: string;
  };
  executionPlan: {
    id: string;
    hash: string;
    artifact: ArtifactReference;
  };
  runtimeEvidence?: {
    evidenceHash: string;
    diagnosticsHash: string;
    artifact: ArtifactReference;
  };
  status: "passed" | "failed" | "incomplete";
  nonReplayableReason?: string;
  failureFacts: Array<{ statement: string; hash: string }>;
}

export interface CreatorVerificationReplay {
  kind: "CreatorVerificationReplay";
  sessionId: string;
  verificationId: string;
  result: "exact_match" | "mismatch" | "missing_or_incomplete";
  recordedStatus: CreatorVerificationRecord["status"];
  replayedStatus?: Exclude<CreatorVerificationRecord["status"], "incomplete">;
  recordedFailureFactHashes: string[];
  replayedFailureFactHashes?: string[];
  detail: string;
}

export interface CreatorSession {
  kind: "CreatorSession";
  id: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  status: CreatorSessionStatus;
  policy: typeof CREATOR_SESSION_POLICY;
  model: string;
  promptHash: string;
  projectId: string;
  initialRevisionHash: string;
  currentRevisionHash: string;
  /** Exact content-addressed project-index capture used to begin this session. */
  initialProjectCaptureHash: string;
  /** Exact content-addressed project-index capture currently authorizing work. */
  currentProjectCaptureHash: string;
  ownershipMapId: string;
  ownershipMapHash: string;
  repairsUsed: number;
  plan?: { id: string; hash: string };
  planApproval?: { id: string; hash: string };
  changeSet?: { id: string; hash: string };
  changeApproval?: { id: string; hash: string };
  checkpoint?: { id: string; hash: string };
  review?: { id: string; hash: string };
  failure?: { code: string; detailHash: string };
}

export interface CreatorRequestArtifact {
  kind: "CreatorRequest";
  sessionId: string;
  promptHash: string;
  /** Exact creator-authored request. This alone defines `promptHash`. */
  creatorText: string;
  /** Host-authored model input; may include bounded conversation context. */
  agentPrompt: string;
  /**
   * Host-issued, immutable conversation citations available to the planner
   * before it opens any project/source tool.  This is always present (and is
   * empty for a transaction that was not started from a conversation).
   */
  contextCitations: readonly CreatorAgentContextCitation[];
}

export interface CreatorSessionBundle {
  session: CreatorSession;
  creatorRequest: ArtifactReference;
  /** Host-validated conversational outcome produced by the planner phase. */
  agentOutcome?: {
    outcome: CreatorAgentOutcome;
    artifact: ArtifactReference;
  };
  projectIndices: import("./project-refresh.js").CreatorProjectIndexArtifactBinding[];
  projectChanges: Array<{
    notice: import("./project-refresh.js").CreatorProjectChangeNotice;
    artifact: ArtifactReference;
    priorStatus: CreatorSessionStatus;
    /** Present only after an open-recording dirty notice has been confirmed. */
    confirmation?: {
      record: import("./project-refresh.js").CreatorTransactionProjectChangeConfirmation;
      artifact: ArtifactReference;
    };
  }>;
  projectRefreshes: Array<{
    refresh: import("./project-refresh.js").CreatorProjectRefresh;
    artifact: ArtifactReference;
  }>;
  predecessorSessionId?: string;
  successorSessionId?: string;
  ownership: StudioOwnershipMap;
  /**
   * Publicly bindable references only. The filesystem root stays in the host
   * context and never enters a session bundle, artifact, or control view.
   */
  projectAuthority?: {
    readonly authorityMap: {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    };
  };
  rojoSourceMutations: Array<{
    readonly changeSet: {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    };
    readonly attempt: {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    };
    readonly syncProofs: readonly {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    }[];
    readonly revert?: {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    };
    readonly revertSyncProofs: readonly {
      readonly id: string;
      readonly hash: string;
      readonly artifact: ArtifactReference;
    }[];
  }>;
  sourceIndices: Array<{
    id: string;
    hash: string;
    artifact: ArtifactReference;
    analysis: { id: string; hash: string; artifact: ArtifactReference };
  }>;
  sourceConsultations: Array<{
    id: string;
    hash: string;
    indexId: string;
    indexHash: string;
    artifact: ArtifactReference;
  }>;
  /** Immutable leaves for every source-write binding retained by a change set. */
  sourceWriteBlobs: CreatorSourceWriteArtifactBinding[];
  plan?: CreatorPlan;
  buildContracts: CreatorBuildContract[];
  approvals: CreatorApproval[];
  changeSets: CreatorChangeSet[];
  checkpoint?: CreatorCheckpoint;
  review?: {
    report: CreatorReviewReport;
    artifact: ArtifactReference;
  };
  /**
   * Durable transaction cursor for a mutation that may still own a Studio
   * ChangeHistory recording.  It contains references only: the immutable
   * bodies stay in the creator artifact store.  This field is cleared only
   * after an exact commit/cancel acknowledgement and its final project-index
   * capture have been persisted.
   */
  activeMutation?: CreatorActiveMutation;
  mutationAttempts: import("./mutation-evidence.js").CreatorMutationAttempt[];
  verifications: CreatorVerificationRecord[];
  agentRuns: Array<{
    phase: "creator_planner" | "creator_builder";
    agentRunId: string;
    agentRun: ArtifactReference;
    traceId: string;
    trace: ArtifactReference;
    traceBuildKey: string;
    creatorSessionHash: string;
    buildContract?: { id: string; hash: string };
    outcome: import("../../agent-runtime/src/index.js").CreatorPhaseOutcome;
  }>;
}

export interface CreatorActiveMutation {
  attemptId: string;
  stage: "preflighted" | "recording_may_be_open" | "provisional" | "recovery_cancelled";
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  beforeIndexRevisionHash: string;
  /** Monitor epoch bound to the complete pre-recording project capture. */
  beforeProjectDetectorEpoch: number;
  recordingId?: string;
  manifest: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  attestation: import("./mutation-evidence.js").CreatorMutationArtifactEvidence;
  changeSet: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  projection: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  preflight: import("./mutation-evidence.js").CreatorMutationArtifactEvidence;
  beforeIndexCapture: import("./mutation-evidence.js").CreatorMutationArtifactIndexCapture;
  directReadback?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  afterIndexCapture?: import("./mutation-evidence.js").CreatorMutationArtifactIndexCapture;
  /** Monitor epoch captured with the complete post-Apply project index. */
  afterProjectDetectorEpoch?: number;
  reconciliation?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  executionFailure?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  verificationPlan?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  verificationDraft?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  recoveryFinalization?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  finalIndexCapture?: import("./mutation-evidence.js").CreatorMutationArtifactIndexCapture;
}

export type CreatorTransactionControlActionId =
  | "transaction_approve_plan"
  | "transaction_reject_plan"
  | "transaction_approve_and_apply_changes"
  | "transaction_reject_changes"
  | "transaction_accept_result"
  | "transaction_reject_and_rollback"
  | "transaction_cancel_changes"
  | "transaction_retry_play_verification"
  | "transaction_refresh_project"
  | "transaction_check_source_sync"
  | "transaction_revert_source_changes"
  | "transaction_cancel_interrupted_recording";
export interface CreatorTransactionControlActionDescriptor {
  id: CreatorTransactionControlActionId;
  label: string;
  intent: "primary" | "secondary";
  requiresReport?: boolean;
}
export interface CreatorTransactionControlView {
  kind: "CreatorTransactionControlView";
  id: string;
  hash: string;
  creatorSessionId: string;
  creatorSessionHash: string;
  status: CreatorSessionStatus;
  title: string;
  detail: string;
  artifact?: {
    kind: "plan" | "change_set";
    id: string;
    hash: string;
    presentation: unknown;
    presentationHash: string;
  };
  evidence?: Array<{
    phase: "creator_planner" | "creator_builder";
    agentRunId: string;
    agentRun: ArtifactReference;
    traceId: string;
    trace: ArtifactReference;
    traceBuildKey: string;
  }>;
  creatorReviewPrompts?: string[];
  artifacts?: {
    prompt?: ArtifactReference;
    plan?: ArtifactReference;
    changeSet?: ArtifactReference;
    studioExecutionPlan?: ArtifactReference;
    capabilityManifest?: ArtifactReference;
    capabilityAttestation?: ArtifactReference;
    mutationProjection?: ArtifactReference;
    mutationPreflight?: ArtifactReference;
    mutationReadback?: ArtifactReference;
    mutationReconciliation?: ArtifactReference;
    mutationFinalization?: ArtifactReference;
    runtimeEvidence?: ArtifactReference;
    verification?: ArtifactReference;
    reviewReport?: ArtifactReference;
    agentRun?: ArtifactReference;
    trace?: ArtifactReference;
    projectAuthorityMap?: ArtifactReference;
    rojoSourceChangeSet?: ArtifactReference;
    rojoMutationAttempt?: ArtifactReference;
    sourceSync?: ArtifactReference;
    sourceRevert?: ArtifactReference;
    sourceRevertSync?: ArtifactReference;
  };
  verification?: {
    id: string;
    status: "passed" | "failed" | "incomplete" | "not_run";
    failureFacts: Array<{ statement: string; hash: string }>;
    replayable: boolean;
    runtimeSummary?: {
      startedAt: string;
      endedAt: string;
      observedFacts: number;
      absentFacts: number;
      unavailableFacts: number;
      readErrorFacts: number;
      diagnosticCount: number;
      issues: Array<{
        key: string;
        status: "unavailable" | "read_error";
        code: string;
      }>;
    };
  };
  mutation?: {
    attemptId: string;
    status:
      | "preflighting"
      | "source_transfer_failed"
      | "prepare_failed"
      | "preflight_failed"
      | "provisional"
      | "matched"
      | "mismatched"
      | "incomplete"
      | "cancelled"
      | "committed"
      | "rolled_back"
      | "recovery_required";
    failureFacts: Array<{ code: string; statement: string; hash: string }>;
    replayable: boolean;
    projectionFactCount: number;
  };
  projectIndex?: {
    status: "indexing" | "complete" | "incomplete" | "dirty";
    authorityMode: "studio_document" | "rojo_source";
    connectorEpoch: string;
    manifestHash?: string;
    rootHash?: string;
    indexedInstances: number;
    indexedBytes: number;
    sourceBlobs: number;
    dirty: boolean;
    artifact?: ArtifactReference;
  };
  sourceConsultation?: {
    artifact: ArtifactReference;
    sourceIndexHash: string;
    sourceCount: number;
    rangeCount: number;
    dependencyNodeCount: number;
  };
  projectChange?: {
    detectedAt: string;
    reasons: string[];
    notice?: ArtifactReference;
    delta?: ArtifactReference;
    predecessorSessionId?: string;
    successorSessionId?: string;
  };
  sourceSync?: {
    status: "awaiting" | "matched" | "mismatched" | "reverted";
    attemptId: string;
    artifact?: ArtifactReference;
  };
  /** The ordered, bounded transaction actions currently authorized by this view. */
  actions: CreatorTransactionControlActionDescriptor[];
}

export type CreatorTransactionStageId = "request" | "plan" | "change" | "studio" | "review";
export interface CreatorTransactionStage {
  id: CreatorTransactionStageId;
  label: "Request" | "Plan" | "Change" | "Studio" | "Review";
  status: "pending" | "active" | "complete" | "blocked" | "failed";
  authority: "creator" | "agent" | "forge" | "studio";
  detail: string;
}
export interface CreatorTransactionSummary {
  id: string;
  hash: string;
  projectId: string;
  prompt: string;
  promptHash: string;
  status: CreatorSessionStatus;
  createdAt: string;
  updatedAt: string;
  latestVerificationStatus?: "passed" | "failed" | "incomplete" | "not_run";
  failure?: { code: string; detailHash: string };
}
export interface CreatorTransactionState {
  kind: "CreatorTransactionState";
  selectedSessionId?: string;
  sessions: CreatorTransactionSummary[];
  controlView?: CreatorTransactionControlView;
  stages: CreatorTransactionStage[];
  pairedStudio: {
    status: "paired" | "unpaired" | "connecting";
    projectId?: string;
    projectName?: string;
    revisionHash?: string;
    capabilities?: string[];
    manifestHash?: string;
    connectorBuildHash?: string;
    attestationStatus?: "verified" | "pending" | "rejected" | "incomplete";
    attestationHash?: string;
    attestationArtifact?: ArtifactReference;
    attestation?: Omit<StudioCapabilityAttestationGrade, "status">;
    /** Backend-derived recovery gate; the dashboard never infers this. */
    transactionInventoryStatus: "clear" | "pending" | "blocked" | "unavailable";
    message: string;
  };
  serverTime: string;
}

/**
 * A host-issued citation is the only project/source reference agent prose may
 * carry into the durable creator conversation. The model chooses among
 * handles it has actually received; it cannot manufacture the bound fact.
 */
export interface CreatorAgentCitation {
  kind: "CreatorAgentCitation";
  id: string;
  hash: string;
  handle: string;
  projectRevisionHash: string;
  authority: "project_index" | "static_analysis" | "creator_memory" | "conversation_evidence";
  subject:
    | {
        kind: "project_fact";
        objectId: string;
        path: string;
        className: string;
        factHash: string;
      }
    | {
        kind: "source_ranges";
        tool:
          | "source.search"
          | "source.read"
          | "source.symbols"
          | "source.references"
          | "source.dependencies";
        resultHash: string;
        ranges: Array<{
          documentId: string;
          path: string;
          sourceHash: string;
          startByte: number;
          endByte: number;
        }>;
      }
    | {
        kind: "memory";
        memoryItemId: string;
        revisionId: string;
        revisionHash: string;
      }
    | {
        kind: "prior_evidence";
        eventId: string;
        eventHash: string;
        evidence: {
          id: string;
          hash: string;
          artifact: ArtifactReference;
        };
      };
}

export interface CreatorAgentContextCitation {
  readonly label: string;
  readonly citation: CreatorAgentCitation;
}

export type CreatorAgentOutcome =
  | {
      kind: "answer";
      id: string;
      hash: string;
      text: string;
      citations: CreatorAgentCitation[];
    }
  | {
      kind: "clarification_requested";
      id: string;
      hash: string;
      question: string;
      citations: CreatorAgentCitation[];
    }
  | {
      kind: "plan_proposed";
      id: string;
      hash: string;
      plan: CreatorPlan;
      citations: CreatorAgentCitation[];
    };

export interface CreatorAgentWorkerDescriptor {
  kind: "CreatorAgentWorkerDescriptor";
  name: "forge-local-creator-agent-worker";
  environment: "local_process";
  isolation: "none";
}

export type CreatorPlannerExecution = {
  runtimeResult: AgentRuntimeResult;
  toolHost: CreatorPlannerToolHost;
  systemPrompt: string;
  finalization: CreatorPhaseFinalization;
  outcome?: CreatorAgentOutcome;
};

export type CreatorBuilderExecution = {
  runtimeResult: AgentRuntimeResult;
  toolHost: CreatorBuilderToolHost;
  systemPrompt: string;
  finalization: CreatorPhaseFinalization;
  changeSet?: CreatorChangeSet;
  sourceWriteBlobs?: readonly CreatorSourceWriteBlobCapture[];
};

export function createCreatorTransactionControlView(
  input: Omit<CreatorTransactionControlView, "kind" | "id" | "hash">,
): CreatorTransactionControlView {
  const canonical = JSON.parse(stableJson(input)) as Omit<
    CreatorTransactionControlView,
    "kind" | "id" | "hash"
  >;
  const hash = contentHash(stableJson(canonical));
  const view: CreatorTransactionControlView = {
    kind: "CreatorTransactionControlView",
    id: `creator_transaction_control_view_${hash.slice(0, 24)}`,
    hash,
    ...canonical,
  };
  assertCreatorTransactionControlView(view);
  return view;
}

export function assertCreatorTransactionControlView(
  value: unknown,
): asserts value is CreatorTransactionControlView {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorTransactionControlView" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.creatorSessionId) ||
    !isHash(value.creatorSessionHash) ||
    !isStatus(value.status) ||
    typeof value.title !== "string" ||
    typeof value.detail !== "string"
  )
    throw new Error("Invalid CreatorTransactionControlView");
  if (
    !Array.isArray(value.actions) ||
    value.actions.length > 2 ||
    !value.actions.every(isTransactionControlActionDescriptor)
  )
    throw new Error("Invalid CreatorTransactionControlView actions");
  const actions = value.actions;
  if (new Set(actions.map((action) => action.id)).size !== actions.length)
    throw new Error("Invalid CreatorTransactionControlView actions");
  if (
    actions.filter((action) => action.intent === "primary").length > 1 ||
    actions.filter((action) => action.intent === "secondary").length > 1 ||
    actions.some(
      (action, index) =>
        action.intent === "primary" &&
        actions.slice(0, index).some((earlier) => earlier.intent === "secondary"),
    )
  )
    throw new Error("Invalid CreatorTransactionControlView action order");
  if (value.artifact !== undefined) {
    if (
      !isRecord(value.artifact) ||
      !["plan", "change_set"].includes(String(value.artifact.kind)) ||
      !isId(value.artifact.id) ||
      !isHash(value.artifact.hash) ||
      !isHash(value.artifact.presentationHash) ||
      contentHash(stableJson(value.artifact.presentation)) !== value.artifact.presentationHash
    )
      throw new Error("Invalid CreatorTransactionControlView artifact");
  }
  if (
    value.evidence !== undefined &&
    (!Array.isArray(value.evidence) || !value.evidence.every(isCreatorEvidencePresentation))
  )
    throw new Error("Invalid CreatorTransactionControlView evidence");
  if (
    value.creatorReviewPrompts !== undefined &&
    (!Array.isArray(value.creatorReviewPrompts) ||
      value.creatorReviewPrompts.length > CREATOR_MAX_CHARTER_CLAUSES ||
      !value.creatorReviewPrompts.every(
        (prompt) => typeof prompt === "string" && prompt.trim().length > 0 && prompt.length <= 4096,
      ))
  )
    throw new Error("Invalid CreatorTransactionControlView review prompts");
  if (value.artifacts !== undefined) {
    if (!isRecord(value.artifacts))
      throw new Error("Invalid CreatorTransactionControlView artifacts");
    for (const reference of Object.values(value.artifacts)) assertArtifactReference(reference);
  }
  if (value.verification !== undefined) {
    if (
      !isRecord(value.verification) ||
      !isId(value.verification.id) ||
      !["passed", "failed", "incomplete", "not_run"].includes(String(value.verification.status)) ||
      typeof value.verification.replayable !== "boolean" ||
      !Array.isArray(value.verification.failureFacts) ||
      !value.verification.failureFacts.every(
        (fact) => isRecord(fact) && typeof fact.statement === "string" && isHash(fact.hash),
      )
    )
      throw new Error("Invalid CreatorTransactionControlView verification");
    if (value.verification.runtimeSummary !== undefined) {
      const summary = value.verification.runtimeSummary;
      if (
        !isRecord(summary) ||
        !Number.isFinite(Date.parse(String(summary.startedAt))) ||
        !Number.isFinite(Date.parse(String(summary.endedAt))) ||
        ![
          summary.observedFacts,
          summary.absentFacts,
          summary.unavailableFacts,
          summary.readErrorFacts,
          summary.diagnosticCount,
        ].every((count) => Number.isSafeInteger(count) && Number(count) >= 0) ||
        !Array.isArray(summary.issues) ||
        summary.issues.length > STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeCalls ||
        !summary.issues.every(
          (issue) =>
            isRecord(issue) &&
            typeof issue.key === "string" &&
            issue.key.length > 0 &&
            ["unavailable", "read_error"].includes(String(issue.status)) &&
            typeof issue.code === "string" &&
            issue.code.length > 0,
        )
      )
        throw new Error("Invalid CreatorTransactionControlView runtime summary");
    }
  }
  if (
    value.mutation !== undefined &&
    (!isRecord(value.mutation) ||
      !isId(value.mutation.attemptId) ||
      ![
        "preflighting",
        "source_transfer_failed",
        "prepare_failed",
        "preflight_failed",
        "provisional",
        "matched",
        "mismatched",
        "incomplete",
        "cancelled",
        "committed",
        "rolled_back",
        "recovery_required",
      ].includes(String(value.mutation.status)) ||
      typeof value.mutation.replayable !== "boolean" ||
      !Number.isInteger(value.mutation.projectionFactCount) ||
      Number(value.mutation.projectionFactCount) < 0 ||
      !Array.isArray(value.mutation.failureFacts) ||
      !value.mutation.failureFacts.every(
        (fact) =>
          isRecord(fact) &&
          typeof fact.code === "string" &&
          fact.code.length > 0 &&
          typeof fact.statement === "string" &&
          isHash(fact.hash),
      ))
  )
    throw new Error("Invalid CreatorTransactionControlView mutation evidence");
  if (
    value.sourceSync !== undefined &&
    (!isRecord(value.sourceSync) ||
      !["awaiting", "matched", "mismatched", "reverted"].includes(
        String(value.sourceSync.status),
      ) ||
      !isId(value.sourceSync.attemptId) ||
      (value.sourceSync.artifact !== undefined &&
        !validArtifactReference(value.sourceSync.artifact)))
  )
    throw new Error("Invalid CreatorTransactionControlView source sync evidence");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_transaction_control_view_${expected.slice(0, 24)}`
  )
    throw new Error("Invalid CreatorTransactionControlView identity");
}

export function assertCreatorTransactionControlActionBinding(
  view: CreatorTransactionControlView,
  action: {
    creatorSessionId: string;
    viewId: string;
    viewHash: string;
    actionId: CreatorTransactionControlActionId;
  },
  replayed = false,
): void {
  assertCreatorTransactionControlView(view);
  if (
    action.creatorSessionId !== view.creatorSessionId ||
    action.viewId !== view.id ||
    action.viewHash !== view.hash
  )
    throw new Error("Creator transaction action is stale or bound to a different control view");
  if (replayed) throw new Error("Creator transaction control view action was already consumed");
  if (!view.actions.some((candidate) => candidate.id === action.actionId))
    throw new Error("Creator transaction action is not available in the current control view");
}

export function createStudioOwnershipMap(input: {
  projectId: string;
  revisionHash: string;
  projectIndex: CreatorProjectIndexView;
  projectAuthority?: ProjectAuthorityManifest;
  /** Exact Studio paths from the host-verified Rojo sourcemap. These are
   * Studio-visible paths only; private workspace paths never enter this map. */
  rojoOwnedPaths?: readonly string[];
}): StudioOwnershipMap {
  assertCreatorProjectIndexView(input.projectIndex);
  assertHash(input.revisionHash, "Studio revision");
  const authority = resolveProjectAuthorityAvailability(input);
  const entries = input.projectIndex.instances
    .map((instance) => {
      const path = canonicalStudioPath(instance.path);
      const owner = authority.rojoOwnedPaths.has(path)
        ? ("rojo_source" as const)
        : ("studio_document" as const);
      return {
        objectId: instance.objectId,
        path,
        className: instance.className,
        owner,
      };
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.objectId.localeCompare(right.objectId),
    );
  if (new Set(entries.map((entry) => entry.objectId)).size !== entries.length)
    throw new Error("Studio project-index object IDs must be unique");
  const payload = {
    projectId: input.projectId,
    revisionHash: input.revisionHash,
    availableAuthorities: authority.availableAuthorities,
    ...(authority.manifestHash ? { authorityManifestHash: authority.manifestHash } : {}),
    entries,
    policy: "per_change_set_single_writer" as const,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "StudioOwnershipMap",
    id: `studio_ownership_map_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

function resolveProjectAuthorityAvailability(input: {
  projectIndex: CreatorProjectIndexView;
  projectAuthority?: ProjectAuthorityManifest;
  rojoOwnedPaths?: readonly string[];
}): {
  availableAuthorities: ProjectWriteAuthority[];
  manifestHash?: string;
  rojoOwnedPaths: ReadonlySet<string>;
} {
  if (input.projectAuthority !== undefined) assertProjectAuthorityManifest(input.projectAuthority);
  const rojoEnabled = input.projectAuthority?.rojo !== undefined;
  if (rojoEnabled !== (input.rojoOwnedPaths !== undefined))
    throw new Error(
      "Rojo authority availability requires exact host-verified Studio path mappings",
    );
  const rojoOwnedPaths = new Set((input.rojoOwnedPaths ?? []).map(canonicalStudioPath));
  if (rojoOwnedPaths.size !== (input.rojoOwnedPaths?.length ?? 0))
    throw new Error("Rojo authority Studio path mappings must be canonical and unique");
  const indexedPaths = new Set(input.projectIndex.instances.map((entry) => entry.path));
  if ([...rojoOwnedPaths].some((path) => !indexedPaths.has(path)))
    throw new Error("Rojo authority Studio path mapping is absent from the current project index");
  return {
    availableAuthorities: rojoEnabled ? ["rojo_source", "studio_document"] : ["studio_document"],
    ...(input.projectAuthority
      ? { manifestHash: contentHash(stableJson(input.projectAuthority)) }
      : {}),
    rojoOwnedPaths,
  };
}

export function createCreatorSession(input: {
  id?: string;
  prompt: string;
  projectId: string;
  revisionHash: string;
  projectCaptureHash: string;
  ownership: StudioOwnershipMap;
  model?: string;
  now?: Date;
}): CreatorSession {
  if (input.prompt.length === 0 || input.prompt !== input.prompt.trim())
    throw new Error("Creator prompt must be non-empty canonical trimmed text");
  assertOwnershipMap(input.ownership);
  if (
    input.ownership.projectId !== input.projectId ||
    input.ownership.revisionHash !== input.revisionHash
  )
    throw new Error("Creator session ownership binding mismatch");
  assertHash(input.projectCaptureHash, "Creator session project-index capture");
  const now = (input.now ?? new Date()).toISOString();
  const promptHash = contentHash(input.prompt);
  const id = input.id ?? `creator_session_${randomUUID()}`;
  if (!isId(id) || !id.startsWith("creator_session_"))
    throw new Error("Creator session identity is invalid");
  return sealSession({
    kind: "CreatorSession",
    id,
    hash: "",
    createdAt: now,
    updatedAt: now,
    status: "indexing",
    policy: CREATOR_SESSION_POLICY,
    model: input.model ?? CREATOR_MODEL,
    promptHash,
    projectId: input.projectId,
    initialRevisionHash: input.revisionHash,
    currentRevisionHash: input.revisionHash,
    initialProjectCaptureHash: input.projectCaptureHash,
    currentProjectCaptureHash: input.projectCaptureHash,
    ownershipMapId: input.ownership.id,
    ownershipMapHash: input.ownership.hash,
    repairsUsed: 0,
  });
}

export function createCreatorPlan(
  input: Omit<
    CreatorPlan,
    | "kind"
    | "id"
    | "hash"
    | "charter"
    | "goal"
    | "sourceIndexId"
    | "sourceIndexHash"
    | "sourceConsultationId"
    | "sourceConsultationHash"
    | "mutationAuthority"
  > & {
    creatorPrompt: string;
    /** The exact complete project-index capture backing this source index. */
    projectCaptureHash: string;
    charter: { clauses: VerificationCharterProposalClause[] };
    sourceIndex: StudioSourceIndex;
    sourceConsultation: CreatorSourceConsultation;
  },
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
): CreatorPlan {
  assertCreatorProjectIndexView(observation);
  assertOwnershipMap(ownership);
  if (
    input.projectRevisionHash !== ownership.revisionHash ||
    input.projectRevisionHash !== observation.revision.hash ||
    input.ownershipMapId !== ownership.id ||
    input.ownershipMapHash !== ownership.hash
  )
    throw new Error("Creator plan ownership or revision binding mismatch");
  const sourceIndex = input.sourceIndex;
  assertStudioSourceIndex(sourceIndex);
  if (sourceIndex.snapshotHash !== input.projectCaptureHash)
    throw new Error("Creator plan source index does not bind the project-index capture");
  const sourceConsultation = input.sourceConsultation;
  assertCreatorSourceConsultation(sourceConsultation, sourceIndex);
  const sourceEvidenceBinding = {
    sourceIndexId: sourceIndex.id,
    sourceIndexHash: sourceIndex.hash,
    sourceConsultationId: sourceConsultation.id,
    sourceConsultationHash: sourceConsultation.hash,
  };
  if (
    sourceEvidenceBinding.sourceIndexId !== sourceIndex.id ||
    sourceEvidenceBinding.sourceIndexHash !== sourceIndex.hash ||
    !isId(sourceEvidenceBinding.sourceConsultationId) ||
    !isHash(sourceEvidenceBinding.sourceConsultationHash)
  )
    throw new Error("Creator plan source consultation binding mismatch");
  const goal = input.creatorPrompt;
  if (goal.length === 0 || goal !== goal.trim() || contentHash(goal) !== input.promptHash)
    throw new Error("Creator plan must bind the immutable creator prompt");
  if (
    input.steps.length === 0 ||
    input.steps.length > CREATOR_MAX_PLAN_STEPS ||
    input.steps.some(
      (step) =>
        step.id.trim().length === 0 ||
        step.statement.trim().length === 0 ||
        step.changeIds.length === 0,
    )
  )
    throw new Error("Creator plan requires concrete steps bound to changes");
  if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
    throw new Error("Creator plan step IDs must be unique");
  if (input.changes.length === 0 || input.changes.length > CREATOR_MAX_CHANGES)
    throw new Error(`Creator plan requires 1-${CREATOR_MAX_CHANGES} typed changes`);
  const inspectionPaths = [...new Set(input.inspectionPaths.map(canonicalStudioPath))].sort();
  if (
    inspectionPaths.length !== input.inspectionPaths.length ||
    inspectionPaths.length > CREATOR_MAX_INSPECTION_PATHS
  )
    throw new Error("Creator plan inspection paths must be unique and bounded");
  for (const path of inspectionPaths)
    if (!observation.instances.some((instance) => instance.path === path))
      throw new Error(`Creator plan inspection path is absent from the initial snapshot: ${path}`);
  const changeIds = input.changes.map((change) => change.id);
  if (new Set(changeIds).size !== changeIds.length)
    throw new Error("Creator plan change IDs must be unique");
  assertStepChangeCoverage(input.steps, changeIds);
  const mutationAuthority = derivePlanMutationAuthority(input.changes, observation, ownership);
  input.changes.forEach((change) =>
    assertCreatorPlanChange(change, input.changes, observation, ownership, mutationAuthority),
  );
  assertPlanChangeSet(input.changes, observation);
  const clauseIds = input.charter.clauses.map((clause) => clause.id);
  if (
    clauseIds.length === 0 ||
    clauseIds.length > CREATOR_MAX_CHARTER_CLAUSES ||
    new Set(clauseIds).size !== clauseIds.length
  )
    throw new Error("Verification charter requires unique clauses");
  input.charter.clauses.forEach((clause) =>
    assertProposedCharterClause(clause, input.changes, observation),
  );
  if (
    !input.charter.clauses.some(
      (clause) =>
        clause.kind === "studio_check" &&
        (clause.check === "instance_exists" || clause.check === "position_series"),
    )
  )
    throw new Error("Verification charter requires at least one bounded Workspace observation");
  if (
    !input.charter.clauses.some(
      (clause) => clause.kind === "studio_check" && clause.check === "playtest_diagnostics",
    )
  )
    throw new Error("Verification charter must expose its playtest diagnostic thresholds");
  assertPlanOutputCoverage(input.changes, input.charter.clauses);
  assertCreatorRuntimeObservationWindow(input.charter.clauses);
  if (
    input.changes.some(sourceBearingPlanChange) &&
    !input.charter.clauses.some(
      (clause) => clause.kind === "local_check" && clause.check === "luau_syntax",
    )
  )
    throw new Error(
      "Verification charter requires luau_syntax for a plan that creates or replaces source",
    );
  const clauses = input.charter.clauses.map((clause) =>
    materializeCharterClause(clause, observation),
  );
  const charterPayload = {
    visibility: "creator_visible" as const,
    authority: "creator_approved_hypothesis" as const,
    clauses,
  };
  const charterHash = contentHash(stableJson(charterPayload));
  const charter: VerificationCharter = {
    kind: "VerificationCharter",
    id: `verification_charter_${charterHash.slice(0, 24)}`,
    hash: charterHash,
    ...charterPayload,
  };
  const payload = {
    sessionId: input.sessionId,
    promptHash: input.promptHash,
    projectRevisionHash: input.projectRevisionHash,
    projectCaptureHash: input.projectCaptureHash,
    ownershipMapId: input.ownershipMapId,
    ownershipMapHash: input.ownershipMapHash,
    ...sourceEvidenceBinding,
    mutationAuthority,
    goal,
    inspectionPaths,
    steps: input.steps.map((step) => ({
      ...step,
      changeIds: [...step.changeIds],
    })),
    changes: input.changes.map(clonePlanChange),
    charter,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorPlan",
    id: `creator_plan_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function createCreatorApproval(
  input: Omit<CreatorApproval, "kind" | "id" | "hash" | "authority">,
): CreatorApproval {
  assertHash(input.artifactHash, "Approval artifact");
  const payload = { ...input, authority: "creator" as const };
  const hash = contentHash(stableJson(payload));
  const approval: CreatorApproval = {
    kind: "CreatorApproval",
    id: `creator_approval_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
  assertCreatorApproval(approval);
  return approval;
}

export function assertCreatorApproval(value: unknown): asserts value is CreatorApproval {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorApproval" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !["plan", "change_set"].includes(String(value.artifactKind)) ||
    !isId(value.artifactId) ||
    !isHash(value.artifactHash) ||
    !["approved", "rejected"].includes(String(value.decision)) ||
    typeof value.decidedAt !== "string" ||
    !Number.isFinite(Date.parse(value.decidedAt)) ||
    value.authority !== "creator"
  )
    throw new Error("Invalid CreatorApproval");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_approval_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorApproval identity");
}

export function createCreatorBuildContract(input: {
  session: CreatorSession;
  plan: CreatorPlan;
  planApproval: CreatorApproval;
  ownership: StudioOwnershipMap;
  projectIndex: CreatorProjectIndexView;
}): CreatorBuildContract {
  return materializeCreatorBuildContract(input, creatorPropertyPolicies());
}

/**
 * Build contracts are immutable evidence. New contracts use the current
 * generated policy, while replay rematerializes an existing contract from the
 * policy snapshot already sealed into that contract. Capability growth must
 * never rewrite the meaning of previously accepted evidence.
 */
function materializeCreatorBuildContract(
  input: {
    session: CreatorSession;
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
  },
  propertyPolicies: Readonly<Record<string, CreatorPropertyPolicy>>,
): CreatorBuildContract {
  assertCreatorPlan(input.plan);
  assertOwnershipMap(input.ownership);
  assertCreatorProjectIndexView(input.projectIndex);
  if (
    input.plan.sessionId !== input.session.id ||
    input.plan.promptHash !== input.session.promptHash ||
    input.plan.ownershipMapId !== input.ownership.id ||
    input.plan.ownershipMapHash !== input.ownership.hash ||
    input.plan.projectRevisionHash !== input.session.initialRevisionHash ||
    input.projectIndex.revision.hash !== input.session.currentRevisionHash ||
    input.planApproval.decision !== "approved" ||
    input.planApproval.artifactKind !== "plan" ||
    input.planApproval.artifactId !== input.plan.id ||
    input.planApproval.artifactHash !== input.plan.hash
  )
    throw new Error("Creator build contract plan or project-revision binding mismatch");
  const changes = input.plan.changes.map((change) =>
    materializeBuildContractChange(change, input.plan, input.projectIndex, propertyPolicies),
  );
  const initialInspectionPaths = [
    ...new Set([...changes.flatMap(contractInspectionPaths), ...input.plan.inspectionPaths]),
  ].sort();
  const payload = {
    sessionId: input.session.id,
    promptHash: input.session.promptHash,
    planId: input.plan.id,
    planHash: input.plan.hash,
    planApprovalId: input.planApproval.id,
    planApprovalHash: input.planApproval.hash,
    ownershipMapId: input.ownership.id,
    ownershipMapHash: input.ownership.hash,
    sourceIndexId: input.plan.sourceIndexId,
    sourceIndexHash: input.plan.sourceIndexHash,
    sourceConsultationId: input.plan.sourceConsultationId,
    sourceConsultationHash: input.plan.sourceConsultationHash,
    mutationAuthority: input.plan.mutationAuthority,
    initialRevisionHash: input.session.currentRevisionHash,
    initialInspectionPaths,
    propertyPolicies: propertyPolicies as Record<StudioWritableClass, CreatorPropertyPolicy>,
    changes,
  };
  const hash = contentHash(stableJson(payload));
  const contract: CreatorBuildContract = {
    kind: "CreatorBuildContract",
    id: `creator_build_contract_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
  assertCreatorBuildContract(contract);
  return contract;
}

export function assertCreatorBuildContract(value: unknown): asserts value is CreatorBuildContract {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorBuildContract" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isHash(value.promptHash) ||
    !isId(value.planId) ||
    !isHash(value.planHash) ||
    !isId(value.planApprovalId) ||
    !isHash(value.planApprovalHash) ||
    !isId(value.ownershipMapId) ||
    !isHash(value.ownershipMapHash) ||
    !isId(value.sourceIndexId) ||
    !isHash(value.sourceIndexHash) ||
    !isId(value.sourceConsultationId) ||
    !isHash(value.sourceConsultationHash) ||
    !isProjectWriteAuthority(value.mutationAuthority) ||
    !isHash(value.initialRevisionHash) ||
    !Array.isArray(value.initialInspectionPaths) ||
    value.initialInspectionPaths.length > CREATOR_MAX_INSPECTION_PATHS ||
    !value.initialInspectionPaths.every((path) => typeof path === "string") ||
    !isRecord(value.propertyPolicies) ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    value.changes.length > CREATOR_MAX_CHANGES
  )
    throw new Error("Invalid CreatorBuildContract");
  const policyKeys = Object.keys(value.propertyPolicies).sort();
  if (
    new Set(value.initialInspectionPaths).size !== value.initialInspectionPaths.length ||
    stableJson([...value.initialInspectionPaths].sort()) !==
      stableJson(value.initialInspectionPaths) ||
    value.initialInspectionPaths.some((path) => canonicalStudioPath(path) !== path)
  )
    throw new Error("CreatorBuildContract inspection paths are non-canonical");
  if (
    policyKeys.length === 0 ||
    policyKeys.length > 2_048 ||
    policyKeys.some(
      (className) =>
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(className) ||
        !isRobloxClassAssignableTo(className, "Instance"),
    )
  )
    throw new Error("CreatorBuildContract property policy classes are invalid");
  for (const className of policyKeys)
    assertCreatorPropertyPolicy(value.propertyPolicies[className]);
  const changeIds = new Set<string>();
  for (const change of value.changes) {
    if (
      !isRecord(change) ||
      !isId(change.planChangeId) ||
      !isId(change.operationId) ||
      !["create", "update", "move", "delete", "edit_source"].includes(String(change.kind)) ||
      changeIds.has(change.planChangeId)
    )
      throw new Error("Invalid CreatorBuildContract change");
    changeIds.add(change.planChangeId);
    if (!isRecord(change.propertyPolicy))
      throw new Error("Invalid CreatorBuildContract change policy");
    assertCreatorPropertyPolicy(change.propertyPolicy);
    const className = String(change.kind === "create" ? change.className : change.expectedClass);
    const sealedPolicy = value.propertyPolicies[className];
    if (
      sealedPolicy === undefined ||
      stableJson(change.propertyPolicy) !== stableJson(sealedPolicy)
    )
      throw new Error("CreatorBuildContract change policy is not bound to its sealed class policy");
  }
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_build_contract_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorBuildContract identity");
}

export function createCreatorChangeSet(
  input: Omit<CreatorChangeSet, "kind" | "id" | "hash" | "mutationAuthority">,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
  plan: CreatorPlan,
  contract: CreatorBuildContract,
): CreatorChangeSet {
  assertCreatorProjectIndexView(observation);
  assertOwnershipMap(ownership);
  assertCreatorBuildContract(contract);
  if (
    input.ownershipMapId !== ownership.id ||
    input.ownershipMapHash !== ownership.hash ||
    input.expectedRevisionHash !== contract.initialRevisionHash ||
    observation.revision.hash !== input.expectedRevisionHash
  )
    throw new Error("Creator change set ownership or active-revision binding mismatch");
  if (
    input.planId !== plan.id ||
    input.planHash !== plan.hash ||
    input.promptHash !== contract.promptHash ||
    input.charterId !== plan.charter.id ||
    input.charterHash !== plan.charter.hash ||
    input.planApprovalId !== contract.planApprovalId ||
    input.planApprovalHash !== contract.planApprovalHash ||
    input.buildContractId !== contract.id ||
    input.buildContractHash !== contract.hash ||
    plan.mutationAuthority !== contract.mutationAuthority
  )
    throw new Error("Creator change set plan binding mismatch");
  input.operations.forEach((operation) =>
    assertStudioChangeOperation(
      operation,
      observation,
      ownership,
      contract.mutationAuthority,
      input.operations,
    ),
  );
  const sourceWriteBlobs = [...input.sourceWriteBlobs];
  if (
    sourceWriteBlobs.some((binding) => {
      try {
        assertCreatorSourceWriteBlobBinding(binding);
        return false;
      } catch {
        return true;
      }
    }) ||
    new Set(sourceWriteBlobs.map((binding) => binding.manifestHash)).size !==
      sourceWriteBlobs.length ||
    stableJson(sourceWriteBlobs) !==
      stableJson(
        [...sourceWriteBlobs].sort((left, right) =>
          left.manifestHash.localeCompare(right.manifestHash),
        ),
      )
  )
    throw new Error("Creator change set source-write bindings are invalid");
  const declaredSourceWrites = new Map(
    sourceWriteBlobs.map((binding) => [binding.manifestHash, binding]),
  );
  const referencedSourceWrites = input.operations.flatMap((operation) => {
    if (operation.kind === "create")
      return operation.sourceBlob === undefined ? [] : [operation.sourceBlob];
    if (operation.kind === "edit_source")
      return operation.edits.map((edit) => edit.replacementBlob);
    return [];
  });
  if (
    referencedSourceWrites.some(
      (binding) =>
        declaredSourceWrites.get(binding.manifestHash) === undefined ||
        stableJson(declaredSourceWrites.get(binding.manifestHash)) !== stableJson(binding),
    ) ||
    new Set(referencedSourceWrites.map((binding) => binding.manifestHash)).size !==
      sourceWriteBlobs.length
  )
    throw new Error("Creator change set source-write bindings must be exact and fully referenced");
  if (
    input.operations.length === 0 ||
    input.operations.length > CREATOR_MAX_CHANGES ||
    new Set(input.operations.map((operation) => operation.id)).size !== input.operations.length
  )
    throw new Error(
      `Creator change set requires 1-${CREATOR_MAX_CHANGES} uniquely identified operations`,
    );
  const createdPaths = input.operations.flatMap((operation) =>
    operation.kind === "create" ? [operation.target.path] : [],
  );
  if (new Set(createdPaths).size !== createdPaths.length)
    throw new Error("Creator change set cannot create the same Studio path twice");
  const tempIds = input.operations.flatMap((operation) =>
    operation.kind === "create" ? [operation.tempId] : [],
  );
  if (new Set(tempIds).size !== tempIds.length)
    throw new Error("Creator change set create temp IDs must be unique");
  const existingTargets = input.operations.flatMap((operation) =>
    operation.kind === "create" ? [] : [studioObjectIdentityKey(operation.target.identity)],
  );
  if (new Set(existingTargets).size !== existingTargets.length)
    throw new Error("Creator change set permits only one operation per existing Studio target");
  assertOperationsMatchPlan(input.operations, plan.changes);
  assertOperationsMatchContract(input.operations, contract);
  const topology = compileCreatorTransactionTopology({
    initial: observation.instances,
    operations: input.operations,
  });
  const payload = {
    ...input,
    mutationAuthority: contract.mutationAuthority,
    operations: topology.orderedOperations.map(cloneOperation),
    sourceWriteBlobs,
    localGate: {
      ...input.localGate,
      issueHashes: [...input.localGate.issueHashes].sort(),
    },
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorChangeSet",
    id: `creator_change_set_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertCreatorChangeSet(value: unknown): asserts value is CreatorChangeSet {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorChangeSet" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !Number.isInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !isHash(value.promptHash) ||
    !isId(value.planId) ||
    !isHash(value.planHash) ||
    !isId(value.charterId) ||
    !isHash(value.charterHash) ||
    !isId(value.planApprovalId) ||
    !isHash(value.planApprovalHash) ||
    !isId(value.buildContractId) ||
    !isHash(value.buildContractHash) ||
    !isId(value.ownershipMapId) ||
    !isHash(value.ownershipMapHash) ||
    !isProjectWriteAuthority(value.mutationAuthority) ||
    !isHash(value.expectedRevisionHash) ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > CREATOR_MAX_CHANGES ||
    !Array.isArray(value.sourceWriteBlobs) ||
    !isRecord(value.localGate) ||
    value.localGate.status !== "eligible" ||
    !Array.isArray(value.localGate.issueHashes) ||
    !value.localGate.issueHashes.every(isHash)
  )
    throw new Error("Invalid CreatorChangeSet");
  for (const operation of value.operations) CHANGE_OPERATION_SCHEMA.parse(operation);
  const sourceWriteBlobs = value.sourceWriteBlobs as unknown[];
  sourceWriteBlobs.forEach(assertCreatorSourceWriteBlobBinding);
  if (
    new Set(
      sourceWriteBlobs.map((binding) => (binding as CreatorSourceWriteBlobBinding).manifestHash),
    ).size !== sourceWriteBlobs.length ||
    stableJson(sourceWriteBlobs) !==
      stableJson(
        [...sourceWriteBlobs].sort((left, right) =>
          (left as CreatorSourceWriteBlobBinding).manifestHash.localeCompare(
            (right as CreatorSourceWriteBlobBinding).manifestHash,
          ),
        ),
      )
  )
    throw new Error("Invalid CreatorChangeSet source-write bindings");
  const declared = new Map(
    sourceWriteBlobs.map((binding) => [
      (binding as CreatorSourceWriteBlobBinding).manifestHash,
      binding as CreatorSourceWriteBlobBinding,
    ]),
  );
  const referenced = (value.operations as StudioChangeOperation[]).flatMap((operation) =>
    operation.kind === "create"
      ? operation.sourceBlob === undefined
        ? []
        : [operation.sourceBlob]
      : operation.kind === "edit_source"
        ? operation.edits.map((edit) => edit.replacementBlob)
        : [],
  );
  if (
    referenced.some(
      (binding) =>
        declared.get(binding.manifestHash) === undefined ||
        stableJson(declared.get(binding.manifestHash)) !== stableJson(binding),
    ) ||
    new Set(referenced.map((binding) => binding.manifestHash)).size !== sourceWriteBlobs.length
  )
    throw new Error("Invalid CreatorChangeSet source-write reference coverage");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_change_set_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorChangeSet identity");
}

export function assertCreatorVerificationRecord(
  value: unknown,
): asserts value is CreatorVerificationRecord {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorVerificationRecord" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isId(value.changeSetId) ||
    !isHash(value.changeSetHash) ||
    !isId(value.charterId) ||
    !isHash(value.charterHash) ||
    !isHash(value.stateRevisionHash) ||
    !isHash(value.stateEvidenceHash) ||
    !isRecord(value.mutationAttempt) ||
    !isId(value.mutationAttempt.id) ||
    !isHash(value.mutationAttempt.hash) ||
    !isHash(value.mutationAttempt.reconciliationHash) ||
    !isRecord(value.executionPlan) ||
    !isId(value.executionPlan.id) ||
    !isHash(value.executionPlan.hash) ||
    !["passed", "failed", "incomplete"].includes(String(value.status)) ||
    (value.nonReplayableReason !== undefined &&
      (typeof value.nonReplayableReason !== "string" ||
        value.nonReplayableReason.trim().length === 0 ||
        value.nonReplayableReason.length > 4096)) ||
    !Array.isArray(value.failureFacts) ||
    value.failureFacts.length > 32 ||
    !value.failureFacts.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.statement === "string" &&
        fact.statement.length > 0 &&
        fact.statement.length <= 4096 &&
        isHash(fact.hash) &&
        fact.hash === contentHash(fact.statement),
    )
  )
    throw new Error("Invalid CreatorVerificationRecord");
  assertArtifactReference(value.executionPlan.artifact);
  if (value.runtimeEvidence !== undefined) {
    if (
      !isRecord(value.runtimeEvidence) ||
      !isHash(value.runtimeEvidence.evidenceHash) ||
      !isHash(value.runtimeEvidence.diagnosticsHash)
    )
      throw new Error("Invalid CreatorVerificationRecord runtime evidence");
    assertArtifactReference(value.runtimeEvidence.artifact);
  }
  if (
    value.status !== "incomplete" &&
    (value.status === "passed") !== (value.failureFacts.length === 0)
  )
    throw new Error("CreatorVerificationRecord status does not match its failure facts");
  if ((value.status === "incomplete") !== (value.nonReplayableReason !== undefined))
    throw new Error("Incomplete creator verification requires one non-replayable reason");
  assertArtifactIdentity(value, "creator_verification");
}

export function assertCreatorCheckpoint(value: unknown): asserts value is CreatorCheckpoint {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorCheckpoint" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isId(value.changeSetId) ||
    !isHash(value.changeSetHash) ||
    !isHash(value.beforeRevisionHash) ||
    !isHash(value.afterRevisionHash) ||
    !isId(value.mutationAttemptId) ||
    !isHash(value.mutationAttemptHash) ||
    !["committed", "rolled_back", "recovery_required"].includes(String(value.status))
  )
    throw new Error("Invalid CreatorCheckpoint");
  assertArtifactIdentity(value, "creator_checkpoint");
}

export function assertCreatorReviewReport(value: unknown): asserts value is CreatorReviewReport {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorReviewReport" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isId(value.changeSetId) ||
    !isHash(value.changeSetHash) ||
    !isId(value.charterId) ||
    !isHash(value.charterHash) ||
    !["accepted", "rejected"].includes(String(value.decision)) ||
    typeof value.report !== "string" ||
    value.report.trim().length === 0 ||
    Buffer.byteLength(value.report, "utf8") > 4096 ||
    !isHash(value.reviewedObservationHash) ||
    value.authority !== "creator" ||
    typeof value.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(value.reviewedAt))
  )
    throw new Error("Invalid CreatorReviewReport");
  assertArtifactIdentity(value, "creator_review_report");
}

export function createCreatorReviewReport(
  input: Omit<CreatorReviewReport, "kind" | "id" | "hash" | "authority">,
): CreatorReviewReport {
  const report = input.report.normalize("NFC");
  const payload = {
    ...input,
    report,
    authority: "creator" as const,
  };
  const hash = contentHash(stableJson(payload));
  const value: CreatorReviewReport = {
    kind: "CreatorReviewReport",
    id: `creator_review_report_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
  assertCreatorReviewReport(value);
  return value;
}

function assertArtifactIdentity(value: Record<string, unknown>, prefix: string): void {
  const { kind: _kind, id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || id !== `${prefix}_${expected.slice(0, 24)}`)
    throw new Error(`Invalid ${String(value.kind)} identity`);
}

export function serializeCreatorChangeSet(value: CreatorChangeSet): string {
  assertCreatorChangeSet(value);
  return stableJson(value);
}

export function advanceSession(
  session: CreatorSession,
  transition: {
    status: CreatorSessionStatus;
    now?: Date;
    plan?: CreatorPlan;
    approval?: CreatorApproval;
    changeSet?: CreatorChangeSet;
    checkpoint?: CreatorCheckpoint;
    review?: CreatorReviewReport;
    projectCapture?: {
      readonly captureHash: string;
      readonly revisionHash: string;
    };
    failure?: { code: string; detail: string };
  },
): CreatorSession {
  assertCreatorSession(session);
  assertTransition(session.status, transition.status);
  const next: CreatorSession = {
    ...session,
    updatedAt: (transition.now ?? new Date()).toISOString(),
    status: transition.status,
  };
  if (transition.plan) next.plan = { id: transition.plan.id, hash: transition.plan.hash };
  if (transition.approval?.artifactKind === "plan")
    next.planApproval = {
      id: transition.approval.id,
      hash: transition.approval.hash,
    };
  if (transition.approval?.artifactKind === "change_set")
    next.changeApproval = {
      id: transition.approval.id,
      hash: transition.approval.hash,
    };
  if (transition.changeSet)
    next.changeSet = {
      id: transition.changeSet.id,
      hash: transition.changeSet.hash,
    };
  if (transition.checkpoint)
    next.checkpoint = {
      id: transition.checkpoint.id,
      hash: transition.checkpoint.hash,
    };
  if (transition.review) next.review = { id: transition.review.id, hash: transition.review.hash };
  if (transition.projectCapture) {
    assertHash(transition.projectCapture.captureHash, "Creator session project-index capture");
    assertHash(transition.projectCapture.revisionHash, "Creator session revision");
    next.currentProjectCaptureHash = transition.projectCapture.captureHash;
    next.currentRevisionHash = transition.projectCapture.revisionHash;
  }
  if (transition.status === "repairing") {
    if (session.repairsUsed >= CREATOR_MAX_REPAIRS)
      throw new Error("Creator repair budget exhausted");
    next.repairsUsed = session.repairsUsed + 1;
  }
  if (transition.failure)
    next.failure = {
      code: transition.failure.code,
      detailHash: contentHash(transition.failure.detail),
    };
  return sealSession(next);
}

export function creatorOrientation(bundle: {
  readonly session: CreatorSession;
  readonly ownership: StudioOwnershipMap;
  /** Ephemeral verified project-index view; it is never persisted as state. */
  readonly projectIndex: CreatorProjectIndexView;
}): AgentOrientation {
  return compileCreatorOrientation({
    projectIndex: bundle.projectIndex,
    revisionHash: bundle.session.currentRevisionHash,
    projectId: bundle.session.projectId,
    availableAuthorities: bundle.ownership.availableAuthorities,
    ownership: new Map(bundle.ownership.entries.map((entry) => [entry.objectId, entry.owner])),
    allowedClasses: STUDIO_WRITABLE_CLASSES,
    resolvableClasses: STUDIO_RESOLVABLE_CLASSES,
  });
}

function formatZodIssues(
  issues: readonly {
    path: readonly PropertyKey[];
    message: string;
  }[],
): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path || "input"}: ${issue.message}`;
    })
    .join("; ");
}

abstract class BaseCreatorToolHost implements AgentToolHost {
  private executedCalls = 0;
  private executedWrites = 0;
  private executedVerifierCalls = 0;
  private totalResultBytes = 0;
  protected constructor(protected readonly budgets: BudgetPolicy = DEFAULT_AGENT_BUDGETS) {}
  abstract definitions(): AgentToolDefinition[];
  validateBatch(calls: readonly ModelToolCall[], seenIds: ReadonlySet<string>): ToolBatchDecision {
    const definitions = new Map(this.definitions().map((entry) => [entry.name, entry]));
    const feedback: ToolBatchDecision["feedback"] = [];
    let valid = true;
    const projected = {
      toolCalls: this.executedCalls + calls.length,
      writes: this.executedWrites + calls.filter((call) => call.name === "studio.stage").length,
      verifierCalls:
        this.executedVerifierCalls + calls.filter((call) => call.name === "forge.verify").length,
    };
    if (
      projected.toolCalls > this.budgets.maxToolCalls ||
      projected.writes > this.budgets.maxWrites ||
      projected.verifierCalls > this.budgets.maxVerifierCalls ||
      this.totalResultBytes >= this.budgets.maxToolResultBytes
    ) {
      return {
        valid: false,
        feedback: calls.map((call) => ({
          id: call.id,
          name: call.name,
          result: failed(
            "TOOL_BUDGET_EXHAUSTED",
            "Creator tool, write, verifier, or result-byte budget exhausted",
          ),
        })),
        budgetExhausted: true,
      };
    }
    for (const call of calls) {
      let result: ToolResult | undefined;
      if (call.id.length === 0)
        result = failed("TOOL_CALL_ID_EMPTY", "Tool-call ID must be non-empty");
      else if (
        seenIds.has(call.id) ||
        calls.filter((candidate) => candidate.id === call.id).length > 1
      )
        result = failed("TOOL_CALL_ID_DUPLICATE", `Duplicate tool-call ID ${call.id}`);
      else {
        const definitionValue = definitions.get(call.name);
        if (!definitionValue) result = failed("TOOL_UNKNOWN", `Unknown tool ${call.name}`);
        else {
          const parsed = z.object(definitionValue.inputShape).safeParse(call.arguments);
          if (!parsed.success)
            result = failed("TOOL_ARGUMENTS_INVALID", formatZodIssues(parsed.error.issues));
        }
      }
      if (result) {
        valid = false;
        feedback.push({ id: call.id, name: call.name, result });
      }
    }
    if (!valid)
      for (const call of calls)
        if (!feedback.some((entry) => entry.id === call.id))
          feedback.push({
            id: call.id,
            name: call.name,
            result: failed(
              "TOOL_BATCH_REJECTED",
              "No tool executed because another call in the batch was invalid",
            ),
          });
    return { valid, feedback, budgetExhausted: false };
  }
  async execute(name: string, input: unknown): Promise<ToolResult> {
    if (
      this.executedCalls >= this.budgets.maxToolCalls ||
      (name === "studio.stage" && this.executedWrites >= this.budgets.maxWrites) ||
      (name === "forge.verify" && this.executedVerifierCalls >= this.budgets.maxVerifierCalls) ||
      this.totalResultBytes >= this.budgets.maxToolResultBytes
    ) {
      const result = failed(
        "TOOL_BUDGET_EXHAUSTED",
        "Creator tool, write, verifier, or result-byte budget exhausted",
      );
      this.record(name, result);
      return result;
    }
    const definitionValue = this.definitions().find((entry) => entry.name === name);
    let result: ToolResult;
    if (!definitionValue) result = failed("TOOL_UNKNOWN", `Unknown tool ${name}`);
    else {
      const parsed = z.object(definitionValue.inputShape).safeParse(input);
      if (!parsed.success)
        result = failed("TOOL_ARGUMENTS_INVALID", formatZodIssues(parsed.error.issues));
      else {
        try {
          result = bounded(await this.dispatch(name, parsed.data));
        } catch (error) {
          result = failed(
            error instanceof ToolFailure ? error.code : "TOOL_FAILURE",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    if (this.totalResultBytes + result.bytes > this.budgets.maxToolResultBytes)
      result = failed("TOOL_OUTPUT_BUDGET_EXHAUSTED", "Creator tool-result byte budget exhausted");
    this.record(name, result);
    return result;
  }
  private record(name: string, result: ToolResult): void {
    this.executedCalls += 1;
    if (name === "studio.stage") this.executedWrites += 1;
    if (name === "forge.verify") this.executedVerifierCalls += 1;
    this.totalResultBytes += result.bytes;
  }
  protected abstract dispatch(name: string, input: unknown): Promise<unknown>;
}

function creatorRobloxApiLookup(
  input: z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>,
): unknown {
  try {
    return lookupRobloxApiCatalog({
      ...(input.className !== undefined ? { className: input.className } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  } catch (error) {
    throw new ToolFailure(
      "ROBLOX_API_LOOKUP_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const CREATOR_PROJECT_QUERY_LIMIT = 100;
const CREATOR_CITATION_LIMIT = 32;
const CREATOR_CONVERSATION_TEXT_MAX_BYTES = 16_000;
const CREATOR_CITATION_HANDLE_SCHEMA = z.string().regex(/^creator_citation_[a-f0-9]{24}$/);
const CREATOR_CITATION_HANDLES_SCHEMA = z
  .array(CREATOR_CITATION_HANDLE_SCHEMA)
  .max(CREATOR_CITATION_LIMIT)
  .refine((handles) => new Set(handles).size === handles.length, "citation handles must be unique");
const CREATOR_ANSWER_SHAPE = {
  text: z
    .string()
    .min(1)
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <= CREATOR_CONVERSATION_TEXT_MAX_BYTES,
      "answer exceeds the creator conversation text bound",
    ),
  citationHandles: CREATOR_CITATION_HANDLES_SCHEMA,
} satisfies ZodRawShape;
const CREATOR_CLARIFICATION_SHAPE = {
  question: z
    .string()
    .min(1)
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <= CREATOR_CONVERSATION_TEXT_MAX_BYTES,
      "clarification exceeds the creator conversation text bound",
    ),
  citationHandles: CREATOR_CITATION_HANDLES_SCHEMA,
} satisfies ZodRawShape;

function projectCursor(input: {
  revisionHash: string;
  operation: "search" | "children";
  query: unknown;
  offset: number;
}): string {
  const binding = contentHash(
    stableJson({
      revisionHash: input.revisionHash,
      operation: input.operation,
      query: input.query,
    }),
  );
  return `creator_project_cursor_${binding.slice(0, 24)}_${input.offset}`;
}

function projectCursorOffset(input: {
  cursor?: string;
  revisionHash: string;
  operation: "search" | "children";
  query: unknown;
}): number {
  if (input.cursor === undefined) return 0;
  const match = /^creator_project_cursor_([a-f0-9]{24})_(\d+)$/.exec(input.cursor);
  const expected = projectCursor({ ...input, offset: 0 })
    .split("_")
    .at(-2);
  if (!match || match[1] !== expected)
    throw new ToolFailure(
      "PROJECT_CURSOR_STALE",
      "Project cursor is stale or belongs to another query or revision. Omit cursor to start at the first page; for later pages copy nextCursor from this exact query. Never invent a cursor.",
    );
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ToolFailure("PROJECT_CURSOR_INVALID", "Project cursor offset is invalid");
  return offset;
}

function sealCreatorAgentCitation(
  input: Omit<CreatorAgentCitation, "kind" | "id" | "hash" | "handle">,
): CreatorAgentCitation {
  const canonical = JSON.parse(stableJson(input)) as typeof input;
  const hash = contentHash(stableJson(canonical));
  return {
    kind: "CreatorAgentCitation",
    id: `creator_agent_citation_${hash.slice(0, 24)}`,
    hash,
    handle: `creator_citation_${hash.slice(0, 24)}`,
    ...canonical,
  };
}

/**
 * Materialize a host-owned citation for conversation context that is already
 * immutable before an AgentRun starts. Project/source citations are still
 * issued only by their bounded tools; this entry point deliberately accepts
 * only creator memory or prior durable evidence.
 */
export function createCreatorAgentContextCitation(input: {
  projectRevisionHash: string;
  label: string;
  subject:
    | {
        kind: "memory";
        memoryItemId: string;
        revisionId: string;
        revisionHash: string;
      }
    | {
        kind: "prior_evidence";
        eventId: string;
        eventHash: string;
        evidence: {
          id: string;
          hash: string;
          artifact: ArtifactReference;
        };
      };
}): CreatorAgentContextCitation {
  assertHash(input.projectRevisionHash, "conversation citation project revision");
  const label = input.label.normalize("NFC").trim();
  if (label.length === 0 || Buffer.byteLength(label, "utf8") > 512)
    throw new Error("Conversation citation label is invalid");
  const authority =
    input.subject.kind === "memory"
      ? ("creator_memory" as const)
      : ("conversation_evidence" as const);
  const citation = sealCreatorAgentCitation({
    projectRevisionHash: input.projectRevisionHash,
    authority,
    subject: input.subject,
  });
  assertCreatorAgentCitation(citation);
  return { label, citation };
}

function sealCreatorAgentOutcome(
  input:
    | { kind: "answer"; text: string; citations: CreatorAgentCitation[] }
    | { kind: "clarification_requested"; question: string; citations: CreatorAgentCitation[] }
    | { kind: "plan_proposed"; plan: CreatorPlan; citations: CreatorAgentCitation[] },
): CreatorAgentOutcome {
  const canonical = JSON.parse(stableJson(input)) as typeof input;
  const hash = contentHash(stableJson(canonical));
  return {
    ...canonical,
    id: `creator_agent_outcome_${hash.slice(0, 24)}`,
    hash,
  } as CreatorAgentOutcome;
}

function citationRanges(value: unknown): Array<{
  documentId: string;
  path: string;
  sourceHash: string;
  startByte: number;
  endByte: number;
}> {
  const ranges = new Map<
    string,
    {
      documentId: string;
      path: string;
      sourceHash: string;
      startByte: number;
      endByte: number;
    }
  >();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isRecord(candidate)) return;
    const document = isRecord(candidate.document)
      ? candidate.document
      : isRecord(candidate.source)
        ? candidate.source
        : undefined;
    const range = isRecord(candidate.range)
      ? candidate.range
      : isRecord(candidate.snippetRange)
        ? candidate.snippetRange
        : isRecord(candidate.location)
          ? candidate.location
          : undefined;
    if (
      document &&
      range &&
      typeof document.documentId === "string" &&
      typeof document.path === "string" &&
      typeof document.sourceHash === "string" &&
      Number.isSafeInteger(range.startByte) &&
      Number.isSafeInteger(range.endByte) &&
      Number(range.startByte) >= 0 &&
      Number(range.endByte) >= Number(range.startByte)
    ) {
      const item = {
        documentId: document.documentId,
        path: document.path,
        sourceHash: document.sourceHash,
        startByte: Number(range.startByte),
        endByte: Number(range.endByte),
      };
      ranges.set(`${item.documentId}:${item.startByte}:${item.endByte}`, item);
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...ranges.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte,
  );
}

export class CreatorPlannerToolHost extends BaseCreatorToolHost {
  private outcome?: CreatorAgentOutcome;
  private lastProposalFailure: ToolFailure | undefined;
  private readonly inspectedPaths = new Set<string>();
  private readonly citations = new Map<string, CreatorAgentCitation>();
  private readonly sourceIndex: StudioSourceIndex;
  private readonly sourceRecorder: SourceConsultationRecorder;
  constructor(
    private readonly input: {
      session: CreatorSession;
      ownership: StudioOwnershipMap;
      projectIndex: CreatorProjectIndexView;
      sourceIndex: StudioSourceIndex;
      sourceResolver: VerifiedSourceResolver;
      prompt: string;
      contextCitations?: readonly CreatorAgentContextCitation[];
      budgets?: BudgetPolicy;
    },
  ) {
    super(input.budgets);
    assertProductionStudioSourceIndex(input.sourceIndex);
    if (input.sourceIndex.snapshotHash !== input.session.currentProjectCaptureHash)
      throw new Error("Planner source index does not bind the current project-index capture");
    if ((input.contextCitations?.length ?? 0) > CREATOR_CITATION_LIMIT)
      throw new Error("Conversation context citation bound exceeded");
    for (const entry of input.contextCitations ?? []) {
      assertCreatorAgentContextCitation(entry);
      if (this.citations.has(entry.citation.handle))
        throw new Error("Conversation context citation handles must be unique");
      this.citations.set(entry.citation.handle, structuredClone(entry.citation));
    }
    this.sourceIndex = structuredClone(input.sourceIndex);
    this.sourceRecorder = new SourceConsultationRecorder(this.sourceIndex, input.sourceResolver);
  }
  override definitions(): AgentToolDefinition[] {
    return [
      definition(
        "studio.api_lookup",
        "Search the pinned official Roblox Engine API catalog for class, property, method, event, callback, datatype, or enum metadata. Results include signatures, security/capability context, source provenance, and Forge's precise direct-authoring/source-only/restricted disposition. Catalog presence informs Luau source; it never grants typed Studio mutation or behavioral proof.",
        ROBLOX_API_LOOKUP_SHAPE,
      ),
      definition(
        "project.search",
        "Search the exact current project index by display path, instance name, or class. Results are bounded, revision-cursor paged, and carry host-issued project-fact citation handles.",
        {
          query: z.string().min(1).max(512),
          limit: z.number().int().min(1).max(CREATOR_PROJECT_QUERY_LIMIT).optional(),
          cursor: PROJECT_QUERY_CURSOR_SCHEMA,
        },
      ),
      definition(
        "project.children",
        'List exact children of one opaque object identity, or one top-level Studio root. Supply exactly one of parentObjectId and rootPath; omit the other field. First-page example: {"rootPath":"Workspace"}. Use only object IDs returned by project.search or project.children. Results are bounded, revision-cursor paged, and carry host-issued project-fact citation handles.',
        {
          parentObjectId: z
            .string()
            .min(1)
            .max(1024)
            .describe("Exact objectId returned by a project tool. Omit when using rootPath.")
            .optional(),
          rootPath: z
            .string()
            .min(1)
            .max(512)
            .describe("Top-level Studio root, e.g. Workspace. Omit when using parentObjectId.")
            .optional(),
          limit: z.number().int().min(1).max(CREATOR_PROJECT_QUERY_LIMIT).optional(),
          cursor: PROJECT_QUERY_CURSOR_SCHEMA,
        },
      ),
      definition(
        "project.inspect",
        "Inspect covered properties, attributes, tags, positions, ownership, and source metadata for exact opaque object identities from the current project index. Source bodies are never returned. Returned facts carry host-issued citation handles.",
        {
          objectIds: z.array(z.string().min(1).max(1024)).min(1).max(CREATOR_MAX_INSPECTION_PATHS),
        },
      ),
      definition(
        "source.search",
        "Search current hash-verified Luau source without executing it. Results and cursors are bound to this exact project source index and become host-authored consultation evidence.",
        {
          query: z.string().min(1).max(512),
          pathPrefix: z.string().min(1).optional(),
          contextUtf8Bytes: z.number().int().min(1).max(512).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().min(1).optional(),
        },
      ),
      definition(
        "source.read",
        "Read one UTF-8-safe page from current hash-verified Luau source. The page, source hash, byte range, and cursor are consultation evidence.",
        {
          documentId: z.string().min(1).max(256),
          maximumUtf8Bytes: z
            .number()
            .int()
            .min(1)
            .max(32 * 1024)
            .optional(),
          cursor: z.string().min(1).optional(),
        },
      ),
      definition(
        "source.symbols",
        "Find static Luau document/workspace symbols in the current source index. This is static-analysis context, not Studio or runtime proof.",
        {
          query: z.string().min(1).max(256),
          pathPrefix: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).optional(),
        },
      ),
      definition(
        "source.references",
        "Find lexical references for one Luau symbol in the current source index, with cursor-bound static-analysis results.",
        {
          symbol: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          pathPrefix: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).optional(),
        },
      ),
      definition(
        "source.dependencies",
        "Inspect static require edges, reverse dependencies, or a bounded dependency closure. Dynamic and unresolved edges remain explicit with source locations.",
        {
          documentId: z.string().min(1).max(256),
          direction: z.enum(["imports", "importers", "closure"]),
          maxDepth: z.number().int().min(1).max(16).optional(),
          limit: z.number().int().min(1).max(1024).optional(),
          cursor: z.string().min(1).optional(),
        },
      ),
      definition(
        "creator.propose_plan",
        `Propose typed changes and a creator-visible verification charter for the immutable creator request. Explore relevant source with source.search, source.read, source.symbols, source.references, and source.dependencies before selecting an existing source target; Forge records the exact consulted closure. Explicitly list every already-inspected initial-index path whose facts the builder may inspect; this list is creator-reviewed and contract-bound. Forge, not the model, derives the plan goal from that request. Each step must bind exact changeIds, covering every change once. Use citationHandles only for relevant host-issued conversation-memory or prior-evidence context; current project/source facts consulted by the plan are bound automatically. Every create or move parent must be either a manifest-declared engine-owned authoring container or an exact Studio-document-owned structural anchor in the initial index; parent authority never grants mutation authority over the parent. Planned instances cannot parent other planned instances. A Script, LocalScript, or ModuleScript create must declare initialization inline_source_required: its one create operation will carry complete initial source. edit_source is only for a Script, LocalScript, or ModuleScript present in the initial index; it cannot author a newly planned script. Non-script creation uses initial_properties. Machine-check language is generated by Forge. Every position_series clause must satisfy (sampleCount - 1) * intervalMs >= ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS}; the manifest bounds each field and the concurrent runtime window.`,
        PLAN_SHAPE,
      ),
      definition(
        "creator.answer",
        "Answer the creator without proposing or applying a change. Cite only host-issued handles returned during this run; uncited prose remains explicit agent interpretation.",
        CREATOR_ANSWER_SHAPE,
      ),
      definition(
        "creator.request_clarification",
        "Ask one material question when a safe, useful plan cannot yet be selected. Cite only host-issued handles returned during this run.",
        CREATOR_CLARIFICATION_SHAPE,
      ),
    ];
  }
  getOutcome(): CreatorAgentOutcome | undefined {
    return this.outcome === undefined ? undefined : structuredClone(this.outcome);
  }
  getSourceIndex(): StudioSourceIndex {
    return structuredClone(this.sourceIndex);
  }
  getSourceConsultation(): CreatorSourceConsultation {
    return this.sourceRecorder.seal();
  }
  progressToken(): string {
    return this.outcome?.hash ?? "creator-outcome-unpublished";
  }
  completionStatus(): AgentToolCompletionStatus {
    return this.outcome
      ? { ready: true }
      : {
          ready: false,
          code: "CREATOR_OUTCOME_NOT_PUBLISHED",
          message: this.lastProposalFailure
            ? `Creator agent ended without publishing a valid outcome. Last outcome failure: ${this.lastProposalFailure.message}`
            : "Creator agent ended without publishing an answer, clarification, or plan",
        };
  }
  protected override async dispatch(name: string, input: unknown): Promise<unknown> {
    if (name === "studio.api_lookup")
      return creatorRobloxApiLookup(input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>);
    if (name === "project.search") return this.searchProject(input as never);
    if (name === "project.children") return this.projectChildren(input as never);
    if (name === "project.inspect") return this.inspectProject(input as never);
    if (
      name === "source.search" ||
      name === "source.read" ||
      name === "source.symbols" ||
      name === "source.references" ||
      name === "source.dependencies"
    )
      return this.sourceTool(name, input);
    if (name === "creator.answer") {
      const value = input as z.infer<z.ZodObject<typeof CREATOR_ANSWER_SHAPE>>;
      this.requireNoOutcome();
      this.outcome = sealCreatorAgentOutcome({
        kind: "answer",
        text: value.text.normalize("NFC"),
        citations: this.resolveCitations(value.citationHandles),
      });
      return { outcomeId: this.outcome.id, outcomeHash: this.outcome.hash };
    }
    if (name === "creator.request_clarification") {
      const value = input as z.infer<z.ZodObject<typeof CREATOR_CLARIFICATION_SHAPE>>;
      this.requireNoOutcome();
      this.outcome = sealCreatorAgentOutcome({
        kind: "clarification_requested",
        question: value.question.normalize("NFC"),
        citations: this.resolveCitations(value.citationHandles),
      });
      return { outcomeId: this.outcome.id, outcomeHash: this.outcome.hash };
    }
    if (name !== "creator.propose_plan")
      throw new ToolFailure("TOOL_UNKNOWN", `Unknown planner tool ${name}`);
    this.requireNoOutcome();
    const value = input as z.infer<z.ZodObject<typeof PLAN_SHAPE>>;
    const uninspected = value.inspectionPaths.filter((path) => !this.inspectedPaths.has(path));
    if (uninspected.length > 0)
      throw correctiveFailure(
        "PLAN_INSPECTION_NOT_OBSERVED",
        "Every declared builder inspection dependency must first be inspected by the read-only planner",
        {
          uninspectedPaths: uninspected,
          inspectedPaths: [...this.inspectedPaths].sort(),
        },
      );
    try {
      const sourceConsultation = this.sourceRecorder.seal();
      const sourceChanges = (value.changes as CreatorPlanChange[]).filter(sourceBearingPlanChange);
      const existingSourceTargets = sourceChanges.flatMap((change) =>
        change.kind === "edit_source"
          ? [
              {
                documentId: studioObjectIdentityKey(change.target.identity),
                path: change.target.path,
              },
            ]
          : [],
      );
      const unconsultedTargets = existingSourceTargets.filter(
        (target) =>
          !sourceConsultation.operations.some(
            (operation) =>
              operation.kind === "read" &&
              operation.sources.some(
                (source) =>
                  source.document.documentId === target.documentId && source.ranges.length > 0,
              ),
          ),
      );
      const targetsWithoutDependencyClosure = existingSourceTargets.filter(
        (target) =>
          !sourceConsultation.operations.some(
            (operation) =>
              operation.kind === "dependencies" &&
              operation.dependencyRequest?.direction === "closure" &&
              operation.dependencyRequest.root.documentId === target.documentId,
          ),
      );
      const dependencyConsulted = sourceConsultation.operations.some(
        (operation) => operation.kind === "dependencies",
      );
      if (
        unconsultedTargets.length > 0 ||
        targetsWithoutDependencyClosure.length > 0 ||
        (sourceChanges.length > 0 &&
          this.sourceIndex.documents.length > 0 &&
          (!dependencyConsulted || sourceConsultation.sources.length === 0))
      )
        throw correctiveFailure(
          "SOURCE_CONSULTATION_INCOMPLETE",
          "Every source-bearing plan must be grounded in the current target source and a static dependency consultation before review",
          {
            unconsultedTargetDocumentIds: unconsultedTargets.map((target) => target.documentId),
            targetsWithoutDependencyClosure: targetsWithoutDependencyClosure.map(
              (target) => target.documentId,
            ),
            dependencyConsulted,
            consultedPaths: sourceConsultation.sources.map((source) => source.document.path),
            sourceIndexHash: this.sourceIndex.hash,
          },
        );
      const plan = createCreatorPlan(
        {
          sessionId: this.input.session.id,
          promptHash: this.input.session.promptHash,
          projectRevisionHash: this.input.session.currentRevisionHash,
          projectCaptureHash: this.input.session.currentProjectCaptureHash,
          ownershipMapId: this.input.ownership.id,
          ownershipMapHash: this.input.ownership.hash,
          creatorPrompt: this.input.prompt,
          inspectionPaths: value.inspectionPaths,
          steps: value.steps,
          changes: value.changes as CreatorPlanChange[],
          charter: {
            clauses: value.clauses as VerificationCharterProposalClause[],
          },
          sourceIndex: this.sourceIndex,
          sourceConsultation,
        },
        this.input.projectIndex,
        this.input.ownership,
      );
      const contextual = this.resolveCitations(value.citationHandles ?? []).filter((citation) =>
        ["creator_memory", "conversation_evidence"].includes(citation.authority),
      );
      const grounded = [...this.citations.values()].filter((citation) =>
        ["project_index", "static_analysis"].includes(citation.authority),
      );
      const citations = new Map(
        [...grounded, ...contextual].map((citation) => [citation.handle, citation]),
      );
      this.outcome = sealCreatorAgentOutcome({
        kind: "plan_proposed",
        plan,
        citations: [...citations.values()].sort((left, right) =>
          left.handle.localeCompare(right.handle),
        ),
      });
    } catch (error) {
      this.lastProposalFailure =
        error instanceof CreatorValidationFailure
          ? correctiveFailure(error.code, error.message, error.details)
          : new ToolFailure("PLAN_INVALID", error instanceof Error ? error.message : String(error));
      throw this.lastProposalFailure;
    }
    this.lastProposalFailure = undefined;
    if (!this.outcome || this.outcome.kind !== "plan_proposed")
      throw new Error("Creator plan outcome was not retained");
    return {
      outcomeId: this.outcome.id,
      outcomeHash: this.outcome.hash,
      planId: this.outcome.plan.id,
      planHash: this.outcome.plan.hash,
      charterId: this.outcome.plan.charter.id,
      charterHash: this.outcome.plan.charter.hash,
    };
  }

  private requireNoOutcome(): void {
    if (this.outcome)
      throw new ToolFailure(
        "CREATOR_OUTCOME_ALREADY_PUBLISHED",
        "Exactly one creator outcome may be published in an AgentRun",
      );
  }

  private resolveCitations(handles: readonly string[]): CreatorAgentCitation[] {
    return handles.map((handle) => {
      const citation = this.citations.get(handle);
      if (!citation)
        throw new ToolFailure(
          "CREATOR_CITATION_NOT_ISSUED",
          `Citation handle ${handle} was not issued during this AgentRun`,
        );
      return citation;
    });
  }

  private issueProjectCitation(
    instance: CreatorProjectIndexView["instances"][number],
  ): CreatorAgentCitation {
    const citation = sealCreatorAgentCitation({
      projectRevisionHash: this.input.session.currentRevisionHash,
      authority: "project_index",
      subject: {
        kind: "project_fact",
        objectId: instance.objectId,
        path: instance.path,
        className: instance.className,
        factHash: contentHash(stableJson(instance)),
      },
    });
    this.citations.set(citation.handle, citation);
    return citation;
  }

  private projectSummary(instance: CreatorProjectIndexView["instances"][number]): unknown {
    const citation = this.issueProjectCitation(instance);
    return {
      objectId: instance.objectId,
      path: instance.path,
      name: instance.name,
      className: instance.className,
      owner:
        this.input.ownership.entries.find((entry) => entry.objectId === instance.objectId)?.owner ??
        "studio_document",
      citationHandle: citation.handle,
    };
  }

  private searchProject(input: { query: string; limit?: number; cursor?: string }): unknown {
    const query = input.query.normalize("NFC").toLocaleLowerCase("en-US");
    const queryBinding = { query };
    const offset = projectCursorOffset({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      revisionHash: this.input.session.currentRevisionHash,
      operation: "search",
      query: queryBinding,
    });
    const limit = input.limit ?? 40;
    const matches = this.input.projectIndex.instances.filter((instance) =>
      [instance.path, instance.name, instance.className].some((value) =>
        value.toLocaleLowerCase("en-US").includes(query),
      ),
    );
    const page = matches.slice(offset, offset + limit);
    return {
      revisionHash: this.input.session.currentRevisionHash,
      results: page.map((instance) => this.projectSummary(instance)),
      ...(offset + page.length < matches.length
        ? {
            nextCursor: projectCursor({
              revisionHash: this.input.session.currentRevisionHash,
              operation: "search",
              query: queryBinding,
              offset: offset + page.length,
            }),
          }
        : {}),
    };
  }

  private projectChildren(input: {
    parentObjectId?: string;
    rootPath?: string;
    limit?: number;
    cursor?: string;
  }): unknown {
    if ((input.parentObjectId === undefined) === (input.rootPath === undefined))
      throw new ToolFailure(
        "PROJECT_PARENT_INVALID",
        'project.children requires exactly one parentObjectId or rootPath. For a root, send {"rootPath":"Workspace"} and omit parentObjectId. For an object, use its returned objectId and omit rootPath. Omit cursor for the first page.',
      );
    const queryBinding = {
      ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
      ...(input.rootPath ? { rootPath: canonicalStudioPath(input.rootPath) } : {}),
    };
    const offset = projectCursorOffset({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      revisionHash: this.input.session.currentRevisionHash,
      operation: "children",
      query: queryBinding,
    });
    const limit = input.limit ?? 40;
    const children = this.input.projectIndex.instances.filter((instance) => {
      if (input.parentObjectId)
        return (
          instance.parentIdentity !== undefined &&
          studioObjectIdentityKey(instance.parentIdentity) === input.parentObjectId
        );
      const path = instance.path.split("/");
      return path.length === 2 && path[0] === queryBinding.rootPath;
    });
    const page = children.slice(offset, offset + limit);
    return {
      revisionHash: this.input.session.currentRevisionHash,
      results: page.map((instance) => this.projectSummary(instance)),
      ...(offset + page.length < children.length
        ? {
            nextCursor: projectCursor({
              revisionHash: this.input.session.currentRevisionHash,
              operation: "children",
              query: queryBinding,
              offset: offset + page.length,
            }),
          }
        : {}),
    };
  }

  private inspectProject(input: { objectIds: string[] }): unknown {
    if (new Set(input.objectIds).size !== input.objectIds.length)
      throw new ToolFailure(
        "PROJECT_INSPECTION_DUPLICATE",
        "Project object identities must be unique",
      );
    const missing = input.objectIds.filter(
      (objectId) => !this.input.projectIndex.instances.some((entry) => entry.objectId === objectId),
    );
    if (missing.length > 0)
      throw new ToolFailure(
        "PROJECT_INSPECTION_ABSENT",
        `Project index has no object for: ${missing.join(", ")}`,
      );
    const instances = this.input.projectIndex.instances
      .filter((instance) => input.objectIds.includes(instance.objectId))
      .map((instance) => {
        this.inspectedPaths.add(instance.path);
        const citation = this.issueProjectCitation(instance);
        const script = this.input.projectIndex.scripts.find(
          (candidate) => candidate.documentId === instance.objectId,
        );
        return {
          objectId: instance.objectId,
          path: instance.path,
          name: instance.name,
          className: instance.className,
          owner:
            this.input.ownership.entries.find((entry) => entry.objectId === instance.objectId)
              ?.owner ?? "studio_document",
          ...(instance.position ? { position: instance.position } : {}),
          properties: instance.properties,
          attributes: instance.attributes,
          tags: instance.tags,
          ...(script
            ? {
                source: {
                  documentId: script.documentId,
                  sourceHash: script.sourceHash,
                  utf8Bytes: script.utf8Bytes,
                  executionContext: script.executionContext,
                },
              }
            : {}),
          citationHandle: citation.handle,
        };
      });
    return { revisionHash: this.input.session.currentRevisionHash, instances };
  }

  private sourceTool(
    name:
      | "source.search"
      | "source.read"
      | "source.symbols"
      | "source.references"
      | "source.dependencies",
    input: unknown,
  ): unknown {
    const result =
      name === "source.search"
        ? this.sourceRecorder.search(input as Parameters<SourceConsultationRecorder["search"]>[0])
        : name === "source.read"
          ? this.sourceRecorder.read(input as Parameters<SourceConsultationRecorder["read"]>[0])
          : name === "source.symbols"
            ? this.sourceRecorder.symbols(
                input as Parameters<SourceConsultationRecorder["symbols"]>[0],
              )
            : name === "source.references"
              ? this.sourceRecorder.references(
                  input as Parameters<SourceConsultationRecorder["references"]>[0],
                )
              : this.sourceRecorder.dependenciesPage(
                  input as Parameters<SourceConsultationRecorder["dependenciesPage"]>[0],
                );
    const ranges = citationRanges(result);
    const citation = sealCreatorAgentCitation({
      projectRevisionHash: this.input.session.currentRevisionHash,
      authority: "static_analysis",
      subject: {
        kind: "source_ranges",
        tool: name,
        resultHash: contentHash(stableJson(result)),
        ranges,
      },
    });
    this.citations.set(citation.handle, citation);
    return { result, citationHandle: citation.handle };
  }
}

export class CreatorBuilderToolHost extends BaseCreatorToolHost {
  private readonly operations: StudioChangeOperation[] = [];
  /** Raw source exists only while the bounded builder is running. Sealed
   * operations retain metadata bindings; callers persist these leaves before
   * the change set may be approved or transported. */
  private readonly sourceWriteBlobs = new Map<string, CreatorSourceWriteBlobCapture>();
  private localGate: CreatorChangeSet["localGate"] = {
    status: "incomplete",
    issueHashes: [],
  };
  readonly contract: CreatorBuildContract;
  constructor(
    private readonly input: {
      session: CreatorSession;
      ownership: StudioOwnershipMap;
      projectIndex: CreatorProjectIndexView;
      plan: CreatorPlan;
      planApproval: CreatorApproval;
      sourceIndex: StudioSourceIndex;
      sourceResolver: VerifiedSourceResolver;
      sourceConsultation: CreatorSourceConsultation;
      budgets?: BudgetPolicy;
    },
  ) {
    super(input.budgets);
    assertProductionStudioSourceIndex(input.sourceIndex);
    assertCreatorSourceConsultation(input.sourceConsultation, input.sourceIndex);
    if (
      input.sourceIndex.id !== input.plan.sourceIndexId ||
      input.sourceIndex.hash !== input.plan.sourceIndexHash ||
      input.sourceConsultation.id !== input.plan.sourceConsultationId ||
      input.sourceConsultation.hash !== input.plan.sourceConsultationHash
    )
      throw new Error("Builder source consultation does not match the approved plan");
    this.contract = createCreatorBuildContract(input);
  }
  override definitions(): AgentToolDefinition[] {
    return BUILDER_DEFINITIONS;
  }
  stagedOperations(): StudioChangeOperation[] {
    return this.operations.map(cloneOperation);
  }
  stagedSourceWriteBlobs(): readonly CreatorSourceWriteBlobCapture[] {
    const bindings = this.operations.flatMap((operation) =>
      operation.kind === "create"
        ? operation.sourceBlob === undefined
          ? []
          : [operation.sourceBlob]
        : operation.kind === "edit_source"
          ? operation.edits.map((edit) => edit.replacementBlob)
          : [],
    );
    return [...new Set(bindings.map((binding) => binding.manifestHash))]
      .sort()
      .map((manifestHash) => {
        const capture = this.sourceWriteBlobs.get(manifestHash);
        if (capture === undefined) throw new Error("Staged source-write blob body is missing");
        assertCreatorSourceWriteBlobCapture(capture, CREATOR_DEFAULT_RESOURCE_POLICY);
        return capture;
      });
  }
  private sourceWriteBlob(source: string): CreatorSourceWriteBlobBinding {
    const capture = createCreatorSourceWriteBlobCapture({
      source,
      maximumSourceBlobBytes: CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes,
      transportChunkBytes: CREATOR_DEFAULT_RESOURCE_POLICY.transportChunkBytes,
    });
    const binding = creatorSourceWriteBlobBinding(capture);
    this.sourceWriteBlobs.set(binding.manifestHash, capture);
    return binding;
  }
  private sourceWriteText(binding: CreatorSourceWriteBlobBinding): string {
    const capture = this.sourceWriteBlobs.get(binding.manifestHash);
    if (capture === undefined) throw new Error("Staged source-write blob body is missing");
    return materializeCreatorSourceWriteBlob(capture, binding);
  }
  gate(): CreatorChangeSet["localGate"] {
    return { ...this.localGate, issueHashes: [...this.localGate.issueHashes] };
  }
  progressToken(): string {
    return contentHash(
      stableJson({
        operations: this.operations.map((operation) => contentHash(stableJson(operation))),
        localGate: this.localGate,
      }),
    );
  }
  completionStatus(): AgentToolCompletionStatus {
    if (this.operations.length === 0)
      return {
        ready: false,
        code: "BUILDER_NO_OPERATIONS",
        message: "Creator builder ended with no accepted Studio operations",
      };
    try {
      assertOperationsMatchPlan(this.operations, this.input.plan.changes);
    } catch (error) {
      return {
        ready: false,
        code: "BUILDER_CHANGE_COVERAGE_INCOMPLETE",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.localGate.status !== "eligible")
      return {
        ready: false,
        code: "BUILDER_LOCAL_GATE_NOT_ELIGIBLE",
        message: `Creator builder ended before forge.verify established an eligible local gate (current: ${this.localGate.status})`,
      };
    return { ready: true };
  }
  seal(): CreatorChangeSet {
    const completion = this.completionStatus();
    if (!completion.ready) throw new Error(completion.message);
    const changeSet = createCreatorChangeSet(
      {
        sessionId: this.input.session.id,
        attempt: this.input.session.repairsUsed + 1,
        promptHash: this.input.session.promptHash,
        planId: this.input.plan.id,
        planHash: this.input.plan.hash,
        charterId: this.input.plan.charter.id,
        charterHash: this.input.plan.charter.hash,
        planApprovalId: this.input.planApproval.id,
        planApprovalHash: this.input.planApproval.hash,
        buildContractId: this.contract.id,
        buildContractHash: this.contract.hash,
        ownershipMapId: this.input.ownership.id,
        ownershipMapHash: this.input.ownership.hash,
        expectedRevisionHash: this.input.session.currentRevisionHash,
        operations: this.stagedOperations(),
        sourceWriteBlobs: this.stagedSourceWriteBlobs().map(creatorSourceWriteBlobBinding),
        localGate: this.gate(),
      },
      this.input.projectIndex,
      this.input.ownership,
      this.input.plan,
      this.contract,
    );
    assertCreatorChangeSet(changeSet);
    return changeSet;
  }
  protected override async dispatch(name: string, input: unknown): Promise<unknown> {
    if (name === "studio.api_lookup")
      return creatorRobloxApiLookup(input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>);
    if (name === "studio.inspect") return this.inspect((input as { paths: string[] }).paths);
    if (name === "source.read")
      return this.readApprovedSource(
        input as {
          documentId: string;
          maximumUtf8Bytes?: number;
          cursor?: string;
        },
      );
    if (name === "studio.stage") {
      const payload = (input as { change: CreatorStagePayload }).change;
      const contractChange = this.contract.changes.find(
        (change) => change.planChangeId === payload.planChangeId,
      );
      if (!contractChange)
        throw correctiveFailure(
          "PLAN_CHANGE_UNKNOWN",
          "The staged planChangeId is not in the approved build contract",
          {
            receivedPlanChangeId: payload.planChangeId,
            expectedPlanChangeIds: this.contract.changes.map((change) => change.planChangeId),
            contractHash: this.contract.hash,
          },
        );
      const existingIndex = this.operations.findIndex(
        (entry) => entry.planChangeId === payload.planChangeId,
      );
      const existingOperation = existingIndex >= 0 ? this.operations[existingIndex] : undefined;
      if (payload.source !== undefined || payload.sourceEdits !== undefined) {
        const bytes =
          payload.source !== undefined
            ? Buffer.byteLength(payload.source, "utf8")
            : payload.sourceEdits!.reduce(
                (sum, edit) => sum + Buffer.byteLength(edit.replacement, "utf8"),
                0,
              );
        const totalBytes =
          this.operations.reduce(
            (sum, operation) =>
              sum +
              (operation.planChangeId !== payload.planChangeId
                ? operation.kind === "create" && operation.sourceBlob
                  ? operation.sourceBlob.utf8Bytes
                  : operation.kind === "edit_source"
                    ? operation.edits.reduce(
                        (total, edit) => total + edit.replacementBlob.utf8Bytes,
                        0,
                      )
                    : 0
                : 0),
            0,
          ) + bytes;
        if (bytes > this.budgets.maxBytesPerFile || totalBytes > this.budgets.maxChangedSourceBytes)
          throw correctiveFailure(
            "SOURCE_BUDGET_EXHAUSTED",
            "Staged source exceeds the active per-source or total changed-source byte budget",
            {
              sourceBytes: bytes,
              totalChangedSourceBytes: totalBytes,
              maxBytesPerFile: this.budgets.maxBytesPerFile,
              maxChangedSourceBytes: this.budgets.maxChangedSourceBytes,
            },
          );
      }
      const operation = deriveStudioOperation(
        contractChange,
        payload,
        this.input.sourceIndex,
        this.input.sourceResolver,
        (source) => this.sourceWriteBlob(source),
        (binding) => this.sourceWriteText(binding),
      );
      const stagedOperations =
        existingIndex < 0
          ? [...this.operations, operation]
          : this.operations.map((existing, index) =>
              index === existingIndex ? operation : existing,
            );
      assertStudioChangeOperation(
        operation,
        this.input.projectIndex,
        this.input.ownership,
        this.contract.mutationAuthority,
        stagedOperations,
      );
      if (existingIndex < 0 && this.operations.length >= CREATOR_MAX_CHANGES)
        throw new ToolFailure("OPERATION_BUDGET_EXHAUSTED", "Studio operation budget exhausted");
      if (existingIndex >= 0) this.operations[existingIndex] = cloneOperation(operation);
      else this.operations.push(cloneOperation(operation));
      this.localGate = { status: "incomplete", issueHashes: [] };
      return {
        staged: true,
        replaced: existingIndex >= 0,
        operationId: operation.id,
        operationHash: contentHash(stableJson(operation)),
        ...(existingOperation
          ? {
              previousOperationHash: contentHash(stableJson(existingOperation)),
            }
          : {}),
      };
    }
    if (name === "studio.diff")
      return {
        operations: this.operations.map((operation) => ({
          id: operation.id,
          planChangeId: operation.planChangeId,
          kind: operation.kind,
          hash: contentHash(stableJson(operation)),
          summary: operationSummary(operation),
          ...(operation.kind === "edit_source"
            ? {
                sourceHash: operation.finalSourceHash,
                sourceBytes: operation.finalByteCount,
                editCount: operation.edits.length,
              }
            : operation.kind === "create" && operation.sourceBlob
              ? {
                  sourceHash: operation.sourceBlob.sourceHash,
                  sourceBytes: operation.sourceBlob.utf8Bytes,
                }
              : {}),
        })),
      };
    if (name === "forge.verify") return this.verify();
    throw new ToolFailure("TOOL_UNKNOWN", `Unknown builder tool ${name}`);
  }
  private owner(stableId: string): StudioOwner {
    return (
      this.input.ownership.entries.find((entry) => entry.objectId === stableId)?.owner ??
      "studio_document"
    );
  }
  private inspect(paths: string[]): unknown {
    const allowed = new Set(this.contract.initialInspectionPaths);
    const unique = [...new Set(paths)];
    if (unique.length !== paths.length || paths.some((path) => !allowed.has(path)))
      throw correctiveFailure(
        "INSPECTION_PATH_INVALID",
        "studio.inspect accepts only explicit initial paths declared by the build contract",
        {
          receivedPaths: paths,
          allowedPaths: this.contract.initialInspectionPaths,
          contractHash: this.contract.hash,
        },
      );
    const instances = this.input.projectIndex.instances
      .filter((instance) => unique.includes(instance.path))
      .map((instance) => ({
        objectId: instance.objectId,
        identity: instance.identity,
        path: instance.path,
        className: instance.className,
        instanceHash: contentHash(stableJson(instance)),
        owner: this.owner(instance.objectId),
        ...(instance.position ? { position: instance.position } : {}),
        properties: instance.properties,
        attributes: instance.attributes,
      }));
    const scripts = this.input.projectIndex.scripts
      .filter((script) => unique.includes(script.path))
      .map((script) => ({
        ...script,
        owner: this.owner(script.documentId),
      }));
    return {
      revisionHash: this.input.session.currentRevisionHash,
      paths: unique,
      instances,
      scripts,
    };
  }
  private readApprovedSource(input: {
    documentId: string;
    maximumUtf8Bytes?: number;
    cursor?: string;
  }): unknown {
    const permitted =
      this.input.sourceConsultation.sources.some(
        (source) => source.document.documentId === input.documentId && source.ranges.length > 0,
      ) ||
      this.input.sourceConsultation.operations.some(
        (operation) =>
          operation.kind === "dependencies" &&
          operation.dependencyRequest?.direction === "closure" &&
          operation.sources.some((source) => source.document.documentId === input.documentId),
      );
    if (!permitted)
      throw correctiveFailure(
        "SOURCE_CONTEXT_OUTSIDE_APPROVED_CLOSURE",
        "source_context_outside_approved_closure: replan before reading source outside the creator-approved consultation graph",
        {
          receivedDocumentId: input.documentId,
          approvedDocumentIds: [
            ...new Set([
              ...this.input.sourceConsultation.sources.map((source) => source.document.documentId),
              ...this.input.sourceConsultation.dependencies.flatMap((dependency) => [
                dependency.source.documentId,
                ...(dependency.target ? [dependency.target.documentId] : []),
              ]),
            ]),
          ].sort(),
          consultationHash: this.input.sourceConsultation.hash,
        },
      );
    return readStudioSource(this.input.sourceIndex, this.input.sourceResolver, input);
  }
  private async verify(): Promise<unknown> {
    if (this.operations.length === 0) {
      this.localGate = {
        status: "rejected",
        issueHashes: [contentHash("no-staged-operations")],
      };
      return this.localGate;
    }
    try {
      assertOperationsMatchPlan(this.operations, this.input.plan.changes);
    } catch (error) {
      this.localGate = {
        status: "rejected",
        issueHashes: [contentHash(error instanceof Error ? error.message : String(error))],
      };
      return {
        ...this.localGate,
        issues: [
          {
            ruleId: "creator-plan-coverage",
            severity: "error",
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    const sources: Array<StudioLuauAnalysisSource & { planChangeId: string; operationId: string }> =
      this.operations.flatMap((operation) =>
        operation.kind === "edit_source"
          ? [
              {
                id: operation.id,
                operationId: operation.id,
                planChangeId: operation.planChangeId,
                studioPath: operation.target.path,
                source: materializeEditedSource(
                  operation,
                  this.input.sourceIndex,
                  this.input.sourceResolver,
                  (binding) => this.sourceWriteText(binding),
                ),
                className: operation.target.className,
              },
            ]
          : operation.kind === "create" &&
              operation.sourceBlob !== undefined &&
              isScriptClass(operation.className)
            ? [
                {
                  id: operation.id,
                  operationId: operation.id,
                  planChangeId: operation.planChangeId,
                  studioPath: operation.target.path,
                  source: this.sourceWriteText(operation.sourceBlob),
                  className: operation.className,
                },
              ]
            : [],
      );
    if (sources.length === 0) {
      this.localGate = { status: "eligible", issueHashes: [] };
      return this.localGate;
    }
    try {
      const analysis = analyzeStudioSourcesWithRobloxLuau({
        nodes: creatorLuauAnalysisTopology(this.input.projectIndex, this.operations),
        sources,
        dependencySources: creatorLuauAnalysisDependencies(
          this.input.projectIndex,
          this.input.sourceIndex,
          this.input.sourceResolver,
          this.operations,
          sources,
        ),
      });
      const issues = analysis.issues
        .map((issue) => creatorVerificationDiagnostic(issue, sources))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      const issueHashes = issues.map((issue) => contentHash(stableJson(issue))).sort();
      const statuses = analysis.tiers.map((tier) => tier.status);
      this.localGate = {
        status: statuses.includes("unavailable")
          ? "incomplete"
          : statuses.includes("fail")
            ? "rejected"
            : "eligible",
        issueHashes,
      };
      return {
        ...this.localGate,
        issues: issues.slice(0, 30),
      };
    } catch (error) {
      const issue = {
        ruleId: "CREATOR_LUAU_PROJECT_UNAVAILABLE",
        severity: "error" as const,
        category: "tooling" as const,
        message: boundedDiagnosticMessage(error instanceof Error ? error.message : String(error)),
      };
      this.localGate = {
        status: "incomplete",
        issueHashes: [contentHash(stableJson(issue))],
      };
      return { ...this.localGate, issues: [issue] };
    }
  }
}

export async function runCreatorPlanner(input: {
  session: CreatorSession;
  ownership: StudioOwnershipMap;
  projectIndex: CreatorProjectIndexView;
  sourceIndex: StudioSourceIndex;
  sourceResolver: VerifiedSourceResolver;
  creatorPrompt: string;
  agentPrompt: string;
  contextCitations?: readonly CreatorAgentContextCitation[];
  runtime: AgentRuntime;
  executionJournal: AgentExecutionJournalSink;
  /** Exact durable response boundary authorized by the creator to continue. */
  resumeFromJournal?: AgentExecutionJournalResume;
  budgets?: BudgetPolicy;
}): Promise<CreatorPlannerExecution> {
  if (contentHash(input.creatorPrompt) !== input.session.promptHash)
    throw new Error("Creator prompt does not match the session");
  const host = new CreatorPlannerToolHost({
    session: input.session,
    ownership: input.ownership,
    projectIndex: input.projectIndex,
    sourceIndex: input.sourceIndex,
    sourceResolver: input.sourceResolver,
    prompt: input.creatorPrompt,
    ...(input.contextCitations ? { contextCitations: input.contextCitations } : {}),
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
  });
  const result = await invokeCreatorRuntime(input.runtime, {
    systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
    prompt: input.agentPrompt,
    orientation: creatorOrientation({
      session: input.session,
      ownership: input.ownership,
      projectIndex: input.projectIndex,
    }),
    tools: host,
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
    model: input.session.model,
    executionJournal: input.executionJournal,
    ...(input.resumeFromJournal ? { resumeFromJournal: input.resumeFromJournal } : {}),
  });
  const outcome = host.getOutcome();
  if (result.status !== "completed")
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
      finalization: runtimeFinalization("creator_outcome", result),
    };
  if (!outcome)
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
      finalization: {
        status: "unsealed",
        intendedArtifactKind: "creator_outcome",
        failureStage: "finalization",
        failureCode: "CREATOR_OUTCOME_NOT_PUBLISHED",
        detail: "Creator agent ended without publishing an answer, clarification, or plan",
        failureKind: "model",
      },
    };
  return {
    outcome,
    runtimeResult: result,
    toolHost: host,
    systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
    finalization: {
      status: "sealed",
      artifact: { kind: "creator_outcome", id: outcome.id, hash: outcome.hash },
    },
  };
}

export async function runCreatorBuilder(input: {
  session: CreatorSession;
  ownership: StudioOwnershipMap;
  projectIndex: CreatorProjectIndexView;
  creatorPrompt: string;
  agentPrompt: string;
  plan: CreatorPlan;
  planApproval: CreatorApproval;
  sourceIndex: StudioSourceIndex;
  sourceResolver: VerifiedSourceResolver;
  sourceConsultation: CreatorSourceConsultation;
  verificationFeedback?: readonly string[];
  runtime: AgentRuntime;
  executionJournal: AgentExecutionJournalSink;
  budgets?: BudgetPolicy;
}): Promise<CreatorBuilderExecution> {
  if (contentHash(input.creatorPrompt) !== input.session.promptHash)
    throw new Error("Creator prompt does not match the session");
  if (
    input.planApproval.decision !== "approved" ||
    input.planApproval.artifactId !== input.plan.id ||
    input.planApproval.artifactHash !== input.plan.hash
  )
    throw new Error("Creator builder requires the exact approved plan");
  const host = new CreatorBuilderToolHost(input);
  const systemPrompt = creatorBuilderSystemPrompt(
    input.plan,
    host.contract,
    input.verificationFeedback,
  );
  const result = await invokeCreatorRuntime(input.runtime, {
    systemPrompt,
    prompt: input.agentPrompt,
    orientation: creatorOrientation({
      session: input.session,
      ownership: input.ownership,
      projectIndex: input.projectIndex,
    }),
    tools: host,
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
    model: input.session.model,
    executionJournal: input.executionJournal,
  });
  if (result.status !== "completed")
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: runtimeFinalization("change_set", result),
    };
  const completion = host.completionStatus();
  if (!completion.ready)
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: {
        status: "unsealed",
        intendedArtifactKind: "change_set",
        failureStage: "finalization",
        failureCode: completion.code,
        detail: completion.message,
        failureKind: "model",
      },
    };
  try {
    const changeSet = host.seal();
    return {
      changeSet,
      sourceWriteBlobs: host.stagedSourceWriteBlobs(),
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: {
        status: "sealed",
        artifact: {
          kind: "change_set",
          id: changeSet.id,
          hash: changeSet.hash,
        },
      },
    };
  } catch (error) {
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: {
        status: "unsealed",
        intendedArtifactKind: "change_set",
        failureStage: "finalization",
        failureCode: "CHANGE_SET_FINALIZATION_FAILED",
        detail: error instanceof Error ? error.message : String(error),
        failureKind: "harness",
      },
    };
  }
}

export async function persistCreatorBundle(
  bundle: CreatorSessionBundle,
  directory: string,
): Promise<{ path: string; artifactHash: string; mode: number }> {
  assertCreatorSessionBundle(bundle);
  const destination = join(resolve(directory), `${bundle.session.id}.json`);
  await mkdir(dirname(destination), { recursive: true });
  const serialized = `${stableJson(bundle)}\n`;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return {
    path: relative(process.cwd(), destination),
    artifactHash: contentHash(serialized),
    mode: 0o600,
  };
}

export async function loadCreatorBundle(path: string): Promise<CreatorSessionBundle> {
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as CreatorSessionBundle;
  assertCreatorSessionBundle(value);
  const store = new ImmutableJsonArtifactStore(dirname(resolve(path)));
  const creatorRequest = await store.read(value.creatorRequest, assertCreatorRequestArtifact);
  if (
    creatorRequest.sessionId !== value.session.id ||
    creatorRequest.promptHash !== value.session.promptHash
  )
    throw new Error("Creator request artifact does not bind its session");
  if (value.agentOutcome) {
    const outcome = await store.read(value.agentOutcome.artifact, assertCreatorAgentOutcome);
    if (stableJson(outcome) !== stableJson(value.agentOutcome.outcome))
      throw new Error("Creator agent outcome artifact body mismatch");
  }
  for (const reference of value.agentRuns) {
    const [agentRun] = await Promise.all([
      store.read(reference.agentRun, assertAgentRun),
      store.verify(reference.trace),
    ]);
    if (
      agentRun.id !== reference.agentRunId ||
      agentRun.phase !== reference.phase ||
      agentRun.origin.kind !== "creator_session" ||
      agentRun.origin.creatorSessionHash !== reference.creatorSessionHash
    )
      throw new Error("Creator bundle AgentRun binding mismatch");
    await verifyAgentRunExecutionJournal(agentRun, store);
  }
  for (const binding of value.projectIndices) {
    const capture = await readCreatorProjectIndexArtifacts(store, binding);
    if (
      capture.hash !== binding.captureHash ||
      capture.projection.id !== binding.projection.id ||
      capture.projection.hash !== binding.projection.hash ||
      capture.indexManifest.id !== binding.manifest.id ||
      capture.indexManifest.hash !== binding.manifest.hash ||
      capture.revision.id !== binding.revision.id ||
      capture.revision.hash !== binding.revision.hash
    )
      throw new Error("Creator project-index artifact graph mismatch");
  }
  if (value.projectAuthority) {
    const authorityMap = await store.read(
      value.projectAuthority.authorityMap.artifact,
      assertProjectAuthorityMap,
    );
    if (
      authorityMap.id !== value.projectAuthority.authorityMap.id ||
      authorityMap.hash !== value.projectAuthority.authorityMap.hash
    )
      throw new Error("Creator project-authority map artifact binding mismatch");
  }
  for (const mutation of value.rojoSourceMutations) {
    const [changeSet, attempt] = await Promise.all([
      store.read(mutation.changeSet.artifact, assertRojoSourceChangeSet),
      store.read(mutation.attempt.artifact, assertRojoMutationAttempt),
    ]);
    if (
      changeSet.id !== mutation.changeSet.id ||
      changeSet.hash !== mutation.changeSet.hash ||
      attempt.id !== mutation.attempt.id ||
      attempt.hash !== mutation.attempt.hash ||
      attempt.changeSetId !== changeSet.id ||
      attempt.changeSetHash !== changeSet.hash
    )
      throw new Error("Creator Rojo source mutation artifact graph mismatch");
    for (const proof of mutation.syncProofs) {
      const value = await store.read(proof.artifact, assertRojoSyncProof);
      if (
        value.id !== proof.id ||
        value.hash !== proof.hash ||
        value.attemptId !== attempt.id ||
        value.attemptHash !== attempt.hash
      )
        throw new Error("Creator Rojo source sync proof binding mismatch");
    }
    if (mutation.revert) {
      const revert = await store.read(mutation.revert.artifact, assertRojoSourceRevert);
      if (
        revert.id !== mutation.revert.id ||
        revert.hash !== mutation.revert.hash ||
        revert.attemptId !== attempt.id ||
        revert.attemptHash !== attempt.hash
      )
        throw new Error("Creator Rojo source revert binding mismatch");
      for (const proof of mutation.revertSyncProofs) {
        const value = await store.read(proof.artifact, assertRojoSourceRevertSyncProof);
        if (
          value.id !== proof.id ||
          value.hash !== proof.hash ||
          value.revertId !== revert.id ||
          value.revertHash !== revert.hash
        )
          throw new Error("Creator Rojo source revert sync proof binding mismatch");
      }
    } else if (mutation.revertSyncProofs.length > 0)
      throw new Error("Creator Rojo source revert proof has no revert");
  }
  for (const entry of value.projectChanges) {
    const notice = await store.read(entry.artifact, assertCreatorProjectChangeNotice);
    if (stableJson(notice) !== stableJson(entry.notice))
      throw new Error("Creator project-change notice artifact binding mismatch");
    if (entry.confirmation) {
      const confirmation = await store.read(
        entry.confirmation.artifact,
        assertCreatorTransactionProjectChangeConfirmation,
      );
      if (
        stableJson(confirmation) !== stableJson(entry.confirmation.record) ||
        stableJson(confirmation.notice) !== stableJson(entry.artifact) ||
        confirmation.sessionId !== value.session.id
      )
        throw new Error("Creator transaction project-change confirmation binding mismatch");
      const expected = value.projectIndices.find(
        (binding) => binding.captureHash === confirmation.expectedCaptureHash,
      );
      if (!expected || expected.revision.hash !== confirmation.expectedRevisionHash)
        throw new Error("Creator transaction project-change expected index binding mismatch");
      if (confirmation.outcome === "incomplete") continue;
      const observed = value.projectIndices.find(
        (binding) => binding.captureHash === confirmation.observedCaptureHash,
      );
      if (
        !observed ||
        observed.revision.hash !== confirmation.observedRevisionHash ||
        !confirmation.delta
      )
        throw new Error("Creator transaction project-change observed index binding mismatch");
      const delta = await store.read(confirmation.delta, assertCreatorProjectDelta);
      if (
        delta.beforeCaptureHash !== confirmation.expectedCaptureHash ||
        delta.afterCaptureHash !== confirmation.observedCaptureHash ||
        delta.beforeRevisionHash !== confirmation.expectedRevisionHash ||
        delta.afterRevisionHash !== confirmation.observedRevisionHash
      )
        throw new Error("Creator transaction project-change delta binding mismatch");
    }
  }
  for (const entry of value.projectRefreshes) {
    const [refresh, delta] = await Promise.all([
      store.read(entry.artifact, assertCreatorProjectRefresh),
      store.read(entry.refresh.delta, assertCreatorProjectDelta),
    ]);
    if (stableJson(refresh) !== stableJson(entry.refresh))
      throw new Error("Creator project-refresh artifact binding mismatch");
    if (
      delta.beforeCaptureHash !== refresh.beforeCaptureHash ||
      delta.afterCaptureHash !== refresh.afterCaptureHash ||
      delta.beforeRevisionHash !== refresh.beforeRevisionHash ||
      delta.afterRevisionHash !== refresh.afterRevisionHash
    )
      throw new Error("Creator project-refresh delta revision binding mismatch");
  }
  const loadedSourceIndices = new Map<string, StudioSourceIndex>();
  const retainedCaptureHashes = new Set(value.projectIndices.map((binding) => binding.captureHash));
  for (const binding of value.sourceIndices) {
    const index = await store.read(binding.artifact, assertStudioSourceIndex);
    assertProductionStudioSourceIndex(index);
    const analysis = await store.read<PinnedSourceAnalysisArtifact>(binding.analysis.artifact);
    if (
      index.id !== binding.id ||
      index.hash !== binding.hash ||
      analysis.kind !== "PinnedSourceAnalysisArtifact" ||
      analysis.id !== binding.analysis.id ||
      analysis.hash !== binding.analysis.hash ||
      analysis.sourceIndexId !== index.id ||
      analysis.sourceIndexHash !== index.hash ||
      analysis.sourceSnapshotHash !== index.snapshotHash
    )
      throw new Error("Creator source-index artifact binding mismatch");
    if (!retainedCaptureHashes.has(index.snapshotHash))
      throw new Error("Creator source index is not bound to a retained project-index capture");
    const key = `${index.id}:${index.hash}`;
    if (loadedSourceIndices.has(key))
      throw new Error("Creator source-index artifact binding is duplicated");
    loadedSourceIndices.set(key, index);
  }
  for (const binding of value.sourceConsultations) {
    const consultation = (await store.read(binding.artifact)) as CreatorSourceConsultation;
    const index = loadedSourceIndices.get(`${binding.indexId}:${binding.indexHash}`);
    if (!index) throw new Error("Creator source consultation lost its source index");
    assertCreatorSourceConsultation(consultation, index);
    if (consultation.id !== binding.id || consultation.hash !== binding.hash)
      throw new Error("Creator source-consultation artifact binding mismatch");
  }
  if (value.plan) {
    const sourceIndex = loadedSourceIndices.get(
      `${value.plan.sourceIndexId}:${value.plan.sourceIndexHash}`,
    );
    if (!sourceIndex || sourceIndex.snapshotHash !== value.plan.projectCaptureHash)
      throw new Error("Creator plan source index does not bind its project-index capture");
  }
  for (const binding of value.sourceWriteBlobs)
    await readCreatorSourceWriteArtifacts(store, binding);
  await Promise.all(
    value.verifications.flatMap((verification) => [
      store.verify(verification.executionPlan.artifact),
      ...(verification.runtimeEvidence
        ? [store.verify(verification.runtimeEvidence.artifact)]
        : []),
    ]),
  );
  await Promise.all(
    value.mutationAttempts
      .flatMap(mutationAttemptArtifactReferences)
      .map((reference) => store.verify(reference)),
  );
  if (value.activeMutation) {
    await Promise.all(
      creatorActiveMutationReferences(value.activeMutation).map((reference) =>
        store.verify(reference),
      ),
    );
  }
  if (value.review) await store.verify(value.review.artifact);
  return value;
}

export function assertCreatorSessionBundle(value: CreatorSessionBundle): void {
  assertCreatorSession(value.session);
  assertArtifactReference(value.creatorRequest);
  if (value.agentOutcome !== undefined) {
    if (!isRecord(value.agentOutcome)) throw new Error("Invalid creator agent outcome binding");
    assertCreatorAgentOutcome(value.agentOutcome.outcome);
    assertArtifactReference(value.agentOutcome.artifact);
    if (
      value.agentOutcome.artifact.artifactHash !==
      contentHash(serializeCanonicalJson(value.agentOutcome.outcome))
    )
      throw new Error("Creator agent outcome artifact binding mismatch");
  }
  assertOwnershipMap(value.ownership);
  if (
    !Array.isArray(value.projectIndices) ||
    value.projectIndices.length < 1 ||
    !Array.isArray(value.projectChanges) ||
    !Array.isArray(value.projectRefreshes)
  )
    throw new Error("Creator session bundle requires project-index and refresh evidence history");
  for (const binding of value.projectIndices) {
    if (!isRecord(binding) || !isId(binding.captureId) || !isHash(binding.captureHash))
      throw new Error("Invalid creator project-index binding");
    for (const reference of creatorProjectIndexArtifactReferences(binding))
      assertArtifactReference(reference);
  }
  for (const entry of value.projectChanges) {
    if (!isRecord(entry)) throw new Error("Invalid creator project-change evidence");
    assertCreatorProjectChangeNotice(entry.notice);
    assertArtifactReference(entry.artifact);
    if (!isStatus(entry.priorStatus))
      throw new Error("Invalid creator project-change prior status");
    if (entry.confirmation !== undefined) {
      if (!isRecord(entry.confirmation))
        throw new Error("Invalid creator transaction project-change confirmation");
      assertCreatorTransactionProjectChangeConfirmation(entry.confirmation.record);
      assertArtifactReference(entry.confirmation.artifact);
      if (stableJson(entry.confirmation.record.notice) !== stableJson(entry.artifact))
        throw new Error("Creator transaction project-change confirmation notice mismatch");
    }
  }
  for (const entry of value.projectRefreshes) {
    if (!isRecord(entry)) throw new Error("Invalid creator project-refresh evidence");
    assertCreatorProjectRefresh(entry.refresh);
    assertArtifactReference(entry.artifact);
    if (
      entry.refresh.predecessorSessionId !== value.session.id ||
      !value.projectChanges.some(
        (change) => stableJson(change.artifact) === stableJson(entry.refresh.notice),
      )
    )
      throw new Error("Creator project refresh has no bound project-change notice");
  }
  if (value.projectAuthority !== undefined) {
    const binding = value.projectAuthority.authorityMap;
    if (!isRecord(binding) || !isId(binding.id) || !isHash(binding.hash))
      throw new Error("Invalid creator project-authority map binding");
    assertArtifactReference(binding.artifact);
  }
  if (!Array.isArray(value.rojoSourceMutations))
    throw new Error("Creator session bundle requires Rojo source mutation history");
  for (const mutation of value.rojoSourceMutations) {
    if (!isRecord(mutation)) throw new Error("Invalid creator Rojo source mutation binding");
    for (const member of [mutation.changeSet, mutation.attempt]) {
      if (!isRecord(member) || !isId(member.id) || !isHash(member.hash))
        throw new Error("Invalid creator Rojo source mutation member binding");
      assertArtifactReference(member.artifact);
    }
    for (const proofs of [mutation.syncProofs, mutation.revertSyncProofs]) {
      if (!Array.isArray(proofs)) throw new Error("Invalid creator Rojo source sync-proof history");
      for (const proof of proofs) {
        if (!isRecord(proof) || !isId(proof.id) || !isHash(proof.hash))
          throw new Error("Invalid creator Rojo source sync-proof binding");
        assertArtifactReference(proof.artifact);
      }
    }
    if (mutation.revert !== undefined) {
      if (!isRecord(mutation.revert) || !isId(mutation.revert.id) || !isHash(mutation.revert.hash))
        throw new Error("Invalid creator Rojo source revert binding");
      assertArtifactReference(mutation.revert.artifact);
    }
  }
  if (value.rojoSourceMutations.length > 0 && value.projectAuthority === undefined)
    throw new Error("Rojo source mutation evidence requires an authority-map artifact");
  if (
    value.projectAuthority !== undefined &&
    !value.ownership.availableAuthorities.includes("rojo_source")
  )
    throw new Error("Creator authority-map evidence requires Rojo authority availability");
  const projectIndexByCapture = new Map(
    value.projectIndices.map((binding) => [binding.captureHash, binding]),
  );
  if (
    !projectIndexByCapture.has(value.session.initialProjectCaptureHash) ||
    !projectIndexByCapture.has(value.session.currentProjectCaptureHash)
  )
    throw new Error("Creator session project-index captures must bind persisted evidence");
  const initialProjectIndex = projectIndexByCapture.get(value.session.initialProjectCaptureHash);
  const currentProjectIndex = projectIndexByCapture.get(value.session.currentProjectCaptureHash);
  if (
    initialProjectIndex?.revision.hash !== value.session.initialRevisionHash ||
    currentProjectIndex?.revision.hash !== value.session.currentRevisionHash
  )
    throw new Error("Creator session project-index capture and revision binding mismatch");
  if (!Array.isArray(value.sourceIndices) || !Array.isArray(value.sourceConsultations))
    throw new Error("Creator session bundle requires source evidence history");
  if (!Array.isArray(value.sourceWriteBlobs))
    throw new Error("Creator session bundle requires source-write evidence history");
  const sourceWriteByManifest = new Map<string, CreatorSourceWriteArtifactBinding>();
  for (const binding of value.sourceWriteBlobs) {
    if (sourceWriteByManifest.has(binding.manifest.hash))
      throw new Error("Creator session source-write evidence is duplicated");
    sourceWriteByManifest.set(binding.manifest.hash, binding);
    for (const reference of creatorSourceWriteArtifactReferences(binding))
      assertArtifactReference(reference);
  }
  for (const binding of value.sourceIndices) {
    if (
      !isRecord(binding) ||
      !isId(binding.id) ||
      !isHash(binding.hash) ||
      !isRecord(binding.analysis) ||
      !isId(binding.analysis.id) ||
      !isHash(binding.analysis.hash)
    )
      throw new Error("Invalid creator source-index binding");
    assertArtifactReference(binding.artifact);
    assertArtifactReference(binding.analysis.artifact);
  }
  for (const binding of value.sourceConsultations) {
    if (
      !isRecord(binding) ||
      !isId(binding.id) ||
      !isHash(binding.hash) ||
      !isId(binding.indexId) ||
      !isHash(binding.indexHash)
    )
      throw new Error("Invalid creator source-consultation binding");
    assertArtifactReference(binding.artifact);
    if (
      !value.sourceIndices.some(
        (index) => index.id === binding.indexId && index.hash === binding.indexHash,
      )
    )
      throw new Error("Creator source consultation has no bound source index");
  }
  if (
    value.ownership.id !== value.session.ownershipMapId ||
    value.ownership.hash !== value.session.ownershipMapHash ||
    value.ownership.projectId !== value.session.projectId ||
    value.ownership.revisionHash !== value.session.initialRevisionHash
  )
    throw new Error("Creator session bundle ownership graph mismatch");
  if (value.plan) {
    assertCreatorPlan(value.plan);
    const sourceIndex = value.sourceIndices.find(
      (binding) =>
        binding.id === value.plan!.sourceIndexId && binding.hash === value.plan!.sourceIndexHash,
    );
    const sourceConsultation = value.sourceConsultations.find(
      (binding) =>
        binding.id === value.plan!.sourceConsultationId &&
        binding.hash === value.plan!.sourceConsultationHash &&
        binding.indexId === value.plan!.sourceIndexId &&
        binding.indexHash === value.plan!.sourceIndexHash,
    );
    if (!sourceIndex || !sourceConsultation)
      throw new Error("Creator plan lost its source-index consultation graph");
    if (
      value.plan.sessionId !== value.session.id ||
      value.plan.promptHash !== value.session.promptHash ||
      value.plan.ownershipMapId !== value.ownership.id ||
      value.plan.ownershipMapHash !== value.ownership.hash ||
      value.plan.projectRevisionHash !== value.session.initialRevisionHash ||
      value.plan.projectCaptureHash !== value.session.initialProjectCaptureHash ||
      !value.ownership.availableAuthorities.includes(value.plan.mutationAuthority) ||
      !projectIndexByCapture.has(value.session.initialProjectCaptureHash)
    )
      throw new Error("Creator session bundle plan graph mismatch");
  }
  if (
    value.session.plan &&
    (!value.plan ||
      value.session.plan.id !== value.plan.id ||
      value.session.plan.hash !== value.plan.hash)
  )
    throw new Error("Creator session plan reference is unresolved");
  if (!Array.isArray(value.buildContracts))
    throw new Error("Creator session bundle requires build-contract evidence");
  value.buildContracts.forEach(assertCreatorBuildContract);
  if (
    new Set(value.buildContracts.map((contract) => contract.id)).size !==
    value.buildContracts.length
  )
    throw new Error("Creator build-contract history contains duplicate identities");
  if (!Array.isArray(value.approvals)) throw new Error("Creator session bundle requires approvals");
  value.approvals.forEach((approval) => {
    assertCreatorApproval(approval);
    if (approval.sessionId !== value.session.id)
      throw new Error("Creator approval session mismatch");
  });
  for (const contract of value.buildContracts) {
    if (!value.plan) throw new Error("Creator build contract requires its persisted plan");
    const approval = value.approvals.find(
      (candidate) =>
        candidate.id === contract.planApprovalId &&
        candidate.hash === contract.planApprovalHash &&
        candidate.artifactKind === "plan" &&
        candidate.artifactId === value.plan!.id &&
        candidate.artifactHash === value.plan!.hash &&
        candidate.decision === "approved",
    );
    if (
      !approval ||
      contract.mutationAuthority !== value.plan.mutationAuthority ||
      !value.ownership.availableAuthorities.includes(contract.mutationAuthority) ||
      contract.initialRevisionHash !== value.plan.projectRevisionHash ||
      !projectIndexByCapture.has(value.session.initialProjectCaptureHash)
    )
      throw new Error("Creator build contract is not bound to its approved project-index revision");
  }
  if (!Array.isArray(value.changeSets))
    throw new Error("Creator session bundle requires change-set history");
  if (new Set(value.changeSets.map((changeSet) => changeSet.id)).size !== value.changeSets.length)
    throw new Error("Creator change-set history contains duplicate identities");
  value.changeSets.forEach((changeSet) => {
    assertCreatorChangeSet(changeSet);
    if (
      !value.plan ||
      changeSet.sessionId !== value.session.id ||
      changeSet.planId !== value.plan.id ||
      changeSet.planHash !== value.plan.hash
    )
      throw new Error("Creator change set requires its bound plan");
    const approval = value.approvals.find(
      (candidate) =>
        candidate.id === changeSet.planApprovalId &&
        candidate.hash === changeSet.planApprovalHash &&
        candidate.artifactKind === "plan" &&
        candidate.artifactId === value.plan!.id &&
        candidate.artifactHash === value.plan!.hash &&
        candidate.decision === "approved",
    );
    if (!approval)
      throw new Error("Creator change set requires its authentic approved-plan decision");
    const contract = value.buildContracts.find(
      (candidate) =>
        candidate.id === changeSet.buildContractId &&
        candidate.hash === changeSet.buildContractHash,
    );
    if (
      !contract ||
      contract.planApprovalId !== approval.id ||
      contract.planApprovalHash !== approval.hash ||
      changeSet.mutationAuthority !== value.plan.mutationAuthority ||
      changeSet.mutationAuthority !== contract.mutationAuthority
    )
      throw new Error("Creator change set requires its persisted build contract");
    assertOperationsMatchPlan(changeSet.operations, value.plan.changes);
    assertOperationsMatchContract(changeSet.operations, contract);
    if (
      changeSet.expectedRevisionHash !== contract.initialRevisionHash ||
      !projectIndexByCapture.has(value.session.initialProjectCaptureHash)
    )
      throw new Error("Creator change set lost its exact pre-apply project-index capture");
  });
  const artifact = (approval: CreatorApproval) =>
    approval.artifactKind === "plan"
      ? value.plan &&
        approval.artifactId === value.plan.id &&
        approval.artifactHash === value.plan.hash
      : value.changeSets.some(
          (changeSet) =>
            changeSet.id === approval.artifactId && changeSet.hash === approval.artifactHash,
        );
  if (value.approvals.some((approval) => !artifact(approval)))
    throw new Error("Creator approval references an unpersisted artifact");
  const approvalReference = (
    reference: { id: string; hash: string } | undefined,
    kind: CreatorApproval["artifactKind"],
  ) =>
    reference === undefined ||
    value.approvals.some(
      (approval) =>
        approval.id === reference.id &&
        approval.hash === reference.hash &&
        approval.artifactKind === kind,
    );
  if (
    !approvalReference(value.session.planApproval, "plan") ||
    !approvalReference(value.session.changeApproval, "change_set")
  )
    throw new Error("Creator session approval reference is unresolved");
  if (
    value.session.changeSet &&
    !value.changeSets.some(
      (changeSet) =>
        changeSet.id === value.session.changeSet!.id &&
        changeSet.hash === value.session.changeSet!.hash,
    )
  )
    throw new Error("Creator session change-set reference is unresolved");
  if (!Array.isArray(value.verifications))
    throw new Error("Creator session bundle requires verification evidence");
  if (!Array.isArray(value.mutationAttempts))
    throw new Error("Creator session bundle requires mutation-attempt evidence");
  for (const attempt of value.mutationAttempts) {
    if (
      !isRecord(attempt) ||
      attempt.kind !== "CreatorMutationAttempt" ||
      !isId(attempt.id) ||
      !isHash(attempt.hash) ||
      attempt.sessionId !== value.session.id
    )
      throw new Error("Invalid creator mutation-attempt evidence");
    const captureHashes =
      attempt.completion === "settled"
        ? [
            attempt.beforeIndexCapture.captureHash,
            attempt.afterIndexCapture.captureHash,
            attempt.finalIndexCapture.captureHash,
          ]
        : [
            attempt.beforeIndexCapture.captureHash,
            ...(attempt.phase === "apply" ? [attempt.finalIndexCapture.captureHash] : []),
          ];
    if (
      captureHashes.some(
        (captureHash) =>
          !value.projectIndices.some((binding) => binding.captureHash === captureHash),
      )
    )
      throw new Error("Creator mutation attempt lost a bound project-index capture");
  }
  if (value.activeMutation !== undefined) assertCreatorActiveMutation(value.activeMutation, value);
  value.verifications.forEach((record) => {
    assertCreatorVerificationRecord(record);
    if (
      record.sessionId !== value.session.id ||
      !value.changeSets.some(
        (changeSet) =>
          changeSet.id === record.changeSetId && changeSet.hash === record.changeSetHash,
      ) ||
      !value.plan ||
      record.charterId !== value.plan.charter.id ||
      record.charterHash !== value.plan.charter.hash ||
      !value.mutationAttempts.some(
        (attempt) =>
          attempt.id === record.mutationAttempt.id &&
          attempt.hash === record.mutationAttempt.hash &&
          attempt.completion === "settled" &&
          isRecord(attempt.reconciliation) &&
          attempt.reconciliation.hash === record.mutationAttempt.reconciliationHash,
      )
    )
      throw new Error("Creator verification graph mismatch");
  });
  if (value.checkpoint) {
    assertCreatorCheckpoint(value.checkpoint);
    if (
      value.checkpoint.sessionId !== value.session.id ||
      !value.changeSets.some(
        (changeSet) =>
          changeSet.id === value.checkpoint!.changeSetId &&
          changeSet.hash === value.checkpoint!.changeSetHash,
      ) ||
      value.session.checkpoint?.id !== value.checkpoint.id ||
      value.session.checkpoint.hash !== value.checkpoint.hash ||
      !value.mutationAttempts.some(
        (attempt) =>
          attempt.id === value.checkpoint!.mutationAttemptId &&
          attempt.hash === value.checkpoint!.mutationAttemptHash &&
          attempt.completion === "settled",
      )
    )
      throw new Error("Creator checkpoint graph mismatch");
  } else if (value.session.checkpoint)
    throw new Error("Creator session checkpoint reference is unresolved");
  if (value.review) {
    if (!isRecord(value.review)) throw new Error("Invalid creator review evidence");
    assertCreatorReviewReport(value.review.report);
    assertArtifactReference(value.review.artifact);
    if (
      value.review.report.sessionId !== value.session.id ||
      !value.changeSets.some(
        (changeSet) =>
          changeSet.id === value.review!.report.changeSetId &&
          changeSet.hash === value.review!.report.changeSetHash,
      ) ||
      !value.plan ||
      value.review.report.charterId !== value.plan.charter.id ||
      value.review.report.charterHash !== value.plan.charter.hash ||
      value.session.review?.id !== value.review.report.id ||
      value.session.review.hash !== value.review.report.hash
    )
      throw new Error("Creator review graph mismatch");
  } else if (value.session.review)
    throw new Error("Creator session review reference is unresolved");
  if (!Array.isArray(value.agentRuns))
    throw new Error("Creator session bundle requires AgentRun references");
  for (const reference of value.agentRuns) {
    if (
      !isRecord(reference) ||
      !["creator_planner", "creator_builder"].includes(String(reference.phase)) ||
      !isId(reference.agentRunId) ||
      !isId(reference.traceId) ||
      !isId(reference.traceBuildKey) ||
      !isHash(reference.creatorSessionHash)
    )
      throw new Error("Invalid creator AgentRun reference");
    assertArtifactReference(reference.agentRun);
    assertArtifactReference(reference.trace);
    assertCreatorPhaseOutcome(reference.outcome);
    const intended = reference.phase === "creator_planner" ? "creator_outcome" : "change_set";
    if (
      (reference.outcome.status === "sealed"
        ? reference.outcome.artifact.kind
        : reference.outcome.intendedArtifactKind) !== intended
    )
      throw new Error("Creator AgentRun outcome does not match its referenced phase");
    if (
      reference.phase === "creator_planner" &&
      reference.outcome.status === "sealed" &&
      value.session.status !== "refresh_required" &&
      (!value.agentOutcome ||
        reference.outcome.artifact.id !== value.agentOutcome.outcome.id ||
        reference.outcome.artifact.hash !== value.agentOutcome.outcome.hash)
    )
      throw new Error("Sealed creator planner AgentRun is not linked to its outcome");
    if (reference.phase === "creator_builder") {
      if (
        !isRecord(reference.buildContract) ||
        !isId(reference.buildContract.id) ||
        !isHash(reference.buildContract.hash) ||
        !value.buildContracts.some(
          (contract) =>
            contract.id === reference.buildContract!.id &&
            contract.hash === reference.buildContract!.hash,
        )
      )
        throw new Error("Creator builder AgentRun reference lost its build contract");
      if (reference.outcome.status === "sealed") {
        const sealedArtifact = reference.outcome.artifact;
        if (
          !value.changeSets.some(
            (changeSet) =>
              changeSet.id === sealedArtifact.id &&
              changeSet.hash === sealedArtifact.hash &&
              changeSet.buildContractId === reference.buildContract!.id &&
              changeSet.buildContractHash === reference.buildContract!.hash,
          )
        )
          throw new Error(
            "Sealed creator builder AgentRun is not linked to its change set and contract",
          );
      }
    } else if (reference.buildContract !== undefined)
      throw new Error("Creator planner AgentRun cannot bind a build contract");
  }
  for (const contract of value.buildContracts)
    if (
      !value.agentRuns.some(
        (reference) =>
          reference.phase === "creator_builder" &&
          reference.buildContract?.id === contract.id &&
          reference.buildContract.hash === contract.hash,
      )
    )
      throw new Error("Persisted CreatorBuildContract has no AgentRun evidence link");
  for (const changeSet of value.changeSets)
    if (
      !value.agentRuns.some(
        (reference) =>
          reference.phase === "creator_builder" &&
          reference.outcome.status === "sealed" &&
          reference.outcome.artifact.id === changeSet.id &&
          reference.outcome.artifact.hash === changeSet.hash,
      )
    )
      throw new Error("Persisted CreatorChangeSet has no sealed AgentRun evidence link");
  for (const changeSet of value.changeSets) {
    assertCreatorChangeSet(changeSet);
    for (const sourceWrite of changeSet.sourceWriteBlobs) {
      const artifact = sourceWriteByManifest.get(sourceWrite.manifestHash);
      if (
        artifact === undefined ||
        artifact.manifest.id !== sourceWrite.manifestId ||
        artifact.manifest.hash !== sourceWrite.manifestHash
      )
        throw new Error("Creator change set lost immutable source-write evidence");
    }
  }
}

export function assertCreatorRequestArtifact(
  value: unknown,
): asserts value is CreatorRequestArtifact {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorRequest" ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !isHash(value.promptHash) ||
    typeof value.creatorText !== "string" ||
    value.creatorText.trim().length === 0 ||
    value.creatorText !== value.creatorText.trim() ||
    Buffer.byteLength(value.creatorText, "utf8") > CREATOR_CONVERSATION_TEXT_MAX_BYTES ||
    contentHash(value.creatorText) !== value.promptHash ||
    typeof value.agentPrompt !== "string" ||
    value.agentPrompt.trim().length === 0 ||
    value.agentPrompt !== value.agentPrompt.trim() ||
    Buffer.byteLength(value.agentPrompt, "utf8") > 256 * 1024 ||
    !Array.isArray(value.contextCitations) ||
    value.contextCitations.length > 32
  )
    throw new Error("Invalid CreatorRequest artifact");
  const citationHandles = new Set<string>();
  for (const citation of value.contextCitations) {
    assertCreatorAgentContextCitation(citation);
    if (citationHandles.has(citation.citation.handle))
      throw new Error("Creator request context citations must be unique");
    citationHandles.add(citation.citation.handle);
  }
}

function mutationAttemptArtifactReferences(
  attempt: import("./mutation-evidence.js").CreatorMutationAttempt,
): ArtifactReference[] {
  const common = [
    attempt.manifest.artifact,
    attempt.attestation.projection.artifact,
    attempt.attestation.envelope.artifact,
    attempt.changeSet.artifact,
    attempt.projection.artifact,
    ...creatorProjectIndexArtifactReferences(attempt.beforeIndexCapture),
    ...(attempt.completion === "incomplete" ? [attempt.preflightProjection.artifact] : []),
    ...(attempt.preflight
      ? [attempt.preflight.projection.artifact, attempt.preflight.envelope.artifact]
      : []),
  ];
  if (attempt.completion === "incomplete")
    return attempt.phase === "apply"
      ? [
          ...common,
          ...creatorProjectIndexArtifactReferences(attempt.finalIndexCapture),
          attempt.finalization.artifact,
        ]
      : common;
  return [
    ...common,
    attempt.directReadback.artifact,
    ...creatorProjectIndexArtifactReferences(attempt.afterIndexCapture),
    ...creatorProjectIndexArtifactReferences(attempt.finalIndexCapture),
    attempt.reconciliation.artifact,
    attempt.finalization.artifact,
  ];
}

function creatorActiveMutationReferences(active: CreatorActiveMutation): ArtifactReference[] {
  return [
    active.manifest.artifact,
    active.attestation.projection.artifact,
    active.attestation.envelope.artifact,
    active.changeSet.artifact,
    active.projection.artifact,
    active.preflight.projection.artifact,
    active.preflight.envelope.artifact,
    ...creatorProjectIndexArtifactReferences(active.beforeIndexCapture),
    ...(active.directReadback ? [active.directReadback.artifact] : []),
    ...(active.afterIndexCapture
      ? creatorProjectIndexArtifactReferences(active.afterIndexCapture)
      : []),
    ...(active.reconciliation ? [active.reconciliation.artifact] : []),
    ...(active.executionFailure ? [active.executionFailure.artifact] : []),
    ...(active.verificationPlan ? [active.verificationPlan.artifact] : []),
    ...(active.verificationDraft ? [active.verificationDraft.artifact] : []),
    ...(active.recoveryFinalization ? [active.recoveryFinalization.artifact] : []),
    ...(active.finalIndexCapture
      ? creatorProjectIndexArtifactReferences(active.finalIndexCapture)
      : []),
  ];
}

function assertCreatorActiveMutation(
  active: CreatorActiveMutation,
  bundle: CreatorSessionBundle,
): void {
  if (
    !isRecord(active) ||
    !isId(active.attemptId) ||
    !["preflighted", "recording_may_be_open", "provisional", "recovery_cancelled"].includes(
      String(active.stage),
    ) ||
    !isId(active.changeSetId) ||
    !isHash(active.changeSetHash) ||
    !isId(active.projectionId) ||
    !isHash(active.projectionHash) ||
    !isHash(active.beforeIndexRevisionHash) ||
    !Number.isSafeInteger(active.beforeProjectDetectorEpoch) ||
    Number(active.beforeProjectDetectorEpoch) < 0 ||
    (active.recordingId !== undefined && !isId(active.recordingId))
  )
    throw new Error("Invalid active creator mutation cursor");
  if (
    !bundle.changeSets.some(
      (changeSet) => changeSet.id === active.changeSetId && changeSet.hash === active.changeSetHash,
    ) ||
    active.projection.hash !== active.projectionHash ||
    !bundle.projectIndices.some(
      (binding) =>
        binding.captureHash === active.beforeIndexCapture.captureHash &&
        binding.revision.hash === active.beforeIndexRevisionHash,
    )
  )
    throw new Error("Active creator mutation must bind its before project-index capture");
  for (const reference of creatorActiveMutationReferences(active))
    assertArtifactReference(reference);
  for (const binding of [
    active.manifest,
    active.attestation.projection,
    active.attestation.envelope,
    active.changeSet,
    active.projection,
    active.preflight.projection,
    active.preflight.envelope,
    active.directReadback,
    active.reconciliation,
    active.executionFailure,
    active.verificationPlan,
    active.verificationDraft,
    active.recoveryFinalization,
  ]) {
    if (binding !== undefined && (!isRecord(binding) || !isHash(binding.hash)))
      throw new Error("Invalid active creator mutation artifact binding");
  }
  if (
    active.stage === "provisional" &&
    (!active.recordingId ||
      !active.directReadback ||
      !active.afterIndexCapture ||
      !Number.isSafeInteger(active.afterProjectDetectorEpoch) ||
      Number(active.afterProjectDetectorEpoch) < 0 ||
      !active.reconciliation)
  )
    throw new Error("Provisional creator mutation cursor is incomplete");
  for (const capture of [active.afterIndexCapture, active.finalIndexCapture]) {
    if (
      capture !== undefined &&
      !bundle.projectIndices.some((binding) => binding.captureHash === capture.captureHash)
    )
      throw new Error("Active creator mutation capture is absent from project-index history");
  }
  if (
    active.stage === "recovery_cancelled" &&
    (!active.recordingId || !active.recoveryFinalization || !active.finalIndexCapture)
  )
    throw new Error("Recovery-cancelled creator mutation cursor is incomplete");
}

export function assertCreatorSession(value: unknown): asserts value is CreatorSession {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorSession" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isStatus(value.status) ||
    value.policy !== CREATOR_SESSION_POLICY ||
    !isHash(value.promptHash) ||
    !isId(value.projectId) ||
    !isHash(value.initialRevisionHash) ||
    !isHash(value.currentRevisionHash) ||
    !isHash(value.initialProjectCaptureHash) ||
    !isHash(value.currentProjectCaptureHash) ||
    !isId(value.ownershipMapId) ||
    !isHash(value.ownershipMapHash) ||
    !Number.isInteger(value.repairsUsed) ||
    Number(value.repairsUsed) < 0 ||
    Number(value.repairsUsed) > CREATOR_MAX_REPAIRS
  )
    throw new Error("Invalid CreatorSession");
  const { hash: _hash, ...payload } = value;
  if (value.hash !== contentHash(stableJson(payload)))
    throw new Error("Invalid CreatorSession identity");
}

export function assertCreatorAgentCitation(value: unknown): asserts value is CreatorAgentCitation {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorAgentCitation" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    value.handle !== `creator_citation_${value.hash.slice(0, 24)}` ||
    !isHash(value.projectRevisionHash) ||
    !["project_index", "static_analysis", "creator_memory", "conversation_evidence"].includes(
      String(value.authority),
    ) ||
    !isRecord(value.subject)
  )
    throw new Error("Invalid CreatorAgentCitation");
  if (value.subject.kind === "project_fact") {
    if (
      value.authority !== "project_index" ||
      !isId(value.subject.objectId) ||
      typeof value.subject.path !== "string" ||
      typeof value.subject.className !== "string" ||
      !isHash(value.subject.factHash)
    )
      throw new Error("Invalid project-fact creator citation");
  } else if (value.subject.kind === "source_ranges") {
    if (
      value.authority !== "static_analysis" ||
      ![
        "source.search",
        "source.read",
        "source.symbols",
        "source.references",
        "source.dependencies",
      ].includes(String(value.subject.tool)) ||
      !isHash(value.subject.resultHash) ||
      !Array.isArray(value.subject.ranges) ||
      !value.subject.ranges.every(
        (range) =>
          isRecord(range) &&
          isId(range.documentId) &&
          typeof range.path === "string" &&
          isHash(range.sourceHash) &&
          Number.isSafeInteger(range.startByte) &&
          Number.isSafeInteger(range.endByte) &&
          Number(range.startByte) >= 0 &&
          Number(range.endByte) >= Number(range.startByte),
      )
    )
      throw new Error("Invalid source-range creator citation");
  } else if (value.subject.kind === "memory") {
    if (
      value.authority !== "creator_memory" ||
      !isId(value.subject.memoryItemId) ||
      !isId(value.subject.revisionId) ||
      !isHash(value.subject.revisionHash)
    )
      throw new Error("Invalid creator-memory citation");
  } else if (value.subject.kind === "prior_evidence") {
    if (
      value.authority !== "conversation_evidence" ||
      !isId(value.subject.eventId) ||
      !isHash(value.subject.eventHash) ||
      !isRecord(value.subject.evidence) ||
      !isId(value.subject.evidence.id) ||
      !isHash(value.subject.evidence.hash)
    )
      throw new Error("Invalid prior-evidence creator citation");
    assertArtifactReference(value.subject.evidence.artifact);
  } else throw new Error("Invalid creator citation subject");
  const { kind: _kind, id: _id, hash: _hash, handle: _handle, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_agent_citation_${expected.slice(0, 24)}` ||
    value.handle !== `creator_citation_${expected.slice(0, 24)}`
  )
    throw new Error("Invalid CreatorAgentCitation identity");
}

export function assertCreatorAgentContextCitation(
  value: unknown,
): asserts value is CreatorAgentContextCitation {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    value.label.trim().length === 0 ||
    value.label !== value.label.normalize("NFC").trim() ||
    Buffer.byteLength(value.label, "utf8") > 512
  )
    throw new Error("Invalid conversation-context citation label");
  assertCreatorAgentCitation(value.citation);
  if (!["creator_memory", "conversation_evidence"].includes(String(value.citation.authority)))
    throw new Error("Conversation context cannot preissue project or source citations");
}

export function assertCreatorAgentOutcome(value: unknown): asserts value is CreatorAgentOutcome {
  if (
    !isRecord(value) ||
    !["answer", "clarification_requested", "plan_proposed"].includes(String(value.kind)) ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !Array.isArray(value.citations) ||
    value.citations.length > CREATOR_CITATION_LIMIT
  )
    throw new Error("Invalid CreatorAgentOutcome");
  for (const citation of value.citations) assertCreatorAgentCitation(citation);
  if (new Set(value.citations.map((citation) => citation.handle)).size !== value.citations.length)
    throw new Error("CreatorAgentOutcome citations must be unique");
  if (
    value.kind === "answer" &&
    (typeof value.text !== "string" ||
      value.text.trim().length === 0 ||
      Buffer.byteLength(value.text, "utf8") > CREATOR_CONVERSATION_TEXT_MAX_BYTES)
  )
    throw new Error("Invalid creator answer outcome");
  if (
    value.kind === "clarification_requested" &&
    (typeof value.question !== "string" ||
      value.question.trim().length === 0 ||
      Buffer.byteLength(value.question, "utf8") > CREATOR_CONVERSATION_TEXT_MAX_BYTES)
  )
    throw new Error("Invalid creator clarification outcome");
  if (value.kind === "plan_proposed") assertCreatorPlan(value.plan);
  const { id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_agent_outcome_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorAgentOutcome identity");
}

export function assertOwnershipMap(value: unknown): asserts value is StudioOwnershipMap {
  if (
    !isRecord(value) ||
    value.kind !== "StudioOwnershipMap" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.projectId) ||
    !isHash(value.revisionHash)
  )
    throw new Error("Invalid StudioOwnershipMap");
  const availableAuthorities = value.availableAuthorities;
  if (
    !Array.isArray(availableAuthorities) ||
    !(
      (availableAuthorities.length === 1 && availableAuthorities[0] === "studio_document") ||
      (availableAuthorities.length === 2 &&
        availableAuthorities[0] === "rojo_source" &&
        availableAuthorities[1] === "studio_document")
    ) ||
    (value.authorityManifestHash !== undefined && !isHash(value.authorityManifestHash)) ||
    (availableAuthorities.includes("rojo_source") && value.authorityManifestHash === undefined) ||
    (!availableAuthorities.includes("rojo_source") && value.authorityManifestHash !== undefined) ||
    value.policy !== "per_change_set_single_writer" ||
    !Array.isArray(value.entries) ||
    !value.entries.every((entry) => isOwnershipEntry(entry, availableAuthorities))
  )
    throw new Error("Invalid StudioOwnershipMap");
  const entries = value.entries as StudioOwnershipMap["entries"];
  if (
    new Set(entries.map((entry) => entry.objectId)).size !== entries.length ||
    entries.some((entry, index) => {
      if (index === 0) return false;
      const previous = entries[index - 1]!;
      return (
        previous.path.localeCompare(entry.path) > 0 ||
        (previous.path === entry.path && previous.objectId.localeCompare(entry.objectId) >= 0)
      );
    })
  )
    throw new Error("Invalid StudioOwnershipMap canonical entries");
  const payload = {
    projectId: value.projectId,
    revisionHash: value.revisionHash,
    availableAuthorities,
    ...(value.authorityManifestHash ? { authorityManifestHash: value.authorityManifestHash } : {}),
    entries,
    policy: value.policy,
  };
  const hash = contentHash(stableJson(payload));
  if (value.hash !== hash || value.id !== `studio_ownership_map_${hash.slice(0, 24)}`)
    throw new Error("Invalid StudioOwnershipMap identity");
}

function isProjectWriteAuthority(value: unknown): value is ProjectWriteAuthority {
  return value === "studio_document" || value === "rojo_source";
}

function isOwnershipEntry(
  value: unknown,
  availableAuthorities: readonly ProjectWriteAuthority[],
): boolean {
  if (
    !isRecord(value) ||
    stableJson(Object.keys(value).sort()) !==
      stableJson(["className", "objectId", "owner", "path"]) ||
    !isId(value.objectId) ||
    typeof value.path !== "string" ||
    canonicalStudioPath(value.path) !== value.path ||
    typeof value.className !== "string" ||
    value.className.trim().length === 0 ||
    !isProjectWriteAuthority(value.owner) ||
    !availableAuthorities.includes(value.owner)
  )
    return false;
  return true;
}

export function assertCreatorPlan(value: unknown): asserts value is CreatorPlan {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorPlan" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isHash(value.promptHash) ||
    !isHash(value.projectRevisionHash) ||
    !isHash(value.projectCaptureHash) ||
    !isId(value.ownershipMapId) ||
    !isHash(value.ownershipMapHash) ||
    !isId(value.sourceIndexId) ||
    !isHash(value.sourceIndexHash) ||
    !isId(value.sourceConsultationId) ||
    !isHash(value.sourceConsultationHash) ||
    !isProjectWriteAuthority(value.mutationAuthority) ||
    typeof value.goal !== "string" ||
    value.goal.trim().length === 0 ||
    value.goal !== value.goal.trim() ||
    contentHash(value.goal) !== value.promptHash ||
    !Array.isArray(value.inspectionPaths) ||
    value.inspectionPaths.length > CREATOR_MAX_INSPECTION_PATHS ||
    !value.inspectionPaths.every(
      (path) => typeof path === "string" && canonicalStudioPath(path) === path,
    ) ||
    new Set(value.inspectionPaths).size !== value.inspectionPaths.length ||
    stableJson([...value.inspectionPaths].sort()) !== stableJson(value.inspectionPaths) ||
    !Array.isArray(value.steps) ||
    value.steps.length > CREATOR_MAX_PLAN_STEPS ||
    !Array.isArray(value.changes) ||
    value.changes.length > CREATOR_MAX_CHANGES ||
    !isRecord(value.charter)
  )
    throw new Error("Invalid CreatorPlan");
  for (const change of value.changes) PLAN_CHANGE_SCHEMA.parse(change);
  if (new Set(value.changes.map((change) => change.id)).size !== value.changes.length)
    throw new Error("CreatorPlan change IDs must be unique");
  const steps = value.steps as unknown[];
  if (
    steps.length === 0 ||
    steps.some(
      (step) =>
        !isRecord(step) ||
        !isId(step.id) ||
        typeof step.statement !== "string" ||
        step.statement.trim().length === 0 ||
        !Array.isArray(step.changeIds) ||
        step.changeIds.length === 0 ||
        !step.changeIds.every(isId),
    ) ||
    new Set(steps.map((step) => String((step as Record<string, unknown>).id))).size !== steps.length
  )
    throw new Error("CreatorPlan steps are invalid");
  assertStepChangeCoverage(
    steps as CreatorPlan["steps"],
    value.changes.map((change) => change.id),
  );
  if (
    value.charter.kind !== "VerificationCharter" ||
    !isId(value.charter.id) ||
    !isHash(value.charter.hash) ||
    value.charter.visibility !== "creator_visible" ||
    value.charter.authority !== "creator_approved_hypothesis" ||
    !Array.isArray(value.charter.clauses) ||
    value.charter.clauses.length > CREATOR_MAX_CHARTER_CLAUSES
  )
    throw new Error("Invalid VerificationCharter");
  for (const clause of value.charter.clauses) {
    FINAL_CLAUSE_SCHEMA.parse(clause);
    assertFinalCharterClause(clause as VerificationCharterClause);
  }
  if (
    new Set((value.charter.clauses as VerificationCharterClause[]).map((clause) => clause.id))
      .size !== value.charter.clauses.length
  )
    throw new Error("VerificationCharter clause IDs must be unique");
  assertPlanOutputCoverage(
    value.changes as CreatorPlanChange[],
    value.charter.clauses as VerificationCharterProposalClause[],
  );
  if (
    (value.changes as CreatorPlanChange[]).some(sourceBearingPlanChange) &&
    !(value.charter.clauses as VerificationCharterClause[]).some(
      (clause) => clause.kind === "local_check" && clause.check === "luau_syntax",
    )
  )
    throw new Error("Verification charter requires luau_syntax for source-bearing plan changes");
  const {
    kind: _charterKind,
    id: _charterId,
    hash: _charterHash,
    ...charterPayload
  } = value.charter;
  const expectedCharterHash = contentHash(stableJson(charterPayload));
  if (
    value.charter.hash !== expectedCharterHash ||
    value.charter.id !== `verification_charter_${expectedCharterHash.slice(0, 24)}`
  )
    throw new Error("Invalid VerificationCharter identity");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_plan_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorPlan identity");
}

const POSITION_SERIES_CAPABILITY = STUDIO_CAPABILITY_MANIFEST.runtimeCapabilities.find(
  (entry) => entry.name === "base_part.position_series",
);
if (
  POSITION_SERIES_CAPABILITY?.maximumSamples === undefined ||
  POSITION_SERIES_CAPABILITY.minimumIntervalMs === undefined ||
  POSITION_SERIES_CAPABILITY.maximumIntervalMs === undefined
)
  throw new Error("Studio manifest is missing bounded position-series limits");
const CREATOR_SERIES_MAX_SAMPLES = POSITION_SERIES_CAPABILITY.maximumSamples;
const CREATOR_SERIES_MIN_INTERVAL_MS = POSITION_SERIES_CAPABILITY.minimumIntervalMs;
const CREATOR_SERIES_MAX_INTERVAL_MS = POSITION_SERIES_CAPABILITY.maximumIntervalMs;

const RESOLVABLE_CLASS_SCHEMA = z.enum(STUDIO_RESOLVABLE_CLASSES);
const PROPOSED_CLAUSE_SCHEMA = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.literal("local_check"),
    check: z.literal("luau_syntax"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("instance_exists"),
    path: z.string().min(1),
    expectedClass: RESOLVABLE_CLASS_SCHEMA,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("position_series"),
    path: z.string().min(1),
    expectedClass: z.literal("BasePart"),
    sampleCount: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
    intervalMs: z
      .number()
      .int()
      .min(CREATOR_SERIES_MIN_INTERVAL_MS)
      .max(CREATOR_SERIES_MAX_INTERVAL_MS),
    quantizationStuds: z.number().positive().max(10),
    minimumDistinctPositions: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("playtest_diagnostics"),
    maximumErrors: z.number().int().min(0).max(20),
    maximumWarnings: z.number().int().min(0).max(100),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("snapshot_check"),
    check: z.literal("subtree_unchanged"),
    path: z.string().min(1),
    expectedClass: RESOLVABLE_CLASS_SCHEMA,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("creator_review"),
    statement: z.string().min(1),
  }),
]);
const FINAL_CLAUSE_SCHEMA = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.literal("local_check"),
    check: z.literal("luau_syntax"),
    statement: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("instance_exists"),
    statement: z.string().min(1),
    path: z.string().min(1),
    expectedClass: RESOLVABLE_CLASS_SCHEMA,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("position_series"),
    statement: z.string().min(1),
    path: z.string().min(1),
    expectedClass: z.literal("BasePart"),
    sampleCount: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
    intervalMs: z
      .number()
      .int()
      .min(CREATOR_SERIES_MIN_INTERVAL_MS)
      .max(CREATOR_SERIES_MAX_INTERVAL_MS),
    quantizationStuds: z.number().positive().max(10),
    minimumDistinctPositions: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("studio_check"),
    check: z.literal("playtest_diagnostics"),
    statement: z.string().min(1),
    maximumErrors: z.number().int().min(0).max(20),
    maximumWarnings: z.number().int().min(0).max(100),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("snapshot_check"),
    check: z.literal("subtree_unchanged"),
    statement: z.string().min(1),
    path: z.string().min(1),
    expectedClass: RESOLVABLE_CLASS_SCHEMA,
    baselineHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("creator_review"),
    statement: z.string().min(1),
  }),
]);
const STUDIO_OBJECT_IDENTITY_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("forge_attribute"),
      stableId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("studio_ephemeral"),
      connectorEpoch: z.string().min(1).max(512),
      opaqueHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rojo_sourcemap"),
      authorityMapHash: z.string().regex(/^[0-9a-f]{64}$/),
      sourcemapHash: z.string().regex(/^[0-9a-f]{64}$/),
      mappingId: z.string().min(1).max(512),
    })
    .strict(),
]);
const STUDIO_INSTANCE_TARGET_SCHEMA = z
  .object({
    kind: z.literal("instance"),
    identity: STUDIO_OBJECT_IDENTITY_SCHEMA,
    path: z.string().min(1),
    className: z.string().min(1),
  })
  .strict();
/** Keep the host's name acceptance exactly aligned with StudioAuthoring.validName. */
function isStudioInstanceName(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 100 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".."
  );
}
const STUDIO_INSTANCE_NAME_SCHEMA = z
  .string()
  .refine(
    isStudioInstanceName,
    "Studio instance names must be non-empty UTF-8 strings of at most 100 bytes without slash or dot segments",
  );
/**
 * A direct operation target is a writable capability, unlike an instance
 * parent which is only a structural anchor. Keep those surfaces distinct even
 * when a persisted change set is read without its plan/contract context.
 */
const STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA = STUDIO_INSTANCE_TARGET_SCHEMA.extend({
  className: z.enum(STUDIO_WRITABLE_CLASSES),
});
const STUDIO_MUTATION_PARENT_SCHEMA = z.union([
  STUDIO_INSTANCE_TARGET_SCHEMA,
  z
    .object({
      kind: z.literal("engine_container"),
      path: z.string().min(1),
      className: z.string().min(1),
    })
    .strict(),
]);
const STUDIO_IDENTITY_ENROLLMENT_SCHEMA = z
  .object({
    identity: z
      .object({
        kind: z.literal("studio_ephemeral"),
        connectorEpoch: z.string().min(1).max(512),
        opaqueHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    stableId: z.string().min(1).max(512),
  })
  .strict();
const PLAN_CHANGE_SCHEMA = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.literal("create"),
    path: z.string().min(1),
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    className: z.enum(STUDIO_SCRIPT_CLASSES),
    initialization: z.literal("inline_source_required"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("create"),
    path: z.string().min(1),
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    className: z.enum(STUDIO_NON_SCRIPT_WRITABLE_CLASSES),
    initialization: z.literal("initial_properties"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("update"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("move"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    toPath: z.string().min(1),
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("delete"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("edit_source"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    expectedClass: z.enum(["Script", "LocalScript", "ModuleScript"]),
  }),
]);

const PLAN_SHAPE = {
  citationHandles: CREATOR_CITATION_HANDLES_SCHEMA.optional(),
  inspectionPaths: z.array(z.string().min(1)).max(CREATOR_MAX_INSPECTION_PATHS),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        statement: z.string().min(1),
        changeIds: z.array(z.string().min(1)).min(1).max(CREATOR_MAX_CHANGES),
      }),
    )
    .min(1)
    .max(CREATOR_MAX_PLAN_STEPS),
  changes: z.array(PLAN_CHANGE_SCHEMA).min(1).max(CREATOR_MAX_CHANGES),
  clauses: z.array(PROPOSED_CLAUSE_SCHEMA).min(1).max(CREATOR_MAX_CHARTER_CLAUSES),
} satisfies ZodRawShape;
function boundedSourceSchema() {
  return z
    .string()
    .refine(
      (source) =>
        Buffer.byteLength(source, "utf8") <= STUDIO_CAPABILITY_MANIFEST.source.maximumUtf8Bytes,
      "source text exceeds the declared source-blob resource bound",
    );
}

/**
 * Exact host analogue of Generated.validateSource(source, true). Replacement
 * leaves may be whitespace, but every complete script candidate must satisfy
 * this rule before local eligibility or Prepare.
 */
function assertRequiredStudioSourceText(source: unknown): asserts source is string {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > STUDIO_CAPABILITY_MANIFEST.source.maximumUtf8Bytes ||
    !/\S/u.test(source)
  )
    throw new Error("Required Studio source is outside the generated source contract");
}
const FINITE_NUMBER_SCHEMA = z.number().finite();
const STUDIO_VALUE_SCHEMA: z.ZodType<StudioValue> = z.custom<StudioValue>((value) => {
  try {
    assertStudioValue(value);
    return true;
  } catch {
    return false;
  }
}, "invalid canonical Studio value");
const PRIMITIVE_SCHEMA = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
const NATURAL_VECTOR3_SCHEMA = z
  .object({
    x: FINITE_NUMBER_SCHEMA,
    y: FINITE_NUMBER_SCHEMA,
    z: FINITE_NUMBER_SCHEMA,
  })
  .strict();
const NATURAL_VECTOR2_SCHEMA = z
  .object({ x: FINITE_NUMBER_SCHEMA, y: FINITE_NUMBER_SCHEMA })
  .strict();
const NATURAL_COLOR3_SCHEMA = z
  .object({
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
  })
  .strict();
const NATURAL_CFRAME_SCHEMA = z
  .object({
    position: NATURAL_VECTOR3_SCHEMA,
    rotation: NATURAL_VECTOR3_SCHEMA.describe(
      "Euler rotation in degrees; Forge composes Z, then Y, then X",
    ),
  })
  .strict();
const NATURAL_UDIM_SCHEMA = z
  .object({ scale: FINITE_NUMBER_SCHEMA, offset: z.number().int() })
  .strict();
const NATURAL_UDIM2_SCHEMA = z.object({ x: NATURAL_UDIM_SCHEMA, y: NATURAL_UDIM_SCHEMA }).strict();
const NATURAL_RECT_SCHEMA = z
  .object({ min: NATURAL_VECTOR2_SCHEMA, max: NATURAL_VECTOR2_SCHEMA })
  .strict();
const NATURAL_NUMBER_RANGE_SCHEMA = z
  .object({ min: FINITE_NUMBER_SCHEMA, max: FINITE_NUMBER_SCHEMA })
  .strict();
const NATURAL_NUMBER_SEQUENCE_SCHEMA = z
  .object({
    keypoints: z
      .array(
        z
          .object({
            time: FINITE_NUMBER_SCHEMA,
            value: FINITE_NUMBER_SCHEMA,
            envelope: FINITE_NUMBER_SCHEMA,
          })
          .strict(),
      )
      .min(2)
      .max(64),
  })
  .strict();
const NATURAL_COLOR_SEQUENCE_SCHEMA = z
  .object({
    keypoints: z
      .array(z.object({ time: FINITE_NUMBER_SCHEMA, color: NATURAL_COLOR3_SCHEMA }).strict())
      .min(2)
      .max(64),
  })
  .strict();
const NATURAL_BRICK_COLOR_SCHEMA = z.object({ name: z.string().min(1).max(128) }).strict();
const NATURAL_FONT_SCHEMA = z
  .object({
    family: z.string().min(1).max(1_024),
    weight: z.string().min(1).max(128),
    style: z.string().min(1).max(128),
  })
  .strict();
const NATURAL_PHYSICAL_PROPERTIES_SCHEMA = z
  .object({
    density: FINITE_NUMBER_SCHEMA,
    friction: FINITE_NUMBER_SCHEMA,
    elasticity: FINITE_NUMBER_SCHEMA,
    frictionWeight: FINITE_NUMBER_SCHEMA,
    elasticityWeight: FINITE_NUMBER_SCHEMA,
  })
  .strict();
const NATURAL_AXES_SCHEMA = z.object({ x: z.boolean(), y: z.boolean(), z: z.boolean() }).strict();
const NATURAL_FACES_SCHEMA = z
  .object({
    top: z.boolean(),
    bottom: z.boolean(),
    left: z.boolean(),
    right: z.boolean(),
    front: z.boolean(),
    back: z.boolean(),
  })
  .strict();
const NATURAL_RAY_SCHEMA = z
  .object({ origin: NATURAL_VECTOR3_SCHEMA, direction: NATURAL_VECTOR3_SCHEMA })
  .strict();
const NATURAL_INSTANCE_REFERENCE_SCHEMA = z
  .object({
    identity: STUDIO_OBJECT_IDENTITY_SCHEMA,
    path: z.string().min(1),
    className: z.string().min(1),
  })
  .strict();
const CREATOR_PROPERTY_INPUT_SCHEMA: z.ZodType<CreatorPropertyInput> = z.union([
  z.null(),
  z.boolean(),
  FINITE_NUMBER_SCHEMA,
  z.string().max(4096),
  NATURAL_VECTOR2_SCHEMA,
  NATURAL_VECTOR3_SCHEMA,
  NATURAL_COLOR3_SCHEMA,
  NATURAL_CFRAME_SCHEMA,
  NATURAL_UDIM_SCHEMA,
  NATURAL_UDIM2_SCHEMA,
  NATURAL_RECT_SCHEMA,
  NATURAL_NUMBER_RANGE_SCHEMA,
  NATURAL_NUMBER_SEQUENCE_SCHEMA,
  NATURAL_COLOR_SEQUENCE_SCHEMA,
  NATURAL_BRICK_COLOR_SCHEMA,
  NATURAL_FONT_SCHEMA,
  NATURAL_PHYSICAL_PROPERTIES_SCHEMA,
  NATURAL_AXES_SCHEMA,
  NATURAL_FACES_SCHEMA,
  NATURAL_RAY_SCHEMA,
  NATURAL_INSTANCE_REFERENCE_SCHEMA,
]);
const CREATOR_SOURCE_WRITE_BLOB_BINDING_SCHEMA: z.ZodType<CreatorSourceWriteBlobBinding> = z
  .object({
    manifestId: z.string().min(1),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    utf8Bytes: z
      .number()
      .int()
      .nonnegative()
      .max(CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes),
  })
  .strict();
const CHANGE_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("create"),
    tempId: z.string().min(1),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    className: z.enum(STUDIO_WRITABLE_CLASSES),
    name: STUDIO_INSTANCE_NAME_SCHEMA,
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    sourceBlob: CREATOR_SOURCE_WRITE_BLOB_BINDING_SCHEMA.optional(),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("update"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    enrollment: STUDIO_IDENTITY_ENROLLMENT_SCHEMA.optional(),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    removedAttributes: z.array(z.string().min(1)).max(64),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("move"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    enrollment: STUDIO_IDENTITY_ENROLLMENT_SCHEMA.optional(),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    name: STUDIO_INSTANCE_NAME_SCHEMA,
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    removedAttributes: z.array(z.string().min(1)).max(64),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("delete"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    enrollment: STUDIO_IDENTITY_ENROLLMENT_SCHEMA.optional(),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("edit_source"),
    target: STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA,
    enrollment: STUDIO_IDENTITY_ENROLLMENT_SCHEMA.optional(),
    beforeSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    edits: z
      .array(
        z.object({
          startByte: z.number().int().nonnegative(),
          endByte: z.number().int().nonnegative(),
          replacementBlob: CREATOR_SOURCE_WRITE_BLOB_BINDING_SCHEMA,
        }),
      )
      .min(1)
      .max(1_024),
    finalSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    finalByteCount: z.number().int().nonnegative(),
  }),
]);
const STAGE_PAYLOAD_SCHEMA = z
  .object({
    planChangeId: z.string().min(1),
    properties: z.record(z.string(), CREATOR_PROPERTY_INPUT_SCHEMA).optional(),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA).optional(),
    removedAttributes: z.array(z.string().min(1)).max(64).optional(),
    source: boundedSourceSchema().optional(),
    sourceEdits: z
      .array(
        z.object({
          startByte: z.number().int().nonnegative(),
          endByte: z.number().int().nonnegative(),
          replacement: boundedSourceSchema(),
        }),
      )
      .min(1)
      .max(1_024)
      .optional(),
  })
  .strict();
const ROBLOX_API_LOOKUP_SHAPE = {
  className: z
    .string()
    .min(1)
    .max(128)
    .describe("One exact class name, e.g. ProximityPrompt. Omit query to browse its members.")
    .optional(),
  query: z
    .string()
    .min(1)
    .max(160)
    .describe(
      "One literal search phrase or member name, e.g. Triggered. Multiple member names require separate calls; do not join them into one query.",
    )
    .optional(),
  limit: z.number().int().min(1).max(20).optional(),
} satisfies ZodRawShape;
const PROJECT_QUERY_CURSOR_SCHEMA = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "Omit for the first page. For later pages, copy nextCursor returned by the same tool and query. Never send 0, START, null, a revision hash, or an invented cursor.",
  )
  .optional();
const BUILDER_DEFINITIONS: AgentToolDefinition[] = [
  definition(
    "studio.api_lookup",
    "Search the pinned official Roblox Engine API catalog for class, property, method, event, callback, datatype, or enum metadata. Results include signatures, security/capability context, source provenance, and Forge's precise direct-authoring/source-only/restricted disposition. Catalog presence informs Luau source; it never grants typed Studio mutation or behavioral proof.",
    ROBLOX_API_LOOKUP_SHAPE,
  ),
  definition(
    "studio.inspect",
    "Inspect only explicit initial-snapshot paths listed in the immutable CreatorBuildContract. Source bodies are not returned.",
    {
      paths: z.array(z.string().min(1)).min(1).max(CREATOR_MAX_INSPECTION_PATHS),
    },
  ),
  definition(
    "source.read",
    "Read a UTF-8-safe page from any source document in the exact creator-approved consultation/dependency closure. Reading outside that closure fails and requires a new plan.",
    {
      documentId: z.string().min(1).max(256),
      maximumUtf8Bytes: z
        .number()
        .int()
        .min(1)
        .max(32 * 1024)
        .optional(),
      cursor: z.string().min(1).optional(),
    },
  ),
  definition(
    "studio.stage",
    "Stage the current proposal for one approved change. Supply only planChangeId and its creative payload. A later valid call for the same planChangeId atomically replaces the earlier staged proposal so verifier feedback can be repaired; a rejected replacement leaves the earlier proposal intact. Property JSON is natural and untagged; the sealed property policy names the required codec. Scalars use booleans, finite numbers, or strings. Compound shapes are Vector2 {x,y}, Vector3 {x,y,z}, Color3 {r,g,b} in 0..1, CFrame {position:{x,y,z},rotation:{x,y,z}} in Euler degrees, UDim {scale,offset}, UDim2 {x:{scale,offset},y:{scale,offset}}, Rect {min:{x,y},max:{x,y}}, NumberRange {min,max}, sequences {keypoints:[...]}, BrickColor {name}, Font {family,weight,style}, PhysicalProperties, Axes, Faces, Ray {origin,direction}, or stable instance reference {stableId,path,className}. Never send type/value wrappers. Attributes are primitive where permitted; source is required only where the contract says so. Forge derives structural fields and converts properties to the trusted Studio representation. This never mutates the live place.",
    { change: STAGE_PAYLOAD_SCHEMA },
  ),
  definition(
    "studio.diff",
    "Inspect plan-change bindings, hashes, source hashes and byte counts, and summaries of the complete current staged Studio change set.",
    {},
  ),
  definition(
    "forge.verify",
    "Run bounded local validation of every staged Luau source in the exact approved Studio hierarchy. Diagnostics identify the plan change, logical Studio path, range, and bounded message needed for repair. The live place is not mutated.",
    {},
  ),
];

function definition(
  name: string,
  description: string,
  inputShape: ZodRawShape,
): AgentToolDefinition {
  return {
    name,
    description,
    inputShape,
    schema: z.toJSONSchema(z.object(inputShape)),
  };
}
async function invokeCreatorRuntime(
  runtime: AgentRuntime,
  input: Parameters<AgentRuntime["run"]>[0],
): Promise<AgentRuntimeResult> {
  try {
    return await runtime.run(input);
  } catch (error) {
    return {
      status: "failed",
      trialStarted: false,
      failureKind: "harness",
      failureCode: "CREATOR_RUNTIME_THROW",
      error: error instanceof Error ? error.message : String(error),
      usage: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      timing: {
        startedAt: "1970-01-01T00:00:00.000Z",
        endedAt: "1970-01-01T00:00:00.000Z",
        durationMs: 0,
      },
      turns: [],
      toolCalls: [],
    };
  }
}
function runtimeFinalization(
  intendedArtifactKind: "creator_outcome" | "change_set",
  result: AgentRuntimeResult,
): Extract<CreatorPhaseFinalization, { status: "unsealed" }> {
  return {
    status: "unsealed",
    intendedArtifactKind,
    failureStage: "runtime",
    failureCode:
      result.failureCode ??
      (result.status === "budget_exhausted" ? "RUNTIME_BUDGET_EXHAUSTED" : "RUNTIME_FAILED"),
    detail:
      result.error ??
      `Creator ${intendedArtifactKind === "creator_outcome" ? "agent" : "builder"} did not complete`,
    failureKind: result.failureKind ?? "harness",
  };
}
function bounded(value: unknown): ToolResult {
  const serialized = stableJson(value);
  const limit = 64 * 1024;
  const bytes = Buffer.byteLength(serialized, "utf8");
  return {
    ok: true,
    value: bytes > limit ? { truncated: true, preview: serialized.slice(0, limit) } : value,
    truncated: bytes > limit,
    resultHash: contentHash(serialized),
    bytes: Math.min(bytes, limit),
  };
}
function failed(code: string, message: string): ToolResult {
  const serialized = stableJson({ code, message });
  return {
    ok: false,
    error: { code, message },
    truncated: false,
    resultHash: contentHash(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}
function sealSession(value: CreatorSession): CreatorSession {
  const { hash: _hash, ...payload } = value;
  const sealed = { ...value, hash: contentHash(stableJson(payload)) };
  assertCreatorSession(sealed);
  return sealed;
}
function clonePlanChange<T extends CreatorPlanChange>(change: T): T {
  return structuredClone(change);
}
function cloneOperation<T extends StudioChangeOperation>(operation: T): T {
  return structuredClone(operation);
}
function operationSummary(operation: StudioChangeOperation): string {
  if (operation.kind === "create") return `Create ${operation.className} ${operation.target.path}`;
  if (operation.kind === "edit_source") return `Edit source for ${operation.target.path}`;
  if (operation.kind === "move")
    return `Move ${operation.target.path} to ${operation.parent.path}/${operation.name}`;
  return `${operation.kind === "delete" ? "Delete" : "Update"} ${operation.target.path}`;
}

function creatorLuauAnalysisTopology(
  observation: CreatorProjectIndexView,
  operations: readonly StudioChangeOperation[],
): StudioLuauAnalysisNode[] {
  const classes = new Map<string, string>(
    STUDIO_AUTHORING_CONTAINERS.map((entry) => [entry.path, entry.className]),
  );
  for (const instance of observation.instances) classes.set(instance.path, instance.className);
  for (const script of observation.scripts)
    if (!classes.has(script.path))
      classes.set(
        script.path,
        script.executionContext === "server"
          ? "Script"
          : script.executionContext === "client"
            ? "LocalScript"
            : "ModuleScript",
      );

  for (const operation of operations) {
    if (operation.kind === "delete") {
      removeStudioTopologySubtree(classes, operation.target.path);
      continue;
    }
    if (operation.kind === "move") {
      const destination = `${operation.parent.path}/${operation.name}`;
      const moved = [...classes]
        .filter(
          ([path]) =>
            path === operation.target.path || path.startsWith(`${operation.target.path}/`),
        )
        .sort(([left], [right]) => pathDepth(left) - pathDepth(right));
      removeStudioTopologySubtree(classes, operation.target.path);
      if (moved.length === 0) classes.set(destination, operation.target.className);
      else
        for (const [path, className] of moved)
          classes.set(`${destination}${path.slice(operation.target.path.length)}`, className);
      continue;
    }
    if (operation.kind === "create") {
      classes.set(operation.target.path, operation.className);
      continue;
    }
    classes.set(operation.target.path, operation.target.className);
  }
  return [...classes]
    .map(([studioPath, className]) => ({ studioPath, className }))
    .sort(
      (left, right) =>
        pathDepth(left.studioPath) - pathDepth(right.studioPath) ||
        left.studioPath.localeCompare(right.studioPath),
    );
}

/**
 * Materialize unchanged, evidence-bound scripts only inside the host's
 * temporary analyzer project. They are never returned by model-facing tools,
 * but their exact source lets luau-lsp resolve requires in staged candidates.
 */
function creatorLuauAnalysisDependencies(
  observation: CreatorProjectIndexView,
  sourceIndex: StudioSourceIndex,
  sourceResolver: VerifiedSourceResolver,
  operations: readonly StudioChangeOperation[],
  stagedSources: readonly StudioLuauAnalysisSource[],
): StudioLuauAnalysisSource[] {
  const scripts = new Map<
    string,
    {
      id: string;
      studioPath: string;
      className: "Script" | "LocalScript" | "ModuleScript";
      source: string;
    }
  >();
  for (const script of observation.scripts) {
    const sourceDocument = sourceIndex.documents.find(
      (document) => document.documentId === script.documentId,
    );
    if (!sourceDocument || sourceDocument.sourceHash !== script.sourceHash)
      throw new Error(`Complete Studio analysis source is unavailable at ${script.path}`);
    const source = sourceResolver.read(sourceDocument);
    if (contentHash(source) !== script.sourceHash)
      throw new Error(`Studio analysis source hash does not match at ${script.path}`);
    scripts.set(script.path, {
      id: `studio_dependency_${script.documentId}`,
      studioPath: script.path,
      className:
        script.executionContext === "server"
          ? "Script"
          : script.executionContext === "client"
            ? "LocalScript"
            : "ModuleScript",
      source,
    });
  }

  for (const operation of operations) {
    if (operation.kind === "delete") {
      for (const path of scripts.keys())
        if (path === operation.target.path || path.startsWith(`${operation.target.path}/`))
          scripts.delete(path);
      continue;
    }
    if (operation.kind === "move") {
      const destination = `${operation.parent.path}/${operation.name}`;
      const moved = [...scripts.entries()].filter(
        ([path]) => path === operation.target.path || path.startsWith(`${operation.target.path}/`),
      );
      for (const [path] of moved) scripts.delete(path);
      for (const [path, source] of moved) {
        const studioPath = `${destination}${path.slice(operation.target.path.length)}`;
        scripts.set(studioPath, { ...source, studioPath });
      }
      continue;
    }
    if (operation.kind === "edit_source") scripts.delete(operation.target.path);
  }

  for (const staged of stagedSources) scripts.delete(staged.studioPath);
  return [...scripts.values()].sort(
    (left, right) =>
      left.studioPath.localeCompare(right.studioPath) || left.id.localeCompare(right.id),
  );
}

function removeStudioTopologySubtree(classes: Map<string, string>, root: string): void {
  for (const path of classes.keys())
    if (path === root || path.startsWith(`${root}/`)) classes.delete(path);
}

function creatorVerificationDiagnostic(
  issue: VerificationIssue,
  sources: readonly (StudioLuauAnalysisSource & {
    planChangeId: string;
    operationId: string;
  })[],
): unknown {
  const source = issue.path ? sources.find((entry) => entry.studioPath === issue.path) : undefined;
  return {
    id: issue.id,
    ruleId: issue.ruleId,
    severity: issue.severity,
    category: issue.category,
    message: boundedDiagnosticMessage(issue.message),
    ...(issue.path ? { path: issue.path } : {}),
    ...(source
      ? {
          planChangeId: source.planChangeId,
          operationId: source.operationId,
        }
      : {}),
    ...(issue.location
      ? {
          location: {
            line: issue.location.line,
            column: issue.location.column,
            ...(issue.location.endLine !== undefined ? { endLine: issue.location.endLine } : {}),
            ...(issue.location.endColumn !== undefined
              ? { endColumn: issue.location.endColumn }
              : {}),
          },
        }
      : {}),
    ...(issue.remediation
      ? {
          remediation: {
            kind: issue.remediation.kind,
            steps: issue.remediation.steps.slice(0, 3).map(boundedDiagnosticMessage),
          },
        }
      : {}),
  };
}

function boundedDiagnosticMessage(value: string): string {
  const maximumCharacters = 1_024;
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters - 1)}…`;
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function canonicalStudioPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    throw new Error(`Invalid Studio path ${value}`);
  return value;
}
function pathParent(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 1) throw new Error(`Studio change path requires a parent: ${path}`);
  return path.slice(0, index);
}
function pathName(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0 || index === path.length - 1)
    throw new Error(`Studio change path requires a child name: ${path}`);
  return path.slice(index + 1);
}
function changeInputPath(change: CreatorPlanChange): string | undefined {
  return change.kind === "move"
    ? change.target.path
    : change.kind === "create"
      ? undefined
      : change.target.path;
}
function changeOutputPath(change: CreatorPlanChange): string | undefined {
  return change.kind === "move"
    ? change.toPath
    : change.kind === "delete"
      ? undefined
      : change.kind === "create"
        ? change.path
        : change.target.path;
}
function planChangeTouchesPath(change: CreatorPlanChange, root: string): boolean {
  return [changeInputPath(change), changeOutputPath(change)].some(
    (path) => path !== undefined && (path === root || path.startsWith(`${root}/`)),
  );
}
function classMatches(actual: string, expected: StudioResolvableClass): boolean {
  return (
    actual === expected ||
    (expected === "BasePart" &&
      new Set([
        "Part",
        "MeshPart",
        "UnionOperation",
        "WedgePart",
        "CornerWedgePart",
        "TrussPart",
        "SpawnLocation",
        "VehicleSeat",
        "Seat",
      ]).has(actual))
  );
}
function resultingClassAt(
  path: string,
  changes: CreatorPlanChange[],
  observation: CreatorProjectIndexView,
): string | undefined {
  for (const change of changes) {
    if (change.kind === "create" && change.path === path) return change.className;
    if (change.kind === "move" && change.toPath === path) return change.expectedClass;
    if (
      (change.kind === "delete" && change.target.path === path) ||
      (change.kind === "move" && change.target.path === path)
    )
      return undefined;
  }
  return observation.instances.find((entry) => entry.path === path)?.className;
}
function derivePlanMutationAuthority(
  changes: readonly CreatorPlanChange[],
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
): ProjectWriteAuthority {
  const authorities = changes.map((change) => planChangeAuthority(change, observation, ownership));
  const selected = [...new Set(authorities)];
  if (selected.length !== 1)
    throw new Error("Mixed creator-plan authority is rejected before approval");
  const authority = selected[0];
  if (!authority || !ownership.availableAuthorities.includes(authority))
    throw new Error("Creator plan selected an unavailable writer authority");
  return authority;
}

function planChangeAuthority(
  change: CreatorPlanChange,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
): ProjectWriteAuthority {
  if (change.kind === "create") {
    const requestedParent = change.parent;
    const parent =
      requestedParent.kind === "instance"
        ? observation.instances.find(
            (entry) =>
              entry.objectId === studioObjectIdentityKey(requestedParent.identity) &&
              entry.path === requestedParent.path &&
              entry.className === requestedParent.className,
          )
        : undefined;
    const parentOwnership =
      parent && ownership.entries.find((entry) => entry.objectId === parent.objectId);
    return isScriptClass(change.className) && parentOwnership?.owner === "rojo_source"
      ? "rojo_source"
      : "studio_document";
  }
  const target = observation.instances.find(
    (entry) =>
      entry.objectId === studioObjectIdentityKey(change.target.identity) &&
      entry.path === change.target.path &&
      entry.className === change.target.className,
  );
  const targetOwnership =
    target && ownership.entries.find((entry) => entry.objectId === target.objectId);
  if (!target || !targetOwnership)
    throw new Error("Creator plan target is absent from the exact ownership map");
  return targetOwnership.owner;
}

function assertCreatorPlanChange(
  change: CreatorPlanChange,
  changes: CreatorPlanChange[],
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
  mutationAuthority: ProjectWriteAuthority,
): void {
  PLAN_CHANGE_SCHEMA.parse(change);
  if (mutationAuthority === "rojo_source") {
    assertRojoSourcePlanChange(change, changes, observation, ownership);
    return;
  }
  if (change.kind === "create") {
    const path = canonicalStudioPath(change.path);
    const parentPath = pathParent(path);
    const parent = assertExactPlanParent(change.parent, parentPath, observation);
    assertStudioStructuralParent(change.parent, parent, ownership, {
      operationId: change.id,
      operationKind: change.kind,
      targetPath: path,
    });
    if (hasIndexedChildNameCollision(observation, parent, pathName(path)))
      throw new Error(`Planned create target already exists: ${path}`);
    return;
  }
  const sourcePath = canonicalStudioPath(change.target.path);
  if (
    change.kind === "edit_source" &&
    changes.some(
      (candidate) =>
        candidate.kind === "create" && canonicalStudioPath(candidate.path) === sourcePath,
    )
  )
    throw new Error(
      `Planned source target is a newly created script: ${sourcePath}. New scripts must be authored by their corresponding create operation with initialization inline_source_required; edit_source is only for scripts from the initial project index.`,
    );
  const observed = observation.instances.find(
    (entry) =>
      entry.objectId === studioObjectIdentityKey(change.target.identity) &&
      entry.path === sourcePath &&
      entry.className === change.target.className,
  );
  const authority =
    observed && ownership.entries.find((entry) => entry.objectId === observed.objectId);
  if (
    !observed ||
    observed.className !== change.expectedClass ||
    authority?.owner !== "studio_document"
  )
    throw new Error(
      `Planned ${change.kind} target is absent, class-mismatched, or not Studio-document-owned: ${sourcePath}`,
    );
  if (change.kind === "move") {
    const destination = canonicalStudioPath(change.toPath);
    if (destination === sourcePath)
      throw new Error(`Planned move destination is invalid or occupied: ${destination}`);
    const parent = assertExactPlanParent(change.parent, pathParent(destination), observation);
    if (hasIndexedChildNameCollision(observation, parent, pathName(destination), observed.objectId))
      throw new Error(`Planned move destination is invalid or occupied: ${destination}`);
    assertStudioStructuralParent(change.parent, parent, ownership, {
      operationId: change.id,
      operationKind: change.kind,
      targetPath: destination,
    });
  }
  if (
    change.kind === "edit_source" &&
    !observation.scripts.some(
      (script) => script.documentId === observed.objectId && script.path === sourcePath,
    )
  )
    throw new Error(`Planned source target has no observed script source: ${sourcePath}`);
}

/**
 * A Rojo project has one filesystem writer. Its Creator plan remains typed,
 * but only an existing source replacement or a new standalone Luau source
 * file can cross this boundary. Properties, topology edits, and deletes have
 * no implicit Studio fallback.
 */
function assertRojoSourcePlanChange(
  change: CreatorPlanChange,
  changes: CreatorPlanChange[],
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
): void {
  if (change.kind === "create") {
    if (!isScriptClass(change.className) || change.initialization !== "inline_source_required")
      throw new Error("Rojo source authority permits only new scripts with inline source");
    const path = canonicalStudioPath(change.path);
    const parent = pathParent(path);
    const parentInstance = assertExactPlanParent(change.parent, parent, observation);
    if (hasIndexedChildNameCollision(observation, parentInstance, pathName(path)))
      throw new Error(`Planned Rojo source creation target already exists: ${path}`);
    const parentAuthority =
      parentInstance &&
      ownership.entries.find((entry) => entry.objectId === parentInstance.objectId);
    if (!parentInstance || parentAuthority?.owner !== "rojo_source")
      throw new Error(
        `Planned Rojo source creation parent is absent or outside source authority: ${parent}`,
      );
    return;
  }
  if (change.kind !== "edit_source")
    throw new Error(
      "Rojo source authority permits only edit_source and source-script create changes",
    );
  const sourcePath = canonicalStudioPath(change.target.path);
  if (
    changes.some(
      (candidate) =>
        candidate.kind === "create" && canonicalStudioPath(candidate.path) === sourcePath,
    )
  )
    throw new Error(
      "Planned Rojo source edit cannot target a script created in the same change set",
    );
  const observed = observation.instances.find(
    (entry) =>
      entry.objectId === studioObjectIdentityKey(change.target.identity) &&
      entry.path === sourcePath &&
      entry.className === change.target.className,
  );
  const authority =
    observed && ownership.entries.find((entry) => entry.objectId === observed.objectId);
  if (
    !observed ||
    observed.className !== change.expectedClass ||
    authority?.owner !== "rojo_source"
  )
    throw new Error(
      `Planned Rojo source target is absent, class-mismatched, or outside source authority: ${sourcePath}`,
    );
  if (
    !observation.scripts.some(
      (script) => script.documentId === observed.objectId && script.path === sourcePath,
    )
  )
    throw new Error(`Planned Rojo source target has no observed script source: ${sourcePath}`);
}
function assertStepChangeCoverage(steps: CreatorPlan["steps"], changeIds: string[]): void {
  const bound = steps.flatMap((step) => step.changeIds);
  if (
    new Set(bound).size !== bound.length ||
    stableJson([...bound].sort()) !== stableJson([...changeIds].sort())
  )
    throw new Error("Creator plan steps must bind every change exactly once");
}
function sourceBearingPlanChange(change: CreatorPlanChange): boolean {
  return (
    change.kind === "edit_source" || (change.kind === "create" && isScriptClass(change.className))
  );
}
function assertPlanOutputCoverage(
  changes: CreatorPlanChange[],
  clauses: VerificationCharterProposalClause[],
): void {
  for (const change of changes) {
    if (change.kind !== "create" && change.kind !== "move") continue;
    const path = change.kind === "create" ? change.path : change.toPath;
    const expectedClass = change.kind === "create" ? change.className : change.expectedClass;
    if (
      !clauses.some(
        (clause) =>
          clause.kind === "studio_check" &&
          clause.check === "instance_exists" &&
          clause.path === path &&
          clause.expectedClass === expectedClass,
      )
    )
      throw new Error(
        `Verification charter requires an exact class-aware instance_exists check for planned output ${path}`,
      );
  }
}
function assertCreatorRuntimeObservationWindow(
  clauses: readonly VerificationCharterProposalClause[],
): void {
  const series = clauses.filter(
    (clause): clause is Extract<VerificationCharterProposalClause, { check: "position_series" }> =>
      clause.kind === "studio_check" && clause.check === "position_series",
  );
  if (series.length === 0) return;
  const durations = series.map((clause) => (clause.sampleCount - 1) * clause.intervalMs);
  if (durations.some((duration) => duration < CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS))
    throw new Error(
      `Each creator position-series check must have capacity for at least ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS} ms so creator-triggered behavior can occur before the creator-defined Stop boundary`,
    );
  if (Math.max(0, ...durations) > STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeMs)
    throw new Error("Creator position-series checks exceed the manifest runtime budget");
}
function assertPlanChangeSet(
  changes: CreatorPlanChange[],
  observation: CreatorProjectIndexView,
): void {
  const outputs = changes.flatMap((change) =>
    changeOutputPath(change) ? [changeOutputPath(change)!] : [],
  );
  if (new Set(outputs).size !== outputs.length)
    throw new Error("Creator plan changes must have unique output paths");
  const existingTargets = changes.flatMap((change) =>
    changeInputPath(change) ? [changeInputPath(change)!] : [],
  );
  if (new Set(existingTargets).size !== existingTargets.length)
    throw new Error("Creator plan permits only one change per existing Studio target");
  const plannedInstances = new Set(
    changes.flatMap((change) =>
      change.kind === "create" || change.kind === "move" ? [changeOutputPath(change)!] : [],
    ),
  );
  for (const change of changes)
    if (
      (change.kind === "create" || change.kind === "move") &&
      plannedInstances.has(pathParent(changeOutputPath(change)!))
    )
      throw new Error("Planned instances cannot parent other planned instances in one change set");
  for (const output of outputs)
    if (
      !observation.instances.some((entry) => entry.path === output) &&
      outputs.filter((candidate) => candidate === output).length > 1
    )
      throw new Error(`Duplicate planned output ${output}`);
}
function assertProposedCharterClause(
  clause: VerificationCharterProposalClause,
  changes: CreatorPlanChange[],
  observation: CreatorProjectIndexView,
): void {
  PROPOSED_CLAUSE_SCHEMA.parse(clause);
  if (!("path" in clause)) return;
  const path = canonicalStudioPath(clause.path);
  assertCheckPathScope(clause, path);
  if (clause.kind === "snapshot_check") {
    const observed = observation.instances.find((entry) => entry.path === path);
    if (!observed || !classMatches(observed.className, clause.expectedClass))
      throw new Error(`Subtree preservation target is absent or class-mismatched: ${path}`);
    if (changes.some((change) => planChangeTouchesPath(change, path)))
      throw new Error(`A subtree cannot be declared unchanged while the plan changes it: ${path}`);
    return;
  }
  const resultingClass = resultingClassAt(path, changes, observation);
  if (!resultingClass || !classMatches(resultingClass, clause.expectedClass))
    throw new Error(
      `Machine-check target is absent, deleted, moved away, or class-mismatched: ${path}`,
    );
  if (clause.check === "position_series" && clause.minimumDistinctPositions > clause.sampleCount)
    throw new Error("Position-series minimum distinct positions cannot exceed its sample count");
}
function materializeCharterClause(
  clause: VerificationCharterProposalClause,
  observation: CreatorProjectIndexView,
): VerificationCharterClause {
  if (clause.kind === "creator_review") return { ...clause };
  if (clause.kind === "local_check") return { ...clause, statement: machineStatement(clause) };
  if (clause.kind === "snapshot_check")
    return {
      ...clause,
      statement: machineStatement(clause),
      baselineHash: subtreeProjectIndexHash(observation, clause.path),
    };
  return {
    ...clause,
    statement: machineStatement(clause),
  } as VerificationCharterClause;
}
function machineStatement(
  clause: Exclude<
    VerificationCharterProposalClause | VerificationCharterClause,
    { kind: "creator_review" }
  >,
): string {
  if (clause.kind === "local_check")
    return "Every staged Luau source passes the bounded local Luau syntax and analysis gate.";
  if (clause.kind === "snapshot_check")
    return `${clause.path} has the same bounded Studio snapshot digest after the change as before it.`;
  if (clause.check === "instance_exists")
    return `${clause.path} resolves as ${clause.expectedClass} during the approved playtest.`;
  if (clause.check === "position_series")
    return `${clause.path} produces at least ${clause.minimumDistinctPositions} distinct ${clause.quantizationStuds}-stud-quantized positions while sampled every ${clause.intervalMs} ms until the creator presses Stop, bounded to at most ${clause.sampleCount} samples.`;
  return `The approved Play Server observation emits at most ${clause.maximumErrors} errors and ${clause.maximumWarnings} warnings before creator Stop; server diagnostic capture must not truncate.`;
}
function assertFinalCharterClause(clause: VerificationCharterClause): void {
  FINAL_CLAUSE_SCHEMA.parse(clause);
  if ("path" in clause) assertCheckPathScope(clause, canonicalStudioPath(clause.path));
  if (clause.kind !== "creator_review") {
    const {
      statement: _statement,
      baselineHash: _baselineHash,
      ...proposal
    } = clause as VerificationCharterClause & { baselineHash?: string };
    if (
      clause.statement !==
      machineStatement(
        proposal as Exclude<VerificationCharterProposalClause, { kind: "creator_review" }>,
      )
    )
      throw new Error("VerificationCharter machine statement is not canonical");
  }
}
function assertCheckPathScope(
  clause: Extract<VerificationCharterProposalClause | VerificationCharterClause, { path: string }>,
  path: string,
): void {
  if (!isAllowedStudioPath(path))
    throw new Error(`Creator check path is outside allowlisted Studio roots: ${path}`);
  if (
    clause.kind === "studio_check" &&
    clause.check === "position_series" &&
    !path.startsWith("Workspace/")
  )
    throw new Error("Creator position-series checks are bounded to Workspace BaseParts");
}
export function subtreeProjectIndexHash(
  observation: CreatorProjectIndexView,
  rootPath: string,
): string {
  assertCreatorProjectIndexView(observation);
  const root = canonicalStudioPath(rootPath);
  const under = (path: string) => path === root || path.startsWith(`${root}/`);
  const payload = {
    instances: observation.instances
      .filter((entry) => under(entry.path))
      .map((entry) => structuredClone(entry))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.objectId.localeCompare(right.objectId),
      ),
    scripts: observation.scripts
      .filter((entry) => under(entry.path))
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.documentId.localeCompare(right.documentId),
      ),
  };
  if (payload.instances.length === 0) throw new Error(`Subtree snapshot target is absent: ${root}`);
  return contentHash(stableJson(payload));
}

function creatorPropertyPolicies(): Record<StudioWritableClass, CreatorPropertyPolicy> {
  return Object.fromEntries(
    STUDIO_CAPABILITY_MANIFEST.classes.map((classDefinition) => [
      classDefinition.name,
      {
        allowedProperties: classDefinition.properties.map((property) => ({
          name: property.name,
          valueKinds: [property.codec],
          nullable: property.nullable,
          constraints: {
            ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
            ...(property.minimumExclusive === undefined
              ? {}
              : { minimumExclusive: property.minimumExclusive }),
            ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
            ...(property.maximumAbsoluteTranslation === undefined
              ? {}
              : {
                  cframeTranslationMaximumAbsolute: property.maximumAbsoluteTranslation,
                }),
            ...(property.minimumUtf8Bytes === undefined
              ? {}
              : { minimumUtf8Bytes: property.minimumUtf8Bytes }),
            ...(property.maximumUtf8Bytes === undefined
              ? {}
              : { maximumUtf8Bytes: property.maximumUtf8Bytes }),
            ...(property.maximumEntries === undefined
              ? {}
              : { maximumEntries: property.maximumEntries }),
            ...(property.referenceClass === undefined
              ? {}
              : { referenceClass: property.referenceClass }),
            ...(property.allowed === undefined ? {} : { allowedStrings: [...property.allowed] }),
          },
        })),
        attributes: "primitive" as const,
        source:
          classDefinition.source === "required_on_create_and_writeable"
            ? ("required" as const)
            : ("forbidden" as const),
      },
    ]),
  ) as Record<StudioWritableClass, CreatorPropertyPolicy>;
}
function assertCreatorPropertyPolicy(value: unknown): asserts value is CreatorPropertyPolicy {
  if (
    !isRecord(value) ||
    !Array.isArray(value.allowedProperties) ||
    !value.allowedProperties.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        Array.isArray(entry.valueKinds) &&
        entry.valueKinds.length === 1 &&
        entry.valueKinds.every((type) =>
          STUDIO_CODECS.includes(type as (typeof STUDIO_CODECS)[number]),
        ) &&
        typeof entry.nullable === "boolean" &&
        (entry.constraints === undefined || validPropertyConstraints(entry.constraints)),
    ) ||
    value.attributes !== "primitive" ||
    (value.source !== "required" && value.source !== "forbidden")
  )
    throw new Error("Invalid CreatorBuildContract property policy");
  const propertyNames = value.allowedProperties.map((entry) => entry.name);
  if (
    new Set(propertyNames).size !== propertyNames.length ||
    stableJson([...propertyNames].sort()) !== stableJson(propertyNames)
  )
    throw new Error("CreatorBuildContract property policy is not canonical");
}
function validPropertyConstraints(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const numericKeys = [
    "minimum",
    "maximum",
    "minimumExclusive",
    "maximumAbsolute",
    "cframeTranslationMaximumAbsolute",
    "cframeRotationMaximumAbsolute",
    "minimumUtf8Bytes",
    "maximumUtf8Bytes",
    "maximumEntries",
  ];
  if (
    Object.keys(value).some(
      (key) => !numericKeys.includes(key) && key !== "allowedStrings" && key !== "referenceClass",
    )
  )
    return false;
  const minimumUtf8Bytes = value.minimumUtf8Bytes;
  const maximumUtf8Bytes = value.maximumUtf8Bytes;
  if (
    minimumUtf8Bytes !== undefined &&
    (typeof minimumUtf8Bytes !== "number" ||
      !Number.isSafeInteger(minimumUtf8Bytes) ||
      minimumUtf8Bytes < 0)
  )
    return false;
  if (
    maximumUtf8Bytes !== undefined &&
    (typeof maximumUtf8Bytes !== "number" ||
      !Number.isSafeInteger(maximumUtf8Bytes) ||
      maximumUtf8Bytes < 0)
  )
    return false;
  if (
    minimumUtf8Bytes !== undefined &&
    maximumUtf8Bytes !== undefined &&
    minimumUtf8Bytes > maximumUtf8Bytes
  )
    return false;
  const maximumEntries = value.maximumEntries;
  if (
    maximumEntries !== undefined &&
    (typeof maximumEntries !== "number" ||
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries <= 0)
  )
    return false;
  if (
    value.referenceClass !== undefined &&
    (typeof value.referenceClass !== "string" ||
      !isRobloxClassAssignableTo(value.referenceClass, "Instance"))
  )
    return false;
  if (
    numericKeys.some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "number" || !Number.isFinite(value[key] as number)),
    )
  )
    return false;
  return (
    value.allowedStrings === undefined ||
    (Array.isArray(value.allowedStrings) &&
      value.allowedStrings.length > 0 &&
      value.allowedStrings.every((item) => typeof item === "string") &&
      new Set(value.allowedStrings).size === value.allowedStrings.length)
  );
}
function materializeBuildContractChange(
  change: CreatorPlanChange,
  plan: CreatorPlan,
  observation: CreatorProjectIndexView,
  policies: Readonly<Record<string, CreatorPropertyPolicy>>,
): CreatorBuildContractChange {
  const identity = (suffix: string) =>
    `${suffix}_${contentHash(stableJson({ planHash: plan.hash, planChangeId: change.id })).slice(0, 24)}`;
  const operationId = identity("creator_operation");
  const policyFor = (className: StudioWritableClass): CreatorPropertyPolicy => {
    const policy = policies[className];
    if (policy === undefined)
      throw new Error(`Creator build contract has no sealed policy for ${className}`);
    return policy;
  };
  if (change.kind === "create") {
    const parentPath = pathParent(change.path);
    const name = change.path.slice(parentPath.length + 1);
    const stableId = identity("creator_created");
    return {
      planChangeId: change.id,
      operationId,
      kind: "create",
      path: change.path,
      target: {
        kind: "instance",
        identity: { kind: "forge_attribute", stableId },
        path: change.path,
        className: change.className,
      },
      parent: change.parent,
      name,
      className: change.className,
      tempId: identity("creator_temp"),
      propertyPolicy: policyFor(change.className),
    };
  }
  const sourcePath = change.target.path;
  const instance = observation.instances.find(
    (entry) =>
      entry.objectId === studioObjectIdentityKey(change.target.identity) &&
      entry.path === sourcePath &&
      entry.className === change.target.className,
  );
  if (!instance)
    throw new Error(`Approved plan target is absent from the initial snapshot: ${sourcePath}`);
  if (change.kind === "update")
    return {
      planChangeId: change.id,
      operationId,
      kind: "update",
      target: change.target,
      ...identityEnrollment(change.target, identity("creator_enrollment")),
      beforeHash: contentHash(stableJson(instance)),
      propertyPolicy: policyFor(change.expectedClass),
    };
  if (change.kind === "move") {
    const parentPath = pathParent(change.toPath);
    return {
      planChangeId: change.id,
      operationId,
      kind: "move",
      target: change.target,
      ...identityEnrollment(change.target, identity("creator_enrollment")),
      beforeHash: contentHash(stableJson(instance)),
      parent: change.parent,
      name: change.toPath.slice(parentPath.length + 1),
      propertyPolicy: policyFor(change.expectedClass),
    };
  }
  if (change.kind === "delete")
    return {
      planChangeId: change.id,
      operationId,
      kind: "delete",
      target: change.target,
      ...identityEnrollment(change.target, identity("creator_enrollment")),
      beforeHash: contentHash(stableJson(instance)),
      propertyPolicy: policyFor(change.expectedClass),
    };
  const script = observation.scripts.find(
    (entry) => entry.documentId === instance.objectId && entry.path === change.target.path,
  );
  if (!script)
    throw new Error(
      `Approved source target is absent from the initial snapshot: ${change.target.path}`,
    );
  return {
    planChangeId: change.id,
    operationId,
    kind: "edit_source",
    target: {
      ...change.target,
      className: change.expectedClass,
    },
    ...identityEnrollment(change.target, identity("creator_enrollment")),
    beforeSourceHash: script.sourceHash,
    propertyPolicy: policyFor(change.expectedClass),
  };
}
function identityEnrollment(
  target: StudioInstanceTarget,
  stableId: string,
): { readonly enrollment?: StudioIdentityEnrollment } {
  return target.identity.kind === "studio_ephemeral"
    ? { enrollment: { identity: target.identity, stableId } }
    : {};
}
function contractInspectionPaths(change: CreatorBuildContractChange): string[] {
  if (change.kind === "create")
    return STUDIO_AUTHORING_CONTAINERS.some((entry) => entry.path === change.parent.path)
      ? []
      : [change.parent.path];
  if (change.kind === "move")
    return STUDIO_AUTHORING_CONTAINERS.some((entry) => entry.path === change.parent.path)
      ? [change.target.path]
      : [change.target.path, change.parent.path];
  return [change.target.path];
}
function deriveStudioOperation(
  contractChange: CreatorBuildContractChange,
  payload: CreatorStagePayload,
  sourceIndex: StudioSourceIndex,
  sourceResolver: VerifiedSourceResolver,
  sourceWriteBlob: (source: string) => CreatorSourceWriteBlobBinding,
  sourceWriteText: (binding: CreatorSourceWriteBlobBinding) => string,
): StudioChangeOperation {
  const propertyInputs = payload.properties ?? {};
  let properties: Record<string, StudioValue> = {};
  const attributes = payload.attributes ?? {};
  const removedAttributes = payload.removedAttributes ?? [];
  const expected = {
    contractChange,
    allowedProperties: contractChange.propertyPolicy.allowedProperties,
    source: contractChange.propertyPolicy.source,
    attributes: contractChange.propertyPolicy.attributes,
  };
  const rejectCreativePayload = (message: string): never => {
    throw correctiveFailure("STAGE_PAYLOAD_INVALID", message, {
      received: payload,
      expected,
    });
  };
  if (
    contractChange.kind === "delete" &&
    (Object.keys(propertyInputs).length > 0 ||
      Object.keys(attributes).length > 0 ||
      removedAttributes.length > 0 ||
      payload.source !== undefined ||
      payload.sourceEdits !== undefined)
  )
    rejectCreativePayload("delete has no creative payload");
  if (
    contractChange.kind === "move" &&
    (payload.source !== undefined || payload.sourceEdits !== undefined)
  )
    rejectCreativePayload("move cannot carry source");
  if (
    contractChange.kind === "edit_source" &&
    (Object.keys(propertyInputs).length > 0 ||
      Object.keys(attributes).length > 0 ||
      removedAttributes.length > 0 ||
      payload.source !== undefined)
  )
    rejectCreativePayload("edit_source accepts only sourceEdits");
  if (!["update", "move"].includes(contractChange.kind) && removedAttributes.length > 0)
    rejectCreativePayload("Only an existing-target change may remove attributes");
  if (
    new Set(removedAttributes).size !== removedAttributes.length ||
    removedAttributes.some((name) => Object.hasOwn(attributes, name))
  )
    rejectCreativePayload("Attribute removals must be unique and disjoint from attribute sets");
  if (contractChange.kind === "create" && contractChange.propertyPolicy.source === "required") {
    try {
      assertRequiredStudioSourceText(payload.source);
    } catch {
      throw correctiveFailure(
        "SOURCE_REQUIRED",
        "This approved change requires complete source within the generated source contract",
        { received: payload, expected },
      );
    }
  }
  if (
    contractChange.propertyPolicy.source === "forbidden" &&
    (payload.source !== undefined || payload.sourceEdits !== undefined)
  )
    rejectCreativePayload("This approved change cannot carry source");
  try {
    properties = normalizeCreatorPropertyInputs(contractChange.propertyPolicy, propertyInputs);
    assertPropertiesWithPolicy(contractChange.propertyPolicy, properties);
    assertAttributes(attributes);
  } catch (error) {
    throw correctiveFailure(
      "PROPERTY_NOT_ALLOWED",
      error instanceof Error ? error.message : String(error),
      { received: payload, expected },
    );
  }
  if (contractChange.kind === "create")
    return {
      id: contractChange.operationId,
      planChangeId: contractChange.planChangeId,
      kind: "create",
      tempId: contractChange.tempId,
      target: contractChange.target,
      parent: contractChange.parent,
      className: contractChange.className,
      name: contractChange.name,
      properties,
      attributes: attributes as Record<string, string | number | boolean>,
      ...(payload.source === undefined ? {} : { sourceBlob: sourceWriteBlob(payload.source) }),
    };
  if (contractChange.kind === "update")
    return {
      id: contractChange.operationId,
      planChangeId: contractChange.planChangeId,
      kind: "update",
      target: contractChange.target,
      ...(contractChange.enrollment ? { enrollment: contractChange.enrollment } : {}),
      beforeHash: contractChange.beforeHash,
      properties,
      attributes,
      removedAttributes,
    };
  if (contractChange.kind === "move")
    return {
      id: contractChange.operationId,
      planChangeId: contractChange.planChangeId,
      kind: "move",
      target: contractChange.target,
      ...(contractChange.enrollment ? { enrollment: contractChange.enrollment } : {}),
      beforeHash: contractChange.beforeHash,
      parent: contractChange.parent,
      name: contractChange.name,
      properties,
      attributes,
      removedAttributes,
    };
  if (contractChange.kind === "delete")
    return {
      id: contractChange.operationId,
      planChangeId: contractChange.planChangeId,
      kind: "delete",
      target: contractChange.target,
      ...(contractChange.enrollment ? { enrollment: contractChange.enrollment } : {}),
      beforeHash: contractChange.beforeHash,
    };
  if (contractChange.kind !== "edit_source")
    throw new Error("Unsupported creator build-contract change");
  const document = sourceIndex.documents.find(
    (entry) => entry.documentId === studioObjectIdentityKey(contractChange.target.identity),
  );
  if (!document || document.sourceHash !== contractChange.beforeSourceHash)
    throw correctiveFailure(
      "SOURCE_PRECONDITION_MISMATCH",
      "The approved source body is absent or no longer matches the build contract",
      {
        expectedPath: contractChange.target.path,
        beforeSourceHash: contractChange.beforeSourceHash,
      },
    );
  if (!payload.sourceEdits)
    throw correctiveFailure(
      "SOURCE_EDITS_REQUIRED",
      "edit_source requires one or more sorted UTF-8-safe byte edits",
      { expectedPath: contractChange.target.path },
    );
  const source = sourceResolver.read(document);
  if (contentHash(source) !== document.sourceHash)
    throw new Error("Verified source resolver returned a changed source body");
  const edits = payload.sourceEdits.map((edit) => ({
    startByte: edit.startByte,
    endByte: edit.endByte,
    replacementBlob: sourceWriteBlob(edit.replacement),
  }));
  const patched = applyCreatorSourceEdits(source, edits, sourceWriteText);
  return {
    id: contractChange.operationId,
    planChangeId: contractChange.planChangeId,
    kind: "edit_source",
    target: contractChange.target,
    ...(contractChange.enrollment ? { enrollment: contractChange.enrollment } : {}),
    beforeSourceHash: contractChange.beforeSourceHash,
    edits,
    finalSourceHash: patched.hash,
    finalByteCount: patched.byteCount,
  };
}

export function applyCreatorSourceEdits(
  source: string,
  edits: readonly CreatorSourceEdit[],
  resolveReplacement: (binding: CreatorSourceWriteBlobBinding) => string,
): { source: string; hash: string; byteCount: number } {
  if (edits.length === 0 || edits.length > 1_024)
    throw new Error("Source edits must contain 1-1024 entries");
  const original = Buffer.from(source, "utf8");
  let previousEnd = 0;
  const chunks: Buffer[] = [];
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.startByte) ||
      !Number.isSafeInteger(edit.endByte) ||
      edit.startByte < previousEnd ||
      edit.endByte < edit.startByte ||
      edit.endByte > original.length ||
      !isUtf8Boundary(original, edit.startByte) ||
      !isUtf8Boundary(original, edit.endByte)
    )
      throw new Error("Source edits must be sorted, non-overlapping, in bounds, and UTF-8 aligned");
    chunks.push(original.subarray(previousEnd, edit.startByte));
    const replacement = resolveReplacement(edit.replacementBlob);
    if (
      typeof replacement !== "string" ||
      Buffer.byteLength(replacement, "utf8") !== edit.replacementBlob.utf8Bytes ||
      contentHash(replacement) !== edit.replacementBlob.sourceHash
    )
      throw new Error("Source edit replacement blob does not match its binding");
    chunks.push(Buffer.from(replacement, "utf8"));
    previousEnd = edit.endByte;
  }
  chunks.push(original.subarray(previousEnd));
  const materialized = Buffer.concat(chunks);
  const patchedSource = materialized.toString("utf8");
  assertRequiredStudioSourceText(patchedSource);
  return {
    source: patchedSource,
    hash: contentHash(patchedSource),
    byteCount: materialized.length,
  };
}

/** Reconstruct one verified proposed source body from its immutable leaves. */
export function materializeCreatorSourceWriteBlob(
  capture: CreatorSourceWriteBlobCapture,
  binding: CreatorSourceWriteBlobBinding,
): string {
  assertCreatorSourceWriteBlobBinding(binding);
  assertCreatorSourceWriteBlobCapture(capture, CREATOR_DEFAULT_RESOURCE_POLICY);
  if (
    capture.manifest.id !== binding.manifestId ||
    capture.manifest.hash !== binding.manifestHash ||
    capture.manifest.sourceHash !== binding.sourceHash ||
    capture.manifest.utf8Bytes !== binding.utf8Bytes
  )
    throw new Error("Source-write blob capture does not match its binding");
  return capture.chunks.map((chunk) => chunk.utf8).join("");
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}

function materializeEditedSource(
  operation: Extract<StudioChangeOperation, { kind: "edit_source" }>,
  index: StudioSourceIndex,
  sourceResolver: VerifiedSourceResolver,
  sourceWriteResolver: (binding: CreatorSourceWriteBlobBinding) => string,
): string {
  const document = index.documents.find(
    (entry) => entry.documentId === studioObjectIdentityKey(operation.target.identity),
  );
  if (!document || document.sourceHash !== operation.beforeSourceHash)
    throw new Error("Edited source lost its immutable before-source binding");
  const source = sourceResolver.read(document);
  if (contentHash(source) !== document.sourceHash)
    throw new Error("Verified source resolver returned a changed source body");
  const materialized = applyCreatorSourceEdits(source, operation.edits, sourceWriteResolver);
  if (
    materialized.hash !== operation.finalSourceHash ||
    materialized.byteCount !== operation.finalByteCount
  )
    throw new Error("Edited source final hash or byte count is not reproducible");
  return materialized.source;
}

function normalizeCreatorPropertyInputs(
  policy: CreatorPropertyPolicy,
  properties: Record<string, CreatorPropertyInput>,
): Record<string, StudioValue> {
  const allowed = new Map(policy.allowedProperties.map((property) => [property.name, property]));
  return Object.fromEntries(
    Object.entries(properties).map(([name, input]) => {
      const rule = allowed.get(name);
      if (!rule)
        throw new Error(
          `Property ${name} is not allowlisted; allowed properties: ${[...allowed.keys()].join(", ") || "none"}`,
        );
      const value = normalizeCreatorPropertyInput(name, input, rule);
      if (
        value.kind === "nil"
          ? rule.nullable !== true || value.expectedCodec !== rule.valueKinds[0]
          : !rule.valueKinds.includes(value.kind)
      )
        throw new Error(
          `Property ${name} requires ${rule.valueKinds.join(" or ")}, but its natural JSON shape resolved to ${value.kind}`,
        );
      return [name, value];
    }),
  );
}

/**
 * Canonicalize one model-facing property value through the current generated
 * authoring policy. This is useful to preflight tooling and keeps the model
 * JSON vocabulary on the same codec path as staged creator changes.
 */
export function canonicalizeCreatorPropertyInput(input: {
  className: StudioWritableClass;
  propertyName: string;
  value: CreatorPropertyInput;
}): StudioValue {
  const policy = creatorPropertyPolicies()[input.className];
  const rule = policy.allowedProperties.find((candidate) => candidate.name === input.propertyName);
  const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find(
    (candidate) => candidate.name === input.className,
  );
  const property = manifestClass?.properties.find(
    (candidate) => candidate.name === input.propertyName,
  );
  if (rule === undefined || property === undefined)
    throw new Error(
      `Property ${input.className}.${input.propertyName} is outside the current proof-closed authoring manifest`,
    );
  const value = normalizeCreatorPropertyInput(input.propertyName, input.value, rule);
  assertStudioValueConstraints(input.propertyName, value, rule.constraints);
  assertStudioValueForProperty(value, property);
  return value;
}

function normalizeCreatorPropertyInput(
  name: string,
  input: CreatorPropertyInput,
  rule: CreatorPropertyPolicy["allowedProperties"][number],
): StudioValue {
  const expectedKind = rule.valueKinds[0]!;
  if (input === null) {
    if (expectedKind === "instance_ref") {
      const expectedClass = rule.constraints?.referenceClass;
      if (expectedClass === undefined)
        throw new Error(`Property ${name} has no manifest Instance reference constraint`);
      return canonicalStudioValue({
        kind: expectedKind,
        state: "nil",
        expectedClass,
      });
    }
    if (rule.nullable !== true)
      throw new Error(`Property ${name} does not declare a nullable value domain`);
    return canonicalStudioValue({ kind: "nil", expectedCodec: expectedKind });
  }
  if (typeof input === "boolean" && expectedKind === "boolean")
    return { kind: "boolean", value: input };
  if (typeof input === "number") {
    if (expectedKind === "number_f32")
      return canonicalStudioValue({ kind: expectedKind, value: input });
    if (expectedKind === "number_f64")
      return canonicalStudioValue({ kind: expectedKind, value: input });
    if (expectedKind === "int32") return canonicalStudioValue({ kind: expectedKind, value: input });
  }
  if (typeof input === "string") {
    if (expectedKind === "enum_name") return { kind: expectedKind, value: input };
    if (expectedKind === "string_utf8" || expectedKind === "content")
      return { kind: expectedKind, value: input };
    if (expectedKind === "int64_decimal") return { kind: expectedKind, value: input };
    if (expectedKind === "brick_color") return { kind: expectedKind, name: input };
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "position" in input &&
    expectedKind === "cframe_f32x12"
  ) {
    const degrees = input.rotation;
    const x = (degrees.x * Math.PI) / 180;
    const y = (degrees.y * Math.PI) / 180;
    const z = (degrees.z * Math.PI) / 180;
    const cx = Math.cos(x);
    const sx = Math.sin(x);
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cz = Math.cos(z);
    const sz = Math.sin(z);
    const clean = (value: number): number => studioFloat(Math.abs(value) < 1e-12 ? 0 : value);
    return {
      kind: "cframe_f32x12",
      components: [
        clean(input.position.x),
        clean(input.position.y),
        clean(input.position.z),
        clean(cz * cy),
        clean(cz * sy * sx - sz * cx),
        clean(cz * sy * cx + sz * sx),
        clean(sz * cy),
        clean(sz * sy * sx + cz * cx),
        clean(sz * sy * cx - cz * sx),
        clean(-sy),
        clean(cy * sx),
        clean(cy * cx),
      ],
    };
  }
  if (typeof input === "object" && input !== null && "r" in input && expectedKind === "color3_rgb8")
    return {
      kind: "color3_rgb8",
      r: studioColorChannel(input.r),
      g: studioColorChannel(input.g),
      b: studioColorChannel(input.b),
    };
  if (
    typeof input === "object" &&
    input !== null &&
    "x" in input &&
    "y" in input &&
    !("z" in input) &&
    typeof input.x === "number" &&
    expectedKind === "vector2_f32"
  )
    return canonicalStudioValue({
      kind: expectedKind,
      x: input.x,
      y: input.y as number,
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "x" in input &&
    "y" in input &&
    "z" in input &&
    typeof input.x === "number" &&
    typeof input.y === "number" &&
    typeof input.z === "number" &&
    expectedKind === "vector3_f32"
  )
    return {
      kind: "vector3_f32",
      x: studioFloat(input.x),
      y: studioFloat(input.y),
      z: studioFloat(input.z),
    };
  if (typeof input === "object" && input !== null && "scale" in input && expectedKind === "udim")
    return canonicalStudioValue({
      kind: expectedKind,
      scale: input.scale,
      offset: input.offset,
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "x" in input &&
    "y" in input &&
    typeof input.x === "object" &&
    input.x !== null &&
    typeof input.y === "object" &&
    input.y !== null &&
    expectedKind === "udim2"
  )
    return canonicalStudioValue({ kind: expectedKind, x: input.x, y: input.y });
  if (
    typeof input === "object" &&
    input !== null &&
    "min" in input &&
    "max" in input &&
    typeof input.min === "object" &&
    input.min !== null &&
    typeof input.max === "object" &&
    input.max !== null &&
    expectedKind === "rect"
  )
    return canonicalStudioValue({
      kind: expectedKind,
      minX: input.min.x,
      minY: input.min.y,
      maxX: input.max.x,
      maxY: input.max.y,
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "min" in input &&
    "max" in input &&
    typeof input.min === "number" &&
    expectedKind === "number_range"
  )
    return canonicalStudioValue({
      kind: expectedKind,
      min: input.min,
      max: input.max as number,
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "keypoints" in input &&
    expectedKind === "number_sequence"
  )
    return canonicalStudioValue({
      kind: expectedKind,
      keypoints: input.keypoints as readonly {
        time: number;
        value: number;
        envelope: number;
      }[],
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "keypoints" in input &&
    expectedKind === "color_sequence"
  )
    return canonicalStudioValue({
      kind: expectedKind,
      keypoints: (
        input.keypoints as readonly {
          time: number;
          color: { r: number; g: number; b: number };
        }[]
      ).map((keypoint) => ({
        time: keypoint.time,
        color: {
          r: studioColorChannel(keypoint.color.r),
          g: studioColorChannel(keypoint.color.g),
          b: studioColorChannel(keypoint.color.b),
        },
      })),
    });
  if (
    typeof input === "object" &&
    input !== null &&
    "name" in input &&
    expectedKind === "brick_color"
  )
    return { kind: expectedKind, name: input.name };
  if (typeof input === "object" && input !== null && "family" in input && expectedKind === "font")
    return canonicalStudioValue({ kind: expectedKind, ...input });
  if (
    typeof input === "object" &&
    input !== null &&
    "density" in input &&
    expectedKind === "physical_properties"
  )
    return canonicalStudioValue({ kind: expectedKind, ...input });
  if (
    typeof input === "object" &&
    input !== null &&
    "x" in input &&
    typeof input.x === "boolean" &&
    expectedKind === "axes"
  )
    return { kind: expectedKind, x: input.x, y: input.y, z: input.z };
  if (typeof input === "object" && input !== null && "top" in input && expectedKind === "faces")
    return { kind: expectedKind, ...input };
  if (typeof input === "object" && input !== null && "origin" in input && expectedKind === "ray")
    return canonicalStudioValue({ kind: expectedKind, ...input });
  if (
    typeof input === "object" &&
    input !== null &&
    "identity" in input &&
    expectedKind === "instance_ref"
  ) {
    const expectedClass = rule.constraints?.referenceClass;
    if (expectedClass === undefined || !isRobloxClassAssignableTo(input.className, expectedClass))
      throw new Error(
        `Property ${name} requires a stable reference assignable to ${expectedClass ?? "its manifest class"}`,
      );
    return canonicalStudioValue({
      kind: expectedKind,
      state: "reference",
      identity: input.identity,
      path: input.path,
      className: input.className,
      expectedClass,
    });
  }
  throw new Error(`Property ${name} has an unsupported natural JSON value`);
}

function studioFloat(value: number): number {
  const canonical = Math.fround(value);
  return Object.is(canonical, -0) ? 0 : canonical;
}

function studioColorChannel(value: number): number {
  return Math.round(value * 255);
}
function assertOperationMatchesPlan(
  operation: StudioChangeOperation,
  changes: CreatorPlanChange[],
): void {
  const change = changes.find((entry) => entry.id === operation.planChangeId);
  if (!change || change.kind !== operation.kind)
    throw new Error(
      `Studio operation is not bound to an approved plan change: ${operation.planChangeId}`,
    );
  if (operation.kind === "create") {
    if (
      change.kind !== "create" ||
      change.path !== operation.target.path ||
      stableJson(change.parent) !== stableJson(operation.parent) ||
      change.className !== operation.className
    )
      throw new Error("Create operation does not match its approved path and class");
    if (
      isScriptClass(operation.className) &&
      (change.initialization !== "inline_source_required" || operation.sourceBlob === undefined)
    )
      throw new Error(
        "Approved script creation requires complete inline source in its one create operation",
      );
    if (
      !isScriptClass(operation.className) &&
      (change.initialization !== "initial_properties" || operation.sourceBlob !== undefined)
    )
      throw new Error(
        "Approved non-script creation requires initial properties and cannot carry source",
      );
  }
  if (
    operation.kind === "update" &&
    (change.kind !== "update" ||
      stableJson(change.target) !== stableJson(operation.target) ||
      change.expectedClass !== operation.target.className)
  )
    throw new Error("Update operation does not match its approved target");
  if (
    operation.kind === "move" &&
    (change.kind !== "move" ||
      stableJson(change.target) !== stableJson(operation.target) ||
      change.toPath !== `${operation.parent.path}/${operation.name}` ||
      stableJson(change.parent) !== stableJson(operation.parent) ||
      change.expectedClass !== operation.target.className)
  )
    throw new Error("Move operation does not match its approved source, destination, and class");
  if (
    operation.kind === "delete" &&
    (change.kind !== "delete" ||
      stableJson(change.target) !== stableJson(operation.target) ||
      change.expectedClass !== operation.target.className)
  )
    throw new Error("Delete operation does not match its approved target");
  if (
    operation.kind === "edit_source" &&
    (change.kind !== "edit_source" ||
      stableJson(change.target) !== stableJson(operation.target) ||
      change.expectedClass !== operation.target.className)
  )
    throw new Error("Source operation does not match its approved target");
}
function assertOperationsMatchPlan(
  operations: StudioChangeOperation[],
  changes: CreatorPlanChange[],
): void {
  if (operations.length !== changes.length)
    throw new Error("Creator change set must implement every approved plan change exactly once");
  const bindings = operations.map((operation) => operation.planChangeId);
  if (
    new Set(bindings).size !== bindings.length ||
    stableJson([...bindings].sort()) !== stableJson(changes.map((change) => change.id).sort())
  )
    throw new Error("Creator change set plan-change coverage is incomplete or duplicated");
  operations.forEach((operation) => assertOperationMatchesPlan(operation, changes));
}
function assertOperationsMatchContract(
  operations: StudioChangeOperation[],
  contract: CreatorBuildContract,
): void {
  if (operations.length !== contract.changes.length)
    throw new Error("Creator change set must implement every build-contract change exactly once");
  for (const operation of operations) {
    const change = contract.changes.find((entry) => entry.planChangeId === operation.planChangeId);
    if (!change || change.operationId !== operation.id || change.kind !== operation.kind)
      throw new Error("Creator change set operation is not derived from its build contract");
    if (
      operation.kind === "create" &&
      (change.kind !== "create" ||
        operation.tempId !== change.tempId ||
        stableJson(operation.target) !== stableJson(change.target) ||
        stableJson(operation.parent) !== stableJson(change.parent) ||
        operation.name !== change.name ||
        operation.className !== change.className)
    )
      throw new Error("Creator create operation does not match its build contract");
    if (
      operation.kind === "update" &&
      (change.kind !== "update" ||
        stableJson(operation.target) !== stableJson(change.target) ||
        stableJson(operation.enrollment) !== stableJson(change.enrollment) ||
        operation.beforeHash !== change.beforeHash)
    )
      throw new Error("Creator update operation does not match its build contract");
    if (
      operation.kind === "move" &&
      (change.kind !== "move" ||
        stableJson(operation.target) !== stableJson(change.target) ||
        stableJson(operation.enrollment) !== stableJson(change.enrollment) ||
        operation.beforeHash !== change.beforeHash ||
        stableJson(operation.parent) !== stableJson(change.parent) ||
        operation.name !== change.name)
    )
      throw new Error("Creator move operation does not match its build contract");
    if (
      operation.kind === "delete" &&
      (change.kind !== "delete" ||
        stableJson(operation.target) !== stableJson(change.target) ||
        stableJson(operation.enrollment) !== stableJson(change.enrollment) ||
        operation.beforeHash !== change.beforeHash)
    )
      throw new Error("Creator delete operation does not match its build contract");
    if (
      operation.kind === "edit_source" &&
      (change.kind !== "edit_source" ||
        stableJson(operation.target) !== stableJson(change.target) ||
        stableJson(operation.enrollment) !== stableJson(change.enrollment) ||
        operation.beforeSourceHash !== change.beforeSourceHash)
    )
      throw new Error("Creator source operation does not match its build contract");
    assertOperationCreativePayload(operation, change.propertyPolicy);
  }
}
function assertOperationCreativePayload(
  operation: StudioChangeOperation,
  policy: CreatorPropertyPolicy,
): void {
  const properties =
    operation.kind === "create" || operation.kind === "update" || operation.kind === "move"
      ? operation.properties
      : {};
  const attributes =
    operation.kind === "create" || operation.kind === "update" || operation.kind === "move"
      ? operation.attributes
      : {};
  const removedAttributes =
    operation.kind === "update" || operation.kind === "move" ? operation.removedAttributes : [];
  assertPropertiesWithPolicy(policy, properties);
  assertAttributes(attributes);
  assertRemovedAttributes(removedAttributes);
  if (removedAttributes.some((name) => Object.hasOwn(attributes, name)))
    throw new Error("Operation attributes cannot be both set and removed");
  const source = operation.kind === "create" ? operation.sourceBlob : undefined;
  if (operation.kind === "edit_source") {
    if (policy.source !== "required")
      throw new Error("Source edits are forbidden by their build contract");
    assertCreatorSourceEditsMetadata(operation.edits);
  } else if (policy.source === "required") assertRequiredSource(source);
  else if (source !== undefined)
    throw new Error("Operation source is forbidden by its build contract");
}
function assertStudioChangeOperation(
  operation: StudioChangeOperation,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
  mutationAuthority: ProjectWriteAuthority,
  transactionOperations: readonly StudioChangeOperation[],
): void {
  CHANGE_OPERATION_SCHEMA.parse(operation);
  if (mutationAuthority === "rojo_source") {
    assertRojoSourceChangeOperation(operation, observation, ownership);
    return;
  }
  if (operation.kind === "create") {
    const parent = assertExactPlanParent(operation.parent, operation.parent.path, observation);
    assertStudioStructuralParent(operation.parent, parent, ownership, {
      operationId: operation.id,
      operationKind: operation.kind,
      targetPath: operation.target.path,
    });
    if (
      operation.target.identity.kind !== "forge_attribute" ||
      pathName(canonicalStudioPath(operation.target.path)) !== operation.name ||
      operation.target.className !== operation.className
    )
      throw new Error("Creator create target identity or structure is invalid");
    if (isScriptClass(operation.className) !== (operation.sourceBlob !== undefined))
      throw new Error("Created scripts require source and non-scripts cannot carry source");
    if (isScriptClass(operation.className)) assertRequiredSource(operation.sourceBlob);
    assertProperties(operation.className, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
      transactionOperations,
    );
    assertAttributes(operation.attributes);
    return;
  }
  const targetObjectId = studioObjectIdentityKey(operation.target.identity);
  const observed = observation.instances.find((entry) => entry.objectId === targetObjectId);
  const owner = ownership.entries.find((entry) => entry.objectId === targetObjectId);
  if (!observed || !owner || owner.owner !== "studio_document")
    throw new Error("Studio operation target is absent or not Studio-document-owned");
  if (observed.path !== operation.target.path || observed.className !== operation.target.className)
    throw new Error("Studio operation target precondition mismatch");
  assertOperationEnrollment(operation.target, operation.enrollment);
  if (operation.kind === "edit_source") {
    const script = observation.scripts.find((entry) => entry.documentId === targetObjectId);
    if (!script || script.sourceHash !== operation.beforeSourceHash)
      throw new Error("Studio script source precondition mismatch");
    assertCreatorSourceEditsMetadata(operation.edits);
    if (
      !isHash(operation.finalSourceHash) ||
      !Number.isSafeInteger(operation.finalByteCount) ||
      operation.finalByteCount < 1
    )
      throw new Error("Studio source edit final binding metadata is invalid");
    return;
  }
  if (contentHash(stableJson(observed)) !== operation.beforeHash)
    throw new Error("Studio instance precondition hash mismatch");
  if (operation.kind === "update") {
    assertProperties(operation.target.className as StudioWritableClass, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
      transactionOperations,
    );
    assertAttributes(operation.attributes);
    assertRemovedAttributes(operation.removedAttributes);
    if (operation.removedAttributes.some((name) => Object.hasOwn(operation.attributes, name)))
      throw new Error("Updated attributes cannot be both set and removed");
  }
  if (operation.kind === "move") {
    const parent = assertExactPlanParent(operation.parent, operation.parent.path, observation);
    assertStudioStructuralParent(operation.parent, parent, ownership, {
      operationId: operation.id,
      operationKind: operation.kind,
      targetPath: `${operation.parent.path}/${operation.name}`,
    });
    assertProperties(operation.target.className as StudioWritableClass, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
      transactionOperations,
    );
    assertAttributes(operation.attributes);
    assertRemovedAttributes(operation.removedAttributes);
    if (operation.removedAttributes.some((name) => Object.hasOwn(operation.attributes, name)))
      throw new Error("Updated attributes cannot be both set and removed");
  }
}

function assertRojoSourceChangeOperation(
  operation: StudioChangeOperation,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
): void {
  if (operation.kind === "create") {
    if (
      !isScriptClass(operation.className) ||
      operation.sourceBlob === undefined ||
      Object.keys(operation.properties).length !== 0 ||
      Object.keys(operation.attributes).length !== 0
    )
      throw new Error("Rojo source authority permits a create only for a source-only script");
    assertRequiredSource(operation.sourceBlob);
    const parent = assertExactPlanParent(operation.parent, operation.parent.path, observation);
    if (hasIndexedChildNameCollision(observation, parent, operation.name))
      throw new Error("Rojo source create target already exists");
    const owner = parent && ownership.entries.find((entry) => entry.objectId === parent.objectId);
    if (!parent || owner?.owner !== "rojo_source")
      throw new Error("Rojo source create parent is absent or outside source authority");
    return;
  }
  if (operation.kind !== "edit_source")
    throw new Error(
      "Rojo source authority permits only edit_source and source-script create operations",
    );
  const targetObjectId = studioObjectIdentityKey(operation.target.identity);
  const observed = observation.instances.find((entry) => entry.objectId === targetObjectId);
  const owner = ownership.entries.find((entry) => entry.objectId === targetObjectId);
  if (
    !observed ||
    !owner ||
    owner.owner !== "rojo_source" ||
    observed.path !== operation.target.path ||
    observed.className !== operation.target.className
  )
    throw new Error("Rojo source operation target precondition mismatch");
  const script = observation.scripts.find((entry) => entry.documentId === targetObjectId);
  if (!script || script.sourceHash !== operation.beforeSourceHash)
    throw new Error("Rojo source script precondition mismatch");
  assertCreatorSourceEditsMetadata(operation.edits);
  if (
    !isHash(operation.finalSourceHash) ||
    !Number.isSafeInteger(operation.finalByteCount) ||
    operation.finalByteCount < 1
  )
    throw new Error("Rojo source edit final binding metadata is invalid");
}
function assertInstanceReferenceProperties(
  properties: Record<string, StudioValue>,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
  transactionOperations: readonly StudioChangeOperation[],
): void {
  for (const [propertyName, value] of Object.entries(properties)) {
    if (value.kind !== "instance_ref") continue;
    if (value.state === "nil") continue;
    const observed = observation.instances.find(
      (entry) => entry.objectId === studioObjectIdentityKey(value.identity),
    );
    const owner = ownership.entries.find(
      (entry) => entry.objectId === studioObjectIdentityKey(value.identity),
    );
    const created = transactionOperations.find(
      (operation) =>
        operation.kind === "create" &&
        studioObjectIdentityKey(operation.target.identity) ===
          studioObjectIdentityKey(value.identity) &&
        operation.target.path === value.path &&
        operation.target.className === value.className,
    );
    if (
      (created === undefined &&
        (observed === undefined ||
          owner?.owner !== "studio_document" ||
          observed.path !== value.path ||
          observed.className !== value.className)) ||
      !isRobloxClassAssignableTo(value.className, value.expectedClass)
    )
      throw new Error(
        `Property ${propertyName} requires an exact stable Studio-owned instance reference`,
      );
  }
}
function assertOperationEnrollment(
  target: StudioInstanceTarget,
  enrollment: StudioIdentityEnrollment | undefined,
): void {
  if (target.identity.kind === "studio_ephemeral") {
    if (
      !enrollment ||
      studioObjectIdentityKey(enrollment.identity) !== studioObjectIdentityKey(target.identity)
    )
      throw new Error("An ephemeral Studio target requires exact approved identity enrollment");
    return;
  }
  if (enrollment !== undefined)
    throw new Error("Only an ephemeral Studio target may carry identity enrollment");
}
function assertProperties(
  className: StudioWritableClass,
  properties: Record<string, StudioValue>,
): void {
  assertPropertiesWithPolicy(creatorPropertyPolicies()[className], properties);
  const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find(
    (entry) => entry.name === className,
  );
  if (!manifestClass)
    throw new Error(`Class ${className} is outside the Studio capability manifest`);
  for (const [name, value] of Object.entries(properties)) {
    const property = manifestClass.properties.find((entry) => entry.name === name);
    if (!property)
      throw new Error(`Property ${className}.${name} is outside the Studio capability manifest`);
    assertStudioValueForProperty(value, property);
  }
}
function assertPropertiesWithPolicy(
  policy: CreatorPropertyPolicy,
  properties: Record<string, StudioValue>,
): void {
  const allowed = new Map(policy.allowedProperties.map((property) => [property.name, property]));
  for (const [name, value] of Object.entries(properties)) {
    const rule = allowed.get(name);
    if (!rule)
      throw new Error(
        `Property ${name} is not allowlisted; allowed properties: ${[...allowed.keys()].join(", ") || "none"}`,
      );
    if (
      value.kind === "nil"
        ? rule.nullable !== true || value.expectedCodec !== rule.valueKinds[0]
        : !rule.valueKinds.includes(value.kind)
    )
      throw new Error(`Property ${name} requires a typed ${rule.valueKinds.join(" or ")} value`);
    assertStudioValueConstraints(name, value, rule.constraints);
  }
}
function assertStudioValueConstraints(
  name: string,
  value: StudioValue,
  constraints?: CreatorPropertyConstraints,
): void {
  assertStudioValue(value);
  if (value.kind === "color3_rgb8")
    for (const channel of [value.r, value.g, value.b])
      if (!Number.isInteger(channel) || channel < 0 || channel > 255)
        throw new Error(`Property ${name} requires canonical 8-bit Studio color channels`);
  if (!constraints) return;
  const scalars =
    value.kind === "number_f32"
      ? [value.value]
      : value.kind === "vector3_f32"
        ? [value.x, value.y, value.z]
        : [];
  for (const scalar of scalars) {
    if (!Number.isFinite(scalar))
      throw new Error(`Property ${name} requires finite numeric values`);
    if (constraints.minimum !== undefined && scalar < constraints.minimum)
      throw new Error(`Property ${name} is below its minimum ${constraints.minimum}`);
    if (constraints.maximum !== undefined && scalar > constraints.maximum)
      throw new Error(`Property ${name} exceeds its maximum ${constraints.maximum}`);
    if (constraints.minimumExclusive !== undefined && scalar <= constraints.minimumExclusive)
      throw new Error(`Property ${name} must be greater than ${constraints.minimumExclusive}`);
    if (constraints.maximumAbsolute !== undefined && Math.abs(scalar) > constraints.maximumAbsolute)
      throw new Error(`Property ${name} exceeds its absolute bound ${constraints.maximumAbsolute}`);
  }
  if (value.kind === "string_utf8" || value.kind === "enum_name") {
    if (
      constraints.maximumUtf8Bytes !== undefined &&
      Buffer.byteLength(value.value, "utf8") > constraints.maximumUtf8Bytes
    )
      throw new Error(`Property ${name} exceeds its UTF-8 byte bound`);
    if (
      constraints.minimumUtf8Bytes !== undefined &&
      Buffer.byteLength(value.value, "utf8") < constraints.minimumUtf8Bytes
    )
      throw new Error(`Property ${name} is below its UTF-8 byte minimum`);
    if (constraints.allowedStrings && !constraints.allowedStrings.includes(value.value))
      throw new Error(`Property ${name} must be one of: ${constraints.allowedStrings.join(", ")}`);
  }
  if (value.kind === "cframe_f32x12") {
    value.components.forEach((component, index) => {
      if (!Number.isFinite(component))
        throw new Error(`Property ${name} requires finite CFrame components`);
      const maximum =
        index < 3
          ? constraints.cframeTranslationMaximumAbsolute
          : constraints.cframeRotationMaximumAbsolute;
      if (maximum !== undefined && Math.abs(component) > maximum)
        throw new Error(`Property ${name} CFrame component exceeds its bound`);
    });
  }
}
function assertAttributes(attributes: Record<string, string | number | boolean>): void {
  if (Object.keys(attributes).length > 64)
    throw new Error("Attribute update exceeds the 64-entry bound");
  for (const [name, value] of Object.entries(attributes)) {
    if (
      name.startsWith("_forge") ||
      name.trim().length === 0 ||
      Buffer.byteLength(name, "utf8") > 100
    )
      throw new Error(`Reserved or invalid attribute ${name}`);
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 4096)
      throw new Error(`Attribute ${name} exceeds the UTF-8 byte bound`);
  }
}
function assertRemovedAttributes(attributes: string[]): void {
  if (attributes.length > 64 || new Set(attributes).size !== attributes.length)
    throw new Error("Removed attributes must be unique and bounded");
  assertAttributes(Object.fromEntries(attributes.map((name) => [name, false])));
}
function assertRequiredSource(source: unknown): asserts source is CreatorSourceWriteBlobBinding {
  try {
    assertCreatorSourceWriteBlobBinding(source);
  } catch {
    throw new Error("Required script source must bind one valid immutable source-write blob");
  }
  if (source.utf8Bytes === 0)
    throw new Error("Required script source cannot bind an empty source-write blob");
}

function assertCreatorSourceEditsMetadata(edits: readonly CreatorSourceEdit[]): void {
  if (edits.length === 0 || edits.length > 1_024)
    throw new Error("Source edits must contain 1-1024 entries");
  let previousEnd = 0;
  for (const edit of edits) {
    if (
      !isRecord(edit) ||
      !Number.isSafeInteger(edit.startByte) ||
      !Number.isSafeInteger(edit.endByte) ||
      edit.startByte < previousEnd ||
      edit.endByte < edit.startByte
    )
      throw new Error("Source edits must be sorted, non-overlapping byte ranges");
    assertCreatorSourceWriteBlobBinding(edit.replacementBlob);
    previousEnd = edit.endByte;
  }
}
function isAllowedStudioPath(path: string): boolean {
  return STUDIO_AUTHORING_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}
function canonicalParentPath(value: string): string {
  const path = canonicalStudioPath(value);
  if (!isAllowedStudioPath(path))
    throw new Error(`Studio parent root is not allowlisted: ${value}`);
  return path;
}
function assertExactPlanParent(
  parent: StudioMutationParent,
  expectedPath: string,
  observation: CreatorProjectIndexView,
): CreatorProjectIndexView["instances"][number] {
  const path = canonicalParentPath(expectedPath);
  if (parent.path !== path)
    throw new Error("Planned parent display path does not match its destination");
  if (parent.kind === "engine_container") {
    const candidates = observation.instances.filter(
      (entry) =>
        entry.engineContainer?.path === path &&
        entry.engineContainer.className === parent.className,
    );
    if (candidates.length !== 1)
      throw new Error("Planned engine parent is not a manifest-declared authoring container");
    return candidates[0]!;
  }
  const observed = observation.instances.find(
    (entry) =>
      entry.objectId === studioObjectIdentityKey(parent.identity) &&
      entry.path === parent.path &&
      entry.className === parent.className,
  );
  if (!observed) throw new Error("Planned parent identity is absent or stale in the project index");
  return observed;
}
function assertStudioStructuralParent(
  parent: StudioMutationParent,
  indexedParent: CreatorProjectIndexView["instances"][number],
  ownership: StudioOwnershipMap,
  context: {
    operationId: string;
    operationKind: "create" | "move";
    targetPath: string;
  },
): void {
  if (parent.kind === "engine_container") return;
  const authority = ownership.entries.find((entry) => entry.objectId === indexedParent.objectId);
  if (authority?.owner !== "studio_document")
    throw new CreatorValidationFailure(
      "PLAN_PARENT_UNAVAILABLE",
      `Studio operation parent ${parent.path} for ${context.targetPath} is neither a manifest-declared engine-owned authoring container nor an exact Studio-document-owned initial-index structural anchor`,
      {
        ...context,
        parentPath: parent.path,
        observedParent: {
          objectIdentity: indexedParent.identity,
          className: indexedParent.className,
          owner: authority?.owner ?? null,
        },
      },
    );
}
function hasIndexedChildNameCollision(
  observation: CreatorProjectIndexView,
  parent: CreatorProjectIndexView["instances"][number],
  name: string,
  exceptObjectId?: string,
): boolean {
  return observation.instances.some(
    (entry) =>
      entry.objectId !== exceptObjectId &&
      entry.name === name &&
      entry.parentIdentity !== undefined &&
      studioObjectIdentityKey(entry.parentIdentity) === parent.objectId,
  );
}
function isScriptClass(value: StudioWritableClass): value is StudioScriptClass {
  return value === "Script" || value === "LocalScript" || value === "ModuleScript";
}
function isTransactionControlActionDescriptor(
  value: unknown,
): value is CreatorTransactionControlActionDescriptor {
  return (
    isRecord(value) &&
    [
      "transaction_approve_plan",
      "transaction_reject_plan",
      "transaction_approve_and_apply_changes",
      "transaction_reject_changes",
      "transaction_accept_result",
      "transaction_reject_and_rollback",
      "transaction_cancel_changes",
      "transaction_retry_play_verification",
      "transaction_refresh_project",
      "transaction_check_source_sync",
      "transaction_revert_source_changes",
      "transaction_cancel_interrupted_recording",
    ].includes(String(value.id)) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    (value.intent === "primary" || value.intent === "secondary") &&
    (value.requiresReport === undefined || value.requiresReport === true)
  );
}
function isCreatorEvidencePresentation(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["creator_planner", "creator_builder"].includes(String(value.phase)) &&
    isId(value.agentRunId) &&
    isId(value.traceId) &&
    isId(value.traceBuildKey) &&
    validArtifactReference(value.agentRun) &&
    validArtifactReference(value.trace)
  );
}
function validArtifactReference(value: unknown): value is ArtifactReference {
  try {
    assertArtifactReference(value);
    return true;
  } catch {
    return false;
  }
}
function assertTransition(from: CreatorSessionStatus, to: CreatorSessionStatus): void {
  const allowed: Record<CreatorSessionStatus, CreatorSessionStatus[]> = {
    indexing: ["planning", "refresh_required", "incomplete"],
    planning: [
      "awaiting_clarification",
      "awaiting_plan_approval",
      "answered",
      "refresh_required",
      "incomplete",
    ],
    awaiting_clarification: ["refining_plan", "refresh_required", "incomplete"],
    refining_plan: [
      "awaiting_clarification",
      "awaiting_plan_approval",
      "answered",
      "refresh_required",
      "superseded",
      "incomplete",
    ],
    awaiting_plan_approval: [
      "refining_plan",
      "building",
      "refresh_required",
      "creator_rejected",
      "incomplete",
    ],
    building: ["awaiting_change_approval", "refresh_required", "incomplete"],
    awaiting_change_approval: [
      "preflighting",
      "refresh_required",
      "creator_rejected",
      "incomplete",
    ],
    preflighting: ["applying", "refresh_required", "incomplete"],
    applying: [
      "awaiting_verification",
      "awaiting_source_sync",
      "cancelling",
      "incomplete",
      "recovery_required",
    ],
    awaiting_verification: [
      "verifying",
      "creator_rejected",
      "cancelling",
      "incomplete",
      "recovery_required",
    ],
    verifying: [
      "awaiting_verification_retry",
      "committing",
      "cancelling",
      "repairing",
      "incomplete",
      "recovery_required",
    ],
    awaiting_verification_retry: ["awaiting_verification", "cancelling", "recovery_required"],
    cancelling: ["repairing", "creator_rejected", "incomplete", "recovery_required"],
    committing: ["awaiting_review", "recovery_required"],
    repairing: ["awaiting_change_approval", "refresh_required", "incomplete"],
    refresh_required: ["refreshing", "incomplete", "recovery_required"],
    refreshing: [
      "planning",
      "awaiting_plan_approval",
      "building",
      "awaiting_change_approval",
      "repairing",
      "awaiting_review",
      "superseded",
      "refresh_required",
      "incomplete",
    ],
    superseded: [],
    awaiting_source_sync: [
      "awaiting_source_sync",
      "awaiting_review",
      "incomplete",
      "recovery_required",
    ],
    awaiting_review: [
      "refresh_required",
      "awaiting_source_sync",
      "recovery_required",
      "creator_accepted",
      "creator_rejected",
      "rolled_back",
      "incomplete",
    ],
    answered: [],
    creator_accepted: [],
    creator_rejected: ["rolled_back"],
    rolled_back: [],
    incomplete: [],
    recovery_required: ["cancelling", "awaiting_source_sync"],
  };
  if (!allowed[from].includes(to))
    throw new Error(`Invalid CreatorSession transition ${from} -> ${to}`);
}
function isStatus(value: unknown): value is CreatorSessionStatus {
  return (
    typeof value === "string" &&
    [
      "indexing",
      "planning",
      "awaiting_clarification",
      "refining_plan",
      "awaiting_plan_approval",
      "building",
      "awaiting_change_approval",
      "preflighting",
      "applying",
      "awaiting_verification",
      "verifying",
      "awaiting_verification_retry",
      "cancelling",
      "committing",
      "repairing",
      "refresh_required",
      "refreshing",
      "superseded",
      "awaiting_source_sync",
      "awaiting_review",
      "answered",
      "creator_accepted",
      "creator_rejected",
      "rolled_back",
      "incomplete",
      "recovery_required",
    ].includes(value)
  );
}
function assertHash(value: string, label: string): void {
  if (!isHash(value)) throw new Error(`${label} hash is invalid`);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIndexedEngineContainer(
  value: unknown,
): value is { readonly path: string; readonly className: string } {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.className === "string" &&
    STUDIO_AUTHORING_CONTAINERS.some(
      (container) => container.path === value.path && container.className === value.className,
    )
  );
}
function assertCreatorProjectIndexView(value: unknown): asserts value is CreatorProjectIndexView {
  if (
    !isRecord(value) ||
    !isRecord(value.project) ||
    !isRecord(value.revision) ||
    !isHash(value.revision.hash) ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.scripts) ||
    !value.instances.every(
      (entry) =>
        isRecord(entry) &&
        isId(entry.objectId) &&
        typeof entry.path === "string" &&
        typeof entry.name === "string" &&
        isStudioInstanceName(entry.name) &&
        STUDIO_OBJECT_IDENTITY_SCHEMA.safeParse(entry.identity).success &&
        (entry.parentIdentity === undefined ||
          STUDIO_OBJECT_IDENTITY_SCHEMA.safeParse(entry.parentIdentity).success) &&
        (entry.engineContainer === undefined || isIndexedEngineContainer(entry.engineContainer)) &&
        isId(entry.className) &&
        isRecord(entry.properties) &&
        isRecord(entry.attributes) &&
        Array.isArray(entry.tags),
    ) ||
    !value.scripts.every(
      (entry) =>
        isRecord(entry) &&
        isId(entry.documentId) &&
        typeof entry.path === "string" &&
        isId(entry.className) &&
        isHash(entry.sourceHash) &&
        Number.isSafeInteger(entry.utf8Bytes) &&
        Number(entry.utf8Bytes) >= 0,
    )
  )
    throw new Error("Invalid creator project-index view");
  const instanceIds = new Set(value.instances.map((entry) => entry.objectId));
  if (
    value.instances.some(
      (entry) =>
        (entry.parentIdentity !== undefined &&
          (!instanceIds.has(studioObjectIdentityKey(entry.parentIdentity)) ||
            entry.objectId === studioObjectIdentityKey(entry.parentIdentity))) ||
        (entry.engineContainer !== undefined &&
          entry.className !== entry.engineContainer.className),
    ) ||
    new Set(
      value.instances.flatMap((entry) =>
        entry.engineContainer === undefined
          ? []
          : [`${entry.engineContainer.path}\u0000${entry.engineContainer.className}`],
      ),
    ).size !== value.instances.filter((entry) => entry.engineContainer !== undefined).length
  )
    throw new Error("Invalid creator project-index hierarchy metadata");
}
class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class CreatorValidationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}
function correctiveFailure(code: string, message: string, details: unknown): ToolFailure {
  return new ToolFailure(code, stableJson({ message, details }));
}

export const CREATOR_PLANNER_SYSTEM_PROMPT = `You are Forge's project-aware conversational agent. The orientation is deliberately bounded: explore exact current project facts with project.search, project.children, and project.inspect, and explore hash-verified Luau with source.search, source.read, source.symbols, source.references, and source.dependencies. Tool facts include host-issued citation handles. You must publish exactly one outcome: creator.answer for a read-only answer, creator.request_clarification for one material blocking question, or creator.propose_plan for reviewed Studio work. Cite only handles issued during this AgentRun; uncited prose remains agent interpretation. Use studio.api_lookup to ground Roblox APIs. Project facts are current-index evidence; source results are static analysis, never runtime proof. Before selecting an existing source target, inspect its source and dependency closure. Before declaring an initial-index path as a builder dependency, inspect its opaque object identity with project.inspect. Forge derives the immutable goal. Every plan step binds exact changeIds and covers every change once. Script creation carries complete initial source; edit_source targets only an existing consulted script and requires luau_syntax. Every create or move parent must be a manifest-declared authoring container or an exact Studio-document-owned structural anchor in the initial index; that does not authorize changing the parent itself. Supply only typed machine-check fields; put client-only output, visual quality, causal attribution, and unsupported gameplay judgments in creator_review. Do not stage changes or invent hidden criteria.`;
export const CREATOR_BUILDER_SYSTEM_PROMPT =
  "You are Forge's bounded Studio builder. The immutable CreatorBuildContract fixes all structural authority and binds the planner's source consultation. Use source.read only inside that approved closure. For edit_source, stage sorted non-overlapping UTF-8 byte edits against the exact before-source hash; Forge materializes the full candidate, verifies its final hash and byte count, shows the exact diff, and applies it through Studio only after creator approval. New scripts still carry complete source. Use studio.stage only with planChangeId and the allowed creative payload, inspect studio.diff, then run forge.verify. Use studio.api_lookup for API context, never as mutation or behavioral proof. Never execute project source, invent structural fields, access source outside the consultation closure, or claim Studio mutation before approval.";

export function creatorBuilderSystemPrompt(
  plan: CreatorPlan,
  contract: CreatorBuildContract,
  verificationFeedback: readonly string[] = [],
): string {
  assertCreatorPlan(plan);
  assertCreatorBuildContract(contract);
  if (
    contract.planId !== plan.id ||
    contract.planHash !== plan.hash ||
    contract.promptHash !== plan.promptHash
  )
    throw new Error("CreatorBuildContract does not bind the approved CreatorPlan");
  if (
    verificationFeedback.length > 32 ||
    verificationFeedback.some((failure) => failure.trim().length === 0 || failure.length > 4096)
  )
    throw new Error("Creator verification feedback is invalid or exceeds its bound");
  return `${CREATOR_BUILDER_SYSTEM_PROMPT}\n\nApproved CreatorPlan semantics (verbatim):\n${stableJson(plan)}\n\nCanonical CreatorBuildContract (verbatim):\n${stableJson(contract)}${verificationFeedback.length === 0 ? "" : `\n\nForge verification facts from the prior approved attempt follow as canonical data. Repair the implementation without weakening or changing the approved charter:\n${stableJson({ verificationFeedback: [...verificationFeedback] })}`}`;
}
