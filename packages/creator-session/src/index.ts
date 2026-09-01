import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";
import { z, type ZodRawShape } from "zod";
import type {
  AgentRuntime,
  AgentRuntimeResult,
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
  assertCreatorPhaseOutcome,
} from "../../agent-runtime/src/index.js";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  compileCreatorOrientation,
  type AgentOrientation,
} from "../../context-compiler/src/index.js";
import { analyzeWithRobloxLuau } from "../../luau-toolchain/src/index.js";
import type { ModelToolCall } from "../../model-client/src/contracts.js";
import {
  CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
  STUDIO_RESOLVABLE_CLASSES,
  type StudioResolvableClass,
} from "../../studio-capabilities/src/index.js";
import { assertStudioProjectState } from "../../semantic-map/src/index.js";
import {
  STUDIO_AUTHORING_ROOTS,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CODECS,
  STUDIO_SCRIPT_CLASSES,
  STUDIO_WRITABLE_CLASSES,
  assertStudioValue,
  assertStudioValueForProperty,
  canonicalStudioValue,
  isRobloxClassAssignableTo,
  lookupRobloxApiCatalog,
  type StudioCapabilityAttestationGrade,
  type StudioProjectState,
  type StudioValue,
} from "../../studio-evidence/src/index.js";

export * from "./mutation-evidence.js";

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
export type StudioOwner = "studio" | "external_rojo";

export type CreatorSessionStatus =
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_change_approval"
  | "preflighting"
  | "applying"
  | "awaiting_verification"
  | "verifying"
  | "cancelling"
  | "committing"
  | "repairing"
  | "awaiting_review"
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
  entries: Array<{
    stableId: string;
    path: string;
    className: string;
    owner: StudioOwner;
    writable: boolean;
  }>;
  policy: "studio_single_writer_external_rojo_read_only";
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
      className: StudioScriptClass;
      initialization: "inline_source_required";
    }
  | {
      id: string;
      kind: "create";
      path: string;
      className: StudioNonScriptWritableClass;
      initialization: "initial_properties";
    }
  | {
      id: string;
      kind: "update";
      path: string;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "move";
      fromPath: string;
      toPath: string;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "delete";
      path: string;
      expectedClass: StudioWritableClass;
    }
  | {
      id: string;
      kind: "write_source";
      path: string;
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
  projectStateHash: string;
  ownershipMapId: string;
  ownershipMapHash: string;
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
      stableId: string;
      path: string;
      className: string;
    };

export type StudioChangeOperation =
  | {
      id: string;
      planChangeId: string;
      kind: "create";
      tempId: string;
      parentPath: string;
      className: StudioWritableClass;
      name: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      source?: string;
    }
  | {
      id: string;
      planChangeId: string;
      kind: "update";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      removedAttributes: string[];
    }
  | {
      id: string;
      planChangeId: string;
      kind: "move";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
      parentPath: string;
      name: string;
      properties: Record<string, StudioValue>;
      attributes: Record<string, string | number | boolean>;
      removedAttributes: string[];
    }
  | {
      id: string;
      planChangeId: string;
      kind: "delete";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
    }
  | {
      id: string;
      planChangeId: string;
      kind: "write_source";
      stableId: string;
      expectedPath: string;
      expectedClass: "Script" | "LocalScript" | "ModuleScript";
      beforeSourceHash: string;
      source: string;
      attributes: Record<string, string | number | boolean>;
      removedAttributes: string[];
    };

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
  initialRevisionHash: string;
  initialInspectionPaths: string[];
  propertyPolicies: Record<StudioWritableClass, CreatorPropertyPolicy>;
  changes: CreatorBuildContractChange[];
}

export interface CreatorPropertyPolicy {
  allowedProperties: Array<{
    name: string;
    valueKinds: StudioValue["kind"][];
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
      parentPath: string;
      name: string;
      className: StudioWritableClass;
      tempId: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "update";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "move";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
      parentPath: string;
      name: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "delete";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioWritableClass;
      beforeHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    }
  | {
      planChangeId: string;
      operationId: string;
      kind: "write_source";
      stableId: string;
      expectedPath: string;
      expectedClass: StudioScriptClass;
      beforeSourceHash: string;
      propertyPolicy: CreatorPropertyPolicy;
    };

export interface CreatorStagePayload {
  planChangeId: string;
  properties?: Record<string, CreatorPropertyInput>;
  attributes?: Record<string, string | number | boolean>;
  removedAttributes?: string[];
  source?: string;
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
  expectedRevisionHash: string;
  operations: StudioChangeOperation[];
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
  text: string;
}

export interface CreatorSessionBundle {
  session: CreatorSession;
  creatorRequest: ArtifactReference;
  ownership: StudioOwnershipMap;
  observation: StudioProjectState;
  observationHistory: Array<{
    revisionHash: string;
    observation: StudioProjectState;
  }>;
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
   * after an exact commit/cancel acknowledgement and its post-finalize state
   * evidence have been persisted.
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
  stage:
    | "preflighted"
    | "recording_may_be_open"
    | "provisional"
    | "recovery_cancelled";
  changeSetId: string;
  changeSetHash: string;
  projectionId: string;
  projectionHash: string;
  beforeRevisionHash: string;
  recordingId?: string;
  manifest: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  attestation: import("./mutation-evidence.js").CreatorMutationArtifactEvidence;
  changeSet: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  projection: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  preflight: import("./mutation-evidence.js").CreatorMutationArtifactEvidence;
  beforeState: import("./mutation-evidence.js").CreatorMutationArtifactStateEvidence;
  directReadback?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  afterState?: import("./mutation-evidence.js").CreatorMutationArtifactStateEvidence;
  reconciliation?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  executionFailure?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  verificationPlan?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  verificationDraft?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  recoveryFinalization?: import("./mutation-evidence.js").CreatorMutationArtifactBinding;
  finalState?: import("./mutation-evidence.js").CreatorMutationArtifactStateEvidence;
}

export type CreatorControlActionId =
  | "approve_plan"
  | "reject_plan"
  | "approve_and_apply_changes"
  | "reject_changes"
  | "start_checks"
  | "accept_result"
  | "reject_and_rollback"
  | "cancel_changes"
  | "cancel_interrupted_recording";
export interface CreatorControlActionDescriptor {
  id: CreatorControlActionId;
  label: string;
  intent: "primary" | "secondary";
  requiresReport?: boolean;
}
export interface CreatorControlView {
  kind: "CreatorControlView";
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
    projectState?: ArtifactReference;
    mutationReconciliation?: ArtifactReference;
    mutationFinalization?: ArtifactReference;
    runtimeEvidence?: ArtifactReference;
    verification?: ArtifactReference;
    reviewReport?: ArtifactReference;
    agentRun?: ArtifactReference;
    trace?: ArtifactReference;
  };
  verification?: {
    id: string;
    status: "passed" | "failed" | "incomplete" | "not_run";
    failureFacts: Array<{ statement: string; hash: string }>;
    replayable: boolean;
  };
  mutation?: {
    attemptId: string;
    status:
      | "preflighting"
      | "preflight_failed"
      | "provisional"
      | "matched"
      | "mismatched"
      | "incomplete"
      | "cancelled"
      | "committed"
      | "rolled_back"
      | "recovery_required";
    failureFacts: Array<{ statement: string; hash: string }>;
    replayable: boolean;
    projectionFactCount: number;
  };
  primaryAction?: CreatorControlActionDescriptor;
  secondaryAction?: CreatorControlActionDescriptor;
}

export type CreatorProgressStageId =
  | "request"
  | "plan"
  | "change"
  | "studio"
  | "review";
export interface CreatorProgressStage {
  id: CreatorProgressStageId;
  label: "Request" | "Plan" | "Change" | "Studio" | "Review";
  status: "pending" | "active" | "complete" | "blocked" | "failed";
  authority: "creator" | "agent" | "forge" | "studio";
  detail: string;
}
export interface CreatorSessionSummary {
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
export interface CreatorDashboardState {
  kind: "CreatorDashboardState";
  selectedSessionId?: string;
  sessions: CreatorSessionSummary[];
  controlView?: CreatorControlView;
  stages: CreatorProgressStage[];
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
    message: string;
  };
  serverTime: string;
}

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
  plan?: CreatorPlan;
};

export type CreatorBuilderExecution = {
  runtimeResult: AgentRuntimeResult;
  toolHost: CreatorBuilderToolHost;
  systemPrompt: string;
  finalization: CreatorPhaseFinalization;
  changeSet?: CreatorChangeSet;
};

export function createCreatorControlView(
  input: Omit<CreatorControlView, "kind" | "id" | "hash">,
): CreatorControlView {
  const canonical = JSON.parse(stableJson(input)) as Omit<
    CreatorControlView,
    "kind" | "id" | "hash"
  >;
  const hash = contentHash(stableJson(canonical));
  const view: CreatorControlView = {
    kind: "CreatorControlView",
    id: `creator_control_view_${hash.slice(0, 24)}`,
    hash,
    ...canonical,
  };
  assertCreatorControlView(view);
  return view;
}

