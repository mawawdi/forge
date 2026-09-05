import { randomUUID } from "node:crypto";
import type { GamePlan } from "../../game-compiler/src/index.js";
import {
  GAME_DESIGN_SPEC_SCHEMA,
  validateGameDesignSpec,
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
} from "../../game-ir/src/index.js";
import {
  assertGamePlan,
  gameBuildPartitionOperations,
  assertGameBuildGraph,
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  verifyGameCheckpointPrefix,
  type GameBuildGraph,
  type GamePartitionBinding,
  type GameCheckpointReceipt,
} from "../../game-compiler/src/index.js";
import { creatorGameCatalog } from "./game-authoring.js";
import { checkGameSourceImports } from "./game-source-checks.js";
import {
  assertGameBuildControlView,
  type GameBuildControlView,
} from "../../creator-conversation/src/game-build-contract.js";
import type {
  HostPhaseRecorder,
  HostPhaseCorrelation,
} from "../../flight-recorder/src/host-phase.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z, type ZodRawShape } from "zod";
import type {
  AgentRun,
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
  assertAgentExecutionSlot,
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
  PinnedSourceAnalysisHost,
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

export const CREATOR_SESSION_POLICY = "compiler_backed_creation" as const;
export const CREATOR_DEFAULT_STORE = ".forge/creator-compiled";
export const CREATOR_MODEL = "openai/gpt-5.6-luna" as const;
export const CREATOR_MAX_REPAIRS = 2;
export const CREATOR_MAX_INSPECTION_PATHS = 64;
export const CREATOR_MAX_PLAN_STEPS = 32;
export const CREATOR_MAX_CHARTER_CLAUSES = 16_384;
export const CREATOR_MAX_COMPILED_CHANGES = 8192;
export const CREATOR_MAX_CHANGES = STUDIO_CAPABILITY_MANIFEST.limits.maximumOperations;

export type StudioWritableClass = (typeof STUDIO_WRITABLE_CLASSES)[number];
export type StudioScriptClass = (typeof STUDIO_SCRIPT_CLASSES)[number];
const STUDIO_CREATABLE_CLASSES = STUDIO_CAPABILITY_MANIFEST.classes
  .filter((classDefinition) => classDefinition.creatable)
  .map((classDefinition) => classDefinition.name) as [
  StudioWritableClass,
  ...StudioWritableClass[],
];
export const STUDIO_NON_SCRIPT_WRITABLE_CLASSES = STUDIO_WRITABLE_CLASSES.filter(
  (className): className is Exclude<StudioWritableClass, StudioScriptClass> =>
    !STUDIO_SCRIPT_CLASSES.includes(className as StudioScriptClass),
);
const STUDIO_NON_SCRIPT_CREATABLE_CLASSES = STUDIO_CREATABLE_CLASSES.filter(
  (className): className is Exclude<StudioWritableClass, StudioScriptClass> =>
    !STUDIO_SCRIPT_CLASSES.includes(className as StudioScriptClass),
) as [
  Exclude<StudioWritableClass, StudioScriptClass>,
  ...Exclude<StudioWritableClass, StudioScriptClass>[],
];
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
  | "completed"
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
  projectId: string;
  /** Exact compiler inventory and locks accepted with this creator review. */
  compiled: GamePlan;
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
      /** Euler angles in degrees. Omitted means no rotation. */
      rotation?: { x: number; y: number; z: number } | undefined;
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
  | { family: string; weight: string; style: string }
  | {
      density: number;
      friction: number;
      elasticity: number;
      frictionWeight: number;
      elasticityWeight: number;
      acousticAbsorption: number;
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
      objectId: string;
    }
  | {
      /** Reference an object created by another approved change in this build. */
      changeId: string;
    };

type CreatorReferenceResolver = (reference: { objectId: string } | { changeId: string }) => {
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
  partition: GamePartitionBinding;
  checkpointOwnership: StudioOwnershipMap;
  /** Public Markdown authored by the builder, shown after successful application. */
  summary: string;
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
  authority: "creator" | "accepted_plan";
  /** Exact creator decision authorizing automatic execution of this change set. */
  planAuthorization?: { id: string; hash: string };
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
  preparationFailure?: {
    execution: import("../../agent-runtime/src/index.js").AgentExecutionSlot;
    failure: { stage: "preparation" | "source_analysis"; code: string; detail: string };
    diagnostic: ArtifactReference;
  };
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
  gameBuilds?: Array<{
    graph: GameBuildGraph;
    buildContractHash: string;
    summary: string;
    receipts: GameCheckpointReceipt[];
    status: "building" | "awaiting_checkpoint" | "complete" | "incomplete";
  }>;
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
   * capture, or a proved-closed recovery acknowledgement, have been persisted.
   */
  activeMutation?: CreatorActiveMutation;
  /** Closed without a commit/cancel verdict; retained evidence, never live authority. */
  closedMutation?: {
    cursor: CreatorActiveMutation;
    acknowledgement: ArtifactReference;
  };
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
  | "transaction_resume_build"
  | "transaction_approve_plan"
  | "transaction_retry_build"
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
  gameBuild?: GameBuildControlView;
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
  graph?: GameBuildGraph;
  summary?: string;
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
  if (value.gameBuild !== undefined) assertGameBuildControlView(value.gameBuild);
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
    | "projectId"
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
  assertGamePlan(input.compiled);
  if (
    input.compiled.projectId !== ownership.projectId ||
    input.compiled.sessionId !== input.sessionId ||
    input.compiled.observedRevisionHash !== observation.revision.hash ||
    stableJson(input.compiled.inventory.map((item) => item.change)) !== stableJson(input.changes)
  )
    throw new Error("Creator plan must exactly match the compiled inventory and revision");
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
  if (input.changes.length === 0 || input.changes.length > CREATOR_MAX_COMPILED_CHANGES)
    throw new Error(`Creator plan exceeds the compiled operation admission profile`);
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
    projectId: ownership.projectId,
    compiled: input.compiled,
    inspectionPaths,
    steps: input.steps.map((step) => ({
      ...step,
      changeIds: [...step.changeIds],
    })),
    changes: input.changes.map(clonePlanChange),
    charter,
  };
  creatorPlanSummary(payload);
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorPlan",
    id: `creator_plan_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function creatorPlanSummary(plan: Pick<CreatorPlan, "steps" | "charter">): string {
  const sections = [
    plan.steps.map((step, index) => `${index + 1}. ${step.statement}`).join("\n\n"),
  ];
  const review = plan.charter.clauses.filter((clause) => clause.kind === "creator_review");
  if (review.length)
    sections.push(`Your review\n${review.map((clause) => `- ${clause.statement}`).join("\n")}`);
  const summary = sections.join("\n\n");
  if (Buffer.byteLength(summary, "utf8") > 16_384)
    throw new Error(
      "Keep the plan steps and check descriptions within 16,384 UTF-8 bytes so the complete plan can be reviewed in the conversation.",
    );
  return summary;
}

export function createCreatorApproval(
  input: Omit<CreatorApproval, "kind" | "id" | "hash" | "authority" | "planAuthorization">,
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

export function authorizeCreatorPlanExecution(
  planApproval: CreatorApproval,
  changeSet: CreatorChangeSet,
  decidedAt: string,
): CreatorApproval {
  assertCreatorApproval(planApproval);
  assertCreatorChangeSet(changeSet);
  if (
    planApproval.authority !== "creator" ||
    planApproval.artifactKind !== "plan" ||
    planApproval.decision !== "approved" ||
    planApproval.sessionId !== changeSet.sessionId ||
    planApproval.artifactId !== changeSet.planId ||
    planApproval.artifactHash !== changeSet.planHash ||
    planApproval.id !== changeSet.planApprovalId ||
    planApproval.hash !== changeSet.planApprovalHash ||
    changeSet.localGate.status !== "eligible"
  )
    throw new Error(
      "Automatic application requires this change set's exact accepted plan and eligible local gate",
    );
  const payload = {
    sessionId: changeSet.sessionId,
    artifactKind: "change_set" as const,
    artifactId: changeSet.id,
    artifactHash: changeSet.hash,
    decision: "approved" as const,
    decidedAt,
    authority: "accepted_plan" as const,
    planAuthorization: { id: planApproval.id, hash: planApproval.hash },
  };
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
    !(
      (value.authority === "creator" && value.planAuthorization === undefined) ||
      (value.authority === "accepted_plan" &&
        value.artifactKind === "change_set" &&
        value.decision === "approved" &&
        isRecord(value.planAuthorization) &&
        isId(value.planAuthorization.id) &&
        isHash(value.planAuthorization.hash))
    )
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

/** Approval-independent preparation. It grants no provider or Studio authority. */
export function prepareCreatorBuildPlan(
  plan: CreatorPlan,
  projectIndex: CreatorProjectIndexView,
  propertyPolicies: Readonly<Record<string, CreatorPropertyPolicy>> = creatorPropertyPolicies(),
): Pick<CreatorBuildContract, "changes" | "propertyPolicies" | "initialInspectionPaths"> {
  assertCreatorPlan(plan);
  assertCreatorProjectIndexView(projectIndex);
  if (plan.projectRevisionHash !== projectIndex.revision.hash)
    throw new Error("Plan preparation requires its exact project revision");
  const changes = plan.changes.map((change) =>
    materializeBuildContractChange(change, plan, projectIndex, propertyPolicies),
  );
  const prepared = {
    changes,
    propertyPolicies: propertyPolicies as Record<StudioWritableClass, CreatorPropertyPolicy>,
    initialInspectionPaths: [
      ...new Set([
        ...changes
          .flatMap(contractInspectionPaths)
          .filter((path) => projectIndex.instances.some((instance) => instance.path === path)),
        ...plan.inspectionPaths,
      ]),
    ].sort(),
  };
  assertBuildPreparation(prepared);
  return prepared;
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
  assertCreatorSession(input.session);
  assertCreatorApproval(input.planApproval);
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
  const prepared = prepareCreatorBuildPlan(input.plan, input.projectIndex, propertyPolicies);
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
    ...prepared,
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
    value.changes.length > CREATOR_MAX_COMPILED_CHANGES
  )
    throw new Error("Invalid CreatorBuildContract");
  assertBuildPreparation({
    initialInspectionPaths: value.initialInspectionPaths,
    propertyPolicies: value.propertyPolicies,
    changes: value.changes,
  });
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (value.hash !== expected || value.id !== `creator_build_contract_${expected.slice(0, 24)}`)
    throw new Error("Invalid CreatorBuildContract identity");
}

function assertBuildPreparation(value: {
  initialInspectionPaths: unknown[];
  propertyPolicies: Readonly<Record<string, unknown>>;
  changes: unknown[];
}): void {
  const policyKeys = Object.keys(value.propertyPolicies).sort();
  if (
    value.initialInspectionPaths.length > CREATOR_MAX_INSPECTION_PATHS ||
    new Set(value.initialInspectionPaths).size !== value.initialInspectionPaths.length ||
    stableJson([...value.initialInspectionPaths].sort()) !==
      stableJson(value.initialInspectionPaths) ||
    value.initialInspectionPaths.some(
      (path) => typeof path !== "string" || canonicalStudioPath(path) !== path,
    )
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
  assertBuildContractChangePolicies(value.changes, value.propertyPolicies);
}

function assertBuildContractChangePolicies(
  changes: readonly unknown[],
  propertyPolicies: Readonly<Record<string, unknown>>,
): void {
  const changeIds = new Set<string>();
  for (const change of changes) {
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
    const target = STUDIO_WRITABLE_INSTANCE_TARGET_SCHEMA.safeParse(change.target);
    if (!target.success) throw new Error("CreatorBuildContract target is invalid");
    const className = target.data.className;
    if (change.kind === "create" && change.className !== className)
      throw new Error("CreatorBuildContract create class differs from its target");
    if (
      change.kind === "edit_source" &&
      !(STUDIO_SCRIPT_CLASSES as readonly string[]).includes(className)
    )
      throw new Error("CreatorBuildContract source target must be a script");
    const sealedPolicy = propertyPolicies[className];
    if (
      sealedPolicy === undefined ||
      stableJson(change.propertyPolicy) !== stableJson(sealedPolicy)
    )
      throw new Error("CreatorBuildContract change policy is not bound to its sealed class policy");
  }
}

export function createCreatorChangeSet(
  input: Omit<CreatorChangeSet, "kind" | "id" | "hash" | "mutationAuthority">,
  observation: CreatorProjectIndexView,
  ownership: StudioOwnershipMap,
  plan: CreatorPlan,
  contract: CreatorBuildContract,
  graph: GameBuildGraph,
): CreatorChangeSet {
  assertCreatorProjectIndexView(observation);
  assertOwnershipMap(ownership);
  assertCreatorBuildContract(contract);
  if (stableJson(input.checkpointOwnership) !== stableJson(ownership))
    throw new Error("Checkpoint ownership evidence differs from the applied authority map");
  assertGameBuildGraph(graph, plan.compiled);
  assertCreatorGraphPartition(input, graph, plan);
  if (
    input.ownershipMapId !== ownership.id ||
    input.ownershipMapHash !== ownership.hash ||
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
  const operationChanges = new Set(input.operations.map((operation) => operation.planChangeId));
  assertOperationsMatchPlan(
    input.operations,
    plan.changes.filter((change) => operationChanges.has(change.id)),
  );
  assertOperationsMatchContract(input.operations, {
    ...contract,
    changes: contract.changes.filter((change) => operationChanges.has(change.planChangeId)),
  });
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

function assertCreatorGraphPartition(
  input: Pick<
    CreatorChangeSet,
    "partition" | "operations" | "expectedRevisionHash" | "planApprovalHash"
  >,
  graph: GameBuildGraph,
  plan: CreatorPlan,
): void {
  const { hash, ...payload } = input.partition;
  const partition = graph.partitions[input.partition.ordinal];
  if (
    hash !== contentHash(stableJson(payload)) ||
    !partition ||
    input.partition.planHash !== plan.compiled.hash ||
    input.partition.graphHash !== graph.hash ||
    input.partition.acceptanceHash !== graph.acceptanceHash ||
    input.planApprovalHash !== graph.acceptanceHash ||
    input.partition.partitionHash !== partition.hash ||
    input.partition.beforeRevisionHash !== input.expectedRevisionHash ||
    stableJson(input.operations) !==
      stableJson(gameBuildPartitionOperations(graph, input.partition.ordinal))
  )
    throw new Error(
      "Creator transaction must be the exact sealed graph partition under its accepted plan",
    );
}

export function assertCreatorChangeSet(value: unknown): asserts value is CreatorChangeSet {
  if (
    !isRecord(value) ||
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0 ||
    value.summary.length > 8192
  )
    throw new Error("Creator change set requires a bounded builder summary");
  if (
    !isRecord(value) ||
    value.kind !== "CreatorChangeSet" ||
    !isRecord(value.partition) ||
    value.partition.kind !== "GamePartitionBinding" ||
    !isHash(value.partition.hash) ||
    !isHash(value.partition.graphHash) ||
    !Number.isSafeInteger(value.partition.ordinal) ||
    !isRecord(value.checkpointOwnership) ||
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
  assertOwnershipMap(value.checkpointOwnership);
  if (
    value.checkpointOwnership.id !== value.ownershipMapId ||
    value.checkpointOwnership.hash !== value.ownershipMapHash ||
    value.checkpointOwnership.revisionHash !== value.expectedRevisionHash
  )
    throw new Error("Creator change set checkpoint ownership binding mismatch");
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
  if (
    session.status === "incomplete" &&
    (transition.status === "building" || transition.status === "incomplete") &&
    session.failure?.code !== "BUILD_PREPARATION_FAILED"
  )
    throw new Error("Only a build preparation failure can retry its approved plan");
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
    allowedClasses: STUDIO_CREATABLE_CLASSES,
    resolvableClasses: STUDIO_RESOLVABLE_CLASSES,
  });
}

function formatZodIssues(
  issues: readonly {
    path: readonly PropertyKey[];
    message: string;
    errors?: readonly (readonly z.core.$ZodIssue[])[];
  }[],
): string {
  return [
    ...new Set(
      issues.flatMap((issue) => {
        if (issue.errors?.length) {
          const matching = issue.errors.filter(
            (branch) =>
              !branch.some(
                (nested) =>
                  nested.code === "invalid_value" &&
                  ["kind", "check"].includes(String(nested.path.at(-1))),
              ),
          );
          return (matching.length ? matching : issue.errors).map((branch) =>
            formatZodIssues(
              branch.map((nested) => ({ ...nested, path: [...issue.path, ...nested.path] })),
            ),
          );
        }
        const path = issue.path.map(String).join(".");
        return `${path || "input"}: ${issue.message}`;
      }),
    ),
  ].join("; ");
}

const CREATOR_WRITE_TOOLS = ["studio.build", "studio.repair"];
const CREATOR_VERIFIER_TOOLS = ["studio.build", "studio.repair"];

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
      writes:
        this.executedWrites +
        calls.filter((call) => CREATOR_WRITE_TOOLS.includes(call.name)).length,
      verifierCalls:
        this.executedVerifierCalls +
        calls.filter((call) => CREATOR_VERIFIER_TOOLS.includes(call.name)).length,
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
          const parsed = z.object(definitionValue.inputShape).strict().safeParse(call.arguments);
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
      (CREATOR_WRITE_TOOLS.includes(name) && this.executedWrites >= this.budgets.maxWrites) ||
      (CREATOR_VERIFIER_TOOLS.includes(name) &&
        this.executedVerifierCalls >= this.budgets.maxVerifierCalls) ||
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
      const parsed = z.object(definitionValue.inputShape).strict().safeParse(input);
      if (!parsed.success)
        result = failed("TOOL_ARGUMENTS_INVALID", formatZodIssues(parsed.error.issues));
      else {
        try {
          const { activity: _activity, ...argumentsOnly } = parsed.data;
          result = bounded(await this.dispatch(name, argumentsOnly));
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
    if (CREATOR_WRITE_TOOLS.includes(name)) this.executedWrites += 1;
    if (CREATOR_VERIFIER_TOOLS.includes(name)) this.executedVerifierCalls += 1;
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
export const CREATOR_REQUEST_TEXT_MAX_BYTES = 64 * 1024;
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
  const outcome = {
    ...canonical,
    id: `creator_agent_outcome_${hash.slice(0, 24)}`,
    hash,
  } as CreatorAgentOutcome;
  assertCreatorAgentOutcome(outcome);
  return outcome;
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
  private readonly inspectedObjectIds = new Set<string>();
  private readonly observedObjectIds = new Set<string>();
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
        "Search the current project by path, name, or class. Batch independent queries together. Each result carries objectIds and citation handles; pagination belongs to its exact query and revision.",
        {
          queries: z
            .array(
              z
                .object({
                  query: z.string().min(1).max(512),
                  limit: z.number().int().min(1).max(CREATOR_PROJECT_QUERY_LIMIT).optional(),
                  cursor: PROJECT_QUERY_CURSOR_SCHEMA,
                })
                .strict(),
            )
            .min(1)
            .max(16),
        },
      ),
      definition(
        "project.children",
        'List children of observed objects or top-level roots. Batch independent parent queries together. Example: {"queries":[{"rootPath":"Workspace"},{"rootPath":"StarterGui"}]}. Each query supplies exactly one of parentObjectId and rootPath, with its own optional cursor.',
        {
          queries: z
            .array(
              z
                .object({
                  parentObjectId: z
                    .string()
                    .min(1)
                    .max(1024)
                    .describe(
                      "Exact objectId returned by a project tool. Omit when using rootPath.",
                    )
                    .optional(),
                  rootPath: z
                    .enum(STUDIO_CAPABILITY_MANIFEST.roots)
                    .describe(
                      "Top-level Studio root, e.g. Workspace. Omit when using parentObjectId.",
                    )
                    .optional(),
                  limit: z.number().int().min(1).max(CREATOR_PROJECT_QUERY_LIMIT).optional(),
                  cursor: PROJECT_QUERY_CURSOR_SCHEMA,
                })
                .strict(),
            )
            .min(1)
            .max(16),
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
          cursor: SOURCE_QUERY_CURSOR_SCHEMA,
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
          cursor: SOURCE_QUERY_CURSOR_SCHEMA,
        },
      ),
      definition(
        "source.symbols",
        "Find static Luau document/workspace symbols in the current source index. This is static-analysis context, not Studio or runtime proof.",
        {
          query: z
            .string()
            .min(1)
            .max(256)
            .describe("A nonempty symbol name or search phrase; do not send an empty query."),
          pathPrefix: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: SOURCE_QUERY_CURSOR_SCHEMA,
        },
      ),
      definition(
        "source.references",
        "Find lexical references for one Luau symbol in the current source index, with cursor-bound static-analysis results.",
        {
          symbol: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          pathPrefix: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: SOURCE_QUERY_CURSOR_SCHEMA,
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
          cursor: SOURCE_QUERY_CURSOR_SCHEMA,
        },
      ),
      definition(
        "game.catalog",
        "Read the host's pinned optional compiler definitions and exact input schemas. Ordinary Luau source packages are the general extension path; no recipe, round, genre, countdown, interface, or world structure is mandatory.",
        {},
      ),
      definition(
        "creator.propose_plan",
        `Propose one GameDesignSpec composed of ordinary Luau source packages and optional pinned recipes returned by game.catalog. For game requests, declare architecture: a game name, named game systems/components with their purpose and exact implementation componentIds, optional parent groups, and meaningful relationships. This is the creator's game map; do not substitute file/folder inventory or invent undeclared behavior. Utility-only changes may omit it. Declare stable IDs, explicit source placements, source/value slots and dependencies. Forge compiles the full exact editor inventory before review, including generated parents. Inspect existing targets and every inspectionObjectId first; read existing source and its dependency closure before replacing it. Planning does not stage source or mutate Studio. The checks and reviews are creator-visible obligations, not proof. A published plan is ready for review; no closing reply is needed.`,
        PLAN_SHAPE,
      ),
      definition(
        "creator.answer",
        "Answer the creator in GitHub-flavored Markdown in the text field, without proposing or applying a change. Use concise paragraphs, lists, inline code, and language-tagged code fences when useful. Do not wrap the whole answer in a code fence. Cite only host-issued handles returned during this run; uncited prose remains explicit agent interpretation.",
        CREATOR_ANSWER_SHAPE,
      ),
      definition(
        "creator.request_clarification",
        "Ask one material question in concise Markdown when a safe, useful plan cannot yet be selected. Cite only host-issued handles returned during this run.",
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
    return (
      this.outcome?.hash ??
      contentHash(
        stableJson({
          observed: [...this.observedObjectIds].sort(),
          inspected: [...this.inspectedObjectIds].sort(),
          source: this.sourceRecorder.seal().sources,
        }),
      )
    );
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
    if (name === "game.catalog") {
      const catalog = await creatorGameCatalog();
      return {
        definitions: catalog.definitions.map((definition) => ({
          lock: gameRecipeDefinitionLock(definition),
          ...definition,
        })),
        sourceExtension: "source_package",
        limits: { maximumCompiledOperations: 8192, maximumOperationsPerTransaction: 128 },
      };
    }
    if (name === "studio.api_lookup")
      return creatorRobloxApiLookup(input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>);
    if (name === "project.search")
      return {
        queries: (
          input as { queries: Parameters<CreatorPlannerToolHost["searchProject"]>[0][] }
        ).queries.map((query) => ({
          query: query.query,
          ...(this.searchProject(query) as object),
        })),
      };
    if (name === "project.children")
      return {
        queries: (
          input as { queries: Parameters<CreatorPlannerToolHost["projectChildren"]>[0][] }
        ).queries.map((query) => ({
          parent: query.parentObjectId ?? query.rootPath,
          ...(this.projectChildren(query) as object),
        })),
      };
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
    const uninspected = value.inspectionObjectIds.filter((id) => !this.inspectedObjectIds.has(id));
    if (uninspected.length > 0)
      throw correctiveFailure(
        "PLAN_INSPECTION_NOT_OBSERVED",
        "Every declared builder inspection dependency must first be inspected by the read-only planner",
        {
          uninspectedObjectIds: uninspected,
          inspectedObjectIds: [...this.inspectedObjectIds].sort(),
        },
      );
    try {
      const catalog = await creatorGameCatalog();
      const admitted = validateGameDesignSpec(value.design, {
        registry: catalog.registry,
        policy: DEFAULT_GAME_ADMISSION_POLICY,
      });
      if (admitted.status !== "eligible") throw new Error(stableJson(admitted.diagnostics));
      const compilerInput = {
        design: admitted.spec,
        registry: catalog.registry,
        projectId: this.input.session.projectId,
        project: this.input.projectIndex.project,
        initialTopology: this.input.projectIndex.instances,
        observation: this.input.projectIndex,
        recipeExpanders: catalog.expanders,
      };
      const expanded = expandGameDesign(compilerInput);
      for (const item of expanded.inventory) {
        const change = item.change;
        if (change.kind !== "create")
          this.resolvePlanObject(studioObjectIdentityKey(change.target.identity), true);
        if (
          (change.kind === "create" || change.kind === "move") &&
          change.parent.kind === "instance" &&
          !isGeneratedPlanParent(
            change.parent,
            expanded.inventory.map((item) => item.change),
            this.input.session.projectId,
          )
        )
          this.resolvePlanObject(studioObjectIdentityKey(change.parent.identity), true);
      }
      const compiled = compileGamePlan({
        ...compilerInput,
        design: expanded.design,
        inventory: expanded.inventory,
        observedSources: expanded.observedSources,
        sessionId: this.input.session.id,
        observedRevisionHash: this.input.session.currentRevisionHash,
      });
      const changes = compiled.inventory.map((item) => item.change);
      const clauses = this.compilePlanChecks(changes, value.checks, value.reviews);
      const sourceConsultation = this.sourceRecorder.seal();
      const sourceChanges = changes.filter(sourceBearingPlanChange);
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
      if (unconsultedTargets.length > 0 || targetsWithoutDependencyClosure.length > 0)
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
          compiled,
          promptHash: this.input.session.promptHash,
          projectRevisionHash: this.input.session.currentRevisionHash,
          projectCaptureHash: this.input.session.currentProjectCaptureHash,
          ownershipMapId: this.input.ownership.id,
          ownershipMapHash: this.input.ownership.hash,
          creatorPrompt: this.input.prompt,
          inspectionPaths: value.inspectionObjectIds.map((id) => this.resolvePlanObject(id).path),
          steps: [
            {
              id: "compile-design",
              statement: compiled.design.intent,
              changeIds: changes.map((change) => change.id),
            },
          ],
          changes,
          charter: {
            clauses,
          },
          sourceIndex: this.sourceIndex,
          sourceConsultation,
        },
        this.input.projectIndex,
        this.input.ownership,
      );
      prepareCreatorBuildPlan(plan, this.input.projectIndex);
      this.outcome = sealCreatorAgentOutcome({
        kind: "plan_proposed",
        plan,
        citations: this.resolveCitations(value.citationHandles ?? []),
      });
    } catch (error) {
      this.lastProposalFailure =
        error instanceof ToolFailure
          ? error
          : error instanceof CreatorValidationFailure
            ? correctiveFailure(error.code, error.message, error.details)
            : new ToolFailure(
                "PLAN_INVALID",
                error instanceof Error ? error.message : String(error),
              );
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

  private resolvePlanObject(
    objectId: string,
    inspected = false,
  ): CreatorProjectIndexView["instances"][number] {
    const instance = this.input.projectIndex.instances.find((entry) => entry.objectId === objectId);
    if (!instance || !this.observedObjectIds.has(objectId))
      throw new ToolFailure(
        "PLAN_OBJECT_NOT_OBSERVED",
        "Use an objectId returned by a project tool in this run. Unknown or stale object IDs cannot authorize a plan.",
      );
    if (inspected && !this.inspectedObjectIds.has(objectId))
      throw correctiveFailure(
        "PLAN_INSPECTION_NOT_OBSERVED",
        "Inspect the existing target before proposing changes to it.",
        { objectId, path: instance.path },
      );
    return instance;
  }

  private compilePlanChecks(
    changes: readonly CreatorPlanChange[],
    checks: readonly z.infer<typeof PLAN_CHECK_INPUT_SCHEMA>[],
    reviews: readonly string[],
  ): VerificationCharterProposalClause[] {
    const clauses: VerificationCharterProposalClause[] = changes.flatMap((change, index) =>
      change.kind !== "delete"
        ? [
            {
              id: `output_${index + 1}`,
              kind: "studio_check" as const,
              check: "instance_exists" as const,
              path:
                change.kind === "create"
                  ? change.path
                  : change.kind === "move"
                    ? change.toPath
                    : change.target.path,
              expectedClass: change.kind === "create" ? change.className : change.expectedClass,
            },
          ]
        : [],
    );
    if (changes.some(sourceBearingPlanChange))
      clauses.push({ id: "source_syntax", kind: "local_check", check: "luau_syntax" });
    checks.forEach((check, index) => {
      const id = `check_${index + 1}`;
      if (check.check === "playtest_diagnostics") {
        clauses.push({ id, kind: "studio_check", ...check });
        return;
      }
      const instance = this.resolvePlanObject(check.objectId);
      if (check.check === "subtree_unchanged" || check.check === "instance_exists") {
        clauses.push(
          PROPOSED_CLAUSE_SCHEMA.parse({
            id,
            kind: check.check === "subtree_unchanged" ? "snapshot_check" : "studio_check",
            check: check.check,
            path: instance.path,
            expectedClass: instance.className,
          }) as VerificationCharterProposalClause,
        );
      } else {
        const { objectId: _objectId, ...fields } = check;
        if (!isRobloxClassAssignableTo(instance.className, "BasePart"))
          throw new ToolFailure(
            "PLAN_CHECK_TARGET_INVALID",
            "Position observations require an existing BasePart.",
          );
        clauses.push({
          id,
          kind: "studio_check",
          ...fields,
          path: instance.path,
          expectedClass: "BasePart",
        });
      }
    });
    reviews.forEach((statement, index) =>
      clauses.push({ id: `review_${index + 1}`, kind: "creator_review", statement }),
    );
    return clauses;
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
    this.observedObjectIds.add(instance.objectId);
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
    if (
      (queryBinding.rootPath &&
        !STUDIO_CAPABILITY_MANIFEST.roots.includes(queryBinding.rootPath)) ||
      (input.parentObjectId &&
        !this.input.projectIndex.instances.some(
          (instance) => instance.objectId === input.parentObjectId,
        ))
    )
      throw new ToolFailure(
        "PROJECT_PARENT_INVALID",
        "Use a declared top-level rootPath, or find the nested object with project.search and pass its objectId as parentObjectId. An unknown parent is not an empty folder.",
      );
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
    const missing = input.objectIds.filter(
      (objectId) => !this.input.projectIndex.instances.some((entry) => entry.objectId === objectId),
    );
    if (missing.length > 0)
      throw new ToolFailure(
        "PROJECT_INSPECTION_ABSENT",
        `Project index has no object for: ${missing.join(", ")}. Search for the object's path and copy its returned objectId exactly. Engine-container parents use {rootPath} in a plan; they do not need an objectId.`,
      );
    const instances = this.input.projectIndex.instances
      .filter((instance) => input.objectIds.includes(instance.objectId))
      .map((instance) => {
        this.inspectedObjectIds.add(instance.objectId);
        const citation = this.issueProjectCitation(instance);
        const script = this.input.projectIndex.scripts.find(
          (candidate) => candidate.documentId === instance.objectId,
        );
        return {
          objectId: instance.objectId,
          path: instance.path,
          name: instance.name,
          className: instance.className,
          target: {
            kind: "instance",
            identity: instance.identity,
            path: instance.path,
            className: instance.className,
          },
          beforeHash: contentHash(stableJson(instance)),
          owner:
            this.input.ownership.entries.find((entry) => entry.objectId === instance.objectId)
              ?.owner ?? "studio_document",
          ...(instance.position ? { position: instance.position } : {}),
          properties: instance.properties,
          layoutNotes: creatorLayoutNotes(instance.properties),
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
  override execute(name: string, input: unknown): Promise<ToolResult> {
    const timing = this.input.timing;
    return timing && (name === "studio.build" || name === "studio.repair")
      ? timing.recorder.measure("local_build_review", timing.correlation, () =>
          super.execute(name, input),
        )
      : super.execute(name, input);
  }
  private summary = "";
  private verificationCache?: {
    fingerprint: string;
    result: unknown;
    gate: CreatorChangeSet["localGate"];
  };
  private readonly operations: StudioChangeOperation[] = [];
  /** Raw source exists only while the bounded builder is running. Sealed
   * operations retain metadata bindings; callers persist these leaves before
   * the change set may be approved or transported. */
  private readonly sourceWriteBlobs = new Map<string, CreatorSourceWriteBlobCapture>();
  private localGate: CreatorChangeSet["localGate"] = {
    status: "incomplete",
    issueHashes: [],
  };
  private latestModelCheckpoint?: string;
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
      timing?: { recorder: HostPhaseRecorder; correlation: HostPhaseCorrelation };
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
    const scripts = this.input.plan.compiled.inventory
      .filter((item) => item.source?.content.kind === "slot")
      .map((item) => item.id);
    const propertyChanges = this.contract.changes
      .filter(
        (change) =>
          (change.kind === "create" || change.kind === "update" || change.kind === "move") &&
          this.input.plan.compiled.inventory.find((item) => item.id === change.planChangeId)!
            .valueSlots.length > 0,
      )
      .map((change) => {
        const slots = this.input.plan.compiled.inventory.find(
          (item) => item.id === change.planChangeId,
        )!.valueSlots;
        return {
          ...change,
          propertyPolicy: {
            ...change.propertyPolicy,
            allowedProperties: change.propertyPolicy.allowedProperties.filter((rule) =>
              slots.some((slot) => slot.propertyName === rule.name),
            ),
          },
        };
      });
    const properties = propertyChanges.map((change) => change.planChangeId);
    const sourceDocumentIds = this.approvedSourceDocumentIds();
    const referencesFor = (rule: CreatorPropertyRule) => this.modelPropertyReferences(rule);
    return [
      definition(
        "game.inspect_inventory",
        "Read a bounded page of the exact accepted compiled inventory. Inspect only needed component/property/source facts; the immutable plan hash binds every page.",
        {
          planHash: z.literal(this.input.plan.compiled.hash),
          componentId: z.string().min(1).optional(),
          offset: z.number().int().nonnegative(),
        },
      ),
      definition(
        "game.read_locked_source",
        "Read a bounded source page from one accepted host-owned runtime/component module. These are fixed locked sources; a read grants no edit authority.",
        {
          operationId: z.string().min(1),
          startLine: z.number().int().min(1),
          lineCount: z.number().int().min(1).max(120),
        },
      ),
      ...BUILDER_DEFINITIONS.flatMap((tool) => {
        if (tool.name === "studio.read_observations") {
          const approvedIds = this.input.projectIndex.instances
            .filter((instance) => this.contract.initialInspectionPaths.includes(instance.path))
            .map((instance) => instance.objectId);
          if (approvedIds.length === 0) return [];
          return [
            definition(tool.name, tool.description, {
              revisionHash: z.literal(this.input.projectIndex.revision.hash),
              reads: z
                .array(
                  z
                    .object({
                      objectId: z.enum(approvedIds),
                      cursor: z.string().max(2048).optional(),
                      fields: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(3),
            }),
          ];
        }
        if (tool.name === "source.read") {
          if (sourceDocumentIds.length === 0) return [];
          return [
            definition(tool.name, tool.description, {
              reads: z
                .array(
                  z
                    .object({
                      documentId: z.enum(sourceDocumentIds),
                      maximumUtf8Bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(16 * 1024)
                        .optional(),
                      cursor: SOURCE_QUERY_CURSOR_SCHEMA,
                    })
                    .strict(),
                )
                .min(1)
                .max(3),
            }),
          ];
        }
        if (tool.name === "studio.build") {
          const slots = this.input.plan.compiled.inventory.flatMap((item) =>
            item.valueSlots.map((slot) => ({ item, slot })),
          );
          const values = combineModelSchemas(
            slots.map(({ item, slot }) => {
              const change = this.contract.changes.find(
                (change) => change.planChangeId === item.id,
              )!;
              const rule = change.propertyPolicy.allowedProperties.find(
                (rule) => rule.name === slot.propertyName,
              )!;
              return z
                .object({
                  slotId: z.literal(slot.id),
                  value: modelPropertyInputSchema(rule, referencesFor(rule))!,
                })
                .strict();
            }),
          );
          return [
            definition(tool.name, tool.description, {
              sources: z
                .array(
                  scripts.length
                    ? z.object({ slotId: z.enum(scripts), source: boundedSourceSchema() }).strict()
                    : z.never(),
                )
                .length(scripts.length),
              values: z.array(values ?? z.never()).length(slots.length),
              summary: BUILDER_SUMMARY_SCHEMA,
            }),
          ];
        }
        if (tool.name === "studio.read_drafts") {
          if (scripts.length === 0) return [];
          return [
            definition(tool.name, tool.description, {
              drafts: z
                .array(MODEL_DRAFT_READ_SCHEMA.extend({ planChangeId: z.enum(scripts) }))
                .min(1)
                .max(scripts.length),
            }),
          ];
        }
        if (tool.name === "studio.repair") {
          if (scripts.length === 0 && properties.length === 0) return [];
          const repair = combineModelSchemas<unknown>([
            ...(scripts.length > 0
              ? [MODEL_SOURCE_REPAIR_SCHEMA.extend({ planChangeId: z.enum(scripts) })]
              : []),
            ...(propertyChanges.length > 0
              ? [groupedModelPropertyRepairSchema(propertyChanges, referencesFor)!]
              : []),
          ])!;
          return [
            definition(tool.name, tool.description, {
              repairs: z
                .array(repair)
                .min(1)
                .max(scripts.length + properties.length),
              summary: BUILDER_SUMMARY_SCHEMA,
            }),
          ];
        }
        return [tool];
      }),
    ];
  }
  stagedOperations(): StudioChangeOperation[] {
    return this.operations.map(cloneOperation);
  }
  sealedGraph(): GameBuildGraph {
    const completion = this.completionStatus();
    if (!completion.ready) throw new Error(completion.message);
    return this.compileCurrentGraph();
  }
  resultSummary(): string {
    return this.summary;
  }
  private compileCurrentGraph(): GameBuildGraph {
    const sources = this.input.plan.compiled.inventory
      .filter((item) => item.source)
      .map((item) => ({ slotId: item.id, source: this.draftSource(item.id) }));
    const values = this.input.plan.compiled.inventory.flatMap((item) => {
      const operation = this.operations.find((operation) => operation.planChangeId === item.id);
      return item.valueSlots.map((slot) => {
        if (!operation || !("properties" in operation))
          throw new Error("Compiled value slot has no staged operation");
        return { slotId: slot.id, value: operation.properties[slot.propertyName]! };
      });
    });
    const graph = materializeGameBuildGraph({
      plan: this.input.plan.compiled,
      acceptanceHash: this.input.planApproval.hash,
      sources,
      values,
      checks: { status: this.localGate.status, artifactHashes: this.localGate.issueHashes },
    }).graph;
    const canonical = (operations: readonly StudioChangeOperation[]) =>
      stableJson([...operations].sort((a, b) => a.id.localeCompare(b.id)));
    if (canonical(graph.operations) !== canonical(this.operations))
      throw new Error("Staged writes exceed the accepted compiler slots");
    return graph;
  }
  private async stageCompiledDesign(request: {
    sources: Array<{ slotId: string; source: string }>;
    values: Array<{ slotId: string; value: CreatorPropertyInput }>;
  }): Promise<unknown> {
    if (
      request.sources.some(
        (source) => Buffer.byteLength(source.source) > this.budgets.maxBytesPerFile,
      ) ||
      request.sources.reduce((sum, source) => sum + Buffer.byteLength(source.source), 0) >
        this.budgets.maxChangedSourceBytes
    )
      throw new Error("Custom source material exceeds the active model authoring budget");
    const catalog = await creatorGameCatalog();
    const editable = new Set(
      this.input.plan.compiled.inventory
        .filter((item) => item.source?.content.kind === "slot")
        .map((item) => item.id),
    );
    if (request.sources.some((source) => !editable.has(source.slotId)))
      throw new Error("Build may fill only accepted custom source slots");
    const sources = [...request.sources];
    for (const item of this.input.plan.compiled.inventory) {
      if (item.source?.content.kind !== "locked") continue;
      const lock = item.source.content;
      let source = catalog.lockedSources.get(lock.sourceHash);
      if (source === undefined) {
        const document = this.input.sourceIndex.documents.find(
          (document) =>
            document.sourceHash === lock.sourceHash &&
            this.approvedSourceDocumentIds().includes(document.documentId),
        );
        if (document) source = this.input.sourceResolver.read(document);
      }
      if (source === undefined) throw new Error("Locked source bytes are unavailable: " + item.id);
      sources.push({ slotId: item.id, source });
    }
    const values = request.values.map(({ slotId, value }) => {
      const item = this.input.plan.compiled.inventory.find((item) =>
        item.valueSlots.some((slot) => slot.id === slotId),
      );
      const slot = item?.valueSlots.find((slot) => slot.id === slotId);
      if (!item || !slot) throw new Error("Value material is outside the accepted slots");
      const className =
        item.change.kind === "create" ? item.change.className : item.change.expectedClass;
      return {
        slotId,
        value: canonicalizeCreatorPropertyInput({
          className,
          propertyName: slot.propertyName,
          value,
          resolveReference: (reference) => this.approvedPropertyReference(reference),
        }),
      };
    });
    const material = materializeGameBuildGraph({
      plan: this.input.plan.compiled,
      acceptanceHash: this.input.planApproval.hash,
      sources,
      values,
      checks: { status: "incomplete", artifactHashes: [] },
    });
    for (const operation of material.graph.operations)
      assertStudioChangeOperation(
        operation,
        this.input.projectIndex,
        this.input.ownership,
        this.contract.mutationAuthority,
        [...material.graph.operations],
      );
    this.operations.splice(
      0,
      this.operations.length,
      ...material.graph.operations.map(cloneOperation),
    );
    this.sourceWriteBlobs.clear();
    for (const capture of material.sourceWriteBlobs)
      this.sourceWriteBlobs.set(capture.manifest.hash, capture);
    this.localGate = { status: "incomplete", issueHashes: [] };
    const review = await this.verify();
    this.compileCurrentGraph();
    return {
      staged: true,
      operations: material.graph.operations.length,
      partitions: material.graph.partitions.length,
      changes: this.operationReceipts(),
      review,
    };
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
  private sourceWriteBlob(
    source: string,
    destination = this.sourceWriteBlobs,
  ): CreatorSourceWriteBlobBinding {
    const capture = createCreatorSourceWriteBlobCapture({
      source,
      maximumSourceBlobBytes: CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes,
      transportChunkBytes: CREATOR_DEFAULT_RESOURCE_POLICY.transportChunkBytes,
    });
    const binding = creatorSourceWriteBlobBinding(capture);
    destination.set(binding.manifestHash, capture);
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
  contextCheckpoint(): string | undefined {
    return this.latestModelCheckpoint;
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
        message: `Creator builder ended before the complete draft passed local review (current: ${this.localGate.status})`,
      };
    if (this.summary.length === 0)
      return {
        ready: false,
        code: "BUILDER_SUMMARY_MISSING",
        message: "Creator builder passed local review without its final Markdown summary",
      };
    return { ready: true };
  }
  protected override async dispatch(name: string, input: unknown): Promise<unknown> {
    let result: unknown;
    if (name === "game.inspect_inventory") {
      const request = input as { componentId?: string; offset: number };
      const inventory = this.input.plan.compiled.inventory.filter(
        (item) => request.componentId === undefined || item.componentId === request.componentId,
      );
      const page = [];
      let bytes = 0;
      for (const item of inventory.slice(request.offset, request.offset + 32)) {
        const size = Buffer.byteLength(stableJson(item));
        if (page.length === 0 && size > 16 * 1024)
          throw new ToolFailure(
            "INVENTORY_ITEM_EXCEEDS_PAGE",
            `Inventory item ${item.id} exceeds the bounded inspection page (${size} bytes). Its authority remains in the accepted plan; use the declared source/value slots and component specification.`,
          );
        if (bytes + size > 16 * 1024) break;
        page.push(item);
        bytes += size;
      }
      result = {
        planHash: this.input.plan.compiled.hash,
        inventory: page,
        total: inventory.length,
        ...(request.offset + page.length < inventory.length
          ? { nextOffset: request.offset + page.length }
          : {}),
      };
    } else if (name === "game.read_locked_source") {
      const request = input as { operationId: string; startLine: number; lineCount: number };
      const item = this.input.plan.compiled.inventory.find(
        (item) => item.id === request.operationId,
      );
      if (item?.source?.content.kind !== "locked")
        throw new Error("Only an accepted locked source can be read through this tool");
      const catalog = await creatorGameCatalog();
      const source = catalog.lockedSources.get(item.source.content.sourceHash);
      if (source === undefined) throw new Error("The locked module source is unavailable");
      result = creatorDraftPage(source, request.startLine, request.lineCount);
    } else if (name === "studio.api_lookup") {
      result = creatorRobloxApiLookup(
        input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>,
      );
    } else if (name === "studio.read_observations") {
      const request = input as {
        revisionHash: string;
        reads: Array<{ objectId: string; cursor?: string; fields?: string[] }>;
      };
      if (new Set(request.reads.map((read) => read.objectId)).size !== request.reads.length)
        throw new ToolFailure(
          "DUPLICATE_OBSERVATION_READ",
          "Read each approved object once per batch.",
        );
      result = {
        observations: request.reads.map((read) =>
          creatorBuilderObservationPage(
            this.input.projectIndex,
            this.contract,
            { ...read, revisionHash: request.revisionHash },
            8 * 1024,
          ),
        ),
      };
    } else if (name === "source.read") {
      const reads = (
        input as {
          reads: Array<{ documentId: string; maximumUtf8Bytes?: number; cursor?: string }>;
        }
      ).reads;
      if (new Set(reads.map((read) => read.documentId)).size !== reads.length)
        throw new ToolFailure(
          "DUPLICATE_SOURCE_READ",
          "Read each source document at most once per batch.",
        );
      result = {
        sources: reads.map((read) => ({
          documentId: read.documentId,
          result: this.readApprovedSource({
            ...read,
            maximumUtf8Bytes: read.maximumUtf8Bytes ?? 8 * 1024,
          }),
        })),
      };
    } else if (name === "studio.read_drafts") {
      const requests = (
        input as {
          drafts: Array<{ planChangeId: string; startLine?: number; lineCount?: number }>;
        }
      ).drafts;
      if (new Set(requests.map((request) => request.planChangeId)).size !== requests.length)
        throw new ToolFailure("DUPLICATE_DRAFT_READ", "Read each staged script at most once.");
      result = {
        drafts: requests.map((request) => ({
          planChangeId: request.planChangeId,
          ...creatorDraftPage(
            this.draftSource(request.planChangeId),
            request.startLine ?? 1,
            request.lineCount ?? 120,
          ),
        })),
      };
    } else if (name === "studio.build") {
      const request = input as {
        sources: Array<{ slotId: string; source: string }>;
        values: Array<{ slotId: string; value: CreatorPropertyInput }>;
        summary: string;
      };
      result = await this.stageCompiledDesign(request);
      if (this.localGate.status === "eligible") this.summary = request.summary;
    } else if (name === "studio.repair") {
      const request = input as {
        repairs: Array<
          | {
              kind: "source";
              planChangeId: string;
              expectedSourceHash: string;
              edits: CreatorDraftLineEdit[];
            }
          | {
              kind: "properties";
              planChangeId: string;
              expectedOperationHash: string;
              properties: Record<string, CreatorPropertyInput>;
            }
        >;
        summary: string;
      };
      result = await this.repairDrafts(request.repairs);
      if (this.localGate.status === "eligible") this.summary = request.summary;
    } else {
      throw new ToolFailure("TOOL_UNKNOWN", `Unknown builder tool ${name}`);
    }
    this.latestModelCheckpoint = stableJson({
      instruction:
        "Continue from this complete current Build state. Do not repeat accepted work or reconstruct earlier tool output.",
      operations: this.operationReceipts(),
      localGate: this.gate(),
      latestResult: result,
    });
    return result;
  }

  private async repairDrafts(
    repairs: Array<
      | {
          kind: "source";
          planChangeId: string;
          expectedSourceHash: string;
          edits: CreatorDraftLineEdit[];
        }
      | {
          kind: "properties";
          planChangeId: string;
          expectedOperationHash: string;
          properties: Record<string, CreatorPropertyInput>;
        }
    >,
  ) {
    if (new Set(repairs.map((repair) => repair.planChangeId)).size !== repairs.length)
      throw new ToolFailure(
        "DUPLICATE_REPAIR_TARGET",
        "Combine all corrections for a planChangeId into one repair entry.",
      );
    const operations = this.operations.map(cloneOperation);
    const blobs = new Map(this.sourceWriteBlobs);
    const gate = this.gate();
    const verificationCache = this.verificationCache
      ? structuredClone(this.verificationCache)
      : undefined;
    try {
      const changes = repairs.map((repair) =>
        repair.kind === "source"
          ? this.patchSourceDraft(repair)
          : this.patchPropertiesDraft(repair),
      );
      const review = await this.verify();
      this.compileCurrentGraph();
      return { repaired: true, changes, review };
    } catch (error) {
      this.operations.splice(0, this.operations.length, ...operations);
      this.sourceWriteBlobs.clear();
      for (const [hash, blob] of blobs) this.sourceWriteBlobs.set(hash, blob);
      this.localGate = gate;
      if (verificationCache) this.verificationCache = verificationCache;
      else delete this.verificationCache;
      throw error;
    }
  }

  private patchPropertiesDraft(patch: {
    planChangeId: string;
    expectedOperationHash: string;
    properties: Record<string, CreatorPropertyInput>;
  }) {
    const slots =
      this.input.plan.compiled.inventory.find((item) => item.id === patch.planChangeId)
        ?.valueSlots ?? [];
    if (
      Object.keys(patch.properties).some(
        (name) => !slots.some((slot) => slot.propertyName === name),
      )
    )
      throw new Error("Repair cannot alter a locked compiled property");
    const operation = this.operations.find((item) => item.planChangeId === patch.planChangeId);
    if (
      !operation ||
      (operation.kind !== "create" && operation.kind !== "update" && operation.kind !== "move")
    )
      throw new ToolFailure(
        "DRAFT_PROPERTIES_MISSING",
        "Build this create, update, or move before repairing its properties.",
      );
    if (contentHash(stableJson(operation)) !== patch.expectedOperationHash)
      throw new ToolFailure(
        "DRAFT_PROPERTIES_STALE",
        "The property draft changed. Use the latest operationHash from the Build checkpoint.",
      );
    const contractChange = this.contract.changes.find(
      (item) => item.planChangeId === patch.planChangeId,
    )!;
    const derived = deriveStudioOperation(
      contractChange,
      {
        planChangeId: patch.planChangeId,
        properties: patch.properties,
        ...(operation.kind === "create" && operation.sourceBlob
          ? { source: this.sourceWriteText(operation.sourceBlob) }
          : {}),
      },
      this.input.sourceIndex,
      this.input.sourceResolver,
      (source) => this.sourceWriteBlob(source),
      (binding) => this.sourceWriteText(binding),
      (reference) => this.approvedPropertyReference(reference),
    );
    if (derived.kind !== "create" && derived.kind !== "update" && derived.kind !== "move")
      throw new ToolFailure("DRAFT_PROPERTIES_MISSING", "This operation has no properties.");
    const updated = {
      ...operation,
      properties: { ...operation.properties, ...derived.properties },
    };
    const next = this.operations.map((item) => (item === operation ? updated : item));
    assertStudioChangeOperation(
      updated,
      this.input.projectIndex,
      this.input.ownership,
      this.contract.mutationAuthority,
      next,
    );
    this.operations[this.operations.indexOf(operation)] = cloneOperation(updated);
    this.localGate = { status: "incomplete", issueHashes: [] };
    return {
      planChangeId: patch.planChangeId,
      operationId: updated.id,
      operationHash: contentHash(stableJson(updated)),
      previousOperationHash: patch.expectedOperationHash,
    };
  }

  private patchSourceDraft(patch: {
    planChangeId: string;
    expectedSourceHash: string;
    edits: CreatorDraftLineEdit[];
  }) {
    const operation = this.operations.find((item) => item.planChangeId === patch.planChangeId);
    if (
      !operation ||
      !(operation.kind === "edit_source" || (operation.kind === "create" && operation.sourceBlob))
    )
      throw new ToolFailure(
        "DRAFT_SOURCE_MISSING",
        "Build this approved script before repairing its source.",
      );
    const source =
      operation.kind === "edit_source"
        ? materializeEditedSource(
            operation,
            this.input.sourceIndex,
            this.input.sourceResolver,
            (binding) => this.sourceWriteText(binding),
          )
        : this.sourceWriteText(operation.sourceBlob!);
    const patched = patchCreatorDraftSource(source, patch.expectedSourceHash, patch.edits);
    if (operation.kind === "create") {
      const bytes = Buffer.byteLength(patched, "utf8");
      const total = this.operations.reduce(
        (sum, item) =>
          sum +
          (item === operation
            ? 0
            : item.kind === "create"
              ? (item.sourceBlob?.utf8Bytes ?? 0)
              : item.kind === "edit_source"
                ? item.edits.reduce((n, edit) => n + edit.replacementBlob.utf8Bytes, 0)
                : 0),
        bytes,
      );
      if (bytes > this.budgets.maxBytesPerFile || total > this.budgets.maxChangedSourceBytes)
        throw new ToolFailure(
          "SOURCE_BUDGET_EXHAUSTED",
          "The repaired source exceeds the active source byte budget.",
        );
      assertRequiredStudioSourceText(patched);
      const updated = { ...operation, sourceBlob: this.sourceWriteBlob(patched) };
      const next = this.operations.map((item) => (item === operation ? updated : item));
      assertStudioChangeOperation(
        updated,
        this.input.projectIndex,
        this.input.ownership,
        this.contract.mutationAuthority,
        next,
      );
      this.operations[this.operations.indexOf(operation)] = cloneOperation(updated);
      this.localGate = { status: "incomplete", issueHashes: [] };
      return {
        planChangeId: patch.planChangeId,
        operationId: updated.id,
        operationHash: contentHash(stableJson(updated)),
        previousOperationHash: contentHash(stableJson(operation)),
        sourceHash: updated.sourceBlob.sourceHash,
        sourceBytes: bytes,
      };
    }
    const document = this.input.sourceIndex.documents.find(
      (item) => item.documentId === studioObjectIdentityKey(operation.target.identity),
    );
    if (!document)
      throw new ToolFailure("SOURCE_PRECONDITION_MISMATCH", "The approved source is absent.");
    const bytes = Buffer.byteLength(patched, "utf8");
    if (bytes > this.budgets.maxBytesPerFile)
      throw new ToolFailure(
        "SOURCE_BUDGET_EXHAUSTED",
        "The repaired source exceeds the active per-source byte budget.",
      );
    const contractChange = this.contract.changes.find(
      (item) => item.planChangeId === patch.planChangeId,
    )!;
    const updated = deriveStudioOperation(
      contractChange,
      {
        planChangeId: patch.planChangeId,
        sourceEdits: [{ startByte: 0, endByte: document.utf8Bytes, replacement: patched }],
      },
      this.input.sourceIndex,
      this.input.sourceResolver,
      (source) => this.sourceWriteBlob(source),
      (binding) => this.sourceWriteText(binding),
      (reference) => this.approvedPropertyReference(reference),
    );
    if (updated.kind !== "edit_source")
      throw new ToolFailure("DRAFT_SOURCE_MISSING", "This operation has no editable source.");
    const next = this.operations.map((item) => (item === operation ? updated : item));
    const totalBytes = next.reduce(
      (sum, item) =>
        sum +
        (item.kind === "create"
          ? (item.sourceBlob?.utf8Bytes ?? 0)
          : item.kind === "edit_source"
            ? item.edits.reduce((n, edit) => n + edit.replacementBlob.utf8Bytes, 0)
            : 0),
      0,
    );
    if (totalBytes > this.budgets.maxChangedSourceBytes)
      throw new ToolFailure(
        "SOURCE_BUDGET_EXHAUSTED",
        "The repaired draft exceeds the active total changed-source byte budget.",
      );
    assertStudioChangeOperation(
      updated,
      this.input.projectIndex,
      this.input.ownership,
      this.contract.mutationAuthority,
      next,
    );
    this.operations[this.operations.indexOf(operation)] = cloneOperation(updated);
    this.localGate = { status: "incomplete", issueHashes: [] };
    return {
      planChangeId: patch.planChangeId,
      operationId: updated.id,
      operationHash: contentHash(stableJson(updated)),
      previousOperationHash: contentHash(stableJson(operation)),
      sourceHash: updated.finalSourceHash,
      sourceBytes: updated.finalByteCount,
    };
  }

  private operationReceipts() {
    return this.operations.map((operation) => ({
      planChangeId: operation.planChangeId,
      kind: operation.kind,
      operationHash: contentHash(stableJson(operation)),
      ...(operation.kind === "edit_source"
        ? { sourceHash: operation.finalSourceHash, sourceBytes: operation.finalByteCount }
        : operation.kind === "create" && operation.sourceBlob
          ? {
              sourceHash: operation.sourceBlob.sourceHash,
              sourceBytes: operation.sourceBlob.utf8Bytes,
            }
          : {}),
    }));
  }

  private approvedInspectionObject(objectId: string) {
    const target = this.input.projectIndex.instances.find(
      (entry) =>
        entry.objectId === objectId && this.contract.initialInspectionPaths.includes(entry.path),
    );
    if (!target)
      throw new ToolFailure(
        "PROPERTY_REFERENCE_NOT_APPROVED",
        "Use an objectId from the approved observed-object scope.",
      );
    return target;
  }
  private approvedPropertyReference(reference: { objectId: string } | { changeId: string }) {
    if ("objectId" in reference) return this.approvedInspectionObject(reference.objectId);
    const change = this.contract.changes.find(
      (candidate) => candidate.planChangeId === reference.changeId && candidate.kind === "create",
    );
    if (!change)
      throw new ToolFailure(
        "PROPERTY_REFERENCE_NOT_APPROVED",
        "Use an observed objectId or the changeId of an object created by this approved build.",
      );
    return {
      identity: change.target.identity,
      path: change.target.path,
      className: change.target.className,
    };
  }
  private modelPropertyReferences(rule: CreatorPropertyRule) {
    const expectedClass = rule.constraints?.referenceClass;
    if (rule.valueKinds[0] !== "instance_ref" || expectedClass === undefined)
      return { objectIds: [], changeIds: [] };
    return {
      objectIds: this.input.projectIndex.instances
        .filter(
          (instance) =>
            this.contract.initialInspectionPaths.includes(instance.path) &&
            isRobloxClassAssignableTo(instance.className, expectedClass),
        )
        .map((instance) => instance.objectId)
        .sort(),
      changeIds: this.contract.changes
        .filter(
          (change) =>
            change.kind === "create" && isRobloxClassAssignableTo(change.className, expectedClass),
        )
        .map((change) => change.planChangeId)
        .sort(),
    };
  }
  private approvedSourceDocumentIds(): string[] {
    return [
      ...new Set([
        ...this.input.sourceConsultation.sources
          .filter((source) => source.ranges.length > 0)
          .map((source) => source.document.documentId),
        ...this.input.sourceConsultation.operations.flatMap((operation) =>
          operation.kind === "dependencies" && operation.dependencyRequest?.direction === "closure"
            ? operation.sources.map((source) => source.document.documentId)
            : [],
        ),
      ]),
    ].sort();
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
  private draftSource(planChangeId: string): string {
    const operation = this.operations.find((item) => item.planChangeId === planChangeId);
    if (operation?.kind === "create" && operation.sourceBlob)
      return this.sourceWriteText(operation.sourceBlob);
    if (operation?.kind === "edit_source")
      return materializeEditedSource(
        operation,
        this.input.sourceIndex,
        this.input.sourceResolver,
        (binding) => this.sourceWriteText(binding),
      );
    throw new ToolFailure(
      "DRAFT_SOURCE_MISSING",
      "Stage this approved script before reading its draft.",
    );
  }
  private async verify(): Promise<unknown> {
    const fingerprint = contentHash(stableJson(this.operations));
    if (this.verificationCache?.fingerprint === fingerprint) {
      this.localGate = structuredClone(this.verificationCache.gate);
      return structuredClone(this.verificationCache.result);
    }
    const result = await this.analyzeDraft();
    // Tooling failures may recover without a source edit and must be retried.
    if (this.localGate.status !== "incomplete")
      this.verificationCache = { fingerprint, result: structuredClone(result), gate: this.gate() };
    return result;
  }
  private async analyzeDraft(): Promise<unknown> {
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
      const dependencySources = creatorLuauAnalysisDependencies(
        this.input.projectIndex,
        this.input.sourceIndex,
        this.input.sourceResolver,
        this.operations,
        sources,
      );
      const analysis = analyzeStudioSourcesWithRobloxLuau({
        nodes: creatorLuauAnalysisTopology(this.input.projectIndex, this.operations),
        sources,
        dependencySources,
      });
      const astSources = [
        ...sources.map((source) => ({ ...source, documentId: source.planChangeId })),
        ...this.input.plan.compiled.observedSources.map((observed) => {
          const source = dependencySources.find(
            (source) =>
              source.studioPath === observed.target.path &&
              contentHash(source.source) === observed.sourceHash &&
              Buffer.byteLength(source.source) === observed.utf8Bytes,
          );
          if (!source)
            throw new Error(
              "Declared installed source dependency is unavailable: " + observed.target.path,
            );
          return { ...source, documentId: source.id };
        }),
      ];
      const documents = astSources.map((source) => {
        const item = this.input.plan.compiled.inventory.find(
          (item) => item.id === source.documentId,
        );
        const component = this.input.plan.compiled.design.components.find(
          (component) => component.id === item?.componentId,
        );
        const context =
          component?.kind === "source_package"
            ? component.files.find((file) => file.id === item?.source?.fileId)?.context
            : undefined;
        return {
          documentId: source.documentId,
          path: source.studioPath,
          className: source.className,
          executionContext:
            context ??
            (source.className === "Script"
              ? ("server" as const)
              : source.className === "LocalScript"
                ? ("client" as const)
                : ("shared" as const)),
          sourceHash: contentHash(source.source),
          utf8Bytes: Buffer.byteLength(source.source),
        };
      });
      const bodies = new Map(astSources.map((source) => [source.documentId, source.source]));
      const read = (document: { documentId: string; sourceHash: string }) => {
        const source = bodies.get(document.documentId);
        if (source === undefined || contentHash(source) !== document.sourceHash)
          throw new Error("AST source bytes differ from the materialized candidate");
        return source;
      };
      const astHost = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
      const ast = await astHost.analyzeAst({
        snapshotHash: this.input.plan.compiled.observedRevisionHash,
        documents,
        resolver: {
          authority: "verified_source_blob",
          read,
          readRange: (document, range) => ({
            ...range,
            source: Buffer.from(read(document))
              .subarray(range.startByte, range.endByte)
              .toString("utf8"),
          }),
        },
      });
      const imports = checkGameSourceImports({ plan: this.input.plan.compiled, analysis: ast });
      const importIssues: VerificationIssue[] = imports.issues.map(
        ({ location: _location, ...issue }) => ({
          ...issue,
          category: issue.category === "source" ? "language" : "tooling",
          kind: "VerificationIssue",
          id: contentHash(stableJson(issue)),
          evidence: [{ type: "pinned_luau_ast", statement: issue.message }],
          authoritativeTier: "static",
        }),
      );
      const diagnostics = [...analysis.issues, ...importIssues]
        .map((issue) => creatorVerificationDiagnostic(issue, sources))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      const issueHashes = diagnostics.map((issue) => contentHash(stableJson(issue))).sort();
      const statuses = analysis.tiers.map((tier) => tier.status);
      this.localGate = {
        status:
          statuses.includes("unavailable") || imports.status === "incomplete"
            ? "incomplete"
            : statuses.includes("fail") || imports.status === "rejected"
              ? "rejected"
              : "eligible",
        issueHashes,
      };
      return {
        ...this.localGate,
        sourceImportCheck: {
          hash: imports.hash,
          status: imports.status,
          imports: imports.imports,
          limitations: imports.limitations,
        },
        issues: consolidateCreatorDiagnostics(diagnostics),
        ...(this.localGate.status === "rejected"
          ? {
              drafts: sources.flatMap((source) => {
                const lines = analysis.issues
                  .filter(
                    (issue) =>
                      issue.severity === "error" &&
                      issue.path === source.studioPath &&
                      issue.location,
                  )
                  .map((issue) => issue.location!.line);
                if (!lines.length) return [];
                return [
                  {
                    planChangeId: source.planChangeId,
                    sourceHash: contentHash(source.source),
                    lineCount: draftLines(source.source).length,
                    excerpts: draftDiagnosticExcerpts(source.source, [...new Set(lines)]),
                  },
                ];
              }),
            }
          : {}),
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
  timing?: { recorder: HostPhaseRecorder; correlation: HostPhaseCorrelation };
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
    input.projectIndex,
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
      finalization: runtimeFinalization("game_build_graph", result),
    };
  const completion = host.completionStatus();
  if (!completion.ready)
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: {
        status: "unsealed",
        intendedArtifactKind: "game_build_graph",
        failureStage: "finalization",
        failureCode: completion.code,
        detail: completion.message,
        failureKind: "model",
      },
    };
  try {
    const graph = host.sealedGraph();
    return {
      graph,
      summary: host.resultSummary(),
      sourceWriteBlobs: host.stagedSourceWriteBlobs(),
      runtimeResult: result,
      toolHost: host,
      systemPrompt,
      finalization: {
        status: "sealed",
        artifact: {
          kind: "game_build_graph",
          id: graph.id,
          hash: graph.hash,
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
        intendedArtifactKind: "game_build_graph",
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
  const store = new ImmutableJsonArtifactStore(dirname(resolve(path)));
  return verifyCreatorBundleArtifacts(value, store);
}

/** Shared by restart admission and provider-free regression replay. */
export async function verifyCreatorBundleArtifacts(
  value: CreatorSessionBundle,
  store: ImmutableJsonArtifactStore,
  options: {
    verifyAgentJournal?: (run: AgentRun, store: ImmutableJsonArtifactStore) => Promise<void>;
  } = {},
): Promise<CreatorSessionBundle> {
  assertCreatorSessionBundle(value);
  for (const build of value.gameBuilds ?? []) {
    const prefix = await verifyGameCheckpointPrefix({
      plan: value.plan!.compiled,
      graph: build.graph,
      receipts: build.receipts,
      store,
    });
    if ((build.status === "complete") !== (prefix.status === "matched"))
      throw new Error(
        "Persisted build completion differs from independently replayed checkpoint evidence",
      );
  }
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
  if (value.preparationFailure) {
    const diagnostic = await store.read(value.preparationFailure.diagnostic);
    if (
      !isRecord(diagnostic) ||
      diagnostic.kind !== "CreatorPreparationDiagnostic" ||
      stableJson(diagnostic.failure) !== stableJson(value.preparationFailure.failure) ||
      stableJson(diagnostic.execution) !== stableJson(value.preparationFailure.execution)
    )
      throw new Error("Preparation diagnostic binding mismatch");
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
    await (options.verifyAgentJournal ?? verifyAgentRunExecutionJournal)(agentRun, store);
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
  if (value.closedMutation) {
    await verifyClosedCreatorRecording(value, value.closedMutation, store);
    await Promise.all(
      creatorActiveMutationReferences(value.closedMutation.cursor).map((reference) =>
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
  if (value.preparationFailure) {
    const binding = value.preparationFailure;
    assertAgentExecutionSlot(binding.execution);
    assertArtifactReference(binding.diagnostic);
    if (
      !["preparation", "source_analysis"].includes(binding.failure.stage) ||
      !isId(binding.failure.code) ||
      typeof binding.failure.detail !== "string" ||
      binding.failure.detail.trim().length === 0 ||
      binding.failure.detail.length > 65_536
    )
      throw new Error("Invalid preparation failure binding");
    if (
      value.session.status === "incomplete" &&
      (value.session.failure?.code !== binding.failure.code ||
        value.session.failure.detailHash !== contentHash(binding.failure.detail))
    )
      throw new Error("Preparation failure does not match its session cause");
    if (value.agentRuns.some((run) => run.agentRunId === binding.execution.agentRunId))
      throw new Error("Preparation failure cannot fabricate an AgentRun");
  }
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
  if (value.gameBuilds !== undefined) {
    if (!Array.isArray(value.gameBuilds) || !value.plan)
      throw new Error("Build graphs require a bound creator plan");
    for (const build of value.gameBuilds) {
      assertGameBuildGraph(build.graph, value.plan.compiled);
      if (
        !value.buildContracts.some((contract) => contract.hash === build.buildContractHash) ||
        !Array.isArray(build.receipts) ||
        !["building", "awaiting_checkpoint", "complete", "incomplete"].includes(build.status)
      )
        throw new Error("Build graph lost its contract or checkpoint state");
    }
  }
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
    const build = value.gameBuilds?.find(
      (build) => build.graph.hash === changeSet.partition.graphHash,
    );
    if (!build || build.buildContractHash !== contract.hash)
      throw new Error("Creator partition lost its sealed graph");
    assertCreatorGraphPartition(changeSet, build.graph, value.plan);
    const changes = new Set(changeSet.operations.map((operation) => operation.planChangeId));
    assertOperationsMatchPlan(
      changeSet.operations,
      value.plan.changes.filter((change) => changes.has(change.id)),
    );
    assertOperationsMatchContract(changeSet.operations, {
      ...contract,
      changes: contract.changes.filter((change) => changes.has(change.planChangeId)),
    });
    if (
      !value.projectIndices.some(
        (capture) => capture.revision.hash === changeSet.expectedRevisionHash,
      )
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
  for (const approval of value.approvals) {
    if (approval.authority !== "accepted_plan") continue;
    const parent = value.approvals.find(
      (item) =>
        item.id === approval.planAuthorization?.id && item.hash === approval.planAuthorization.hash,
    );
    const changeSet = value.changeSets.find(
      (item) => item.id === approval.artifactId && item.hash === approval.artifactHash,
    );
    if (
      !parent ||
      !changeSet ||
      authorizeCreatorPlanExecution(parent, changeSet, approval.decidedAt).hash !== approval.hash
    )
      throw new Error("Automatic application lost its exact accepted-plan authority");
  }
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
  if (value.closedMutation !== undefined) {
    if (
      value.activeMutation ||
      value.session.status !== "incomplete" ||
      value.session.failure?.code !== "interrupted_recording_not_open"
    )
      throw new Error(
        "Closed creator recording must remain incomplete without live mutation authority",
      );
    assertArtifactReference(value.closedMutation.acknowledgement);
    assertCreatorActiveMutation(value.closedMutation.cursor, value);
  }
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
  if (value.session.status === "completed") {
    const completedChangeSet = value.changeSets.at(-1);
    if (!completedChangeSet || value.activeMutation)
      throw new Error("Completed work requires a closed change set");
    if (
      completedChangeSet.mutationAuthority === "studio_document" &&
      (!value.checkpoint ||
        value.checkpoint.status !== "committed" ||
        value.checkpoint.changeSetHash !== completedChangeSet.hash ||
        value.checkpoint.afterRevisionHash !== value.session.currentRevisionHash)
    )
      throw new Error("Completed Studio work requires its exact committed checkpoint");
    if (completedChangeSet.mutationAuthority === "studio_document") {
      const build = value.gameBuilds?.find(
        (build) => build.graph.hash === completedChangeSet.partition.graphHash,
      );
      if (
        !build ||
        build.status !== "complete" ||
        build.receipts.length !== build.graph.partitions.length ||
        build.receipts.at(-1)?.afterRevisionHash !== value.session.currentRevisionHash
      )
        throw new Error(
          "Whole-build success requires every verified graph checkpoint, including final acknowledgement",
        );
    }
  }
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
          !value.gameBuilds?.some(
            (build) =>
              build.graph.id === sealedArtifact.id &&
              build.graph.hash === sealedArtifact.hash &&
              build.buildContractHash === reference.buildContract!.hash,
          )
        )
          throw new Error(
            "Sealed creator builder AgentRun is not linked to its build graph and contract",
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
          reference.outcome.artifact.hash === changeSet.partition.graphHash,
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
    Buffer.byteLength(value.creatorText, "utf8") > CREATOR_REQUEST_TEXT_MAX_BYTES ||
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

/** Validate the complete closed-recording proof before releasing local authority. */
async function verifyClosedCreatorRecording(
  bundle: CreatorSessionBundle,
  closed: NonNullable<CreatorSessionBundle["closedMutation"]>,
  store: ImmutableJsonArtifactStore,
): Promise<void> {
  type RecoveryPayload = Extract<
    import("../../studio-protocol/src/index.js").PluginToBackendMessage,
    { type: "CreatorRecordingRecovery" }
  >["payload"];
  type AcknowledgementPayload = Extract<
    import("../../studio-protocol/src/index.js").PluginToBackendMessage,
    { type: "CreatorClosedRecordingAcknowledged" }
  >["payload"];
  const acknowledgement = await store.read<{
    kind: string;
    studioSessionId: string;
    projectId: string;
    recovery: ArtifactReference;
    payload: AcknowledgementPayload;
  }>(closed.acknowledgement);
  if (
    acknowledgement.kind !== "CreatorClosedRecordingAcknowledgement" ||
    acknowledgement.projectId !== bundle.session.projectId ||
    !isId(acknowledgement.studioSessionId) ||
    acknowledgement.payload?.status !== "closed_cursor_cleared"
  )
    throw new Error("Invalid closed creator recording acknowledgement");
  assertArtifactReference(acknowledgement.recovery);
  const recovery = await store.read<{
    kind: string;
    studioSessionId: string;
    projectId: string;
    payload: RecoveryPayload;
    projectIndex: import("./project-refresh.js").CreatorProjectIndexArtifactBinding;
  }>(acknowledgement.recovery);
  if (
    recovery.kind !== "CreatorRecordingRecoveryRecord" ||
    recovery.projectId !== acknowledgement.projectId ||
    recovery.studioSessionId !== acknowledgement.studioSessionId ||
    recovery.payload?.recordingState !== "not_open"
  )
    throw new Error("Closed creator recording has no exact not-open recovery proof");
  const before = await readCreatorProjectIndexArtifacts(store, closed.cursor.beforeIndexCapture);
  const observed = await readCreatorProjectIndexArtifacts(store, recovery.projectIndex);
  const expected = {
    creatorSessionId: bundle.session.id,
    changeSetId: closed.cursor.changeSetId,
    changeSetHash: closed.cursor.changeSetHash,
    projectionId: closed.cursor.projectionId,
    projectionHash: closed.cursor.projectionHash,
    manifestHash: closed.cursor.manifest.hash,
    beforeProjectIndexManifestId: before.indexManifest.id,
    beforeProjectRevisionHash: before.revision.hash,
    beforeProjectDetectorEpoch: before.detectorEpoch,
    recordingId: closed.cursor.recordingId,
    recoveryProjectIndexManifestId: observed.indexManifest.id,
    recoveryProjectRevisionHash: observed.revision.hash,
    recoveryProjectDetectorEpoch: observed.detectorEpoch,
  };
  if (
    !isId(expected.recordingId) ||
    Object.entries(expected).some(
      ([key, value]) =>
        acknowledgement.payload[key as keyof AcknowledgementPayload] !== value ||
        recovery.payload[key as keyof RecoveryPayload] !== value,
    )
  )
    throw new Error("Closed creator recording proof does not match the retained transaction");
}

export async function closeInterruptedCreatorRecording(
  bundle: CreatorSessionBundle,
  acknowledgement: ArtifactReference,
  store: ImmutableJsonArtifactStore,
): Promise<CreatorSessionBundle> {
  if (bundle.session.status !== "recovery_required" || !bundle.activeMutation)
    throw new Error("Only an interrupted creator recording can be closed by recovery evidence");
  const { activeMutation, ...retained } = bundle;
  const closedMutation = { cursor: activeMutation, acknowledgement };
  await verifyClosedCreatorRecording(bundle, closedMutation, store);
  return {
    ...retained,
    closedMutation,
    session: advanceSession(bundle.session, {
      status: "incomplete",
      failure: {
        code: "interrupted_recording_not_open",
        detail:
          "Studio confirmed the interrupted recording is closed. Its outcome is unknown; no changes were resumed or finalized. You can continue with a new message.",
      },
    }),
  };
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
    !isId(value.projectId) ||
    !isRecord(value.compiled) ||
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
    value.changes.length > CREATOR_MAX_COMPILED_CHANGES ||
    !isRecord(value.charter)
  )
    throw new Error("Invalid CreatorPlan");
  for (const change of value.changes) PLAN_CHANGE_SCHEMA.parse(change);
  assertGamePlan(value.compiled);
  if (
    value.compiled.projectId !== value.projectId ||
    value.compiled.sessionId !== value.sessionId ||
    value.compiled.observedRevisionHash !== value.projectRevisionHash ||
    stableJson(value.compiled.inventory.map((item) => item.change)) !== stableJson(value.changes)
  )
    throw new Error("Creator plan compiler binding is invalid");
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
const STUDIO_CREATABLE_INSTANCE_TARGET_SCHEMA = STUDIO_INSTANCE_TARGET_SCHEMA.extend({
  className: z.enum(STUDIO_CREATABLE_CLASSES),
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
export const PLAN_CHANGE_SCHEMA = z.union([
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
    className: z.enum(STUDIO_NON_SCRIPT_CREATABLE_CLASSES),
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

const OBJECT_HANDLE_SCHEMA = z
  .string()
  .min(1)
  .max(1024)
  .describe("Copy an objectId returned by project tools; never reconstruct an identity.");
const PLAN_CHECK_INPUT_SCHEMA = z.union([
  z.object({ check: z.literal("instance_exists"), objectId: OBJECT_HANDLE_SCHEMA }).strict(),
  z.object({ check: z.literal("subtree_unchanged"), objectId: OBJECT_HANDLE_SCHEMA }).strict(),
  z
    .object({
      check: z.literal("position_series"),
      objectId: OBJECT_HANDLE_SCHEMA,
      sampleCount: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
      intervalMs: z
        .number()
        .int()
        .min(CREATOR_SERIES_MIN_INTERVAL_MS)
        .max(CREATOR_SERIES_MAX_INTERVAL_MS),
      quantizationStuds: z.number().positive().max(10),
      minimumDistinctPositions: z.number().int().min(2).max(CREATOR_SERIES_MAX_SAMPLES),
    })
    .strict(),
  z
    .object({
      check: z.literal("playtest_diagnostics"),
      maximumErrors: z.number().int().min(0).max(20),
      maximumWarnings: z.number().int().min(0).max(100),
    })
    .strict(),
]);
const PLAN_SHAPE = {
  citationHandles: CREATOR_CITATION_HANDLES_SCHEMA.optional(),
  inspectionObjectIds: z.array(OBJECT_HANDLE_SCHEMA).max(CREATOR_MAX_INSPECTION_PATHS),
  design: GAME_DESIGN_SPEC_SCHEMA,
  checks: z
    .array(PLAN_CHECK_INPUT_SCHEMA)
    .max(CREATOR_MAX_CHARTER_CLAUSES)
    .describe(
      "Optional fixed observations appropriate to this design. Existence and source syntax checks are compiler-generated. Runtime behavior requires separately collected native evidence.",
    ),
  reviews: z.array(z.string().min(1).max(4096)).max(32),
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
const STUDIO_VALUE_SCHEMA: z.ZodType<StudioValue> = z.custom<StudioValue>((value) => {
  try {
    assertStudioValue(value);
    return true;
  } catch {
    return false;
  }
}, "invalid canonical Studio value");
const PRIMITIVE_SCHEMA = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
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
export const CHANGE_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("create"),
    tempId: z.string().min(1),
    target: STUDIO_CREATABLE_INSTANCE_TARGET_SCHEMA,
    parent: STUDIO_MUTATION_PARENT_SCHEMA,
    className: z.enum(STUDIO_CREATABLE_CLASSES),
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
const SOURCE_QUERY_CURSOR_SCHEMA = z
  .string()
  .min(1)
  .describe(
    "Omit for the first page. To continue, copy nextCursor from this same source tool with unchanged query/document and options. Never invent a cursor or send START, 0, null, a document ID, or a hash. If nextCursor is absent, there are no more pages.",
  )
  .optional();
const BUILDER_SUMMARY_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .describe(
    "The concise final Markdown message describing what was built and any useful limitations. Do not claim a passed Play test.",
  );
const MODEL_DRAFT_READ_SCHEMA = z
  .object({
    planChangeId: z.string().min(1),
    startLine: z.number().int().min(1).optional(),
    lineCount: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const MODEL_SOURCE_REPAIR_SCHEMA = z
  .object({
    kind: z.literal("source"),
    planChangeId: z.string().min(1),
    expectedSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    edits: z
      .array(
        z
          .object({
            startLine: z.number().int().min(1),
            deleteCount: z.number().int().min(0),
            replacement: boundedSourceSchema(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

type CreatorPropertyRule = CreatorPropertyPolicy["allowedProperties"][number];

function modelNumberSchema(
  rule: CreatorPropertyRule,
  options: { integer?: true; minimum?: number; maximum?: number } = {},
) {
  let schema = options.integer ? z.number().int() : z.number().finite();
  const minimum = options.minimum ?? rule.constraints?.minimum;
  const maximum = options.maximum ?? rule.constraints?.maximum;
  if (minimum !== undefined) schema = schema.min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  if (rule.constraints?.minimumExclusive !== undefined)
    schema = schema.gt(rule.constraints.minimumExclusive);
  if (rule.constraints?.maximumAbsolute !== undefined) {
    schema = schema.min(-rule.constraints.maximumAbsolute).max(rule.constraints.maximumAbsolute);
  }
  return schema;
}

function modelStringSchema(rule: CreatorPropertyRule) {
  const maximum = rule.constraints?.maximumUtf8Bytes ?? 4096;
  const minimum = rule.constraints?.minimumUtf8Bytes ?? 0;
  return z
    .string()
    .refine((value) => {
      const bytes = Buffer.byteLength(value, "utf8");
      return bytes >= minimum && bytes <= maximum;
    }, `UTF-8 value must be ${minimum}-${maximum} bytes`)
    .describe(`UTF-8 string, ${minimum}-${maximum} bytes`);
}

function strictVector2(component: z.ZodNumber) {
  return z.object({ x: component, y: component }).strict();
}

function strictVector3(component: z.ZodNumber) {
  return z.object({ x: component, y: component, z: component }).strict();
}

function modelPropertyInputDescription(kind: StudioCodec): string {
  switch (kind) {
    case "boolean":
      return "boolean";
    case "number_f32":
    case "number_f64":
    case "int32":
      return "number";
    case "int64_decimal":
      return "base-10 integer string";
    case "string_utf8":
    case "content":
      return "string";
    case "color3_rgb8":
      return "{r,g,b}, each 0..1";
    case "vector2_f32":
      return "{x,y}";
    case "vector3_f32":
      return "{x,y,z}";
    case "cframe_f32x12":
      return "{position:{x,y,z},rotation?:{x,y,z}}; rotation is Euler degrees and defaults to zero";
    case "udim":
      return "{scale,offset}";
    case "udim2":
      return "{x:{scale,offset},y:{scale,offset}}";
    case "rect":
      return "{min:{x,y},max:{x,y}}";
    case "number_range":
      return "{min,max}";
    case "number_sequence":
      return "{keypoints:[{time,value,envelope}]}";
    case "color_sequence":
      return "{keypoints:[{time,color:{r,g,b}}]}";
    case "brick_color":
    case "enum_name":
      return "allowed name string";
    case "font":
      return "{family,weight,style}";
    case "physical_properties":
      return "{density,friction,elasticity,frictionWeight,elasticityWeight,acousticAbsorption}";
    case "axes":
      return "{x,y,z} booleans";
    case "faces":
      return "{top,bottom,left,right,front,back} booleans";
    case "ray":
      return "{origin:{x,y,z},direction:{x,y,z}}";
    case "instance_ref":
      return "{objectId} for an observed object or {changeId} for an object created by this build";
  }
}

function modelPropertyInputSchema(
  rule: CreatorPropertyRule,
  references: { objectIds: string[]; changeIds: string[] },
): z.ZodType<CreatorPropertyInput> | undefined {
  const kind = rule.valueKinds[0]!;
  const number = () => modelNumberSchema(rule);
  let schema: z.ZodType<CreatorPropertyInput> | undefined;
  if (kind === "boolean") schema = z.boolean();
  else if (kind === "number_f32" || kind === "number_f64") schema = number();
  else if (kind === "int32")
    schema = modelNumberSchema(rule, {
      integer: true,
      minimum: -2_147_483_648,
      maximum: 2_147_483_647,
    });
  else if (kind === "int64_decimal") schema = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/);
  else if (kind === "string_utf8" || kind === "content") schema = modelStringSchema(rule);
  else if (kind === "enum_name") {
    const allowed = rule.constraints?.allowedStrings;
    schema = allowed?.length
      ? z.enum(allowed as [string, ...string[]])
      : z.string().min(1).max(256);
  } else if (kind === "brick_color") schema = z.string().min(1).max(128);
  else if (kind === "color3_rgb8")
    schema = z
      .object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
      })
      .strict();
  else if (kind === "vector2_f32") schema = strictVector2(number());
  else if (kind === "vector3_f32") schema = strictVector3(number());
  else if (kind === "cframe_f32x12") {
    const maximum = rule.constraints?.cframeTranslationMaximumAbsolute;
    const positionComponent = z
      .number()
      .finite()
      .min(maximum === undefined ? -Number.MAX_VALUE : -maximum)
      .max(maximum === undefined ? Number.MAX_VALUE : maximum);
    schema = z
      .object({
        position: strictVector3(positionComponent),
        rotation: strictVector3(z.number().finite()).optional(),
      })
      .strict();
  } else if (kind === "udim") schema = z.object({ scale: number(), offset: number() }).strict();
  else if (kind === "udim2") {
    const axis = z.object({ scale: number(), offset: number() }).strict();
    schema = z.object({ x: axis, y: axis }).strict();
  } else if (kind === "rect")
    schema = z.object({ min: strictVector2(number()), max: strictVector2(number()) }).strict();
  else if (kind === "number_range") schema = z.object({ min: number(), max: number() }).strict();
  else if (kind === "number_sequence")
    schema = z
      .object({
        keypoints: z
          .array(
            z
              .object({
                time: z.number().min(0).max(1),
                value: z.number().finite(),
                envelope: z.number().nonnegative(),
              })
              .strict(),
          )
          .min(2)
          .max(rule.constraints?.maximumEntries ?? 20),
      })
      .strict();
  else if (kind === "color_sequence")
    schema = z
      .object({
        keypoints: z
          .array(
            z
              .object({
                time: z.number().min(0).max(1),
                color: z
                  .object({
                    r: z.number().min(0).max(1),
                    g: z.number().min(0).max(1),
                    b: z.number().min(0).max(1),
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(2)
          .max(rule.constraints?.maximumEntries ?? 20),
      })
      .strict();
  else if (kind === "font")
    schema = z
      .object({
        family: z.string().min(1).max(4096),
        weight: z.string().min(1),
        style: z.string().min(1),
      })
      .strict();
  else if (kind === "physical_properties")
    schema = z
      .object({
        density: z.number().finite().min(Math.fround(0.0001)).max(100),
        friction: z.number().finite().min(0).max(2),
        elasticity: z.number().finite().min(0).max(1),
        frictionWeight: z.number().finite().min(0).max(100),
        elasticityWeight: z.number().finite().min(0).max(100),
        acousticAbsorption: z.number().finite().min(0).max(1),
      })
      .strict();
  else if (kind === "axes")
    schema = z.object({ x: z.boolean(), y: z.boolean(), z: z.boolean() }).strict();
  else if (kind === "faces")
    schema = z
      .object({
        top: z.boolean(),
        bottom: z.boolean(),
        left: z.boolean(),
        right: z.boolean(),
        front: z.boolean(),
        back: z.boolean(),
      })
      .strict();
  else if (kind === "ray")
    schema = z
      .object({
        origin: strictVector3(z.number().finite()),
        direction: strictVector3(z.number().finite()),
      })
      .strict();
  else if (kind === "instance_ref") {
    const variants: z.ZodType<CreatorPropertyInput>[] = [];
    if (references.objectIds.length > 0)
      variants.push(
        z.object({ objectId: z.enum(references.objectIds as [string, ...string[]]) }).strict(),
      );
    if (references.changeIds.length > 0)
      variants.push(
        z.object({ changeId: z.enum(references.changeIds as [string, ...string[]]) }).strict(),
      );
    schema = combineModelSchemas(variants);
  }
  if (rule.nullable) schema = schema ? z.union([z.null(), schema]) : z.null();
  return schema?.describe(modelPropertyInputDescription(kind));
}

function combineModelSchemas<T>(schemas: z.ZodType<T>[]): z.ZodType<T> | undefined {
  if (schemas.length === 0) return undefined;
  let combined = schemas[0]!;
  for (const schema of schemas.slice(1)) combined = z.union([combined, schema]);
  return combined;
}

function modelPropertiesSchema(
  policy: CreatorPropertyPolicy,
  referencesFor: (rule: CreatorPropertyRule) => { objectIds: string[]; changeIds: string[] },
) {
  const shape: Record<string, z.ZodType> = {};
  for (const rule of policy.allowedProperties) {
    const schema = modelPropertyInputSchema(rule, referencesFor(rule));
    if (schema) shape[rule.name] = schema.optional();
  }
  return z.object(shape).strict();
}

function groupedModelPropertyRepairSchema(
  changes: readonly CreatorBuildContractChange[],
  referencesFor: (rule: CreatorPropertyRule) => { objectIds: string[]; changeIds: string[] },
) {
  const repairable = changes.filter(
    (change) => change.kind === "create" || change.kind === "update" || change.kind === "move",
  );
  const groups = new Map<
    string,
    { change: (typeof repairable)[number]; planChangeIds: [string, ...string[]] }
  >();
  for (const change of repairable) {
    const key = stableJson(change.propertyPolicy);
    const group = groups.get(key);
    if (group) group.planChangeIds.push(change.planChangeId);
    else groups.set(key, { change, planChangeIds: [change.planChangeId] });
  }
  return combineModelSchemas(
    [...groups.values()].map(({ change, planChangeIds }) =>
      z
        .object({
          kind: z.literal("properties"),
          planChangeId: z.enum(planChangeIds),
          expectedOperationHash: z.string().regex(/^[0-9a-f]{64}$/),
          properties: modelPropertiesSchema(change.propertyPolicy, referencesFor).refine(
            (value) => Object.keys(value).length > 0,
            "Supply at least one property",
          ),
        })
        .strict(),
    ),
  );
}

const BUILDER_DEFINITIONS: AgentToolDefinition[] = [
  definition(
    "studio.read_observations",
    "Retrieve bounded immutable facts from objects already inspected in the accepted plan. Use the approved revisionHash. Fields use property:Name, attribute:Name or tags. A nextCursor continues the exact same object and field selection. This does not query Studio or expand approval; use the facts already supplied before requesting more.",
    { revisionHash: z.string(), reads: z.array(z.unknown()).min(1).max(3) },
  ),
  definition(
    "studio.api_lookup",
    "Search the pinned official Roblox Engine API catalog for class, property, method, event, callback, datatype, or enum metadata. Results include signatures, security/capability context, source provenance, and Forge's precise direct-authoring/source-only/restricted disposition. Catalog presence informs Luau source; it never grants typed Studio mutation or behavioral proof.",
    ROBLOX_API_LOOKUP_SHAPE,
  ),
  definition(
    "source.read",
    "Read up to three UTF-8-safe source pages together from the exact creator-approved consultation/dependency closure. Reading outside that closure fails and requires a new plan.",
    {
      reads: z
        .array(
          z.object({
            documentId: z.string().min(1).max(256),
            maximumUtf8Bytes: z
              .number()
              .int()
              .min(1)
              .max(16 * 1024)
              .optional(),
            cursor: SOURCE_QUERY_CURSOR_SCHEMA,
          }),
        )
        .min(1)
        .max(3),
    },
  ),
  definition(
    "studio.build",
    "Fill all accepted custom source and value slots once. Forge materializes locked runtime/component sources, properties and hierarchy; validates the complete candidate; and partitions it into bounded Studio transactions. Both new and replaced custom scripts use complete source in their named slot. CFrame uses position and optional rotation, Color3 channels are0..1, and Instance references use an offered objectId or changeId. Local build is virtual and sends no Studio writes.",
    {
      sources: z.array(z.unknown()).max(CREATOR_MAX_COMPILED_CHANGES),
      values: z.array(z.unknown()).max(CREATOR_MAX_COMPILED_CHANGES),
      summary: BUILDER_SUMMARY_SCHEMA,
    },
  ),
  definition(
    "studio.read_drafts",
    "Read one or more staged scripts in one request. Each page has exact 1-based line numbers and a sourceHash for a later repair. Request only code outside the diagnostic excerpts already returned by studio.build or studio.repair.",
    {
      drafts: z.array(MODEL_DRAFT_READ_SCHEMA).min(1).max(CREATOR_MAX_CHANGES),
    },
  ),
  definition(
    "studio.repair",
    "Apply all independent source and property corrections in one atomic request, then rerun the complete local review. Source repairs use exact line ranges and sourceHash values from the latest diagnostics or studio.read_drafts. Property repairs use the operationHash from the latest receipt. Every omitted field and source line is preserved. A stale or invalid repair changes nothing.",
    {
      repairs: z.array(z.unknown()).min(1).max(CREATOR_MAX_CHANGES),
      summary: BUILDER_SUMMARY_SCHEMA,
    },
  ),
];

function definition(
  name: string,
  description: string,
  inputShape: ZodRawShape,
): AgentToolDefinition {
  const shape = {
    ...inputShape,
    activity: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        "A short public summary of the goal you are working toward, e.g. 'Connecting the airlock controls to the server'. Describe intent at feature level, not this tool call or private reasoning. Reuse the summary while the same task continues.",
      )
      .optional(),
  };
  return {
    name,
    description,
    inputShape: shape,
    schema: z.toJSONSchema(z.object(shape)),
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
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
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
  intendedArtifactKind: "creator_outcome" | "game_build_graph",
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

interface CreatorVerificationDiagnosticView {
  id: string;
  ruleId: string;
  severity: VerificationIssue["severity"];
  category: VerificationIssue["category"];
  message: string;
  path?: string;
  planChangeId?: string;
  operationId?: string;
  location?: {
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
  };
  remediation?: {
    kind: string;
    steps: string[];
  };
}

function creatorVerificationDiagnostic(
  issue: VerificationIssue,
  sources: readonly (StudioLuauAnalysisSource & {
    planChangeId: string;
    operationId: string;
  })[],
): CreatorVerificationDiagnosticView {
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

function consolidateCreatorDiagnostics(
  diagnostics: readonly CreatorVerificationDiagnosticView[],
): Array<
  Omit<CreatorVerificationDiagnosticView, "id" | "operationId" | "location"> & {
    count: number;
    locations?: CreatorVerificationDiagnosticView["location"][];
  }
> {
  const groups = new Map<
    string,
    Omit<CreatorVerificationDiagnosticView, "id" | "operationId" | "location"> & {
      count: number;
      locations?: CreatorVerificationDiagnosticView["location"][];
    }
  >();
  for (const { id: _id, operationId: _operationId, location, ...diagnostic } of diagnostics) {
    const key = stableJson(diagnostic);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (
        location &&
        (existing.locations?.length ?? 0) < 12 &&
        !existing.locations?.some((candidate) => stableJson(candidate) === stableJson(location))
      )
        (existing.locations ??= []).push(location);
      continue;
    }
    groups.set(key, {
      ...diagnostic,
      count: 1,
      ...(location ? { locations: [location] } : {}),
    });
  }
  return [...groups.values()].sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right)),
  );
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
    if (isGeneratedPlanParent(change.parent, changes, ownership.projectId)) {
      if (change.parent.path !== parentPath)
        throw new Error("Generated parent does not match the planned destination");
      return;
    }
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
    if (isGeneratedPlanParent(change.parent, changes, ownership.projectId)) {
      if (change.parent.path !== pathParent(destination))
        throw new Error("Generated parent does not match the planned destination");
      return;
    }
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
  const missing: string[] = [];
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
      missing.push(`${path} (${expectedClass})`);
  }
  if (missing.length > 0)
    throw new Error(
      `Verification charter requires an exact class-aware instance_exists check for each planned output: ${missing.join(", ")}`,
    );
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
/** Stable editor identity belongs to the project/entity, not one plan's array order. */
export function creatorGeneratedObjectIdentity(
  projectId: string,
  entityId: string,
): StudioObjectIdentity {
  return {
    kind: "forge_attribute",
    stableId: `forge_game_${contentHash(stableJson({ projectId, entityId })).slice(0, 32)}`,
  };
}

export function creatorCompiledIdentity(
  projectId: string,
  entityId: string,
  suffix: string,
): string {
  return `${suffix}_${contentHash(stableJson({ projectId, entityId })).slice(0, 24)}`;
}

function materializeBuildContractChange(
  change: CreatorPlanChange,
  plan: CreatorPlan,
  observation: CreatorProjectIndexView,
  policies: Readonly<Record<string, CreatorPropertyPolicy>>,
): CreatorBuildContractChange {
  const identity = (suffix: string) => creatorCompiledIdentity(plan.projectId, change.id, suffix);
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
    return {
      planChangeId: change.id,
      operationId,
      kind: "create",
      path: change.path,
      target: {
        kind: "instance",
        identity: creatorGeneratedObjectIdentity(plan.projectId, change.id),
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
  resolveReference: CreatorReferenceResolver,
): StudioChangeOperation {
  const propertyInputs = payload.properties ?? {};
  let properties: Record<string, StudioValue> = {};
  const attributes = payload.attributes ?? {};
  const removedAttributes = payload.removedAttributes ?? [];
  const expected = {
    planChangeId: contractChange.planChangeId,
    kind: contractChange.kind,
    source: contractChange.propertyPolicy.source,
    attributes: contractChange.propertyPolicy.attributes,
  };
  const received = {
    planChangeId: payload.planChangeId,
    properties: Object.keys(propertyInputs),
    attributes: Object.keys(attributes),
    removedAttributes,
    sourceBytes: payload.source === undefined ? 0 : Buffer.byteLength(payload.source, "utf8"),
    sourceEdits: payload.sourceEdits?.length ?? 0,
  };
  const rejectCreativePayload = (message: string): never => {
    throw correctiveFailure("STAGE_PAYLOAD_INVALID", message, {
      received,
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
        { received, expected },
      );
    }
  }
  if (
    contractChange.propertyPolicy.source === "forbidden" &&
    (payload.source !== undefined || payload.sourceEdits !== undefined)
  )
    rejectCreativePayload("This approved change cannot carry source");
  try {
    properties = normalizeCreatorPropertyInputs(
      contractChange.propertyPolicy,
      propertyInputs,
      resolveReference,
    );
    assertPropertiesWithPolicy(contractChange.propertyPolicy, properties);
    assertAttributes(attributes);
  } catch (error) {
    throw correctiveFailure(
      "PROPERTY_NOT_ALLOWED",
      error instanceof Error ? error.message : String(error),
      { received, expected },
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

export interface CreatorDraftLineEdit {
  readonly startLine: number;
  readonly deleteCount: number;
  readonly replacement: string;
}

/** Keep original newline bytes; an empty file has no lines and accepts insertion at 1. */
function draftLines(source: string): string[] {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function creatorDraftPage(source: string, startLine: number, lineCount: number) {
  const lines = draftLines(source);
  if (
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    startLine > lines.length + 1 ||
    !Number.isSafeInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > 200
  )
    throw new ToolFailure(
      "DRAFT_RANGE_INVALID",
      `Read from line 1 through ${lines.length + 1}, with 1–200 lines per page.`,
    );
  const page = lines.slice(startLine - 1, startLine - 1 + lineCount);
  const nextLine = startLine + page.length;
  return {
    sourceHash: contentHash(source),
    lineCount: lines.length,
    lines: page.map((text, index) => ({ line: startLine + index, text })),
    ...(nextLine <= lines.length ? { nextLine } : {}),
  };
}

function draftDiagnosticExcerpts(source: string, issueLines: readonly number[]) {
  const lines = draftLines(source);
  const selected = new Set<number>();
  for (const line of issueLines)
    for (let at = Math.max(1, line - 3); at <= Math.min(lines.length, line + 3); at++)
      selected.add(at);
  return [...selected].sort((a, b) => a - b).map((line) => ({ line, text: lines[line - 1]! }));
}

/** Exact line ranges against one immutable source hash. No searching or partial writes. */
export function patchCreatorDraftSource(
  source: string,
  expectedHash: string,
  edits: readonly CreatorDraftLineEdit[],
): string {
  if (contentHash(source) !== expectedHash)
    throw new ToolFailure(
      "DRAFT_SOURCE_CHANGED",
      "The draft changed. Read its current lines and sourceHash with studio.read_drafts before retrying.",
    );
  if (edits.length === 0 || edits.length > 64)
    throw new ToolFailure("DRAFT_PATCH_INVALID", "Supply 1–64 exact draft edits.");
  const lines = draftLines(source);
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length);
  const issues: string[] = [];
  const ranges = edits
    .flatMap((edit, index) => {
      if (
        !Number.isSafeInteger(edit.startLine) ||
        !Number.isSafeInteger(edit.deleteCount) ||
        edit.startLine < 1 ||
        edit.deleteCount < 0 ||
        edit.startLine > lines.length + 1 ||
        edit.startLine - 1 + edit.deleteCount > lines.length ||
        typeof edit.replacement !== "string"
      ) {
        issues.push(
          `Edit ${index + 1}: range is outside the ${lines.length}-line draft. Use 1-based startLine and a nonnegative deleteCount.`,
        );
        return [];
      }
      const start = offsets[edit.startLine - 1]!;
      const end = offsets[edit.startLine - 1 + edit.deleteCount]!;
      if (
        start === source.length &&
        source.length &&
        !source.endsWith("\n") &&
        edit.replacement.length &&
        !edit.replacement.startsWith("\n")
      )
        issues.push(
          `Edit ${index + 1}: append after an unterminated line must begin with a newline, or replace that final line.`,
        );
      if (edit.replacement.length && end < source.length && !edit.replacement.endsWith("\n"))
        issues.push(
          `Edit ${index + 1}: replacement must end with a newline before the following untouched line.`,
        );
      return [{ ...edit, index, start, end }];
    })
    .sort((left, right) => left.start - right.start);
  if (issues.length)
    throw new ToolFailure(
      "DRAFT_PATCH_RANGE",
      `${issues.join("\n")} No edits were applied; the source hash is unchanged.`,
    );
  for (let index = 1; index < ranges.length; index++)
    if (
      ranges[index]!.start < ranges[index - 1]!.end ||
      ranges[index]!.start === ranges[index - 1]!.start
    )
      throw new ToolFailure(
        "DRAFT_PATCH_OVERLAP",
        `Edits ${ranges[index - 1]!.index + 1} and ${ranges[index]!.index + 1} overlap. Combine them into one line range against the original draft. No edits were applied; the source hash is unchanged.`,
      );
  let result = source;
  for (const edit of ranges.reverse())
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

/** Observed layout facts are advice, never evidence of client rendering quality. */
export function creatorLayoutNotes(properties: Readonly<Record<string, StudioValue>>): string[] {
  const size = properties.Size;
  const automatic = properties.AutomaticSize;
  if (size?.kind !== "udim2" || automatic?.kind !== "enum_name" || automatic.value !== "None")
    return [];
  const collapsed = [size.x, size.y].some((axis) => axis.scale === 0 && axis.offset <= 0);
  return collapsed
    ? [
        "This GUI has a zero-size axis and AutomaticSize is None. Before adding visible controls, plan an update to its Size/Position/AnchorPoint or deliberate automatic sizing. Child layout does not resize a fixed parent. Check available space, padding and viewport fit.",
      ]
    : [];
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
  resolveReference: CreatorReferenceResolver,
): Record<string, StudioValue> {
  const allowed = new Map(policy.allowedProperties.map((property) => [property.name, property]));
  return Object.fromEntries(
    Object.entries(properties).map(([name, input]) => {
      const rule = allowed.get(name);
      if (!rule)
        throw new Error(
          name === "Font" && allowed.has("FontFace")
            ? 'Use FontFace with {family, weight, style}, for example {family:"rbxasset://fonts/families/BuilderSans.json", weight:"Regular", style:"Normal"}.'
            : `Property ${name} is unavailable for this change. Supported properties: ${[...allowed.keys()].join(", ") || "none"}`,
        );
      const value = normalizeCreatorPropertyInput(name, input, rule, resolveReference);
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
  resolveReference?: CreatorReferenceResolver;
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
  const value = normalizeCreatorPropertyInput(
    input.propertyName,
    input.value,
    rule,
    input.resolveReference,
  );
  assertStudioValueConstraints(input.propertyName, value, rule.constraints);
  assertStudioValueForProperty(value, property);
  return value;
}

function normalizeCreatorPropertyInput(
  name: string,
  input: CreatorPropertyInput,
  rule: CreatorPropertyPolicy["allowedProperties"][number],
  resolveReference?: CreatorReferenceResolver,
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
    const degrees = input.rotation ?? { x: 0, y: 0, z: 0 };
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
    ("objectId" in input || "changeId" in input) &&
    expectedKind === "instance_ref"
  ) {
    if (!resolveReference)
      throw new Error(`Property ${name} requires a host-resolved objectId or changeId`);
    const target = resolveReference(input);
    const expectedClass = rule.constraints?.referenceClass;
    if (expectedClass === undefined || !isRobloxClassAssignableTo(target.className, expectedClass))
      throw new Error(
        `Property ${name} requires a stable reference assignable to ${expectedClass ?? "its manifest class"}`,
      );
    return canonicalStudioValue({
      kind: expectedKind,
      state: "reference",
      identity: target.identity,
      path: target.path,
      className: target.className,
      expectedClass,
    });
  }
  throw new Error(
    `Property ${name} expects ${modelPropertyInputDescription(expectedKind)}; received a different JSON shape`,
  );
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
    if (!isGeneratedOperationParent(operation.parent, transactionOperations)) {
      const parent = assertExactPlanParent(operation.parent, operation.parent.path, observation);
      assertStudioStructuralParent(operation.parent, parent, ownership, {
        operationId: operation.id,
        operationKind: operation.kind,
        targetPath: operation.target.path,
      });
    }
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
    if (!isGeneratedOperationParent(operation.parent, transactionOperations)) {
      const parent = assertExactPlanParent(operation.parent, operation.parent.path, observation);
      assertStudioStructuralParent(operation.parent, parent, ownership, {
        operationId: operation.id,
        operationKind: operation.kind,
        targetPath: `${operation.parent.path}/${operation.name}`,
      });
    }
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
function isGeneratedPlanParent(
  parent: StudioMutationParent,
  changes: readonly CreatorPlanChange[],
  projectId: string,
): boolean {
  if (parent.kind !== "instance") return false;
  const created = changes.find((change) => change.kind === "create" && change.path === parent.path);
  if (!created || created.kind !== "create") return false;
  if (
    created.className !== parent.className ||
    stableJson(parent.identity) !==
      stableJson(creatorGeneratedObjectIdentity(projectId, created.id))
  )
    throw new Error("Generated parent identity or class does not match the exact planned object");
  canonicalParentPath(parent.path);
  return true;
}

function isGeneratedOperationParent(
  parent: StudioMutationParent,
  operations: readonly StudioChangeOperation[],
): boolean {
  if (parent.kind !== "instance") return false;
  const created = operations.find(
    (operation) =>
      operation.kind === "create" &&
      stableJson(operation.target.identity) === stableJson(parent.identity),
  );
  if (!created || created.kind !== "create") return false;
  if (created.target.path !== parent.path || created.className !== parent.className)
    throw new Error("Generated transaction parent does not match its allocated target");
  return true;
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
      "transaction_retry_build",
      "transaction_resume_build",
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
export const CREATOR_SESSION_TRANSITIONS: Readonly<
  Record<CreatorSessionStatus, readonly CreatorSessionStatus[]>
> = {
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
    "refining_plan",
    "preflighting",
    "refresh_required",
    "creator_rejected",
    "incomplete",
  ],
  preflighting: ["applying", "refresh_required", "incomplete"],
  applying: [
    "committing",
    "awaiting_verification",
    "awaiting_source_sync",
    "cancelling",
    "incomplete",
    "recovery_required",
  ],
  awaiting_verification: [
    "committing",
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
  committing: [
    "committing",
    "awaiting_change_approval",
    "completed",
    "awaiting_review",
    "incomplete",
    "recovery_required",
  ],
  repairing: ["awaiting_change_approval", "refresh_required", "incomplete"],
  refresh_required: ["refreshing", "incomplete", "recovery_required"],
  refreshing: [
    "completed",
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
    "committing",
    "completed",
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
  completed: [],
  creator_accepted: [],
  creator_rejected: ["rolled_back"],
  rolled_back: [],
  incomplete: ["building", "awaiting_change_approval", "refresh_required", "incomplete"],
  recovery_required: ["committing", "cancelling", "awaiting_source_sync", "incomplete"],
};
function assertTransition(from: CreatorSessionStatus, to: CreatorSessionStatus): void {
  if (!CREATOR_SESSION_TRANSITIONS[from].includes(to))
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
      "completed",
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

const CREATOR_PRESENTATION_GUIDANCE =
  'Write all creator-facing prose in GitHub-flavored Markdown. Lead with the useful answer or next step. Use short paragraphs, concise lists, and headings only when they help. Display Roblox hierarchy paths with dots, e.g. Workspace.Airlock.OuterDoor, and bracket notation for names containing spaces, punctuation or Luau keywords (e.g. StarterGui.HUD["Control Panel"]). Slash-separated paths returned by tools are exact internal handles: preserve those bytes in tool arguments, but use Roblox notation in public prose. Filesystem paths keep their original separators. Use inline code for paths, API names, and identifiers; put code examples in fenced code blocks with a language such as luau. Never wrap the entire response in a code fence or emit HTML. Keep internal bookkeeping, journal semantics, and implementation jargon out of the conversation unless requested. Markdown belongs only in prose fields such as answer text, clarification questions, and plan step summaries; tool arguments remain exact schema-valid JSON, and identifiers, paths, enums, staged source, and property values must not acquire Markdown formatting. Include activity in substantive tool calls: a concise public, feature-level summary of what you are working toward, under 120 characters. For example: Connecting the airlock controls to the server. Keep it stable across related calls; do not narrate individual tool operations, private reasoning, bookkeeping, or claim unverified success. No extra request or tool call just for progress. Plan steps should each be one concise sentence about the intended result. Review items should be brief, direct things the user can try; omit Creator review prefixes, evidence terminology and machine-check descriptions. Final answers and plans use the dedicated outcome tools.';

export const CREATOR_PLANNER_SYSTEM_PROMPT = `You are Forge, the creator's Roblox project collaborator. Explore current facts with project.search, project.children and project.inspect; batch independent reads. Use game.catalog to obtain the installed recipe definitions and their exact locks. Propose a GameDesignSpec composed of ordinary source_package nodes and optional recipe_instance nodes. There is no required genre, round, countdown, terminal state, reset, scene or UI. New mechanics use normal Luau source packages; use a recipe only when its documented semantics fit the request.

For a game request, include architecture describing the actual game concepts the creator will recognize. Give the game a name and each system or component a stable ID, readable name, purpose, and exact componentIds for its implementation. Organize substantial gameplay systems with their concrete player-facing components as children so the creator can expand them on the game map. Relationships explain how those systems interact. Optionally choose a single Unicode emoji as icon for the game and each concept. Choose concepts from the request and planned behavior, without a fixed genre or system vocabulary. Do not present file names, hashes, runtime packages, build stages or implementation categories as game systems. Every leaf must bind declared implementation components. This map is reviewed design intent, not proof that its behavior works. Standalone utility or source-only edits may omit architecture when no game map is relevant.

Planning is read-only. Declare stable component/file IDs, exact editor placements, source imports and source slots with byte budgets. Copy known locked source hashes only from host evidence; never invent future source hashes. Copy recipe locks from game.catalog. Configure recipe structure and locked values now; declare constrained value slots only where Build must choose a value. The host expands the full object/source inventory for exact creator acceptance, then Build fills only approved slots. Runtime Instance creation by installed game code is separate from editor mutation authority.

Inspect existing targets and parent anchors before selecting them. project.inspect returns exact target identities and before hashes; copy those values rather than reconstructing them. Source edits require hash-verified source inspection and dependency closure. When scriptCount is zero there is no existing source to search. Use studio.api_lookup only for missing Roblox API facts. For UI changes inspect existing container sizing and layout. Plan responsive sizing, readable contrast, spacing, focus and viewport fit alongside behavior. Use creator-visible reviews for visual judgment, play behavior and evidence the fixed observers cannot establish.

Publish exactly one outcome: creator.answer, creator.request_clarification for a material blocking question, or creator.propose_plan with design, inspectionObjectIds, checks and reviews. Forge derives existence and source-syntax checks. Do not stage a candidate, weaken the request, invent hidden criteria or include undeclared dependencies. Once an outcome is published, the phase is complete.

${CREATOR_PRESENTATION_GUIDANCE}`;
export const CREATOR_BUILDER_SYSTEM_PROMPT = `You are Forge's Studio builder. Implement the accepted modular design in its declared source and value slots. Forge compiles the complete graph and applies bounded transactions under the creator's exact plan acceptance.

WORKFLOW
- The approved observedObjects contain bounded evidence pages from the exact revision inspected during planning. Use supplied facts directly. Only when a needed fact is absent, use studio.read_observations with observationRevisionHash and its nextCursor or exact field names (property:Color, attribute:Purpose, tags); it retrieves immutable approved evidence without querying Studio. An incomplete page never proves an omitted field absent. source.read is present only when the approved consultation closure contains readable source.
- Call studio.build once with sources and values arrays covering each custom slot exactly once, plus a concise final Markdown summary. Locked package sources, geometry and component internals are supplied by Forge. A complete virtual build runs local review before Studio writes.
- Treat the generated studio.build schema as the only property-input format. Each offered property has one exact JSON shape; copy its lower-case field names and do not invent engine component aliases. Use {changeId} when one new object references another object created in this Build.
- An eligible studio.build result completes Build without another model request. If it is rejected, use the grouped diagnostics and supplied excerpts. Read multiple missing draft ranges together with studio.read_drafts only when the excerpts are insufficient, then apply every independent correction together in one studio.repair call. An eligible repair also completes Build immediately.
- Source slots take complete source for both new scripts and reviewed replacements. Forge checks the approved previous source hash and converts replacements into the fixed source-write contract. Ordinary Luau modules can implement any declared behavior; rounds, countdowns, terminal states, scene recipes, UI and networking are optional.
- studio.repair preserves omitted properties and source lines. Use the latest operationHash or sourceHash exactly; stale or invalid repair batches change nothing. Do not repeat accepted work already present in the current Build checkpoint.

LUAU AND SECURITY
- Use accurate strict types; never disable analysis, add broad any casts, duplicate modules, or weaken behavior to pass it. Roblox module resolution follows inferred GetService/WaitForChild chains: local storage = game:GetService("ReplicatedStorage"); local system = storage:WaitForChild("System"); require(system:WaitForChild("Protocol")). Keep casts out of require arguments and their instance-path aliases.
- Review callable APIs versus properties, finite numeric validation (including computed distances and every untrusted numeric component), authorization, replay protection, rate limiting, cleanup, and cancellation. Unknown/NaN/infinite values must fail closed.
- Review each client-callable route independently. An action name alone grants no world interaction authority. Remote routes must enforce the same prerequisites, distance and enabled checks, or exclude prompt-only actions. Rate-limit before parsing or ANY rejection response/broadcast; exhausted callers receive no expensive response.
- Bound replay memory for the entire player session. A monotonic request counter must not reset on respawn or wrap on the client while the server retains its high-water mark. At exhaustion stop issuing requests; clean up player state on departure.
- Validate legal transitions before changing cancellation generations. Recheck cancellation after each yield before state mutation. Mutable state narrowed before a yield can be stale at runtime; inspect a fresh snapshot when validating the resumed phase.

GUI AND CAPABILITIES
- Use inspected parent bounds. UDim2 scale is a fraction of the parent, offset is pixels. Set the approved container's Size/Position/AnchorPoint, account for every row and spacing, and use responsive child widths plus padding. Never leave controls inside a zero-size fixed parent. Set distinct LayoutOrder values, legible fonts, deliberate button colors, and room for wrapping.
- Property Color3 channels are 0..1. Use supplied property rules and previous lookup results; call studio.api_lookup only for missing or uncertain API facts. Catalog facts are neither mutation authority nor gameplay proof.
- Never execute source, invent structural fields, read outside approved scope, or claim a passed Play test from local analysis.

${CREATOR_PRESENTATION_GUIDANCE}`;

/** Facts are bounded pages of approved immutable observations, never new authority. */
export function creatorBuilderObservationPage(
  projectIndex: CreatorProjectIndexView,
  contract: CreatorBuildContract,
  request: { objectId: string; revisionHash: string; cursor?: string; fields?: string[] },
  maximumFactBytes = 8 * 1024,
) {
  if (
    request.revisionHash !== projectIndex.revision.hash ||
    request.revisionHash !== contract.initialRevisionHash
  )
    throw new ToolFailure(
      "OBSERVATION_REVISION_MISMATCH",
      "Use the exact approved observation revision.",
    );
  const instance = projectIndex.instances.find((item) => item.objectId === request.objectId);
  if (!instance || !contract.initialInspectionPaths.includes(instance.path))
    throw new ToolFailure(
      "OBSERVATION_NOT_APPROVED",
      "The object was not inspected within the approved plan.",
    );
  if (
    !Number.isSafeInteger(maximumFactBytes) ||
    maximumFactBytes < 0 ||
    maximumFactBytes > 8 * 1024
  )
    throw new Error("Invalid observation page budget");
  const facts = [
    ...Object.entries(instance.properties).map(([name, value]) => ({
      field: `property:${name}`,
      value: creatorBuilderObservedValue(value),
    })),
    ...Object.entries(instance.attributes).map(([name, value]) => ({
      field: `attribute:${name}`,
      value,
    })),
    { field: "tags", value: instance.tags },
  ].sort((left, right) => left.field.localeCompare(right.field));
  if (
    request.fields &&
    (new Set(request.fields).size !== request.fields.length ||
      request.fields.some((field) => !facts.some((fact) => fact.field === field)))
  )
    throw new ToolFailure(
      "OBSERVATION_FIELD_MISSING",
      "Every requested field must exist in the approved observation.",
    );
  const selected = request.fields
    ? facts.filter((fact) => request.fields!.includes(fact.field))
    : facts;
  const binding = contentHash(
    stableJson({
      revisionHash: request.revisionHash,
      objectId: request.objectId,
      fields: request.fields ? [...request.fields].sort() : null,
    }),
  );
  let offset = 0;
  if (request.cursor) {
    const [cursorBinding, cursorOffset, extra] = request.cursor.split(":");
    if (
      extra !== undefined ||
      cursorBinding !== binding ||
      !/^(0|[1-9][0-9]*)$/.test(cursorOffset ?? "")
    )
      throw new ToolFailure(
        "OBSERVATION_CURSOR_INVALID",
        "The observation cursor belongs to another object, revision or field selection.",
      );
    offset = Number(cursorOffset);
    if (!Number.isSafeInteger(offset) || offset >= selected.length)
      throw new ToolFailure(
        "OBSERVATION_CURSOR_INVALID",
        "The observation cursor is outside this immutable page sequence.",
      );
  }
  const page: Array<{ field: string; value: unknown }> = [];
  let bytes = 2;
  let next = offset;
  while (next < selected.length) {
    const fact = selected[next]!;
    const size = Buffer.byteLength(stableJson(fact), "utf8") + (page.length ? 1 : 0);
    if (bytes + size > maximumFactBytes) break;
    page.push(fact);
    bytes += size;
    next += 1;
  }
  return {
    objectId: instance.objectId,
    revisionHash: request.revisionHash,
    facts: page,
    complete: next === selected.length,
    ...(next < selected.length ? { nextCursor: `${binding}:${next}` } : {}),
    ...(next === offset && next < selected.length
      ? {
          deferredField: selected[next]!.field,
          deferredFieldBytes: Buffer.byteLength(stableJson(selected[next]), "utf8"),
        }
      : {}),
  };
}

function creatorBuilderObservedValue(value: StudioValue): unknown {
  if (value.kind === "nil") return null;
  if (
    value.kind === "boolean" ||
    value.kind === "number_f32" ||
    value.kind === "number_f64" ||
    value.kind === "int32" ||
    value.kind === "int64_decimal" ||
    value.kind === "string_utf8" ||
    value.kind === "content" ||
    value.kind === "enum_name"
  )
    return value.value;
  if (value.kind === "vector2_f32") return { x: value.x, y: value.y };
  if (value.kind === "vector3_f32") return { x: value.x, y: value.y, z: value.z };
  if (value.kind === "udim") return { scale: value.scale, offset: value.offset };
  if (value.kind === "udim2") return { x: { ...value.x }, y: { ...value.y } };
  if (value.kind === "color3_rgb8") return { r: value.r / 255, g: value.g / 255, b: value.b / 255 };
  if (value.kind === "font")
    return { family: value.family, weight: value.weight, style: value.style };
  return value;
}

export function creatorBuilderSystemPrompt(
  plan: CreatorPlan,
  contract: CreatorBuildContract,
  projectIndex: CreatorProjectIndexView,
  verificationFeedback: readonly string[] = [],
): string {
  assertCreatorPlan(plan);
  assertCreatorBuildContract(contract);
  assertCreatorProjectIndexView(projectIndex);
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
  let remainingObservationBytes = 16 * 1024;
  const context = {
    observationRevisionHash: projectIndex.revision.hash,
    steps: plan.steps,
    qualityRequirements: plan.charter.clauses
      .filter(
        (clause) =>
          clause.kind === "creator_review" ||
          (clause.kind === "studio_check" && clause.check !== "instance_exists"),
      )
      .map((clause) => clause.statement),
    observedObjects: contract.initialInspectionPaths.flatMap((path) => {
      const instance = projectIndex.instances.find((candidate) => candidate.path === path);
      if (!instance) return [];
      const script = projectIndex.scripts.find(
        (candidate) => candidate.documentId === instance.objectId,
      );
      const evidence = creatorBuilderObservationPage(
        projectIndex,
        contract,
        {
          objectId: instance.objectId,
          revisionHash: projectIndex.revision.hash,
        },
        Math.min(2 * 1024, remainingObservationBytes),
      );
      remainingObservationBytes = Math.max(
        0,
        remainingObservationBytes - Buffer.byteLength(stableJson(evidence.facts), "utf8"),
      );
      return [
        {
          objectId: instance.objectId,
          path: instance.path,
          className: instance.className,
          evidence,
          layoutNotes: creatorLayoutNotes(instance.properties),
          ...(instance.position ? { position: instance.position } : {}),
          ...(script
            ? {
                source: {
                  documentId: script.documentId,
                  sourceHash: script.sourceHash,
                  utf8Bytes: script.utf8Bytes,
                },
              }
            : {}),
        },
      ];
    }),
    design: plan.compiled.design,
    compiledInventory: { count: plan.compiled.inventory.length, hash: plan.compiled.hash },
    sourceSlots: plan.compiled.inventory
      .filter((item) => item.source)
      .map((item) => ({
        id: item.id,
        componentId: item.componentId,
        path: item.change.kind === "create" ? item.change.path : item.change.target.path,
        ...item.source,
      })),
    valueSlots: plan.compiled.inventory.flatMap((item) =>
      item.valueSlots.map((slot) => ({
        ...slot,
        operationId: item.id,
        path: item.change.kind === "create" ? item.change.path : item.change.target.path,
      })),
    ),
  };
  return `${CREATOR_BUILDER_SYSTEM_PROMPT}\n\nApproved compiled design. Fill each source content slot and value slot exactly once. Locked sources and properties are materialized by Forge. Use the exact studio.build schema for property input; the host converts those inputs to canonical values. The creator request is in the conversation message.\n${stableJson(context)}${verificationFeedback.length === 0 ? "" : `\n\nForge verification facts from the prior approved attempt follow as canonical data. Repair within the accepted slots:\n${stableJson({ verificationFeedback: [...verificationFeedback] })}`}`;
}