export function assertCreatorControlView(
  value: unknown,
): asserts value is CreatorControlView {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorControlView" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.creatorSessionId) ||
    !isHash(value.creatorSessionHash) ||
    !isStatus(value.status) ||
    typeof value.title !== "string" ||
    typeof value.detail !== "string"
  )
    throw new Error("Invalid CreatorControlView");
  const actions: unknown[] = [
    value.primaryAction,
    value.secondaryAction,
  ].filter((action) => action !== undefined);
  if (actions.length > 2 || !actions.every(isControlActionDescriptor))
    throw new Error("Invalid CreatorControlView actions");
  if (new Set(actions.map((action) => action.id)).size !== actions.length)
    throw new Error("Invalid CreatorControlView actions");
  if (
    value.primaryAction !== undefined &&
    (!isRecord(value.primaryAction) || value.primaryAction.intent !== "primary")
  )
    throw new Error("Invalid CreatorControlView primary action");
  if (
    value.secondaryAction !== undefined &&
    (!isRecord(value.secondaryAction) ||
      value.secondaryAction.intent !== "secondary")
  )
    throw new Error("Invalid CreatorControlView secondary action");
  if (value.artifact !== undefined) {
    if (
      !isRecord(value.artifact) ||
      !["plan", "change_set"].includes(String(value.artifact.kind)) ||
      !isId(value.artifact.id) ||
      !isHash(value.artifact.hash) ||
      !isHash(value.artifact.presentationHash) ||
      contentHash(stableJson(value.artifact.presentation)) !==
        value.artifact.presentationHash
    )
      throw new Error("Invalid CreatorControlView artifact");
  }
  if (
    value.evidence !== undefined &&
    (!Array.isArray(value.evidence) ||
      !value.evidence.every(isCreatorEvidencePresentation))
  )
    throw new Error("Invalid CreatorControlView evidence");
  if (
    value.creatorReviewPrompts !== undefined &&
    (!Array.isArray(value.creatorReviewPrompts) ||
      value.creatorReviewPrompts.length > CREATOR_MAX_CHARTER_CLAUSES ||
      !value.creatorReviewPrompts.every(
        (prompt) =>
          typeof prompt === "string" &&
          prompt.trim().length > 0 &&
          prompt.length <= 4096,
      ))
  )
    throw new Error("Invalid CreatorControlView review prompts");
  if (value.artifacts !== undefined) {
    if (!isRecord(value.artifacts))
      throw new Error("Invalid CreatorControlView artifacts");
    for (const reference of Object.values(value.artifacts))
      assertArtifactReference(reference);
  }
  if (value.verification !== undefined) {
    if (
      !isRecord(value.verification) ||
      !isId(value.verification.id) ||
      !["passed", "failed", "incomplete", "not_run"].includes(
        String(value.verification.status),
      ) ||
      typeof value.verification.replayable !== "boolean" ||
      !Array.isArray(value.verification.failureFacts) ||
      !value.verification.failureFacts.every(
        (fact) =>
          isRecord(fact) &&
          typeof fact.statement === "string" &&
          isHash(fact.hash),
      )
    )
      throw new Error("Invalid CreatorControlView verification");
  }
  if (
    value.mutation !== undefined &&
    (!isRecord(value.mutation) ||
      !isId(value.mutation.attemptId) ||
      ![
        "preflighting",
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
          typeof fact.statement === "string" &&
          isHash(fact.hash),
      ))
  ) throw new Error("Invalid CreatorControlView mutation evidence");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_control_view_${expected.slice(0, 24)}`
  )
    throw new Error("Invalid CreatorControlView identity");
}

export function assertCreatorControlActionBinding(
  view: CreatorControlView,
  action: {
    creatorSessionId: string;
    viewId: string;
    viewHash: string;
    actionId: CreatorControlActionId;
  },
  replayed = false,
): void {
  assertCreatorControlView(view);
  if (
    action.creatorSessionId !== view.creatorSessionId ||
    action.viewId !== view.id ||
    action.viewHash !== view.hash
  )
    throw new Error(
      "Creator action is stale or bound to a different control view",
    );
  if (replayed)
    throw new Error("Creator control view action was already consumed");
  if (
    ![view.primaryAction?.id, view.secondaryAction?.id].includes(
      action.actionId,
    )
  )
    throw new Error(
      "Creator action is not available in the current control view",
    );
}

export function createStudioOwnershipMap(input: {
  projectId: string;
  revisionHash: string;
  observation: StudioProjectState;
  externalRojoPaths?: readonly string[];
}): StudioOwnershipMap {
  assertStudioProjectState(input.observation);
  assertHash(input.revisionHash, "Studio revision");
  const external = [...(input.externalRojoPaths ?? [])]
    .map(canonicalStudioPath)
    .sort();
  if (new Set(external).size !== external.length)
    throw new Error("Rojo ownership paths must be unique");
  const entries = input.observation.instances
    .map((instance) => {
      const matching = external.filter(
        (path) =>
          instance.path === path || instance.path.startsWith(`${path}/`),
      );
      if (
        matching.length > 1 &&
        !matching.every((path) => path.startsWith(matching[0]!))
      )
        throw new Error(`Ambiguous external ownership for ${instance.path}`);
      const owner: StudioOwner =
        matching.length > 0 ? "external_rojo" : "studio";
      return {
        stableId: instance.stableId,
        path: canonicalStudioPath(instance.path),
        className: instance.className,
        owner,
        writable: owner === "studio",
      };
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.stableId.localeCompare(right.stableId),
    );
  if (new Set(entries.map((entry) => entry.stableId)).size !== entries.length)
    throw new Error("Studio snapshot stable IDs must be unique");
  const payload = {
    projectId: input.projectId,
    revisionHash: input.revisionHash,
    entries,
    policy: "studio_single_writer_external_rojo_read_only" as const,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "StudioOwnershipMap",
    id: `studio_ownership_map_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function createCreatorSession(input: {
  prompt: string;
  projectId: string;
  revisionHash: string;
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
  const now = (input.now ?? new Date()).toISOString();
  const promptHash = contentHash(input.prompt);
  const id = `creator_session_${randomUUID()}`;
  return sealSession({
    kind: "CreatorSession",
    id,
    hash: "",
    createdAt: now,
    updatedAt: now,
    status: "planning",
    policy: CREATOR_SESSION_POLICY,
    model: input.model ?? CREATOR_MODEL,
    promptHash,
    projectId: input.projectId,
    initialRevisionHash: input.revisionHash,
    currentRevisionHash: input.revisionHash,
    ownershipMapId: input.ownership.id,
    ownershipMapHash: input.ownership.hash,
    repairsUsed: 0,
  });
}

export function createCreatorPlan(
  input: Omit<
    CreatorPlan,
    "kind" | "id" | "hash" | "charter" | "goal" | "projectStateHash"
  > & {
    creatorPrompt: string;
    charter: { clauses: VerificationCharterProposalClause[] };
  },
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
): CreatorPlan {
  assertStudioProjectState(observation);
  assertOwnershipMap(ownership);
  if (
    input.projectRevisionHash !== ownership.revisionHash ||
    input.ownershipMapId !== ownership.id ||
    input.ownershipMapHash !== ownership.hash
  )
    throw new Error("Creator plan ownership or revision binding mismatch");
  const goal = input.creatorPrompt;
  if (
    goal.length === 0 ||
    goal !== goal.trim() ||
    contentHash(goal) !== input.promptHash
  )
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
  const inspectionPaths = [
    ...new Set(input.inspectionPaths.map(canonicalStudioPath)),
  ].sort();
  if (
    inspectionPaths.length !== input.inspectionPaths.length ||
    inspectionPaths.length > CREATOR_MAX_INSPECTION_PATHS
  )
    throw new Error("Creator plan inspection paths must be unique and bounded");
  for (const path of inspectionPaths)
    if (!observation.instances.some((instance) => instance.path === path))
      throw new Error(
        `Creator plan inspection path is absent from the initial snapshot: ${path}`,
      );
  const changeIds = input.changes.map((change) => change.id);
  if (new Set(changeIds).size !== changeIds.length)
    throw new Error("Creator plan change IDs must be unique");
  assertStepChangeCoverage(input.steps, changeIds);
  input.changes.forEach((change) =>
    assertCreatorPlanChange(change, input.changes, observation, ownership),
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
        (clause.check === "instance_exists" ||
          clause.check === "position_series"),
    )
  )
    throw new Error(
      "Verification charter requires at least one bounded Workspace observation",
    );
  if (
    !input.charter.clauses.some(
      (clause) =>
        clause.kind === "studio_check" &&
        clause.check === "playtest_diagnostics",
    )
  )
    throw new Error(
      "Verification charter must expose its playtest diagnostic thresholds",
    );
  assertPlanOutputCoverage(input.changes, input.charter.clauses);
  assertCreatorRuntimeObservationWindow(input.charter.clauses);
  if (
    input.changes.some(sourceBearingPlanChange) &&
    !input.charter.clauses.some(
      (clause) =>
        clause.kind === "local_check" && clause.check === "luau_syntax",
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
    projectStateHash: studioProjectStateHash(observation),
    ownershipMapId: input.ownershipMapId,
    ownershipMapHash: input.ownershipMapHash,
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

export function assertCreatorApproval(
  value: unknown,
): asserts value is CreatorApproval {
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
  if (
    value.hash !== expected ||
    value.id !== `creator_approval_${expected.slice(0, 24)}`
  )
    throw new Error("Invalid CreatorApproval identity");
}

export function createCreatorBuildContract(input: {
  session: CreatorSession;
  plan: CreatorPlan;
  planApproval: CreatorApproval;
  ownership: StudioOwnershipMap;
  observation: StudioProjectState;
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
    observation: StudioProjectState;
  },
  propertyPolicies: Readonly<Record<string, CreatorPropertyPolicy>>,
): CreatorBuildContract {
  assertCreatorPlan(input.plan);
  assertOwnershipMap(input.ownership);
  assertStudioProjectState(input.observation);
  if (
    input.plan.sessionId !== input.session.id ||
    input.plan.promptHash !== input.session.promptHash ||
    input.plan.ownershipMapId !== input.ownership.id ||
    input.plan.ownershipMapHash !== input.ownership.hash ||
    input.plan.projectRevisionHash !== input.session.initialRevisionHash ||
    input.plan.projectStateHash !==
      studioProjectStateHash(input.observation) ||
    input.planApproval.decision !== "approved" ||
    input.planApproval.artifactKind !== "plan" ||
    input.planApproval.artifactId !== input.plan.id ||
    input.planApproval.artifactHash !== input.plan.hash
  )
    throw new Error(
      "Creator build contract plan or Studio-state binding mismatch",
    );
  const changes = input.plan.changes.map((change) =>
    materializeBuildContractChange(
      change,
      input.plan,
      input.observation,
      propertyPolicies,
    ),
  );
  const initialInspectionPaths = [
    ...new Set([
      ...changes.flatMap(contractInspectionPaths),
      ...input.plan.inspectionPaths,
    ]),
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
    initialRevisionHash: input.session.currentRevisionHash,
    initialInspectionPaths,
    propertyPolicies:
      propertyPolicies as Record<StudioWritableClass, CreatorPropertyPolicy>,
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

export function assertCreatorBuildContract(
  value: unknown,
): asserts value is CreatorBuildContract {
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
    new Set(value.initialInspectionPaths).size !==
      value.initialInspectionPaths.length ||
    stableJson([...value.initialInspectionPaths].sort()) !==
      stableJson(value.initialInspectionPaths) ||
    value.initialInspectionPaths.some(
      (path) => canonicalStudioPath(path) !== path,
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
  const changeIds = new Set<string>();
  for (const change of value.changes) {
    if (
      !isRecord(change) ||
      !isId(change.planChangeId) ||
      !isId(change.operationId) ||
      !["create", "update", "move", "delete", "write_source"].includes(
        String(change.kind),
      ) ||
      changeIds.has(change.planChangeId)
    )
      throw new Error("Invalid CreatorBuildContract change");
    changeIds.add(change.planChangeId);
    if (!isRecord(change.propertyPolicy))
      throw new Error("Invalid CreatorBuildContract change policy");
    assertCreatorPropertyPolicy(change.propertyPolicy);
    const className = String(
      change.kind === "create" ? change.className : change.expectedClass,
    );
    const sealedPolicy = value.propertyPolicies[className];
    if (
      sealedPolicy === undefined ||
      stableJson(change.propertyPolicy) !== stableJson(sealedPolicy)
    )
      throw new Error(
        "CreatorBuildContract change policy is not bound to its sealed class policy",
      );
  }
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_build_contract_${expected.slice(0, 24)}`
  )
    throw new Error("Invalid CreatorBuildContract identity");
}

export function createCreatorChangeSet(
  input: Omit<CreatorChangeSet, "kind" | "id" | "hash">,
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
  plan: CreatorPlan,
  contract: CreatorBuildContract,
): CreatorChangeSet {
  assertStudioProjectState(observation);
  assertOwnershipMap(ownership);
  assertCreatorBuildContract(contract);
  if (
    input.ownershipMapId !== ownership.id ||
    input.ownershipMapHash !== ownership.hash ||
    input.expectedRevisionHash !== contract.initialRevisionHash
  )
    throw new Error(
      "Creator change set ownership or active-revision binding mismatch",
    );
  if (
    input.planId !== plan.id ||
    input.planHash !== plan.hash ||
    input.promptHash !== contract.promptHash ||
    input.charterId !== plan.charter.id ||
    input.charterHash !== plan.charter.hash ||
    input.planApprovalId !== contract.planApprovalId ||
    input.planApprovalHash !== contract.planApprovalHash ||
    input.buildContractId !== contract.id ||
    input.buildContractHash !== contract.hash
  )
    throw new Error("Creator change set plan binding mismatch");
  input.operations.forEach((operation) =>
    assertStudioChangeOperation(operation, observation, ownership),
  );
  if (
    input.operations.length === 0 ||
    input.operations.length > CREATOR_MAX_CHANGES ||
    new Set(input.operations.map((operation) => operation.id)).size !==
      input.operations.length
  )
    throw new Error(
      `Creator change set requires 1-${CREATOR_MAX_CHANGES} uniquely identified operations`,
    );
  const createdPaths = input.operations.flatMap((operation) =>
    operation.kind === "create"
      ? [`${operation.parentPath}/${operation.name}`]
      : [],
  );
  if (new Set(createdPaths).size !== createdPaths.length)
    throw new Error(
      "Creator change set cannot create the same Studio path twice",
    );
  const tempIds = input.operations.flatMap((operation) =>
    operation.kind === "create" ? [operation.tempId] : [],
  );
  if (new Set(tempIds).size !== tempIds.length)
    throw new Error("Creator change set create temp IDs must be unique");
  const existingTargets = input.operations.flatMap((operation) =>
    operation.kind === "create" ? [] : [operation.stableId],
  );
  if (new Set(existingTargets).size !== existingTargets.length)
    throw new Error(
      "Creator change set permits only one operation per existing Studio target",
    );
  assertOperationsMatchPlan(input.operations, plan.changes);
  assertOperationsMatchContract(input.operations, contract);
  const payload = {
    ...input,
    operations: input.operations.map(cloneOperation),
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

export function assertCreatorChangeSet(
  value: unknown,
): asserts value is CreatorChangeSet {
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
    !isHash(value.expectedRevisionHash) ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > CREATOR_MAX_CHANGES ||
    !isRecord(value.localGate) ||
    value.localGate.status !== "eligible" ||
    !Array.isArray(value.localGate.issueHashes) ||
    !value.localGate.issueHashes.every(isHash)
  )
    throw new Error("Invalid CreatorChangeSet");
  for (const operation of value.operations)
    CHANGE_OPERATION_SCHEMA.parse(operation);
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_change_set_${expected.slice(0, 24)}`
  )
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
    throw new Error(
      "CreatorVerificationRecord status does not match its failure facts",
    );
  if (
    (value.status === "incomplete") !==
    (value.nonReplayableReason !== undefined)
  )
    throw new Error(
      "Incomplete creator verification requires one non-replayable reason",
    );
  assertArtifactIdentity(value, "creator_verification");
}

export function assertCreatorCheckpoint(
  value: unknown,
): asserts value is CreatorCheckpoint {
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
    !["committed", "rolled_back", "recovery_required"].includes(
      String(value.status),
    )
  )
    throw new Error("Invalid CreatorCheckpoint");
  assertArtifactIdentity(value, "creator_checkpoint");
}

export function assertCreatorReviewReport(
  value: unknown,
): asserts value is CreatorReviewReport {
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

function assertArtifactIdentity(
  value: Record<string, unknown>,
  prefix: string,
): void {
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
    revisionHash?: string;
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
  if (transition.plan)
    next.plan = { id: transition.plan.id, hash: transition.plan.hash };
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
  if (transition.review)
    next.review = { id: transition.review.id, hash: transition.review.hash };
  if (transition.revisionHash) {
    assertHash(transition.revisionHash, "Creator session revision");
    next.currentRevisionHash = transition.revisionHash;
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

export function creatorOrientation(
  bundle: Pick<CreatorSessionBundle, "session" | "ownership" | "observation">,
): AgentOrientation {
  return compileCreatorOrientation({
    state: bundle.observation,
    revisionHash: bundle.session.currentRevisionHash,
    projectId: bundle.session.projectId,
    ownership: new Map(
      bundle.ownership.entries.map((entry) => [entry.stableId, entry.owner]),
    ),
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
  protected constructor(
    protected readonly budgets: BudgetPolicy = DEFAULT_AGENT_BUDGETS,
  ) {}
  abstract definitions(): AgentToolDefinition[];
  validateBatch(
    calls: readonly ModelToolCall[],
    seenIds: ReadonlySet<string>,
  ): ToolBatchDecision {
    const definitions = new Map(
      this.definitions().map((entry) => [entry.name, entry]),
    );
    const feedback: ToolBatchDecision["feedback"] = [];
    let valid = true;
    const projected = {
      toolCalls: this.executedCalls + calls.length,
      writes:
        this.executedWrites +
        calls.filter((call) => call.name === "studio.stage").length,
      verifierCalls:
        this.executedVerifierCalls +
        calls.filter((call) => call.name === "forge.verify").length,
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
        result = failed(
          "TOOL_CALL_ID_DUPLICATE",
          `Duplicate tool-call ID ${call.id}`,
        );
      else {
        const definitionValue = definitions.get(call.name);
        if (!definitionValue)
          result = failed("TOOL_UNKNOWN", `Unknown tool ${call.name}`);
        else {
          const parsed = z
            .object(definitionValue.inputShape)
            .safeParse(call.arguments);
          if (!parsed.success)
            result = failed(
              "TOOL_ARGUMENTS_INVALID",
              formatZodIssues(parsed.error.issues),
            );
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
      (name === "studio.stage" &&
        this.executedWrites >= this.budgets.maxWrites) ||
      (name === "forge.verify" &&
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
    const definitionValue = this.definitions().find(
      (entry) => entry.name === name,
    );
    let result: ToolResult;
    if (!definitionValue)
      result = failed("TOOL_UNKNOWN", `Unknown tool ${name}`);
    else {
      const parsed = z.object(definitionValue.inputShape).safeParse(input);
      if (!parsed.success)
        result = failed(
          "TOOL_ARGUMENTS_INVALID",
          formatZodIssues(parsed.error.issues),
        );
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
      result = failed(
        "TOOL_OUTPUT_BUDGET_EXHAUSTED",
        "Creator tool-result byte budget exhausted",
      );
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

function inspectSnapshot(
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
  paths: string[],
): unknown {
  const unique = [...new Set(paths.map(canonicalStudioPath))];
  if (unique.length !== paths.length)
    throw correctiveFailure(
      "INSPECTION_PATH_DUPLICATE",
      "Studio inspection paths must be unique and canonical",
      { receivedPaths: paths },
    );
  const missing = unique.filter(
    (path) => !observation.instances.some((instance) => instance.path === path),
  );
  if (missing.length > 0)
    throw correctiveFailure(
      "INSPECTION_PATH_ABSENT",
      "Studio inspection accepts only exact paths present in the initial snapshot",
      { missingPaths: missing },
    );
  const owner = (stableId: string): StudioOwner =>
    ownership.entries.find((entry) => entry.stableId === stableId)?.owner ??
    "studio";
  const instances = observation.instances
    .filter((instance) => unique.includes(instance.path))
    .map((instance) => ({
      stableId: instance.stableId,
      path: instance.path,
      className: instance.className,
      instanceHash: contentHash(stableJson(instance)),
      owner: owner(instance.stableId),
      writable:
        ownership.entries.find((entry) => entry.stableId === instance.stableId)
          ?.writable === true,
      ...(instance.position ? { position: instance.position } : {}),
      properties: instance.properties,
      attributes: instance.attributes,
    }));
  const scripts = observation.scripts
    .filter((script) => unique.includes(script.path))
    .map(({ source: _source, ...script }) => ({
      ...script,
      owner: owner(script.stableId),
    }));
  return { paths: unique, instances, scripts };
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

export class CreatorPlannerToolHost extends BaseCreatorToolHost {
  private proposal?: CreatorPlan;
  private readonly inspectedPaths = new Set<string>();
  constructor(
    private readonly input: {
      session: CreatorSession;
      ownership: StudioOwnershipMap;
      observation: StudioProjectState;
      prompt: string;
      budgets?: BudgetPolicy;
    },
  ) {
    super(input.budgets);
  }
  override definitions(): AgentToolDefinition[] {
    return [
      definition(
        "studio.api_lookup",
        "Search the pinned official Roblox Engine API catalog for class, property, method, event, callback, datatype, or enum metadata. Results include signatures, security/capability context, source provenance, and Forge's precise direct-authoring/source-only/restricted disposition. Catalog presence informs Luau source; it never grants typed Studio mutation or behavioral proof.",
        ROBLOX_API_LOOKUP_SHAPE,
      ),
      definition(
        "studio.inspect",
        "Inspect bounded properties, attributes, positions, ownership, and script hashes for exact paths in the initial Studio snapshot. Source bodies are never returned. Any path declared as a builder inspection dependency must first be inspected here.",
        { paths: z.array(z.string().min(1)).min(1).max(CREATOR_MAX_INSPECTION_PATHS) },
      ),
      definition(
        "creator.propose_plan",
        "Propose typed changes and a creator-visible verification charter for the immutable creator request. Explicitly list every already-inspected initial-snapshot path whose facts the builder may inspect; this list is creator-reviewed and contract-bound. Forge, not the model, derives the plan goal from that request. Each step must bind exact changeIds, covering every change once. Every create or move parent must already exist in the initial snapshot; planned instances cannot parent other planned instances. A Script, LocalScript, or ModuleScript create must declare initialization inline_source_required: its one create operation will carry complete initial source. write_source is only for a Script, LocalScript, or ModuleScript present in the initial snapshot; it cannot author a newly planned script. Non-script creation uses initial_properties. Machine-check language is generated by Forge.",
        PLAN_SHAPE,
      ),
    ];
  }
  getPlan(): CreatorPlan | undefined {
    return this.proposal;
  }
  progressToken(): string {
    return this.proposal?.hash ?? "creator-plan-unpublished";
  }
  completionStatus(): AgentToolCompletionStatus {
    return this.proposal
      ? { ready: true }
      : {
          ready: false,
          code: "PLAN_NOT_PUBLISHED",
          message: "Creator planner ended without publishing a valid plan",
        };
  }
  protected override async dispatch(
    name: string,
    input: unknown,
  ): Promise<unknown> {
    if (name === "studio.api_lookup")
      return creatorRobloxApiLookup(
        input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>,
      );
    if (name === "studio.inspect") {
      const paths = (input as { paths: string[] }).paths;
      const inspected = inspectSnapshot(
        this.input.observation,
        this.input.ownership,
        paths,
      );
      for (const path of paths) this.inspectedPaths.add(path);
      return inspected;
    }
    if (name !== "creator.propose_plan")
      throw new ToolFailure("TOOL_UNKNOWN", `Unknown planner tool ${name}`);
    const value = input as z.infer<z.ZodObject<typeof PLAN_SHAPE>>;
    const uninspected = value.inspectionPaths.filter(
      (path) => !this.inspectedPaths.has(path),
    );
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
      this.proposal = createCreatorPlan(
        {
          sessionId: this.input.session.id,
          promptHash: this.input.session.promptHash,
          projectRevisionHash: this.input.session.currentRevisionHash,
          ownershipMapId: this.input.ownership.id,
          ownershipMapHash: this.input.ownership.hash,
          creatorPrompt: this.input.prompt,
          inspectionPaths: value.inspectionPaths,
          steps: value.steps,
          changes: value.changes as CreatorPlanChange[],
          charter: {
            clauses: value.clauses as VerificationCharterProposalClause[],
          },
        },
        this.input.observation,
        this.input.ownership,
      );
    } catch (error) {
      throw new ToolFailure(
        "PLAN_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      planId: this.proposal.id,
      planHash: this.proposal.hash,
      charterId: this.proposal.charter.id,
      charterHash: this.proposal.charter.hash,
    };
  }
}

export class CreatorBuilderToolHost extends BaseCreatorToolHost {
  private readonly operations: StudioChangeOperation[] = [];
  private localGate: CreatorChangeSet["localGate"] = {
    status: "incomplete",
    issueHashes: [],
  };
  readonly contract: CreatorBuildContract;
  constructor(
    private readonly input: {
      session: CreatorSession;
      ownership: StudioOwnershipMap;
      observation: StudioProjectState;
      plan: CreatorPlan;
      planApproval: CreatorApproval;
      budgets?: BudgetPolicy;
    },
  ) {
    super(input.budgets);
    this.contract = createCreatorBuildContract(input);
  }
  override definitions(): AgentToolDefinition[] {
    return BUILDER_DEFINITIONS;
  }
  stagedOperations(): StudioChangeOperation[] {
    return this.operations.map(cloneOperation);
  }
  gate(): CreatorChangeSet["localGate"] {
    return { ...this.localGate, issueHashes: [...this.localGate.issueHashes] };
  }
  progressToken(): string {
    return contentHash(
      stableJson({
        operations: this.operations.map((operation) =>
          contentHash(stableJson(operation)),
        ),
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
        localGate: this.gate(),
      },
      this.input.observation,
      this.input.ownership,
      this.input.plan,
      this.contract,
    );
    assertCreatorChangeSet(changeSet);
    return changeSet;
  }
  protected override async dispatch(
    name: string,
    input: unknown,
  ): Promise<unknown> {
    if (name === "studio.api_lookup")
      return creatorRobloxApiLookup(
        input as z.infer<z.ZodObject<typeof ROBLOX_API_LOOKUP_SHAPE>>,
      );
    if (name === "studio.inspect")
      return this.inspect((input as { paths: string[] }).paths);
    if (name === "studio.read_source")
      return this.readSource((input as { path: string }).path);
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
            expectedPlanChangeIds: this.contract.changes.map(
              (change) => change.planChangeId,
            ),
            contractHash: this.contract.hash,
          },
        );
      if (
        this.operations.some(
          (entry) => entry.planChangeId === payload.planChangeId,
        )
      )
        throw correctiveFailure(
          "PLAN_CHANGE_DUPLICATE",
          "Each approved planChangeId may be staged exactly once",
          {
            receivedPlanChangeId: payload.planChangeId,
            expectedContract: contractChange,
          },
        );
      if (payload.source !== undefined) {
        const bytes = Buffer.byteLength(payload.source, "utf8");
        const totalBytes =
          this.operations.reduce(
            (sum, operation) =>
              sum +
              ("source" in operation && operation.source
                ? Buffer.byteLength(operation.source, "utf8")
                : 0),
            0,
          ) + bytes;
        if (
          bytes > this.budgets.maxBytesPerFile ||
          totalBytes > this.budgets.maxChangedSourceBytes
        )
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
      const operation = deriveStudioOperation(contractChange, payload);
      assertStudioChangeOperation(
        operation,
        this.input.observation,
        this.input.ownership,
      );
      if (this.operations.length >= 32)
        throw new ToolFailure(
          "OPERATION_BUDGET_EXHAUSTED",
          "Studio operation budget exhausted",
        );
      this.operations.push(cloneOperation(operation));
      this.localGate = { status: "incomplete", issueHashes: [] };
      return {
        staged: true,
        operationId: operation.id,
        operationHash: contentHash(stableJson(operation)),
      };
    }
    if (name === "studio.diff")
      return {
        operations: this.operations.map((operation) => ({
          id: operation.id,
          kind: operation.kind,
          hash: contentHash(stableJson(operation)),
          summary: operationSummary(operation),
        })),
      };
    if (name === "forge.verify") return this.verify();
    throw new ToolFailure("TOOL_UNKNOWN", `Unknown builder tool ${name}`);
  }
  private owner(stableId: string): StudioOwner {
    return (
      this.input.ownership.entries.find((entry) => entry.stableId === stableId)
        ?.owner ?? "studio"
    );
  }
  private inspect(paths: string[]): unknown {
    const allowed = new Set(this.contract.initialInspectionPaths);
    const unique = [...new Set(paths)];
    if (
      unique.length !== paths.length ||
      paths.some((path) => !allowed.has(path))
    )
      throw correctiveFailure(
        "INSPECTION_PATH_INVALID",
        "studio.inspect accepts only explicit initial paths declared by the build contract",
        {
          receivedPaths: paths,
          allowedPaths: this.contract.initialInspectionPaths,
          contractHash: this.contract.hash,
        },
      );
    const instances = this.input.observation.instances
      .filter((instance) => unique.includes(instance.path))
      .map((instance) => ({
        stableId: instance.stableId,
        path: instance.path,
        className: instance.className,
        instanceHash: contentHash(stableJson(instance)),
        owner: this.owner(instance.stableId),
        ...(instance.position ? { position: instance.position } : {}),
        properties: instance.properties,
        attributes: instance.attributes,
      }));
    const scripts = this.input.observation.scripts
      .filter((script) => unique.includes(script.path))
      .map(({ source: _source, ...script }) => ({
        ...script,
        owner: this.owner(script.stableId),
      }));
    return {
      revisionHash: this.input.session.currentRevisionHash,
      paths: unique,
      instances,
      scripts,
    };
  }
  private readSource(path: string): unknown {
    const approvedSources = this.contract.changes.filter(
      (
        change,
      ): change is Extract<
        CreatorBuildContractChange,
        { kind: "write_source" }
      > => change.kind === "write_source",
    );
    const contractChange = approvedSources.find(
      (change) => change.expectedPath === path,
    );
    if (!contractChange)
      throw correctiveFailure(
        "SOURCE_PATH_NOT_APPROVED",
        "studio.read_source accepts only an existing script bound to an approved write_source change",
        {
          receivedPath: path,
          approvedPaths: approvedSources.map((change) => change.expectedPath),
        },
      );
    const script = this.input.observation.scripts.find(
      (entry) =>
        entry.stableId === contractChange.stableId &&
        entry.path === path &&
        entry.sourceHash === contractChange.beforeSourceHash &&
        typeof entry.source === "string",
    );
    if (!script || typeof script.source !== "string")
      throw new ToolFailure(
        "SOURCE_PRECONDITION_MISMATCH",
        `Approved source target is absent, unreadable, or changed: ${path}`,
      );
    return {
      path,
      stableId: script.stableId,
      className: contractChange.expectedClass,
      sourceHash: script.sourceHash,
      utf8Bytes: Buffer.byteLength(script.source, "utf8"),
      source: script.source,
    };
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
        issueHashes: [
          contentHash(error instanceof Error ? error.message : String(error)),
        ],
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
    const sources = this.operations.flatMap((operation) =>
      operation.kind === "write_source"
        ? [
            {
              id: operation.id,
              source: operation.source,
              className: operation.expectedClass,
            },
          ]
        : operation.kind === "create" && operation.source !== undefined
          ? [
              {
                id: operation.id,
                source: operation.source,
                className: operation.className,
              },
            ]
          : [],
    );
    if (sources.length === 0) {
      this.localGate = { status: "eligible", issueHashes: [] };
      return this.localGate;
    }
    const root = await mkdtemp(join(tmpdir(), "forge-creator-verify-"));
    try {
      const paths: string[] = [];
      for (const source of sources) {
        const suffix =
          source.className === "Script"
            ? ".server.luau"
            : source.className === "LocalScript"
              ? ".client.luau"
              : ".luau";
        const path = `${source.id.replace(/[^A-Za-z0-9_-]/g, "_")}${suffix}`;
        await writeFile(join(root, path), source.source, "utf8");
        paths.push(path);
      }
      const analysis = analyzeWithRobloxLuau(root, paths);
      const issueHashes = analysis.issues
        .map((issue) => contentHash(stableJson(issue)))
        .sort();
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
        issues: analysis.issues.slice(0, 30).map((issue) => ({
          ruleId: issue.ruleId,
          severity: issue.severity,
          path: issue.path,
        })),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function runCreatorPlanner(input: {
  session: CreatorSession;
  ownership: StudioOwnershipMap;
  observation: StudioProjectState;
  prompt: string;
  runtime: AgentRuntime;
  budgets?: BudgetPolicy;
}): Promise<CreatorPlannerExecution> {
  if (contentHash(input.prompt) !== input.session.promptHash)
    throw new Error("Creator prompt does not match the session");
  const host = new CreatorPlannerToolHost({
    session: input.session,
    ownership: input.ownership,
    observation: input.observation,
    prompt: input.prompt,
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
  });
  const result = await invokeCreatorRuntime(input.runtime, {
    systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
    prompt: input.prompt,
    orientation: creatorOrientation({
      session: input.session,
      ownership: input.ownership,
      observation: input.observation,
    }),
    tools: host,
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
    model: input.session.model,
  });
  const plan = host.getPlan();
  if (result.status !== "completed")
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
      finalization: runtimeFinalization("plan", result),
    };
  if (!plan)
    return {
      runtimeResult: result,
      toolHost: host,
      systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
      finalization: {
        status: "unsealed",
        intendedArtifactKind: "plan",
        failureStage: "finalization",
        failureCode: "PLAN_NOT_PUBLISHED",
        detail: "Creator planner ended without publishing a valid plan",
        failureKind: "model",
      },
    };
  return {
    plan,
    runtimeResult: result,
    toolHost: host,
    systemPrompt: CREATOR_PLANNER_SYSTEM_PROMPT,
    finalization: {
      status: "sealed",
      artifact: { kind: "plan", id: plan.id, hash: plan.hash },
    },
  };
}

export async function runCreatorBuilder(input: {
  session: CreatorSession;
  ownership: StudioOwnershipMap;
  observation: StudioProjectState;
  prompt: string;
  plan: CreatorPlan;
  planApproval: CreatorApproval;
  verificationFeedback?: readonly string[];
  runtime: AgentRuntime;
  budgets?: BudgetPolicy;
}): Promise<CreatorBuilderExecution> {
  if (contentHash(input.prompt) !== input.session.promptHash)
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
    prompt: input.prompt,
    orientation: creatorOrientation({
      session: input.session,
      ownership: input.ownership,
      observation: input.observation,
    }),
    tools: host,
    budgets: input.budgets ?? DEFAULT_AGENT_BUDGETS,
    model: input.session.model,
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
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return {
    path: relative(process.cwd(), destination),
    artifactHash: contentHash(serialized),
    mode: 0o600,
  };
}

export async function loadCreatorBundle(
  path: string,
): Promise<CreatorSessionBundle> {
  const value = JSON.parse(
    await readFile(resolve(path), "utf8"),
  ) as CreatorSessionBundle;
  assertCreatorSessionBundle(value);
  const store = new ImmutableJsonArtifactStore(dirname(resolve(path)));
  const creatorRequest = await store.read(
    value.creatorRequest,
    assertCreatorRequestArtifact,
  );
  if (
    creatorRequest.sessionId !== value.session.id ||
    creatorRequest.promptHash !== value.session.promptHash
  )
    throw new Error("Creator request artifact does not bind its session");
  for (const reference of value.agentRuns) {
    await Promise.all([
      store.verify(reference.agentRun),
      store.verify(reference.trace),
    ]);
  }
  await Promise.all(
    value.verifications.flatMap((verification) => [
      store.verify(verification.executionPlan.artifact),
      ...(verification.runtimeEvidence
        ? [store.verify(verification.runtimeEvidence.artifact)]
        : []),
    ]),
  );
  await Promise.all(
    value.mutationAttempts.flatMap(mutationAttemptArtifactReferences)
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
  assertOwnershipMap(value.ownership);
  assertStudioProjectState(value.observation);
  if (
    !Array.isArray(value.observationHistory) ||
    value.observationHistory.length < 1 ||
    value.observationHistory.length > 32
  )
    throw new Error(
      "Creator session bundle requires bounded Studio observation history",
    );
  for (const entry of value.observationHistory) {
    if (!isRecord(entry) || !isHash(entry.revisionHash))
      throw new Error("Invalid creator Studio observation history entry");
    assertStudioProjectState(entry.observation);
  }
  if (
    new Set(
      value.observationHistory.map((entry) => contentHash(stableJson(entry))),
    ).size !== value.observationHistory.length
  )
    throw new Error(
      "Creator Studio observation history contains duplicate evidence",
    );
  const initialObservation = value.observationHistory[0]!;
  const currentObservation = value.observationHistory.at(-1)!;
  if (
    initialObservation.revisionHash !== value.session.initialRevisionHash ||
    currentObservation.revisionHash !== value.session.currentRevisionHash ||
    stableJson(currentObservation.observation) !== stableJson(value.observation)
  )
    throw new Error("Creator session observation history graph mismatch");
  if (
    value.ownership.id !== value.session.ownershipMapId ||
    value.ownership.hash !== value.session.ownershipMapHash ||
    value.ownership.projectId !== value.session.projectId ||
    value.ownership.revisionHash !== value.session.initialRevisionHash
  )
    throw new Error("Creator session bundle ownership graph mismatch");
  if (value.plan) {
    assertCreatorPlan(value.plan);
    if (
      value.plan.sessionId !== value.session.id ||
      value.plan.promptHash !== value.session.promptHash ||
      value.plan.ownershipMapId !== value.ownership.id ||
      value.plan.ownershipMapHash !== value.ownership.hash ||
      value.plan.projectRevisionHash !== value.session.initialRevisionHash
    )
      throw new Error("Creator session bundle plan graph mismatch");
    const rematerialized = createCreatorPlan(
      {
        sessionId: value.plan.sessionId,
        promptHash: value.plan.promptHash,
        projectRevisionHash: value.plan.projectRevisionHash,
        ownershipMapId: value.plan.ownershipMapId,
        ownershipMapHash: value.plan.ownershipMapHash,
        creatorPrompt: value.plan.goal,
        inspectionPaths: [...value.plan.inspectionPaths],
        steps: structuredClone(value.plan.steps),
        changes: structuredClone(value.plan.changes),
        charter: {
          clauses: value.plan.charter.clauses.map(charterProposalFromFinal),
        },
      },
      initialObservation.observation,
      value.ownership,
    );
    if (
      rematerialized.id !== value.plan.id ||
      rematerialized.hash !== value.plan.hash
    )
      throw new Error(
        "Creator plan is not reproducible from its initial Studio observation",
      );
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
    throw new Error(
      "Creator build-contract history contains duplicate identities",
    );
  if (!Array.isArray(value.approvals))
    throw new Error("Creator session bundle requires approvals");
  value.approvals.forEach((approval) => {
    assertCreatorApproval(approval);
    if (approval.sessionId !== value.session.id)
      throw new Error("Creator approval session mismatch");
  });
  for (const contract of value.buildContracts) {
    if (!value.plan)
      throw new Error("Creator build contract requires its persisted plan");
    const approval = value.approvals.find(
      (candidate) =>
        candidate.id === contract.planApprovalId &&
        candidate.hash === contract.planApprovalHash &&
        candidate.artifactKind === "plan" &&
        candidate.artifactId === value.plan!.id &&
        candidate.artifactHash === value.plan!.hash &&
        candidate.decision === "approved",
    );
    const observed = value.observationHistory.find(
      (entry) =>
        entry.revisionHash === contract.initialRevisionHash &&
        studioProjectStateHash(entry.observation) ===
          value.plan!.projectStateHash,
    );
    if (!approval || !observed)
      throw new Error(
        "Creator build contract is not bound to approved plan and reproducible Studio facts",
      );
    const rematerialized = materializeCreatorBuildContract(
      {
        session: {
          ...value.session,
          currentRevisionHash: contract.initialRevisionHash,
        },
        plan: value.plan,
        planApproval: approval,
        ownership: value.ownership,
        observation: observed.observation,
      },
      contract.propertyPolicies,
    );
    if (
      rematerialized.id !== contract.id ||
      rematerialized.hash !== contract.hash
    )
      throw new Error(
        "Creator build contract is not reproducible from approved inputs",
      );
  }
  if (!Array.isArray(value.changeSets))
    throw new Error("Creator session bundle requires change-set history");
  if (
    new Set(value.changeSets.map((changeSet) => changeSet.id)).size !==
    value.changeSets.length
  )
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
      throw new Error(
        "Creator change set requires its authentic approved-plan decision",
      );
    const contract = value.buildContracts.find(
      (candidate) =>
        candidate.id === changeSet.buildContractId &&
        candidate.hash === changeSet.buildContractHash,
    );
    if (
      !contract ||
      contract.planApprovalId !== approval.id ||
      contract.planApprovalHash !== approval.hash
    )
      throw new Error(
        "Creator change set requires its persisted build contract",
      );
    assertOperationsMatchPlan(changeSet.operations, value.plan.changes);
    assertOperationsMatchContract(changeSet.operations, contract);
    const observed = value.observationHistory.find(
      (entry) =>
        entry.revisionHash === changeSet.expectedRevisionHash &&
        studioProjectStateHash(entry.observation) ===
          value.plan!.projectStateHash,
    );
    if (!observed)
      throw new Error(
        "Creator change set lost its exact pre-apply Studio observation",
      );
    const { kind: _kind, id: _id, hash: _hash, ...payload } = changeSet;
    const rematerialized = createCreatorChangeSet(
      structuredClone(payload),
      observed.observation,
      value.ownership,
      value.plan,
      contract,
    );
    if (
      rematerialized.id !== changeSet.id ||
      rematerialized.hash !== changeSet.hash
    )
      throw new Error(
        "Creator change set is not reproducible from its approved contract and Studio facts",
      );
  });
  const artifact = (approval: CreatorApproval) =>
    approval.artifactKind === "plan"
      ? value.plan &&
        approval.artifactId === value.plan.id &&
        approval.artifactHash === value.plan.hash
      : value.changeSets.some(
          (changeSet) =>
            changeSet.id === approval.artifactId &&
            changeSet.hash === approval.artifactHash,
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
    ) throw new Error("Invalid creator mutation-attempt evidence");
  }
  if (value.activeMutation !== undefined)
    assertCreatorActiveMutation(value.activeMutation, value);
  value.verifications.forEach((record) => {
    assertCreatorVerificationRecord(record);
    if (
      record.sessionId !== value.session.id ||
      !value.changeSets.some(
        (changeSet) =>
          changeSet.id === record.changeSetId &&
          changeSet.hash === record.changeSetHash,
      ) ||
      !value.plan ||
      record.charterId !== value.plan.charter.id ||
      record.charterHash !== value.plan.charter.hash ||
      !value.mutationAttempts.some((attempt) =>
        attempt.id === record.mutationAttempt.id &&
        attempt.hash === record.mutationAttempt.hash &&
        attempt.completion === "settled" &&
        isRecord(attempt.reconciliation) &&
        attempt.reconciliation.hash === record.mutationAttempt.reconciliationHash)
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
      !value.mutationAttempts.some((attempt) =>
        attempt.id === value.checkpoint!.mutationAttemptId &&
        attempt.hash === value.checkpoint!.mutationAttemptHash &&
        attempt.completion === "settled")
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
      !["creator_planner", "creator_builder"].includes(
        String(reference.phase),
      ) ||
      !isId(reference.agentRunId) ||
      !isId(reference.traceId) ||
      !isId(reference.traceBuildKey) ||
      !isHash(reference.creatorSessionHash)
    )
      throw new Error("Invalid creator AgentRun reference");
    assertArtifactReference(reference.agentRun);
    assertArtifactReference(reference.trace);
    assertCreatorPhaseOutcome(reference.outcome);
    const intended =
      reference.phase === "creator_planner" ? "plan" : "change_set";
    if (
      (reference.outcome.status === "sealed"
        ? reference.outcome.artifact.kind
        : reference.outcome.intendedArtifactKind) !== intended
    )
      throw new Error(
        "Creator AgentRun outcome does not match its referenced phase",
      );
    if (
      reference.phase === "creator_planner" &&
      reference.outcome.status === "sealed" &&
      (!value.plan ||
        reference.outcome.artifact.id !== value.plan.id ||
        reference.outcome.artifact.hash !== value.plan.hash)
    )
      throw new Error(
        "Sealed creator planner AgentRun is not linked to its plan",
      );
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
        throw new Error(
          "Creator builder AgentRun reference lost its build contract",
        );
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
      throw new Error(
        "Persisted CreatorBuildContract has no AgentRun evidence link",
      );
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
      throw new Error(
        "Persisted CreatorChangeSet has no sealed AgentRun evidence link",
      );
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
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text !== value.text.trim() ||
    contentHash(value.text) !== value.promptHash
  )
    throw new Error("Invalid CreatorRequest artifact");
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
    attempt.beforeState.projection.artifact,
    attempt.beforeState.envelope.artifact,
    attempt.beforeState.revision.artifact,
    ...(attempt.completion === "incomplete"
      ? [attempt.preflightProjection.artifact]
      : []),
    ...(attempt.preflight
      ? [attempt.preflight.projection.artifact, attempt.preflight.envelope.artifact]
      : []),
  ];
  if (attempt.completion === "incomplete")
    return attempt.phase === "apply"
      ? [
          ...common,
          attempt.finalState.projection.artifact,
          attempt.finalState.envelope.artifact,
          attempt.finalState.revision.artifact,
          attempt.finalization.artifact,
        ]
      : common;
  return [
    ...common,
    attempt.directReadback.artifact,
    attempt.afterState.projection.artifact,
    attempt.afterState.envelope.artifact,
    attempt.afterState.revision.artifact,
    attempt.finalState.projection.artifact,
    attempt.finalState.envelope.artifact,
    attempt.finalState.revision.artifact,
    attempt.reconciliation.artifact,
    attempt.finalization.artifact,
  ];
}

function creatorActiveMutationReferences(
  active: CreatorActiveMutation,
): ArtifactReference[] {
  return [
    active.manifest.artifact,
    active.attestation.projection.artifact,
    active.attestation.envelope.artifact,
    active.changeSet.artifact,
    active.projection.artifact,
    active.preflight.projection.artifact,
    active.preflight.envelope.artifact,
    active.beforeState.projection.artifact,
    active.beforeState.envelope.artifact,
    active.beforeState.revision.artifact,
    ...(active.directReadback ? [active.directReadback.artifact] : []),
    ...(active.afterState
      ? [
          active.afterState.projection.artifact,
          active.afterState.envelope.artifact,
          active.afterState.revision.artifact,
        ]
      : []),
    ...(active.reconciliation ? [active.reconciliation.artifact] : []),
    ...(active.executionFailure ? [active.executionFailure.artifact] : []),
    ...(active.verificationPlan ? [active.verificationPlan.artifact] : []),
    ...(active.verificationDraft ? [active.verificationDraft.artifact] : []),
    ...(active.recoveryFinalization
      ? [active.recoveryFinalization.artifact]
      : []),
    ...(active.finalState
      ? [
          active.finalState.projection.artifact,
          active.finalState.envelope.artifact,
          active.finalState.revision.artifact,
        ]
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
    ![
      "preflighted",
      "recording_may_be_open",
      "provisional",
      "recovery_cancelled",
    ].includes(
      String(active.stage),
    ) ||
    !isId(active.changeSetId) ||
    !isHash(active.changeSetHash) ||
    !isId(active.projectionId) ||
    !isHash(active.projectionHash) ||
    !isHash(active.beforeRevisionHash) ||
    (active.recordingId !== undefined && !isId(active.recordingId))
  )
    throw new Error("Invalid active creator mutation cursor");
  if (
    !bundle.changeSets.some(
      (changeSet) =>
        changeSet.id === active.changeSetId &&
        changeSet.hash === active.changeSetHash,
    ) ||
    active.projection.hash !== active.projectionHash
  )
    throw new Error("Active creator mutation graph mismatch");
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
    active.beforeState.projection,
    active.beforeState.envelope,
    active.beforeState.revision,
    active.directReadback,
    active.afterState?.projection,
    active.afterState?.envelope,
    active.afterState?.revision,
    active.reconciliation,
    active.executionFailure,
    active.verificationPlan,
    active.verificationDraft,
    active.recoveryFinalization,
    active.finalState?.projection,
    active.finalState?.envelope,
    active.finalState?.revision,
  ]) {
    if (
      binding !== undefined &&
      (!isRecord(binding) || !isHash(binding.hash))
    )
      throw new Error("Invalid active creator mutation artifact binding");
  }
  if (
    active.stage === "provisional" &&
    (!active.recordingId ||
      !active.directReadback ||
      !active.afterState ||
      !active.reconciliation)
  )
    throw new Error("Provisional creator mutation cursor is incomplete");
  if (
    active.stage === "recovery_cancelled" &&
    (!active.recordingId || !active.recoveryFinalization || !active.finalState)
  )
    throw new Error("Recovery-cancelled creator mutation cursor is incomplete");
}

export function assertCreatorSession(
  value: unknown,
): asserts value is CreatorSession {
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

export function assertOwnershipMap(
  value: unknown,
): asserts value is StudioOwnershipMap {
  if (
    !isRecord(value) ||
    value.kind !== "StudioOwnershipMap" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.projectId) ||
    !isHash(value.revisionHash) ||
    value.policy !== "studio_single_writer_external_rojo_read_only" ||
    !Array.isArray(value.entries)
  )
    throw new Error("Invalid StudioOwnershipMap");
  const payload = {
    projectId: value.projectId,
    revisionHash: value.revisionHash,
    entries: value.entries,
    policy: value.policy,
  };
  const hash = contentHash(stableJson(payload));
  if (
    value.hash !== hash ||
    value.id !== `studio_ownership_map_${hash.slice(0, 24)}`
  )
    throw new Error("Invalid StudioOwnershipMap identity");
}

export function assertCreatorPlan(
  value: unknown,
): asserts value is CreatorPlan {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorPlan" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.sessionId) ||
    !isHash(value.promptHash) ||
    !isHash(value.projectRevisionHash) ||
    !isHash(value.projectStateHash) ||
    !isId(value.ownershipMapId) ||
    !isHash(value.ownershipMapHash) ||
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
    stableJson([...value.inspectionPaths].sort()) !==
      stableJson(value.inspectionPaths) ||
    !Array.isArray(value.steps) ||
    value.steps.length > CREATOR_MAX_PLAN_STEPS ||
    !Array.isArray(value.changes) ||
    value.changes.length > CREATOR_MAX_CHANGES ||
    !isRecord(value.charter)
  )
    throw new Error("Invalid CreatorPlan");
  for (const change of value.changes) PLAN_CHANGE_SCHEMA.parse(change);
  if (
    new Set(value.changes.map((change) => change.id)).size !==
    value.changes.length
  )
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
    new Set(steps.map((step) => String((step as Record<string, unknown>).id)))
      .size !== steps.length
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
    new Set(
      (value.charter.clauses as VerificationCharterClause[]).map(
        (clause) => clause.id,
      ),
    ).size !== value.charter.clauses.length
  )
    throw new Error("VerificationCharter clause IDs must be unique");
  assertPlanOutputCoverage(
    value.changes as CreatorPlanChange[],
    value.charter.clauses as VerificationCharterProposalClause[],
  );
  if (
    (value.changes as CreatorPlanChange[]).some(sourceBearingPlanChange) &&
    !(value.charter.clauses as VerificationCharterClause[]).some(
      (clause) =>
        clause.kind === "local_check" && clause.check === "luau_syntax",
    )
  )
    throw new Error(
      "Verification charter requires luau_syntax for source-bearing plan changes",
    );
  const {
    kind: _charterKind,
    id: _charterId,
    hash: _charterHash,
    ...charterPayload
  } = value.charter;
  const expectedCharterHash = contentHash(stableJson(charterPayload));
  if (
    value.charter.hash !== expectedCharterHash ||
    value.charter.id !==
      `verification_charter_${expectedCharterHash.slice(0, 24)}`
  )
    throw new Error("Invalid VerificationCharter identity");
  const { kind: _kind, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(payload));
  if (
    value.hash !== expected ||
    value.id !== `creator_plan_${expected.slice(0, 24)}`
  )
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
    intervalMs: z.number().int().min(CREATOR_SERIES_MIN_INTERVAL_MS).max(CREATOR_SERIES_MAX_INTERVAL_MS),
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
    intervalMs: z.number().int().min(CREATOR_SERIES_MIN_INTERVAL_MS).max(CREATOR_SERIES_MAX_INTERVAL_MS),
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
const PLAN_CHANGE_SCHEMA = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.literal("create"),
    path: z.string().min(1),
    className: z.enum(STUDIO_SCRIPT_CLASSES),
    initialization: z.literal("inline_source_required"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("create"),
    path: z.string().min(1),
    className: z.enum(STUDIO_NON_SCRIPT_WRITABLE_CLASSES),
    initialization: z.literal("initial_properties"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("update"),
    path: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("move"),
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("delete"),
    path: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("write_source"),
    path: z.string().min(1),
    expectedClass: z.enum(["Script", "LocalScript", "ModuleScript"]),
  }),
]);

const PLAN_SHAPE = {
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
      (source) => Buffer.byteLength(source, "utf8") <= 48_000,
      "source exceeds the 48000-byte UTF-8 bound",
    );
}
const FINITE_NUMBER_SCHEMA = z.number().finite();
const STUDIO_VALUE_SCHEMA: z.ZodType<StudioValue> = z.custom<StudioValue>(
  (value) => {
    try {
      assertStudioValue(value);
      return true;
    } catch {
      return false;
    }
  },
  "invalid canonical Studio value",
);
const PRIMITIVE_SCHEMA = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
]);
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
const NATURAL_UDIM2_SCHEMA = z
  .object({ x: NATURAL_UDIM_SCHEMA, y: NATURAL_UDIM_SCHEMA })
  .strict();
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
      .array(
        z
          .object({ time: FINITE_NUMBER_SCHEMA, color: NATURAL_COLOR3_SCHEMA })
          .strict(),
      )
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
const NATURAL_AXES_SCHEMA = z
  .object({ x: z.boolean(), y: z.boolean(), z: z.boolean() })
  .strict();
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
    stableId: z.string().min(1),
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
const CHANGE_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("create"),
    tempId: z.string().min(1),
    parentPath: z.string().min(1),
    className: z.enum(STUDIO_WRITABLE_CLASSES),
    name: z.string().min(1).max(100),
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    source: boundedSourceSchema().optional(),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("update"),
    stableId: z.string().min(1),
    expectedPath: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    removedAttributes: z.array(z.string().min(1)).max(64),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("move"),
    stableId: z.string().min(1),
    expectedPath: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
    parentPath: z.string().min(1),
    name: z.string().min(1).max(100),
    properties: z.record(z.string(), STUDIO_VALUE_SCHEMA),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    removedAttributes: z.array(z.string().min(1)).max(64),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("delete"),
    stableId: z.string().min(1),
    expectedPath: z.string().min(1),
    expectedClass: z.enum(STUDIO_WRITABLE_CLASSES),
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    id: z.string().min(1),
    planChangeId: z.string().min(1),
    kind: z.literal("write_source"),
    stableId: z.string().min(1),
    expectedPath: z.string().min(1),
    expectedClass: z.enum(["Script", "LocalScript", "ModuleScript"]),
    beforeSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    source: boundedSourceSchema(),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA),
    removedAttributes: z.array(z.string().min(1)).max(64),
  }),
]);
const STAGE_PAYLOAD_SCHEMA = z
  .object({
    planChangeId: z.string().min(1),
    properties: z.record(z.string(), CREATOR_PROPERTY_INPUT_SCHEMA).optional(),
    attributes: z.record(z.string(), PRIMITIVE_SCHEMA).optional(),
    removedAttributes: z.array(z.string().min(1)).max(64).optional(),
    source: boundedSourceSchema().optional(),
  })
  .strict();
const ROBLOX_API_LOOKUP_SHAPE = {
  className: z.string().min(1).max(128).optional(),
  query: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(20).optional(),
} satisfies ZodRawShape;
const BUILDER_DEFINITIONS: AgentToolDefinition[] = [
  definition(
    "studio.api_lookup",
    "Search the pinned official Roblox Engine API catalog for class, property, method, event, callback, datatype, or enum metadata. Results include signatures, security/capability context, source provenance, and Forge's precise direct-authoring/source-only/restricted disposition. Catalog presence informs Luau source; it never grants typed Studio mutation or behavioral proof.",
    ROBLOX_API_LOOKUP_SHAPE,
  ),
  definition(
    "studio.inspect",
    "Inspect only explicit initial-snapshot paths listed in the immutable CreatorBuildContract. Source bodies are not returned.",
    { paths: z.array(z.string().min(1)).min(1).max(CREATOR_MAX_INSPECTION_PATHS) },
  ),
  definition(
    "studio.read_source",
    "Read the bounded current source body only for an existing script whose approved build-contract change is write_source. The exact source hash and UTF-8 byte count are returned with the body.",
    { path: z.string().min(1) },
  ),
  definition(
    "studio.stage",
    "Stage exactly one approved change. Supply only planChangeId and its creative payload. Property JSON is natural and untagged; the sealed property policy names the required codec. Scalars use booleans, finite numbers, or strings. Compound shapes are Vector2 {x,y}, Vector3 {x,y,z}, Color3 {r,g,b} in 0..1, CFrame {position:{x,y,z},rotation:{x,y,z}} in Euler degrees, UDim {scale,offset}, UDim2 {x:{scale,offset},y:{scale,offset}}, Rect {min:{x,y},max:{x,y}}, NumberRange {min,max}, sequences {keypoints:[...]}, BrickColor {name}, Font {family,weight,style}, PhysicalProperties, Axes, Faces, Ray {origin,direction}, or stable instance reference {stableId,path,className}. Never send type/value wrappers. Attributes are primitive where permitted; source is required only where the contract says so. Forge derives structural fields and converts properties to the trusted Studio representation. This never mutates the live place.",
    { change: STAGE_PAYLOAD_SCHEMA },
  ),
  definition(
    "studio.diff",
    "Inspect hashes and summaries of the complete staged Studio change set.",
    {},
  ),
  definition(
    "forge.verify",
    "Run bounded local validation of every staged Luau source. The live place is not mutated.",
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
  intendedArtifactKind: "plan" | "change_set",
  result: AgentRuntimeResult,
): Extract<CreatorPhaseFinalization, { status: "unsealed" }> {
  return {
    status: "unsealed",
    intendedArtifactKind,
    failureStage: "runtime",
    failureCode:
      result.failureCode ??
      (result.status === "budget_exhausted"
        ? "RUNTIME_BUDGET_EXHAUSTED"
        : "RUNTIME_FAILED"),
    detail:
      result.error ??
      `Creator ${intendedArtifactKind === "plan" ? "planner" : "builder"} did not complete`,
    failureKind: result.failureKind ?? "harness",
  };
}
function bounded(value: unknown): ToolResult {
  const serialized = stableJson(value);
  const limit = 64 * 1024;
  const bytes = Buffer.byteLength(serialized, "utf8");
  return {
    ok: true,
    value:
      bytes > limit
        ? { truncated: true, preview: serialized.slice(0, limit) }
        : value,
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
  if (operation.kind === "create")
    return `Create ${operation.className} ${operation.parentPath}/${operation.name}`;
  if (operation.kind === "write_source")
    return `Replace source for ${operation.expectedPath}`;
  if (operation.kind === "move")
    return `Move ${operation.expectedPath} to ${operation.parentPath}/${operation.name}`;
  return `${operation.kind === "delete" ? "Delete" : "Update"} ${operation.expectedPath}`;
}
function canonicalStudioPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  )
    throw new Error(`Invalid Studio path ${value}`);
  return value;
}
function pathParent(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 1)
    throw new Error(`Studio change path requires a parent: ${path}`);
  return path.slice(0, index);
}
function changeInputPath(change: CreatorPlanChange): string | undefined {
  return change.kind === "move"
    ? change.fromPath
    : change.kind === "create"
      ? undefined
      : change.path;
}
function changeOutputPath(change: CreatorPlanChange): string | undefined {
  return change.kind === "move"
    ? change.toPath
    : change.kind === "delete"
      ? undefined
      : change.path;
}
function planChangeTouchesPath(
  change: CreatorPlanChange,
  root: string,
): boolean {
  return [changeInputPath(change), changeOutputPath(change)].some(
    (path) =>
      path !== undefined && (path === root || path.startsWith(`${root}/`)),
  );
}
function classMatches(
  actual: string,
  expected: StudioResolvableClass,
): boolean {
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
  observation: StudioProjectState,
): string | undefined {
  for (const change of changes) {
    if (change.kind === "create" && change.path === path)
      return change.className;
    if (change.kind === "move" && change.toPath === path)
      return change.expectedClass;
    if (
      (change.kind === "delete" && change.path === path) ||
      (change.kind === "move" && change.fromPath === path)
    )
      return undefined;
  }
  return observation.instances.find((entry) => entry.path === path)?.className;
}
function assertCreatorPlanChange(
  change: CreatorPlanChange,
  changes: CreatorPlanChange[],
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
): void {
  PLAN_CHANGE_SCHEMA.parse(change);
  if (change.kind === "create") {
    const path = canonicalStudioPath(change.path);
    assertWritableParent(pathParent(path), observation, ownership);
    if (observation.instances.some((entry) => entry.path === path))
      throw new Error(`Planned create target already exists: ${path}`);
    return;
  }
  const sourcePath = canonicalStudioPath(
    change.kind === "move" ? change.fromPath : change.path,
  );
  if (
    change.kind === "write_source" &&
    changes.some(
      (candidate) =>
        candidate.kind === "create" &&
        canonicalStudioPath(candidate.path) === sourcePath,
    )
  )
    throw new Error(
      `Planned source target is a newly created script: ${sourcePath}. New scripts must be authored by their corresponding create operation with initialization inline_source_required; write_source is only for scripts from the initial snapshot.`,
    );
  const observed = observation.instances.find(
    (entry) => entry.path === sourcePath,
  );
  const authority =
    observed &&
    ownership.entries.find((entry) => entry.stableId === observed.stableId);
  if (
    !observed ||
    observed.className !== change.expectedClass ||
    authority?.owner !== "studio" ||
    !authority.writable
  )
    throw new Error(
      `Planned ${change.kind} target is absent, class-mismatched, or not Studio-writable: ${sourcePath}`,
    );
  if (change.kind === "move") {
    const destination = canonicalStudioPath(change.toPath);
    if (
      destination === sourcePath ||
      observation.instances.some((entry) => entry.path === destination)
    )
      throw new Error(
        `Planned move destination is invalid or occupied: ${destination}`,
      );
    assertWritableParent(pathParent(destination), observation, ownership);
  }
  if (
    change.kind === "write_source" &&
    !observation.scripts.some(
      (script) =>
        script.stableId === observed.stableId && script.path === sourcePath,
    )
  )
    throw new Error(
      `Planned source target has no observed script source: ${sourcePath}`,
    );
}
function assertStepChangeCoverage(
  steps: CreatorPlan["steps"],
  changeIds: string[],
): void {
  const bound = steps.flatMap((step) => step.changeIds);
  if (
    new Set(bound).size !== bound.length ||
    stableJson([...bound].sort()) !== stableJson([...changeIds].sort())
  )
    throw new Error("Creator plan steps must bind every change exactly once");
}
function sourceBearingPlanChange(change: CreatorPlanChange): boolean {
  return (
    change.kind === "write_source" ||
    (change.kind === "create" && isScriptClass(change.className))
  );
}
function assertPlanOutputCoverage(
  changes: CreatorPlanChange[],
  clauses: VerificationCharterProposalClause[],
): void {
  for (const change of changes) {
    if (change.kind !== "create" && change.kind !== "move") continue;
    const path = change.kind === "create" ? change.path : change.toPath;
    const expectedClass =
      change.kind === "create" ? change.className : change.expectedClass;
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
    (
      clause,
    ): clause is Extract<
      VerificationCharterProposalClause,
      { check: "position_series" }
    > => clause.kind === "studio_check" && clause.check === "position_series",
  );
  if (series.length === 0) return;
  const durations = series.map(
    (clause) => (clause.sampleCount - 1) * clause.intervalMs,
  );
  if (
    durations.some(
      (duration) => duration < CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
    )
  )
    throw new Error(
      `Each creator position-series check must span at least ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS} ms so creator-triggered behavior can occur during the authoritative Play Solo observation window`,
    );
  if (
    durations.reduce((total, duration) => total + duration, 0) >
    STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeMs
  )
    throw new Error(
      "Creator position-series checks exceed the manifest runtime budget; use one bounded machine observation and leave unsupported behavior to creator review",
    );
}
function assertPlanChangeSet(
  changes: CreatorPlanChange[],
  observation: StudioProjectState,
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
    throw new Error(
      "Creator plan permits only one change per existing Studio target",
    );
  const plannedInstances = new Set(
    changes.flatMap((change) =>
      change.kind === "create" || change.kind === "move"
        ? [changeOutputPath(change)!]
        : [],
    ),
  );
  for (const change of changes)
    if (
      (change.kind === "create" || change.kind === "move") &&
      plannedInstances.has(pathParent(changeOutputPath(change)!))
    )
      throw new Error(
        "Planned instances cannot parent other planned instances in one change set",
      );
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
  observation: StudioProjectState,
): void {
  PROPOSED_CLAUSE_SCHEMA.parse(clause);
  if (!("path" in clause)) return;
  const path = canonicalStudioPath(clause.path);
  assertCheckPathScope(clause, path);
  if (clause.kind === "snapshot_check") {
    const observed = observation.instances.find((entry) => entry.path === path);
    if (!observed || !classMatches(observed.className, clause.expectedClass))
      throw new Error(
        `Subtree preservation target is absent or class-mismatched: ${path}`,
      );
    if (changes.some((change) => planChangeTouchesPath(change, path)))
      throw new Error(
        `A subtree cannot be declared unchanged while the plan changes it: ${path}`,
      );
    return;
  }
  const resultingClass = resultingClassAt(path, changes, observation);
  if (!resultingClass || !classMatches(resultingClass, clause.expectedClass))
    throw new Error(
      `Machine-check target is absent, deleted, moved away, or class-mismatched: ${path}`,
    );
  if (
    clause.check === "position_series" &&
    clause.minimumDistinctPositions > clause.sampleCount
  )
    throw new Error(
      "Position-series minimum distinct positions cannot exceed its sample count",
    );
}
function materializeCharterClause(
  clause: VerificationCharterProposalClause,
  observation: StudioProjectState,
): VerificationCharterClause {
  if (clause.kind === "creator_review") return { ...clause };
  if (clause.kind === "local_check")
    return { ...clause, statement: machineStatement(clause) };
  if (clause.kind === "snapshot_check")
    return {
      ...clause,
      statement: machineStatement(clause),
      baselineHash: subtreeSnapshotHash(observation, clause.path),
    };
  return {
    ...clause,
    statement: machineStatement(clause),
  } as VerificationCharterClause;
}
function charterProposalFromFinal(
  clause: VerificationCharterClause,
): VerificationCharterProposalClause {
  if (clause.kind === "creator_review") return { ...clause };
  if (clause.kind === "local_check")
    return { id: clause.id, kind: clause.kind, check: clause.check };
  if (clause.kind === "snapshot_check")
    return {
      id: clause.id,
      kind: clause.kind,
      check: clause.check,
      path: clause.path,
      expectedClass: clause.expectedClass,
    };
  if (clause.check === "instance_exists")
    return {
      id: clause.id,
      kind: clause.kind,
      check: clause.check,
      path: clause.path,
      expectedClass: clause.expectedClass,
    };
  if (clause.check === "position_series")
    return {
      id: clause.id,
      kind: clause.kind,
      check: clause.check,
      path: clause.path,
      expectedClass: clause.expectedClass,
      sampleCount: clause.sampleCount,
      intervalMs: clause.intervalMs,
      quantizationStuds: clause.quantizationStuds,
      minimumDistinctPositions: clause.minimumDistinctPositions,
    };
  return {
    id: clause.id,
    kind: clause.kind,
    check: clause.check,
    maximumErrors: clause.maximumErrors,
    maximumWarnings: clause.maximumWarnings,
  };
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
    return `${clause.path} produces at least ${clause.minimumDistinctPositions} distinct ${clause.quantizationStuds}-stud-quantized positions across ${clause.sampleCount} samples taken every ${clause.intervalMs} ms.`;
  return `The complete approved playtest emits at most ${clause.maximumErrors} errors and ${clause.maximumWarnings} warnings; diagnostic capture must not truncate.`;
}
function assertFinalCharterClause(clause: VerificationCharterClause): void {
  FINAL_CLAUSE_SCHEMA.parse(clause);
  if ("path" in clause)
    assertCheckPathScope(clause, canonicalStudioPath(clause.path));
  if (clause.kind !== "creator_review") {
    const {
      statement: _statement,
      baselineHash: _baselineHash,
      ...proposal
    } = clause as VerificationCharterClause & { baselineHash?: string };
    if (
      clause.statement !==
      machineStatement(
        proposal as Exclude<
          VerificationCharterProposalClause,
          { kind: "creator_review" }
        >,
      )
    )
      throw new Error("VerificationCharter machine statement is not canonical");
  }
}
function assertCheckPathScope(
  clause: Extract<
    VerificationCharterProposalClause | VerificationCharterClause,
    { path: string }
  >,
  path: string,
): void {
  if (!isAllowedStudioPath(path))
    throw new Error(
      `Creator check path is outside allowlisted Studio roots: ${path}`,
    );
  if (
    clause.kind === "studio_check" &&
    clause.check === "position_series" &&
    !path.startsWith("Workspace/")
  )
    throw new Error(
      "Creator position-series checks are bounded to Workspace BaseParts",
    );
}
export function subtreeSnapshotHash(
  observation: StudioProjectState,
  rootPath: string,
): string {
  assertStudioProjectState(observation);
  const root = canonicalStudioPath(rootPath);
  const under = (path: string) => path === root || path.startsWith(`${root}/`);
  const payload = {
    instances: observation.instances
      .filter((entry) => under(entry.path))
      .map((entry) => structuredClone(entry))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.stableId.localeCompare(right.stableId),
      ),
    scripts: observation.scripts
      .filter((entry) => under(entry.path))
      .map(({ source: _source, ...entry }) => ({ ...entry }))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.stableId.localeCompare(right.stableId),
      ),
    remotes: observation.remotes
      .filter((entry) => under(entry.path))
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (payload.instances.length === 0)
    throw new Error(`Subtree snapshot target is absent: ${root}`);
  return contentHash(stableJson(payload));
}

/** Stable factual Studio state, excluding capture time and transport revision. */
export function studioProjectStateHash(
  observation: StudioProjectState,
): string {
  assertStudioProjectState(observation);
  return contentHash(
    stableJson({
      project: observation.project,
      instances: observation.instances,
      scripts: observation.scripts.map(
        ({ source: _source, ...script }) => script,
      ),
      remotes: observation.remotes,
    }),
  );
}
function creatorPropertyPolicies(): Record<
  StudioWritableClass,
  CreatorPropertyPolicy
> {
  return Object.fromEntries(
    STUDIO_CAPABILITY_MANIFEST.classes.map((classDefinition) => [
      classDefinition.name,
      {
        allowedProperties: classDefinition.properties.map((property) => ({
          name: property.name,
          valueKinds: [property.codec],
          constraints: {
            ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
            ...(property.minimumExclusive === undefined ? {} : { minimumExclusive: property.minimumExclusive }),
            ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
            ...(property.maximumAbsoluteTranslation === undefined ? {} : { cframeTranslationMaximumAbsolute: property.maximumAbsoluteTranslation }),
            ...(property.maximumUtf8Bytes === undefined ? {} : { maximumUtf8Bytes: property.maximumUtf8Bytes }),
            ...(property.maximumEntries === undefined ? {} : { maximumEntries: property.maximumEntries }),
            ...(property.referenceClass === undefined ? {} : { referenceClass: property.referenceClass }),
            ...(property.allowed === undefined ? {} : { allowedStrings: [...property.allowed] }),
          },
        })),
        attributes: "primitive" as const,
        source: classDefinition.source === "required_on_create_and_writeable" ? "required" as const : "forbidden" as const,
      },
    ]),
  ) as Record<StudioWritableClass, CreatorPropertyPolicy>;
}
function assertCreatorPropertyPolicy(
  value: unknown,
): asserts value is CreatorPropertyPolicy {
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
        (entry.constraints === undefined ||
          validPropertyConstraints(entry.constraints)),
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
    "maximumUtf8Bytes",
    "maximumEntries",
  ];
  if (
    Object.keys(value).some(
      (key) =>
        !numericKeys.includes(key) &&
        key !== "allowedStrings" &&
        key !== "referenceClass",
    )
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
        (typeof value[key] !== "number" ||
          !Number.isFinite(value[key] as number)),
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
  observation: StudioProjectState,
  policies: Readonly<Record<string, CreatorPropertyPolicy>>,
): CreatorBuildContractChange {
  const identity = (suffix: string) =>
    `${suffix}_${contentHash(stableJson({ planHash: plan.hash, planChangeId: change.id })).slice(0, 24)}`;
  const operationId = identity("creator_operation");
  const policyFor = (className: StudioWritableClass): CreatorPropertyPolicy => {
    const policy = policies[className];
    if (policy === undefined)
      throw new Error(
        `Creator build contract has no sealed policy for ${className}`,
      );
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
      parentPath,
      name,
      className: change.className,
      tempId: identity("creator_temp"),
      propertyPolicy: policyFor(change.className),
    };
  }
  const sourcePath = change.kind === "move" ? change.fromPath : change.path;
  const instance = observation.instances.find(
    (entry) => entry.path === sourcePath,
  );
  if (!instance)
    throw new Error(
      `Approved plan target is absent from the initial snapshot: ${sourcePath}`,
    );
  if (change.kind === "update")
    return {
      planChangeId: change.id,
      operationId,
      kind: "update",
      stableId: instance.stableId,
      expectedPath: change.path,
      expectedClass: change.expectedClass,
      beforeHash: contentHash(stableJson(instance)),
      propertyPolicy: policyFor(change.expectedClass),
    };
  if (change.kind === "move") {
    const parentPath = pathParent(change.toPath);
    return {
      planChangeId: change.id,
      operationId,
      kind: "move",
      stableId: instance.stableId,
      expectedPath: change.fromPath,
      expectedClass: change.expectedClass,
      beforeHash: contentHash(stableJson(instance)),
      parentPath,
      name: change.toPath.slice(parentPath.length + 1),
      propertyPolicy: policyFor(change.expectedClass),
    };
  }
  if (change.kind === "delete")
    return {
      planChangeId: change.id,
      operationId,
      kind: "delete",
      stableId: instance.stableId,
      expectedPath: change.path,
      expectedClass: change.expectedClass,
      beforeHash: contentHash(stableJson(instance)),
      propertyPolicy: policyFor(change.expectedClass),
    };
  const script = observation.scripts.find(
    (entry) =>
      entry.stableId === instance.stableId && entry.path === change.path,
  );
  if (!script)
    throw new Error(
      `Approved source target is absent from the initial snapshot: ${change.path}`,
    );
  return {
    planChangeId: change.id,
    operationId,
    kind: "write_source",
    stableId: instance.stableId,
    expectedPath: change.path,
    expectedClass: change.expectedClass,
    beforeSourceHash: script.sourceHash,
    propertyPolicy: policyFor(change.expectedClass),
  };
}
function contractInspectionPaths(change: CreatorBuildContractChange): string[] {
  if (change.kind === "create") return [change.parentPath];
  if (change.kind === "move") return [change.expectedPath, change.parentPath];
  return [change.expectedPath];
}
function deriveStudioOperation(
  contractChange: CreatorBuildContractChange,
  payload: CreatorStagePayload,
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
      payload.source !== undefined)
  )
    rejectCreativePayload("delete has no creative payload");
  if (contractChange.kind === "move" && payload.source !== undefined)
    rejectCreativePayload("move cannot carry source");
  if (
    contractChange.kind === "write_source" &&
    Object.keys(propertyInputs).length > 0
  )
    rejectCreativePayload("write_source cannot carry instance properties");
  if (
    !["update", "move", "write_source"].includes(contractChange.kind) &&
    removedAttributes.length > 0
  )
    rejectCreativePayload(
      "Only an existing-target change may remove attributes",
    );
  if (
    new Set(removedAttributes).size !== removedAttributes.length ||
    removedAttributes.some((name) => Object.hasOwn(attributes, name))
  )
    rejectCreativePayload(
      "Attribute removals must be unique and disjoint from attribute sets",
    );
  if (
    contractChange.propertyPolicy.source === "required" &&
    (payload.source === undefined || payload.source.trim().length === 0)
  )
    throw correctiveFailure(
      "SOURCE_REQUIRED",
      "This approved change requires complete non-empty inline source",
      { received: payload, expected },
    );
  if (
    contractChange.propertyPolicy.source === "forbidden" &&
    payload.source !== undefined
  )
    rejectCreativePayload("This approved change cannot carry source");
  try {
    properties = normalizeCreatorPropertyInputs(
      contractChange.propertyPolicy,
      propertyInputs,
    );
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
      parentPath: contractChange.parentPath,
      className: contractChange.className,
      name: contractChange.name,
      properties,
      attributes: attributes as Record<string, string | number | boolean>,
      ...(payload.source === undefined ? {} : { source: payload.source }),
    };
  if (contractChange.kind === "update")
    return {
      id: contractChange.operationId,
      planChangeId: contractChange.planChangeId,
      kind: "update",
      stableId: contractChange.stableId,
      expectedPath: contractChange.expectedPath,
      expectedClass: contractChange.expectedClass,
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
      stableId: contractChange.stableId,
      expectedPath: contractChange.expectedPath,
      expectedClass: contractChange.expectedClass,
      beforeHash: contractChange.beforeHash,
      parentPath: contractChange.parentPath,
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
      stableId: contractChange.stableId,
      expectedPath: contractChange.expectedPath,
      expectedClass: contractChange.expectedClass,
      beforeHash: contractChange.beforeHash,
    };
  return {
    id: contractChange.operationId,
    planChangeId: contractChange.planChangeId,
    kind: "write_source",
    stableId: contractChange.stableId,
    expectedPath: contractChange.expectedPath,
    expectedClass: contractChange.expectedClass,
    beforeSourceHash: contractChange.beforeSourceHash,
    source: payload.source!,
    attributes,
    removedAttributes,
  };
}

function normalizeCreatorPropertyInputs(
  policy: CreatorPropertyPolicy,
  properties: Record<string, CreatorPropertyInput>,
): Record<string, StudioValue> {
  const allowed = new Map(
    policy.allowedProperties.map((property) => [property.name, property]),
  );
  return Object.fromEntries(
    Object.entries(properties).map(([name, input]) => {
      const rule = allowed.get(name);
      if (!rule)
        throw new Error(
          `Property ${name} is not allowlisted; allowed properties: ${[...allowed.keys()].join(", ") || "none"}`,
        );
      const value = normalizeCreatorPropertyInput(name, input, rule);
      if (!rule.valueKinds.includes(value.kind))
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
  const rule = policy.allowedProperties.find(
    (candidate) => candidate.name === input.propertyName,
  );
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
  );
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
  if (input === null && expectedKind === "instance_ref") {
    const expectedClass = rule.constraints?.referenceClass;
    if (expectedClass === undefined)
      throw new Error(`Property ${name} has no manifest Instance reference constraint`);
    return canonicalStudioValue({ kind: expectedKind, state: "nil", expectedClass });
  }
  if (typeof input === "boolean" && expectedKind === "boolean") return { kind: "boolean", value: input };
  if (typeof input === "number") {
    if (expectedKind === "number_f32")
      return canonicalStudioValue({ kind: expectedKind, value: input });
    if (expectedKind === "number_f64")
      return canonicalStudioValue({ kind: expectedKind, value: input });
    if (expectedKind === "int32")
      return canonicalStudioValue({ kind: expectedKind, value: input });
  }
  if (typeof input === "string") {
    if (expectedKind === "enum_name") return { kind: expectedKind, value: input };
    if (expectedKind === "string_utf8" || expectedKind === "content")
      return { kind: expectedKind, value: input };
    if (expectedKind === "int64_decimal")
      return { kind: expectedKind, value: input };
    if (expectedKind === "brick_color")
      return { kind: expectedKind, name: input };
  }
  if (typeof input === "object" && input !== null && "position" in input && expectedKind === "cframe_f32x12") {
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
    const clean = (value: number): number =>
      studioFloat(Math.abs(value) < 1e-12 ? 0 : value);
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
  if (
    typeof input === "object" &&
    input !== null &&
    "scale" in input &&
    expectedKind === "udim"
  )
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
      keypoints: (input.keypoints as readonly {
        time: number;
        color: { r: number; g: number; b: number };
      }[]).map((keypoint) => ({
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
  if (
    typeof input === "object" &&
    input !== null &&
    "family" in input &&
    expectedKind === "font"
  )
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
  if (
    typeof input === "object" &&
    input !== null &&
    "top" in input &&
    expectedKind === "faces"
  )
    return { kind: expectedKind, ...input };
  if (
    typeof input === "object" &&
    input !== null &&
    "origin" in input &&
    expectedKind === "ray"
  )
    return canonicalStudioValue({ kind: expectedKind, ...input });
  if (
    typeof input === "object" &&
    input !== null &&
    "stableId" in input &&
    expectedKind === "instance_ref"
  ) {
    const expectedClass = rule.constraints?.referenceClass;
    if (
      expectedClass === undefined ||
      !isRobloxClassAssignableTo(input.className, expectedClass)
    )
      throw new Error(
        `Property ${name} requires a stable reference assignable to ${expectedClass ?? "its manifest class"}`,
      );
    return canonicalStudioValue({
      kind: expectedKind,
      state: "reference",
      stableId: input.stableId,
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
      change.path !== `${operation.parentPath}/${operation.name}` ||
      change.className !== operation.className
    )
      throw new Error(
        "Create operation does not match its approved path and class",
      );
    if (
      isScriptClass(operation.className) &&
      (change.initialization !== "inline_source_required" ||
        operation.source === undefined)
    )
      throw new Error(
        "Approved script creation requires complete inline source in its one create operation",
      );
    if (
      !isScriptClass(operation.className) &&
      (change.initialization !== "initial_properties" ||
        operation.source !== undefined)
    )
      throw new Error(
        "Approved non-script creation requires initial properties and cannot carry source",
      );
  }
  if (
    operation.kind === "update" &&
    (change.kind !== "update" ||
      change.path !== operation.expectedPath ||
      change.expectedClass !== operation.expectedClass)
  )
    throw new Error("Update operation does not match its approved target");
  if (
    operation.kind === "move" &&
    (change.kind !== "move" ||
      change.fromPath !== operation.expectedPath ||
      change.toPath !== `${operation.parentPath}/${operation.name}` ||
      change.expectedClass !== operation.expectedClass)
  )
    throw new Error(
      "Move operation does not match its approved source, destination, and class",
    );
  if (
    operation.kind === "delete" &&
    (change.kind !== "delete" ||
      change.path !== operation.expectedPath ||
      change.expectedClass !== operation.expectedClass)
  )
    throw new Error("Delete operation does not match its approved target");
  if (
    operation.kind === "write_source" &&
    (change.kind !== "write_source" ||
      change.path !== operation.expectedPath ||
      change.expectedClass !== operation.expectedClass)
  )
    throw new Error("Source operation does not match its approved target");
}
function assertOperationsMatchPlan(
  operations: StudioChangeOperation[],
  changes: CreatorPlanChange[],
): void {
  if (operations.length !== changes.length)
    throw new Error(
      "Creator change set must implement every approved plan change exactly once",
    );
  const bindings = operations.map((operation) => operation.planChangeId);
  if (
    new Set(bindings).size !== bindings.length ||
    stableJson([...bindings].sort()) !==
      stableJson(changes.map((change) => change.id).sort())
  )
    throw new Error(
      "Creator change set plan-change coverage is incomplete or duplicated",
    );
  operations.forEach((operation) =>
    assertOperationMatchesPlan(operation, changes),
  );
}
function assertOperationsMatchContract(
  operations: StudioChangeOperation[],
  contract: CreatorBuildContract,
): void {
  if (operations.length !== contract.changes.length)
    throw new Error(
      "Creator change set must implement every build-contract change exactly once",
    );
  for (const operation of operations) {
    const change = contract.changes.find(
      (entry) => entry.planChangeId === operation.planChangeId,
    );
    if (
      !change ||
      change.operationId !== operation.id ||
      change.kind !== operation.kind
    )
      throw new Error(
        "Creator change set operation is not derived from its build contract",
      );
    if (
      operation.kind === "create" &&
      (change.kind !== "create" ||
        operation.tempId !== change.tempId ||
        operation.parentPath !== change.parentPath ||
        operation.name !== change.name ||
        operation.className !== change.className)
    )
      throw new Error(
        "Creator create operation does not match its build contract",
      );
    if (
      operation.kind === "update" &&
      (change.kind !== "update" ||
        operation.stableId !== change.stableId ||
        operation.expectedPath !== change.expectedPath ||
        operation.expectedClass !== change.expectedClass ||
        operation.beforeHash !== change.beforeHash)
    )
      throw new Error(
        "Creator update operation does not match its build contract",
      );
    if (
      operation.kind === "move" &&
      (change.kind !== "move" ||
        operation.stableId !== change.stableId ||
        operation.expectedPath !== change.expectedPath ||
        operation.expectedClass !== change.expectedClass ||
        operation.beforeHash !== change.beforeHash ||
        operation.parentPath !== change.parentPath ||
        operation.name !== change.name)
    )
      throw new Error(
        "Creator move operation does not match its build contract",
      );
    if (
      operation.kind === "delete" &&
      (change.kind !== "delete" ||
        operation.stableId !== change.stableId ||
        operation.expectedPath !== change.expectedPath ||
        operation.expectedClass !== change.expectedClass ||
        operation.beforeHash !== change.beforeHash)
    )
      throw new Error(
        "Creator delete operation does not match its build contract",
      );
    if (
      operation.kind === "write_source" &&
      (change.kind !== "write_source" ||
        operation.stableId !== change.stableId ||
        operation.expectedPath !== change.expectedPath ||
        operation.expectedClass !== change.expectedClass ||
        operation.beforeSourceHash !== change.beforeSourceHash)
    )
      throw new Error(
        "Creator source operation does not match its build contract",
      );
    assertOperationCreativePayload(operation, change.propertyPolicy);
  }
}
function assertOperationCreativePayload(
  operation: StudioChangeOperation,
  policy: CreatorPropertyPolicy,
): void {
  const properties =
    operation.kind === "create" ||
    operation.kind === "update" ||
    operation.kind === "move"
      ? operation.properties
      : {};
  const attributes =
    operation.kind === "create" ||
    operation.kind === "update" ||
    operation.kind === "move" ||
    operation.kind === "write_source"
      ? operation.attributes
      : {};
  const removedAttributes =
    operation.kind === "update" ||
    operation.kind === "move" ||
    operation.kind === "write_source"
      ? operation.removedAttributes
      : [];
  assertPropertiesWithPolicy(policy, properties);
  assertAttributes(attributes);
  assertRemovedAttributes(removedAttributes);
  if (removedAttributes.some((name) => Object.hasOwn(attributes, name)))
    throw new Error("Operation attributes cannot be both set and removed");
  const source =
    operation.kind === "create" || operation.kind === "write_source"
      ? operation.source
      : undefined;
  if (policy.source === "required") assertRequiredSource(source);
  else if (source !== undefined)
    throw new Error("Operation source is forbidden by its build contract");
}
function assertStudioChangeOperation(
  operation: StudioChangeOperation,
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
): void {
  CHANGE_OPERATION_SCHEMA.parse(operation);
  if (operation.kind === "create") {
    assertWritableParent(operation.parentPath, observation, ownership);
    if (
      observation.instances.some(
        (entry) => entry.path === `${operation.parentPath}/${operation.name}`,
      )
    )
      throw new Error("Creator create target already exists");
    if (isScriptClass(operation.className) !== (operation.source !== undefined))
      throw new Error(
        "Created scripts require source and non-scripts cannot carry source",
      );
    if (isScriptClass(operation.className))
      assertRequiredSource(operation.source);
    assertProperties(operation.className, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
    );
    assertAttributes(operation.attributes);
    return;
  }
  const observed = observation.instances.find(
    (entry) => entry.stableId === operation.stableId,
  );
  const owner = ownership.entries.find(
    (entry) => entry.stableId === operation.stableId,
  );
  if (!observed || !owner || owner.owner !== "studio" || !owner.writable)
    throw new Error("Studio operation target is absent or externally owned");
  if (
    observed.path !== operation.expectedPath ||
    observed.className !== operation.expectedClass
  )
    throw new Error("Studio operation target precondition mismatch");
  if (operation.kind === "write_source") {
    const script = observation.scripts.find(
      (entry) => entry.stableId === operation.stableId,
    );
    if (!script || script.sourceHash !== operation.beforeSourceHash)
      throw new Error("Studio script source precondition mismatch");
    assertRequiredSource(operation.source);
    assertAttributes(operation.attributes);
    assertRemovedAttributes(operation.removedAttributes);
    if (
      operation.removedAttributes.some((name) =>
        Object.hasOwn(operation.attributes, name),
      )
    )
      throw new Error("Updated attributes cannot be both set and removed");
    return;
  }
  if (contentHash(stableJson(observed)) !== operation.beforeHash)
    throw new Error("Studio instance precondition hash mismatch");
  if (operation.kind === "update") {
    assertProperties(operation.expectedClass, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
    );
    assertAttributes(operation.attributes);
    assertRemovedAttributes(operation.removedAttributes);
    if (
      operation.removedAttributes.some((name) =>
        Object.hasOwn(operation.attributes, name),
      )
    )
      throw new Error("Updated attributes cannot be both set and removed");
  }
  if (operation.kind === "move") {
    assertWritableParent(operation.parentPath, observation, ownership);
    if (
      observation.instances.some(
        (entry) =>
          entry.stableId !== operation.stableId &&
          entry.path === `${operation.parentPath}/${operation.name}`,
      )
    )
      throw new Error("Creator move destination already exists");
    assertProperties(operation.expectedClass, operation.properties);
    assertInstanceReferenceProperties(
      operation.properties,
      observation,
      ownership,
    );
    assertAttributes(operation.attributes);
    assertRemovedAttributes(operation.removedAttributes);
    if (
      operation.removedAttributes.some((name) =>
        Object.hasOwn(operation.attributes, name),
      )
    )
      throw new Error("Updated attributes cannot be both set and removed");
  }
}
function assertInstanceReferenceProperties(
  properties: Record<string, StudioValue>,
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
): void {
  for (const [propertyName, value] of Object.entries(properties)) {
    if (value.kind !== "instance_ref") continue;
    if (value.state === "nil") continue;
    const observed = observation.instances.find(
      (entry) => entry.stableId === value.stableId,
    );
    const owner = ownership.entries.find(
      (entry) => entry.stableId === value.stableId,
    );
    if (
      observed === undefined ||
      owner?.owner !== "studio" ||
      observed.path !== value.path ||
      observed.className !== value.className ||
      !isRobloxClassAssignableTo(value.className, value.expectedClass)
    )
      throw new Error(
        `Property ${propertyName} requires an exact stable Studio-owned instance reference`,
      );
  }
}
function assertProperties(
  className: StudioWritableClass,
  properties: Record<string, StudioValue>,
): void {
  assertPropertiesWithPolicy(creatorPropertyPolicies()[className], properties);
  const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
  if (!manifestClass) throw new Error(`Class ${className} is outside the Studio capability manifest`);
  for (const [name, value] of Object.entries(properties)) {
    const property = manifestClass.properties.find((entry) => entry.name === name);
    if (!property) throw new Error(`Property ${className}.${name} is outside the Studio capability manifest`);
    assertStudioValueForProperty(value, property);
  }
}
function assertPropertiesWithPolicy(
  policy: CreatorPropertyPolicy,
  properties: Record<string, StudioValue>,
): void {
  const allowed = new Map(
    policy.allowedProperties.map((property) => [property.name, property]),
  );
  for (const [name, value] of Object.entries(properties)) {
    const rule = allowed.get(name);
    if (!rule)
      throw new Error(
        `Property ${name} is not allowlisted; allowed properties: ${[...allowed.keys()].join(", ") || "none"}`,
      );
    if (!rule.valueKinds.includes(value.kind))
      throw new Error(
        `Property ${name} requires a typed ${rule.valueKinds.join(" or ")} value`,
      );
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
        throw new Error(
          `Property ${name} requires canonical 8-bit Studio color channels`,
        );
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
      throw new Error(
        `Property ${name} is below its minimum ${constraints.minimum}`,
      );
    if (constraints.maximum !== undefined && scalar > constraints.maximum)
      throw new Error(
        `Property ${name} exceeds its maximum ${constraints.maximum}`,
      );
    if (
      constraints.minimumExclusive !== undefined &&
      scalar <= constraints.minimumExclusive
    )
      throw new Error(
        `Property ${name} must be greater than ${constraints.minimumExclusive}`,
      );
    if (
      constraints.maximumAbsolute !== undefined &&
      Math.abs(scalar) > constraints.maximumAbsolute
    )
      throw new Error(
        `Property ${name} exceeds its absolute bound ${constraints.maximumAbsolute}`,
      );
  }
  if (value.kind === "string_utf8" || value.kind === "enum_name") {
    if (
      constraints.maximumUtf8Bytes !== undefined &&
      Buffer.byteLength(value.value, "utf8") > constraints.maximumUtf8Bytes
    )
      throw new Error(`Property ${name} exceeds its UTF-8 byte bound`);
    if (
      constraints.allowedStrings &&
      !constraints.allowedStrings.includes(value.value)
    )
      throw new Error(
        `Property ${name} must be one of: ${constraints.allowedStrings.join(", ")}`,
      );
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
function assertAttributes(
  attributes: Record<string, string | number | boolean>,
): void {
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
function assertRequiredSource(source: unknown): asserts source is string {
  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    Buffer.byteLength(source, "utf8") > 48_000 ||
    Buffer.from(source, "utf8").toString("utf8") !== source
  )
    throw new Error(
      "Required script source must be non-empty valid UTF-8 within the 48000-byte bound",
    );
}
function isAllowedStudioPath(path: string): boolean {
  return STUDIO_AUTHORING_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}
function canonicalParentPath(value: string): string {
  const path = canonicalStudioPath(value);
  if (!isAllowedStudioPath(path))
    throw new Error(`Studio parent root is not allowlisted: ${value}`);
  return path;
}
function assertWritableParent(
  value: string,
  observation: StudioProjectState,
  ownership: StudioOwnershipMap,
): void {
  const path = canonicalParentPath(value);
  const parent = observation.instances.find((entry) => entry.path === path);
  const authority =
    parent &&
    ownership.entries.find((entry) => entry.stableId === parent.stableId);
  if (!parent || !authority?.writable || authority.owner !== "studio")
    throw new Error(
      "Studio operation parent is absent from the initial snapshot or externally owned",
    );
}
function isScriptClass(value: StudioWritableClass): boolean {
  return (
    value === "Script" || value === "LocalScript" || value === "ModuleScript"
  );
}
function isControlActionDescriptor(
  value: unknown,
): value is CreatorControlActionDescriptor {
  return (
    isRecord(value) &&
    [
      "approve_plan",
      "reject_plan",
      "approve_and_apply_changes",
      "reject_changes",
      "start_checks",
      "accept_result",
      "reject_and_rollback",
      "cancel_changes",
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
function assertTransition(
  from: CreatorSessionStatus,
  to: CreatorSessionStatus,
): void {
  const allowed: Record<CreatorSessionStatus, CreatorSessionStatus[]> = {
    planning: ["awaiting_plan_approval", "incomplete"],
    awaiting_plan_approval: ["building", "creator_rejected", "incomplete"],
    building: ["awaiting_change_approval", "incomplete"],
    awaiting_change_approval: ["preflighting", "creator_rejected", "incomplete"],
    preflighting: ["applying", "incomplete"],
    applying: ["awaiting_verification", "cancelling", "incomplete", "recovery_required"],
    awaiting_verification: [
      "verifying",
      "creator_rejected", "cancelling",
      "incomplete",
      "recovery_required",
    ],
    verifying: [
      "committing", "cancelling",
      "repairing",
      "incomplete",
      "recovery_required",
    ],
    cancelling: ["repairing", "creator_rejected", "incomplete", "recovery_required"],
    committing: ["awaiting_review", "recovery_required"],
    repairing: ["awaiting_change_approval", "incomplete"],
    awaiting_review: [
      "creator_accepted",
      "creator_rejected",
      "rolled_back",
      "incomplete",
    ],
    creator_accepted: [],
    creator_rejected: ["rolled_back"],
    rolled_back: [],
    incomplete: [],
    recovery_required: ["cancelling"],
  };
  if (!allowed[from].includes(to))
    throw new Error(`Invalid CreatorSession transition ${from} -> ${to}`);
}
function isStatus(value: unknown): value is CreatorSessionStatus {
  return (
    typeof value === "string" &&
    [
      "planning",
      "awaiting_plan_approval",
      "building",
      "awaiting_change_approval",
      "preflighting",
      "applying",
      "awaiting_verification",
      "verifying",
      "cancelling",
      "committing",
      "repairing",
      "awaiting_review",
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
class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function correctiveFailure(
  code: string,
  message: string,
  details: unknown,
): ToolFailure {
  return new ToolFailure(code, stableJson({ message, details }));
}

export const CREATOR_PLANNER_SYSTEM_PROMPT =
  "You are Forge's read-only creator planner. Use studio.api_lookup to ground every Roblox class, member, datatype, or enum that source-bearing work depends on in the pinned official catalog; its source-only results authorize Luau references, not direct Studio mutation or behavioral proof. Use studio.inspect for exact initial paths whose properties, attributes, position, ownership, or script hashes matter, then publish one typed plan and visible charter with creator.propose_plan. Explicitly declare the exact already-inspected inspectionPaths the builder will need for relationships, placement, integration, or preservation; do not rely on prose inference. Forge derives the plan goal exactly from the immutable creator request: never restate, weaken, or replace it. Each step must bind exact changeIds and the steps must cover every change once. Each change requires an exact path, action, class, and initialization. Every create and move parent must already exist in the initial snapshot and be Studio-writable; a planned instance cannot parent another planned instance. Script, LocalScript, and ModuleScript creation uses initialization inline_source_required: the builder supplies complete source inside that one create operation. write_source only targets a script present in the initial snapshot; never use it for a planned creation. Non-script creation uses initial_properties. Supply only typed fields for machine checks because Forge generates their exact statements. Every create or move output requires an exact class-aware instance_exists check. Any source-bearing plan requires luau_syntax. instance_exists can use an allowlisted Studio root; position_series is Workspace BasePart-only and every creator position series must span the current creator observation window while all sequential series remain within the generated manifest runtime budget, so creator interaction can occur during the authoritative Play Solo window. Playtest diagnostics count the complete playtest rather than attributable messages; subtree_unchanged is only a bounded snapshot comparison. Put visual quality, causal attribution, exact input-to-effect claims, and unsupported gameplay judgments in creator_review. Do not stage changes or invent hidden criteria.";
export const CREATOR_BUILDER_SYSTEM_PROMPT =
  "You are Forge's bounded Studio builder. The exact immutable CreatorBuildContract is supplied below. It already fixes each operation's kind, path, parent, name, class, stable ID, precondition hashes, temporary ID, and operation ID. Never repeat or invent structural fields. Use studio.api_lookup to ground every Roblox class, member, datatype, or enum used in authored source in the pinned official catalog; source-only entries may be referenced in Luau but cannot be sent as typed Studio mutations or claimed as proof. Use studio.inspect only with explicit contract initial paths. For an approved write_source change, use studio.read_source to read its bounded current source before authoring the complete replacement. Use studio.stage with only a planChangeId plus the permitted creative payload. Property inputs use natural JSON without type/value wrappers; follow each sealed property's required codec. Scalars are booleans, finite numbers, or strings. Compound inputs use Vector2 {x,y}, Vector3 {x,y,z}, Color3 {r,g,b} in 0..1, CFrame {position:{x,y,z},rotation:{x,y,z}} in Euler degrees, UDim {scale,offset}, UDim2 {x:{scale,offset},y:{scale,offset}}, Rect {min:{x,y},max:{x,y}}, NumberRange {min,max}, sequences {keypoints:[...]}, BrickColor {name}, Font {family,weight,style}, PhysicalProperties, Axes, Faces, Ray {origin,direction}, or stable instance reference {stableId,path,className}. Implement every contract change exactly once, inspect the diff, and run forge.verify. The contract's per-class property policy is authoritative. A source-required change needs complete non-empty inline source. Never use arbitrary execution, generic property access, unapproved content IDs, terrain, or externally owned Rojo targets. The live place is not mutated until the creator separately approves the sealed change set.";

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
    throw new Error(
      "CreatorBuildContract does not bind the approved CreatorPlan",
    );
  if (
    verificationFeedback.length > 32 ||
    verificationFeedback.some(
      (failure) => failure.trim().length === 0 || failure.length > 4096,
    )
  )
    throw new Error(
      "Creator verification feedback is invalid or exceeds its bound",
    );
  return `${CREATOR_BUILDER_SYSTEM_PROMPT}\n\nApproved CreatorPlan semantics (verbatim):\n${stableJson(plan)}\n\nCanonical CreatorBuildContract (verbatim):\n${stableJson(contract)}${verificationFeedback.length === 0 ? "" : `\n\nForge verification facts from the prior approved attempt follow as canonical data. Repair the implementation without weakening or changing the approved charter:\n${stableJson({ verificationFeedback: [...verificationFeedback] })}`}`;
}
