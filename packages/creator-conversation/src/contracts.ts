import type { ArtifactReference } from "../../artifact-store/src/index.js";
import type { ModelUsage, ModelRequestSizes } from "../../model-client/src/contracts.js";
import { assertGameBuildControlView, type GameBuildControlView } from "./game-build-contract.js";
import { VISUAL_OBSERVATION_INPUT_SCHEMA } from "../../visual-evidence/src/contracts.js";
import type { VisualObservationInput } from "../../visual-evidence/src/contracts.js";
export type { VisualObservationInput } from "../../visual-evidence/src/contracts.js";

/** Browser-safe reservation shape; lower runtime validates the same closed algebra. */
export interface CreatorAgentExecutionSlot {
  readonly purpose: "planner" | "builder" | "repair";
  readonly ordinal: number;
  readonly agentRunId: string;
  readonly journalId: string;
}

export type CreatorConversationAuthority = "creator" | "agent" | "forge" | "studio";
export type CreatorTurnType = "new_work" | "clarification" | "plan_refinement" | "follow_up";
export type CreatorAgentOutcome = "answer" | "clarification_requested" | "plan_proposed";
export type CreatorWorkEpisodeStatus =
  | "indexing"
  | "planning"
  | "awaiting_clarification"
  | "awaiting_plan_decision"
  | "refining_plan"
  | "building"
  | "awaiting_change_decision"
  | "applying"
  | "awaiting_play"
  | "observing_play"
  | "finalizing"
  | "awaiting_verification_retry"
  | "awaiting_review"
  | "refresh_required"
  | "refreshing"
  | "recovery_required"
  | "awaiting_source_sync"
  | "accepted"
  | "completed"
  | "rejected"
  | "superseded"
  | "incomplete";

export type CreatorProjectIdentity =
  | {
      readonly kind: "published";
      readonly universeId: string;
      readonly placeId: string;
    }
  | {
      readonly kind: "local_linked";
      readonly forgeProjectId: string;
    };

export interface CreatorArtifactBinding {
  readonly id: string;
  readonly hash: string;
  readonly artifact: ArtifactReference;
}

/**
 * A technical artifact whose body deliberately has no Forge record identity.
 * Its `hash` is the immutable artifact hash, and its ID is derived from that
 * hash rather than pretending to identify the referenced body.
 */
export interface CreatorUnboundTechnicalReference {
  readonly kind: "unbound_technical_reference";
  readonly id: string;
  readonly hash: string;
  readonly artifact: ArtifactReference;
}

export type CreatorTechnicalArtifactReference =
  CreatorArtifactBinding | CreatorUnboundTechnicalReference;

export type CreatorCitationTarget =
  | {
      readonly kind: "source_range";
      readonly projectRevisionHash: string;
      readonly sourceIndexHash: string;
      readonly sourceHash: string;
      readonly displayPath: string;
      readonly startByte: number;
      readonly endByte: number;
    }
  | {
      readonly kind: "project_fact";
      readonly projectRevisionHash: string;
      readonly factKey: string;
      readonly factHash: string;
    }
  | {
      readonly kind: "prior_evidence";
      readonly eventId: string;
      readonly eventHash: string;
      readonly evidence: CreatorArtifactBinding;
    }
  | {
      readonly kind: "memory";
      readonly memoryItemId: string;
      readonly revisionId: string;
      readonly revisionHash: string;
    };

export interface CreatorCitation {
  readonly kind: "CreatorCitation";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly issuedForAgentRunId: string;
  readonly handle: string;
  readonly label: string;
  readonly target: CreatorCitationTarget;
  readonly authority: "forge";
}

export type CreatorConversationTurn = CreatorTurn | AgentTurn;

export interface CreatorTurn {
  readonly kind: "CreatorConversationTurn";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly episodeId?: string;
  readonly role: "creator";
  readonly turnType: CreatorTurnType;
  readonly text: string;
  readonly selectedModelId: string;
  readonly projectRevisionHash?: string;
  readonly replyToEventId?: string;
  readonly createdAt: string;
}

export interface AgentTurn {
  readonly kind: "CreatorConversationTurn";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly episodeId?: string;
  readonly role: "agent";
  readonly outcome: CreatorAgentOutcome;
  readonly text: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly responseModelId: string;
  readonly agentRunId: string;
  readonly timing: {
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs: number;
  };
  readonly usage: ModelUsage;
  readonly projectRevisionHash?: string;
  readonly citations: readonly CreatorCitation[];
  readonly createdAt: string;
}

export interface CreatorPlanRevision {
  readonly kind: "CreatorPlanRevision";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly episodeId: string;
  readonly revision: number;
  readonly projectRevisionHash: string;
  readonly modelId: string;
  readonly plan: CreatorArtifactBinding;
  readonly sourceConsultation?: CreatorArtifactBinding;
  readonly supersedes?: { readonly id: string; readonly hash: string };
  readonly publishedAt: string;
}

export interface CreatorMemoryRevision {
  readonly kind: "CreatorMemoryRevision";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly itemId: string;
  readonly revision: number;
  readonly operation: "remember" | "correct" | "pin" | "unpin" | "forget";
  readonly category: "preference" | "convention" | "vocabulary" | "goal" | "unresolved";
  readonly text: string;
  readonly state: "active" | "forgotten";
  readonly pinned: boolean;
  readonly authority: "creator";
  readonly priorRevision?: { readonly id: string; readonly hash: string };
  readonly createdAt: string;
}

export interface CreatorWorkEpisode {
  readonly kind: "CreatorWorkEpisode";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly ordinal: number;
  readonly status: CreatorWorkEpisodeStatus;
  readonly selectedModelId: string;
  readonly initialProjectRevisionHash: string;
  readonly currentProjectRevisionHash: string;
  readonly sessionBundle: CreatorArtifactBinding;
  readonly creatorTurnId: string;
  readonly planRevision?: { readonly id: string; readonly hash: string };
  readonly activeJob?: { readonly id: string; readonly hash: string };
  readonly predecessorEpisodeId?: string;
  readonly successorEpisodeId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatorProjectConversation {
  readonly kind: "CreatorProjectConversation";
  readonly id: string;
  readonly hash: string;
  readonly project: CreatorProjectIdentity;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestEventSequence: number;
  readonly episodeIds: readonly string[];
  readonly activeEpisodeId?: string;
  readonly memoryHeads: readonly {
    readonly itemId: string;
    readonly revisionId: string;
    readonly revisionHash: string;
  }[];
}

export type CreatorWorkJobStatus =
  | "queued"
  | "running"
  | "awaiting_external"
  | "outcome_unknown"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface CreatorWorkJob {
  readonly kind: "CreatorWorkJob";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly episodeId?: string;
  readonly turnId?: string;
  readonly idempotencyKey: string;
  /** SHA-256 of the canonical admitted CreatorTurnRequest/CreatorActionRequest. */
  readonly requestHash: string;
  /** Exact immutable request body; its artifact hash must equal requestHash. */
  readonly admittedRequest: ArtifactReference;
  /** Exact immutable turn contract or control view that authorized admission. */
  readonly admissionAuthority: ArtifactReference;
  /** Preassigned lower transaction identity; required before agent dispatch. */
  readonly transactionSessionId?: string;
  /**
   * Exact lower runtime identities reserved before this job is published.
   * An empty list proves this job has no authority to dispatch a provider.
   */
  readonly agentExecutions: readonly CreatorAgentExecutionSlot[];
  /** Exact terminal agent job whose creator-authorized work this job resumes or retries. */
  readonly resumesJob?: { readonly id: string; readonly hash: string };
  /** Host-authored bounded context persisted before provider dispatch. */
  readonly conversationContext?: ArtifactReference;
  readonly jobType:
    "agent_turn" | "agent_action" | "control_action" | "project_index" | "studio_transaction";
  readonly status: CreatorWorkJobStatus;
  readonly phase: string;
  readonly providerOutcome:
    | "not_applicable"
    | "never_dispatched"
    | "intent_persisted"
    | "response_persisted"
    | "failure_persisted"
    | "outcome_unknown";
  readonly selectedModelId?: string;
  readonly providerRequestId?: string;
  readonly resultEventId?: string;
  readonly failure?: { readonly code: string; readonly detailHash: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatorModelRegistry {
  readonly kind: "CreatorModelRegistry";
  readonly id: string;
  readonly hash: string;
  readonly generatedAt: string;
  readonly defaultModelId: string;
  readonly models: readonly CreatorModelRegistryEntry[];
}

export interface CreatorModelRegistryEntry {
  readonly id: string;
  readonly displayName: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly imageInput: "supported" | "unsupported" | "unknown";
  readonly requiredCapabilities: readonly ["tools"];
  readonly providerFallback: "disabled";
  readonly detail?: string;
}

export type CreatorConversationArtifactRole =
  | "visual_observation"
  | "project_index"
  | "source_consultation"
  | "agent_run"
  | "build_trace"
  | "plan"
  | "change_set"
  | "mutation"
  | "runtime_evidence"
  | "verification"
  | "review_report"
  | "refresh"
  | "source_sync"
  | "recovery"
  | "project_identity"
  | "technical_detail";

export interface CreatorConversationAttachment {
  readonly role: CreatorConversationArtifactRole;
  readonly label: string;
  readonly binding: CreatorArtifactBinding;
}

export interface CreatorTechnicalAttachment {
  readonly role: CreatorConversationArtifactRole;
  readonly label: string;
  readonly binding: CreatorTechnicalArtifactReference;
}

export interface CreatorEventBinding {
  readonly sessionId?: string;
  readonly sessionHash?: string;
  readonly planRevisionId?: string;
  readonly planRevisionHash?: string;
  readonly controlViewId?: string;
  readonly controlViewHash?: string;
}

interface CreatorConversationEventBase {
  readonly kind: "CreatorConversationEvent";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly authority: CreatorConversationAuthority;
  readonly projectRevisionHash?: string;
  readonly episodeId?: string;
  readonly binding?: CreatorEventBinding;
  readonly attachments: readonly CreatorConversationAttachment[];
}

export type CreatorConversationEvent =
  | (CreatorConversationEventBase & {
      readonly eventType: "creator_turn";
      readonly authority: "creator";
      readonly data: {
        readonly turn: CreatorArtifactBinding;
        readonly turnType: CreatorTurnType;
        readonly text: string;
        readonly selectedModelId: string;
        /** Present only when this creator turn atomically admits foreground work. */
        readonly job?: CreatorArtifactBinding;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "agent_turn";
      readonly authority: "agent";
      readonly data: {
        readonly turn: CreatorArtifactBinding;
        readonly outcome: CreatorAgentOutcome;
        readonly modelId: string;
        readonly providerId: string;
        readonly responseModelId: string;
        readonly agentRunId: string;
        readonly timing: AgentTurn["timing"];
        readonly usage: AgentTurn["usage"];
        readonly text: string;
        readonly citations: readonly CreatorCitation[];
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "activity";
      readonly data: {
        readonly job: CreatorArtifactBinding;
        readonly status: CreatorWorkJobStatus;
        readonly phase: string;
        readonly message: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "plan_revision";
      readonly authority: "agent" | "forge";
      readonly data: {
        readonly planRevision: CreatorArtifactBinding;
        readonly recompilation?: CreatorArtifactBinding;
        readonly revision: number;
        readonly summary: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "decision";
      readonly authority: "creator";
      readonly data: {
        readonly actionInstanceId: string;
        readonly decision:
          | "new_conversation"
          | "build"
          | "revise_plan"
          | "reject_plan"
          | "apply"
          | "resume_build"
          | "reject_change"
          | "retry_play"
          | "cancel_change"
          | "keep"
          | "undo"
          | "refresh"
          | "recover"
          | "source_sync"
          | "remember"
          | "correct_memory"
          | "pin_memory"
          | "unpin_memory"
          | "forget_memory"
          | "resume_work"
          | "retry_work"
          | "continue_published_project"
          | "start_published_project";
        readonly report?: string;
        /** Present only when this decision atomically admits foreground work. */
        readonly job?: CreatorArtifactBinding;
        /** A plan-refinement creator turn committed with its authorizing decision. */
        readonly refinement?: {
          readonly turn: CreatorArtifactBinding;
          readonly text: string;
          readonly selectedModelId: string;
        };
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "change_set";
      readonly authority: "agent";
      readonly data: {
        readonly changeSet: CreatorArtifactBinding;
        readonly creates: number;
        readonly updates: number;
        readonly moves: number;
        readonly deletes: number;
        readonly sourceEdits: number;
        readonly summary: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "project_change";
      readonly data: {
        readonly state: "detected" | "refreshed" | "unchanged" | "superseded";
        readonly message: string;
        readonly predecessorEpisodeId?: string;
        readonly successorEpisodeId?: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "mutation";
      readonly data: {
        readonly attemptId: string;
        readonly attemptHash: string;
        readonly status:
          | "preflighting"
          | "provisional"
          | "matched"
          | "mismatched"
          | "incomplete"
          | "committed"
          | "cancelled"
          | "recovery_required";
        readonly message: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "playtest";
      readonly data: {
        readonly state: "ready" | "waiting" | "observing" | "complete" | "incomplete";
        readonly message: string;
        readonly machineChecks: readonly string[];
        readonly creatorChecks: readonly string[];
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "verification";
      readonly authority: "forge";
      readonly data: {
        readonly verification: CreatorArtifactBinding;
        readonly status: "passed" | "failed" | "incomplete";
        readonly failureFacts: readonly { readonly statement: string; readonly hash: string }[];
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "final_review";
      readonly data: {
        readonly state: "requested" | "accepted" | "rejected" | "rolled_back";
        readonly message: string;
        readonly report?: CreatorArtifactBinding;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "recovery";
      readonly data: {
        readonly state: "required" | "available" | "completed" | "incomplete";
        readonly message: string;
        readonly studioMayContainOpenRecording: boolean;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "source_sync";
      readonly data: {
        readonly status: "awaiting" | "matched" | "mismatched" | "reverted";
        readonly message: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "memory";
      readonly authority: "creator";
      readonly data: {
        readonly memoryRevision: CreatorArtifactBinding;
        readonly operation: CreatorMemoryRevision["operation"];
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "job";
      readonly authority: "forge";
      readonly data: {
        readonly job: CreatorArtifactBinding;
        readonly status: CreatorWorkJobStatus;
        readonly message: string;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "project_identity";
      readonly data: {
        readonly state:
          "linked" | "forked" | "unlinked" | "conflict" | "published_continuity" | "published_new";
        readonly project: CreatorProjectIdentity;
        readonly message: string;
        readonly continuityReceipt?: CreatorArtifactBinding;
      };
    })
  | (CreatorConversationEventBase & {
      readonly eventType: "terminal_output";
      readonly authority: "forge" | "agent";
      readonly data: {
        readonly outcome: "completed" | "accepted" | "rejected" | "superseded" | "incomplete";
        readonly message: string;
        readonly studioHasAcceptedResult: boolean;
      };
    });

export interface CreatorConversationCommit {
  readonly kind: "CreatorConversationCommit";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly previousCommitHash?: string;
  readonly previousCommit?: ArtifactReference;
  readonly conversation: ArtifactReference;
  readonly conversationHash: string;
  readonly event: ArtifactReference;
  readonly eventId: string;
  readonly eventHash: string;
  readonly episodeSnapshot?: ArtifactReference;
  readonly episodeId?: string;
  readonly episodeHash?: string;
  readonly turn?: ArtifactReference;
  readonly turnId?: string;
  readonly turnHash?: string;
  readonly citations: readonly {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  }[];
  readonly memoryRevision?: ArtifactReference;
  readonly memoryRevisionId?: string;
  readonly memoryRevisionHash?: string;
  readonly planRevision?: ArtifactReference;
  readonly planRevisionId?: string;
  readonly planRevisionHash?: string;
  readonly job?: ArtifactReference;
  readonly jobId?: string;
  readonly jobHash?: string;
  readonly committedAt: string;
}

export type CreatorControlActionId =
  | "new_conversation"
  | "link_project"
  | "fork_project"
  | "continue_published_project"
  | "start_published_project"
  | "resume_work"
  | "retry_work"
  | "build_plan"
  | "retry_build"
  | "resume_build"
  | "revise_plan"
  | "reject_plan"
  | "apply_changes"
  | "reject_changes"
  | "refresh_project"
  | "retry_play"
  | "cancel_changes"
  | "undo_changes"
  | "keep_changes"
  | "cancel_recovery"
  | "check_source_sync"
  | "revert_source_changes"
  | "remember"
  | "correct_memory"
  | "pin_memory"
  | "unpin_memory"
  | "forget_memory";

export type CreatorControlInputRequirement =
  | { readonly kind: "none" }
  | {
      readonly kind: "text";
      readonly field: "message" | "report" | "confirmation" | "memory";
      readonly label: string;
      readonly minimumBytes: number;
      readonly maximumBytes: number;
      readonly multiline: boolean;
    };

export interface CreatorControlActionDescriptor {
  readonly actionInstanceId: string;
  readonly actionId: CreatorControlActionId;
  readonly label: string;
  readonly intent: "primary" | "secondary" | "danger";
  readonly controlViewId: string;
  readonly authorizingEventId: string;
  readonly authorizingEventHash: string;
  readonly target: "none" | "memory_head";
  readonly input: CreatorControlInputRequirement;
}

export interface CreatorTurnContract {
  readonly kind: "CreatorTurnContract";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly episodeId?: string;
  readonly allowedTurnTypes: readonly CreatorTurnType[];
  readonly replyToEventId?: string;
  readonly planRevisionId?: string;
  readonly planRevisionHash?: string;
  readonly projectRevisionHash?: string;
  readonly modelRegistryHash: string;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly issuedAt: string;
}

export interface CreatorControlView {
  readonly kind: "CreatorControlView";
  readonly id: string;
  readonly hash: string;
  readonly conversationId: string;
  readonly conversationHash: string;
  readonly eventSequence: number;
  readonly episodeId?: string;
  readonly status:
    "ready" | "working" | "awaiting_creator" | "blocked" | "recovery_required" | "terminal";
  readonly title: string;
  readonly detail: string;
  readonly turnContract?: CreatorTurnContract;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly activeActivity?: {
    readonly jobId: string;
    readonly status: CreatorWorkJobStatus;
    readonly phase: string;
    readonly message: string;
    readonly startedAt: string;
  };
  readonly technicalAttachments: readonly CreatorTechnicalAttachment[];
  readonly gameBuild?: GameBuildControlView;
}

export interface CreatorConversationSummary {
  readonly id: string;
  readonly hash: string;
  readonly title: string;
  readonly projectName: string;
  readonly project: CreatorProjectIdentity;
  readonly status: CreatorControlView["status"];
  readonly currentProjectRevisionHash?: string;
  readonly latestEventSequence: number;
  readonly episodeCount: number;
  readonly updatedAt: string;
}

export interface CreatorConversationEventPage {
  readonly conversationId: string;
  readonly events: readonly CreatorConversationEvent[];
  readonly beforeCursor?: string;
  readonly nextBeforeCursor?: string;
  readonly complete: boolean;
}

export interface CreatorWorkEpisodeSummary {
  readonly id: string;
  readonly hash: string;
  readonly ordinal: number;
  readonly status: CreatorWorkEpisodeStatus;
  readonly selectedModelId: string;
  readonly currentProjectRevisionHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatorMemorySummary {
  readonly itemId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly category: CreatorMemoryRevision["category"];
  readonly text: string;
  readonly pinned: boolean;
  readonly state: CreatorMemoryRevision["state"];
}

export interface CreatorDashboardState {
  readonly kind: "CreatorDashboardState";
  readonly conversations: readonly CreatorConversationSummary[];
  readonly selectedConversationId?: string;
  readonly selectedConversation?: CreatorProjectConversation;
  readonly eventPage?: CreatorConversationEventPage;
  readonly episodes: readonly CreatorWorkEpisodeSummary[];
  readonly memories: readonly CreatorMemorySummary[];
  readonly projectSettings?: {
    readonly controlView: CreatorControlView;
    readonly memories: readonly CreatorMemorySummary[];
  };
  readonly modelRegistry: CreatorModelRegistry;
  readonly controlView?: CreatorControlView;
  readonly pairedStudio: {
    readonly status: "unpaired" | "connecting" | "ready" | "update_required" | "attention";
    readonly message: string;
    readonly project?: CreatorProjectIdentity;
    readonly projectName?: string;
    readonly projectRevisionHash?: string;
    readonly indexStatus?: "indexing" | "complete" | "incomplete" | "dirty";
    readonly transactionStatus: "clear" | "pending" | "blocked" | "unavailable";
  };
  readonly serverTime: string;
  readonly agentActivities?: readonly {
    readonly jobId: string;
    /** Position after the admitting creator event; wall clocks do not determine message order. */
    readonly afterEventSequence: number;
    /** Absent during host-owned Studio work; no provider execution is implied. */
    readonly agentRunId?: string;
    readonly running: boolean;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly currentStep: string;
    /** Public assistant commentary only; provider continuations are never presentation data. */
    readonly commentary: readonly { readonly sequence: number; readonly text: string }[];
    readonly modelTurns: number;
    readonly usage: ModelUsage | null;
    readonly requestSizes: ModelRequestSizes | null;
    readonly steps: readonly {
      readonly sequence: number;
      readonly toolName?: string;
      readonly label: string;
      readonly detail: string;
      readonly status: "complete" | "failed";
    }[];
  }[];
}

export interface CreatorTurnRequest {
  readonly kind: "CreatorTurnRequest";
  readonly conversationId?: string;
  readonly turnContractId: string;
  readonly turnContractHash: string;
  readonly turnKind: CreatorTurnType;
  readonly text: string;
  readonly selectedModelId: string;
  readonly idempotencyKey: string;
  /** Original creator-supplied pixels, sealed by the host against submission context. */
  readonly visualObservations?: readonly VisualObservationInput[];
}

export interface CreatorActionRequest {
  readonly kind: "CreatorActionRequest";
  readonly conversationId: string;
  readonly viewId: string;
  readonly viewHash: string;
  readonly actionInstanceId: string;
  readonly idempotencyKey: string;
  readonly target?: {
    readonly kind: "memory_head";
    readonly itemId: string;
    readonly revisionId: string;
    readonly revisionHash: string;
  };
  readonly input?: {
    readonly report?: string;
    readonly text?: string;
    readonly memoryCategory?: CreatorMemoryRevision["category"];
    /** Required only for plan-card refinement; selected by the creator. */
    readonly selectedModelId?: string;
    readonly modelRegistryHash?: string;
  };
}

export interface CreatorWorkAdmission {
  readonly kind: "CreatorWorkAdmission";
  readonly jobId: string;
  readonly conversationId: string;
  readonly acceptedAt: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_TEXT_BYTES = 1024 * 1024;

export function assertCreatorProjectConversation(
  value: unknown,
): asserts value is CreatorProjectConversation {
  const record = assertRecord(value, "CreatorProjectConversation");
  assertKindIdentity(record, "CreatorProjectConversation");
  assertProjectIdentity(record.project, "conversation project");
  assertBoundedText(record.title, "conversation title", 1, 512);
  const created = assertCanonicalIso(record.createdAt, "conversation createdAt");
  const updated = assertCanonicalIso(record.updatedAt, "conversation updatedAt");
  if (updated < created) throw new Error("Invalid CreatorProjectConversation interval");
  assertNonNegativeInteger(record.latestEventSequence, "conversation event sequence");
  assertUniqueIds(record.episodeIds, "conversation episode IDs", 100_000);
  if (record.activeEpisodeId !== undefined) {
    assertId(record.activeEpisodeId, "conversation active episode");
    if (!(record.episodeIds as unknown[]).includes(record.activeEpisodeId))
      throw new Error("Conversation active episode is not in episodeIds");
  }
  if (!Array.isArray(record.memoryHeads) || record.memoryHeads.length > 100_000)
    throw new Error("Invalid conversation memory heads");
  let previousItem = "";
  for (const head of record.memoryHeads) {
    const entry = assertRecord(head, "conversation memory head");
    assertId(entry.itemId, "memory item");
    assertId(entry.revisionId, "memory revision");
    assertHash(entry.revisionHash, "memory revision hash");
    if (String(entry.itemId) <= previousItem)
      throw new Error("Conversation memory heads must be unique and canonically ordered");
    previousItem = String(entry.itemId);
  }
}

export function assertCreatorConversationTurn(
  value: unknown,
): asserts value is CreatorConversationTurn {
  const record = assertRecord(value, "CreatorConversationTurn");
  assertKindIdentity(record, "CreatorConversationTurn");
  assertId(record.conversationId, "turn conversation");
  optionalId(record.episodeId, "turn episode");
  assertBoundedText(record.text, "turn text", 1, MAX_TEXT_BYTES);
  optionalHash(record.projectRevisionHash, "turn project revision");
  assertCanonicalIso(record.createdAt, "turn createdAt");
  if (record.role === "creator") {
    assertOneOf(record.turnType, TURN_TYPES, "creator turn type");
    assertModelId(record.selectedModelId, "creator selected model");
    optionalId(record.replyToEventId, "turn reply event");
    return;
  }
  if (record.role !== "agent") throw new Error("Invalid conversation turn role");
  assertOneOf(record.outcome, AGENT_OUTCOMES, "agent outcome");
  assertModelId(record.modelId, "agent model");
  assertBoundedText(record.providerId, "agent provider", 1, 256);
  assertModelId(record.responseModelId, "agent response model");
  assertId(record.agentRunId, "agent run");
  assertInterval(record.timing, "agent turn timing");
  assertModelUsage(record.usage, "agent turn usage");
  if (!Array.isArray(record.citations) || record.citations.length > 512)
    throw new Error("Invalid agent citations");
  const handles = new Set<string>();
  for (const citation of record.citations) {
    assertCreatorCitation(citation);
    if (
      citation.conversationId !== record.conversationId ||
      citation.issuedForAgentRunId !== record.agentRunId
    )
      throw new Error("Agent citation binding mismatch");
    if (handles.has(citation.handle)) throw new Error("Duplicate agent citation handle");
    handles.add(citation.handle);
  }
}

export function assertCreatorCitation(value: unknown): asserts value is CreatorCitation {
  const record = assertRecord(value, "CreatorCitation");
  assertKindIdentity(record, "CreatorCitation");
  assertId(record.conversationId, "citation conversation");
  assertId(record.issuedForAgentRunId, "citation AgentRun");
  assertBoundedText(record.handle, "citation handle", 1, 128);
  assertBoundedText(record.label, "citation label", 1, 512);
  if (record.authority !== "forge") throw new Error("Invalid citation authority");
  const target = assertRecord(record.target, "citation target");
  switch (target.kind) {
    case "source_range":
      assertHash(target.projectRevisionHash, "citation project revision");
      assertHash(target.sourceIndexHash, "citation source index");
      assertHash(target.sourceHash, "citation source hash");
      assertBoundedText(target.displayPath, "citation path", 1, 4096);
      assertNonNegativeInteger(target.startByte, "citation start byte");
      assertNonNegativeInteger(target.endByte, "citation end byte");
      if (Number(target.endByte) <= Number(target.startByte))
        throw new Error("Citation source range must be non-empty");
      break;
    case "project_fact":
      assertHash(target.projectRevisionHash, "citation project revision");
      assertBoundedText(target.factKey, "citation fact key", 1, 4096);
      assertHash(target.factHash, "citation fact hash");
      break;
    case "prior_evidence":
      assertId(target.eventId, "citation event");
      assertHash(target.eventHash, "citation event hash");
      assertArtifactBinding(target.evidence, "citation evidence");
      break;
    case "memory":
      assertId(target.memoryItemId, "citation memory item");
      assertId(target.revisionId, "citation memory revision");
      assertHash(target.revisionHash, "citation memory revision hash");
      break;
    default:
      throw new Error("Invalid citation target");
  }
}

export function assertCreatorPlanRevision(value: unknown): asserts value is CreatorPlanRevision {
  const record = assertRecord(value, "CreatorPlanRevision");
  assertKindIdentity(record, "CreatorPlanRevision");
  assertId(record.conversationId, "plan conversation");
  assertId(record.episodeId, "plan episode");
  assertPositiveInteger(record.revision, "plan revision");
  assertHash(record.projectRevisionHash, "plan project revision");
  assertModelId(record.modelId, "plan model");
  assertArtifactBinding(record.plan, "plan artifact");
  if (record.sourceConsultation !== undefined)
    assertArtifactBinding(record.sourceConsultation, "plan source consultation");
  if (record.supersedes !== undefined) assertIdentityBinding(record.supersedes, "superseded plan");
  assertCanonicalIso(record.publishedAt, "plan publishedAt");
}

export function assertCreatorMemoryRevision(
  value: unknown,
): asserts value is CreatorMemoryRevision {
  const record = assertRecord(value, "CreatorMemoryRevision");
  assertKindIdentity(record, "CreatorMemoryRevision");
  assertId(record.conversationId, "memory conversation");
  assertId(record.itemId, "memory item");
  assertPositiveInteger(record.revision, "memory revision");
  assertOneOf(
    record.operation,
    ["remember", "correct", "pin", "unpin", "forget"],
    "memory operation",
  );
  assertOneOf(
    record.category,
    ["preference", "convention", "vocabulary", "goal", "unresolved"],
    "memory category",
  );
  assertBoundedText(record.text, "memory text", record.operation === "forget" ? 0 : 1, 16_384);
  assertOneOf(record.state, ["active", "forgotten"], "memory state");
  if (typeof record.pinned !== "boolean" || record.authority !== "creator")
    throw new Error("Invalid memory authority or pin state");
  if (record.operation === "forget" && (record.state !== "forgotten" || record.pinned !== false))
    throw new Error("Forgotten memory must be inactive and unpinned");
  if (record.revision === 1) {
    if (record.operation !== "remember" || record.priorRevision !== undefined)
      throw new Error("First memory revision must remember a new item");
  } else {
    if (record.operation === "remember" || record.priorRevision === undefined)
      throw new Error("Later memory revisions require their predecessor");
    assertIdentityBinding(record.priorRevision, "prior memory revision");
  }
  assertCanonicalIso(record.createdAt, "memory createdAt");
}

export function assertCreatorWorkEpisode(value: unknown): asserts value is CreatorWorkEpisode {
  const record = assertRecord(value, "CreatorWorkEpisode");
  assertKindIdentity(record, "CreatorWorkEpisode");
  assertId(record.conversationId, "episode conversation");
  assertPositiveInteger(record.ordinal, "episode ordinal");
  assertOneOf(record.status, EPISODE_STATUSES, "episode status");
  assertModelId(record.selectedModelId, "episode model");
  assertHash(record.initialProjectRevisionHash, "episode initial project revision");
  assertHash(record.currentProjectRevisionHash, "episode current project revision");
  assertArtifactBinding(record.sessionBundle, "episode session bundle");
  assertId(record.creatorTurnId, "episode creator turn");
  if (record.planRevision !== undefined) assertIdentityBinding(record.planRevision, "episode plan");
  if (record.activeJob !== undefined) assertIdentityBinding(record.activeJob, "episode active job");
  optionalId(record.predecessorEpisodeId, "predecessor episode");
  optionalId(record.successorEpisodeId, "successor episode");
  const created = assertCanonicalIso(record.createdAt, "episode createdAt");
  const updated = assertCanonicalIso(record.updatedAt, "episode updatedAt");
  if (updated < created) throw new Error("Invalid CreatorWorkEpisode interval");
}

export function assertCreatorWorkJob(value: unknown): asserts value is CreatorWorkJob {
  const record = assertRecord(value, "CreatorWorkJob");
  assertKindIdentity(record, "CreatorWorkJob");
  assertId(record.conversationId, "job conversation");
  optionalId(record.episodeId, "job episode");
  optionalId(record.turnId, "job turn");
  assertBoundedText(record.idempotencyKey, "job idempotency key", 16, 256);
  assertHash(record.requestHash, "job request hash");
  assertArtifactReferenceShape(record.admittedRequest, "job admitted request");
  assertArtifactReferenceShape(record.admissionAuthority, "job admission authority");
  optionalId(record.transactionSessionId, "job transaction session");
  if (!Array.isArray(record.agentExecutions) || record.agentExecutions.length > 1)
    throw new Error("Invalid job agent execution reservations");
  const executionIds = new Set<string>();
  const journalIds = new Set<string>();
  record.agentExecutions.forEach((execution, index) => {
    assertCreatorAgentExecutionSlot(execution);
    if ((execution as CreatorAgentExecutionSlot).ordinal !== index + 1)
      throw new Error("Job agent execution reservations are not in canonical ordinal order");
    if (
      executionIds.has((execution as CreatorAgentExecutionSlot).agentRunId) ||
      journalIds.has((execution as CreatorAgentExecutionSlot).journalId)
    )
      throw new Error("Job agent execution reservations are not unique");
    executionIds.add((execution as CreatorAgentExecutionSlot).agentRunId);
    journalIds.add((execution as CreatorAgentExecutionSlot).journalId);
  });
  if (record.resumesJob !== undefined) assertIdentityBinding(record.resumesJob, "resumed job");
  if (record.conversationContext !== undefined)
    assertArtifactReferenceShape(record.conversationContext, "job conversation context");
  if ((record.admittedRequest as ArtifactReference).artifactHash !== record.requestHash)
    throw new Error("Creator work job request artifact does not match its request hash");
  assertOneOf(
    record.jobType,
    ["agent_turn", "agent_action", "control_action", "project_index", "studio_transaction"],
    "job type",
  );
  assertOneOf(record.status, JOB_STATUSES, "job status");
  assertBoundedText(record.phase, "job phase", 1, 256);
  assertOneOf(
    record.providerOutcome,
    [
      "not_applicable",
      "never_dispatched",
      "intent_persisted",
      "response_persisted",
      "failure_persisted",
      "outcome_unknown",
    ],
    "job provider outcome",
  );
  const hasAgentExecution = record.agentExecutions.length > 0;
  if (!hasAgentExecution && record.providerOutcome !== "not_applicable")
    throw new Error("Work without an execution reservation cannot claim a provider outcome");
  if (hasAgentExecution && record.providerOutcome === "not_applicable")
    throw new Error("Provider-capable work requires an explicit provider outcome");
  if (record.jobType === "agent_turn" && !hasAgentExecution)
    throw new Error("Agent work requires a preassigned execution reservation");
  if (record.jobType === "agent_action" && !hasAgentExecution)
    throw new Error("Agent action requires a preassigned execution reservation");
  if (!["agent_turn", "agent_action"].includes(String(record.jobType)) && hasAgentExecution)
    throw new Error("Non-agent job cannot reserve a provider execution");
  if (record.jobType === "agent_turn" && record.transactionSessionId === undefined)
    throw new Error("Agent work requires a preassigned transaction session");
  if (record.jobType !== "agent_turn" && record.transactionSessionId !== undefined)
    throw new Error("Non-agent work cannot bind a provider transaction session");
  if (
    record.resumesJob !== undefined &&
    !["agent_turn", "agent_action"].includes(String(record.jobType))
  )
    throw new Error("Only provider-capable work can resume a prior job");
  if (
    ["intent_persisted", "response_persisted", "failure_persisted", "outcome_unknown"].includes(
      String(record.providerOutcome),
    ) &&
    record.jobType === "agent_turn" &&
    record.conversationContext === undefined
  )
    throw new Error("Dispatched agent work requires its immutable conversation context");
  if (
    hasAgentExecution &&
    (record.status === "outcome_unknown") !== (record.providerOutcome === "outcome_unknown")
  )
    throw new Error("Unknown work status and provider outcome must agree");
  if (
    record.status === "succeeded" &&
    record.jobType === "agent_turn" &&
    record.providerOutcome !== "response_persisted"
  )
    throw new Error("Successful agent work requires a persisted provider response");
  if (record.selectedModelId !== undefined) assertModelId(record.selectedModelId, "job model");
  if (hasAgentExecution !== (record.selectedModelId !== undefined))
    throw new Error("Job model selection does not match its execution reservations");
  optionalBoundedText(record.providerRequestId, "provider request", 1, 512);
  if (
    record.providerRequestId !== undefined &&
    !["intent_persisted", "response_persisted", "failure_persisted", "outcome_unknown"].includes(
      String(record.providerOutcome),
    )
  )
    throw new Error("Provider request ID precedes its persisted intent");
  optionalId(record.resultEventId, "job result event");
  if (record.failure !== undefined) {
    const failure = assertRecord(record.failure, "job failure");
    assertBoundedText(failure.code, "job failure code", 1, 256);
    assertHash(failure.detailHash, "job failure detail hash");
  }
  const created = assertCanonicalIso(record.createdAt, "job createdAt");
  const updated = assertCanonicalIso(record.updatedAt, "job updatedAt");
  if (updated < created) throw new Error("Invalid CreatorWorkJob interval");
}

export function assertCreatorAgentExecutionSlot(
  value: unknown,
): asserts value is CreatorAgentExecutionSlot {
  const record = assertRecord(value, "creator agent execution slot");
  assertOneOf(record.purpose, ["planner", "builder", "repair"], "execution purpose");
  assertPositiveInteger(record.ordinal, "execution ordinal");
  assertId(record.agentRunId, "execution AgentRun");
  if (!String(record.agentRunId).startsWith("agent_run_"))
    throw new Error("Invalid execution AgentRun prefix");
  if (record.journalId !== `agent_execution_journal:${String(record.agentRunId)}`)
    throw new Error("Execution journal is not derived from its AgentRun identity");
}

export function assertCreatorModelRegistry(value: unknown): asserts value is CreatorModelRegistry {
  const record = assertRecord(value, "CreatorModelRegistry");
  assertKindIdentity(record, "CreatorModelRegistry");
  assertCanonicalIso(record.generatedAt, "model registry generatedAt");
  assertModelId(record.defaultModelId, "default model");
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > 32)
    throw new Error("Invalid model registry entries");
  const ids = new Set<string>();
  for (const model of record.models) {
    const entry = assertRecord(model, "model registry entry");
    assertModelId(entry.id, "registry model");
    assertBoundedText(entry.displayName, "model display name", 1, 128);
    assertOneOf(entry.availability, ["available", "unavailable", "unknown"], "model availability");
    assertOneOf(entry.imageInput, ["supported", "unsupported", "unknown"], "model image input");
    if (
      !Array.isArray(entry.requiredCapabilities) ||
      entry.requiredCapabilities.length !== 1 ||
      entry.requiredCapabilities[0] !== "tools"
    )
      throw new Error("Creator models must require tool support");
    if (entry.providerFallback !== "disabled")
      throw new Error("Creator model fallback must be disabled");
    optionalBoundedText(entry.detail, "model detail", 1, 1024);
    if (ids.has(String(entry.id))) throw new Error("Duplicate creator model ID");
    ids.add(String(entry.id));
  }
  if (!ids.has(String(record.defaultModelId)))
    throw new Error("Creator default model is absent from its registry");
}

export function assertCreatorConversationEvent(
  value: unknown,
): asserts value is CreatorConversationEvent {
  const record = assertRecord(value, "CreatorConversationEvent");
  assertKindIdentity(record, "CreatorConversationEvent");
  assertId(record.conversationId, "event conversation");
  assertPositiveInteger(record.sequence, "event sequence");
  assertCanonicalIso(record.occurredAt, "event occurredAt");
  assertOneOf(record.authority, ["creator", "agent", "forge", "studio"], "event authority");
  optionalHash(record.projectRevisionHash, "event project revision");
  optionalId(record.episodeId, "event episode");
  if (record.binding !== undefined) assertEventBinding(record.binding);
  if (!Array.isArray(record.attachments) || record.attachments.length > 64)
    throw new Error("Invalid conversation event attachments");
  for (const attachment of record.attachments) assertAttachment(attachment);
  const data = assertRecord(record.data, "conversation event data");
  switch (record.eventType) {
    case "creator_turn":
      requireAuthority(record.authority, "creator", record.eventType);
      assertArtifactBinding(data.turn, "creator turn artifact");
      assertOneOf(data.turnType, TURN_TYPES, "creator turn type");
      assertBoundedText(data.text, "creator event text", 1, MAX_TEXT_BYTES);
      assertModelId(data.selectedModelId, "creator event model");
      if (data.job !== undefined) assertArtifactBinding(data.job, "creator-turn admission job");
      break;
    case "agent_turn":
      requireAuthority(record.authority, "agent", record.eventType);
      assertArtifactBinding(data.turn, "agent turn artifact");
      assertOneOf(data.outcome, AGENT_OUTCOMES, "agent outcome");
      assertModelId(data.modelId, "agent event model");
      assertBoundedText(data.providerId, "agent event provider", 1, 256);
      assertModelId(data.responseModelId, "agent event response model");
      assertId(data.agentRunId, "agent event run");
      assertInterval(data.timing, "agent event timing");
      assertModelUsage(data.usage, "agent event usage");
      assertBoundedText(data.text, "agent event text", 1, MAX_TEXT_BYTES);
      if (!Array.isArray(data.citations) || data.citations.length > 512)
        throw new Error("Invalid agent event citations");
      for (const citation of data.citations) assertCreatorCitation(citation);
      break;
    case "activity":
      assertArtifactBinding(data.job, "activity job");
      assertOneOf(data.status, JOB_STATUSES, "activity job status");
      assertBoundedText(data.phase, "activity phase", 1, 256);
      assertBoundedText(data.message, "activity message", 1, 4096);
      break;
    case "plan_revision":
      if (record.authority === "forge") {
        assertArtifactBinding(data.recompilation, "host plan recompilation");
      } else {
        requireAuthority(record.authority, "agent", record.eventType);
        if (data.recompilation !== undefined)
          throw new Error("Agent plan revisions cannot claim host recompilation authority");
      }
      assertArtifactBinding(data.planRevision, "plan revision artifact");
      assertPositiveInteger(data.revision, "plan event revision");
      assertBoundedText(data.summary, "plan summary", 1, 16_384);
      break;
    case "decision":
      requireAuthority(record.authority, "creator", record.eventType);
      assertId(data.actionInstanceId, "decision action instance");
      assertOneOf(
        data.decision,
        [
          "build",
          "revise_plan",
          "reject_plan",
          "apply",
          "resume_build",
          "reject_change",
          "retry_play",
          "cancel_change",
          "keep",
          "undo",
          "refresh",
          "recover",
          "source_sync",
          "remember",
          "correct_memory",
          "pin_memory",
          "unpin_memory",
          "forget_memory",
          "resume_work",
          "retry_work",
          "continue_published_project",
          "start_published_project",
          "new_conversation",
        ],
        "creator decision",
      );
      optionalBoundedText(data.report, "creator report", 1, 4096);
      if (data.job !== undefined) assertArtifactBinding(data.job, "decision admission job");
      if (data.refinement !== undefined) {
        if (data.decision !== "revise_plan")
          throw new Error("Only plan refinement decisions can carry a creator turn");
        const refinement = assertRecord(data.refinement, "plan refinement turn");
        assertArtifactBinding(refinement.turn, "plan refinement turn artifact");
        assertBoundedText(refinement.text, "plan refinement text", 1, MAX_TEXT_BYTES);
        assertModelId(refinement.selectedModelId, "plan refinement model");
      }
      break;
    case "change_set":
      requireAuthority(record.authority, "agent", record.eventType);
      assertArtifactBinding(data.changeSet, "change-set artifact");
      for (const [name, count] of [
        ["creates", data.creates],
        ["updates", data.updates],
        ["moves", data.moves],
        ["deletes", data.deletes],
        ["source edits", data.sourceEdits],
      ] as const)
        assertNonNegativeInteger(count, name);
      assertBoundedText(data.summary, "change summary", 1, 16_384);
      break;
    case "project_change":
      assertOneOf(
        data.state,
        ["detected", "refreshed", "unchanged", "superseded"],
        "project change state",
      );
      assertBoundedText(data.message, "project change message", 1, 4096);
      optionalId(data.predecessorEpisodeId, "project change predecessor");
      optionalId(data.successorEpisodeId, "project change successor");
      break;
    case "mutation":
      assertId(data.attemptId, "mutation attempt");
      assertHash(data.attemptHash, "mutation attempt hash");
      assertOneOf(
        data.status,
        [
          "preflighting",
          "provisional",
          "matched",
          "mismatched",
          "incomplete",
          "committed",
          "cancelled",
          "recovery_required",
        ],
        "mutation status",
      );
      assertBoundedText(data.message, "mutation message", 1, 4096);
      break;
    case "playtest":
      assertOneOf(
        data.state,
        ["ready", "waiting", "observing", "complete", "incomplete"],
        "playtest state",
      );
      assertBoundedText(data.message, "playtest message", 1, 4096);
      assertStringList(data.machineChecks, "machine checks", 256, 4096);
      assertStringList(data.creatorChecks, "creator checks", 256, 4096);
      break;
    case "verification":
      requireAuthority(record.authority, "forge", record.eventType);
      assertArtifactBinding(data.verification, "verification artifact");
      assertOneOf(data.status, ["passed", "failed", "incomplete"], "verification status");
      if (!Array.isArray(data.failureFacts) || data.failureFacts.length > 1024)
        throw new Error("Invalid verification failure facts");
      for (const item of data.failureFacts) {
        const fact = assertRecord(item, "verification failure fact");
        assertBoundedText(fact.statement, "failure statement", 1, 4096);
        assertHash(fact.hash, "failure fact hash");
      }
      break;
    case "final_review":
      assertOneOf(
        data.state,
        ["requested", "accepted", "rejected", "rolled_back"],
        "final review state",
      );
      assertBoundedText(data.message, "final review message", 1, 4096);
      if (data.report !== undefined) assertArtifactBinding(data.report, "review report");
      break;
    case "recovery":
      assertOneOf(
        data.state,
        ["required", "available", "completed", "incomplete"],
        "recovery state",
      );
      assertBoundedText(data.message, "recovery message", 1, 4096);
      if (typeof data.studioMayContainOpenRecording !== "boolean")
        throw new Error("Invalid recovery recording state");
      break;
    case "source_sync":
      assertOneOf(
        data.status,
        ["awaiting", "matched", "mismatched", "reverted"],
        "source sync status",
      );
      assertBoundedText(data.message, "source sync message", 1, 4096);
      break;
    case "memory":
      requireAuthority(record.authority, "creator", record.eventType);
      assertArtifactBinding(data.memoryRevision, "memory revision artifact");
      assertOneOf(
        data.operation,
        ["remember", "correct", "pin", "unpin", "forget"],
        "memory event operation",
      );
      break;
    case "job":
      requireAuthority(record.authority, "forge", record.eventType);
      assertArtifactBinding(data.job, "job artifact");
      assertOneOf(data.status, JOB_STATUSES, "job event status");
      assertBoundedText(data.message, "job message", 1, 4096);
      break;
    case "project_identity":
      assertOneOf(
        data.state,
        ["linked", "forked", "unlinked", "conflict", "published_continuity", "published_new"],
        "project identity state",
      );
      assertProjectIdentity(data.project, "project identity event");
      assertBoundedText(data.message, "project identity message", 1, 4096);
      if (["published_continuity", "published_new"].includes(String(data.state))) {
        requireAuthority(record.authority, "creator", record.eventType);
        assertArtifactBinding(data.continuityReceipt, "published continuity receipt");
      } else if (data.continuityReceipt !== undefined) {
        throw new Error("Unexpected published continuity receipt");
      }
      break;
    case "terminal_output":
      requireAuthority(
        record.authority,
        data.outcome === "completed" ? "agent" : "forge",
        record.eventType,
      );
      assertOneOf(
        data.outcome,
        ["completed", "accepted", "rejected", "superseded", "incomplete"],
        "terminal outcome",
      );
      assertBoundedText(data.message, "terminal message", 1, 8192);
      if (typeof data.studioHasAcceptedResult !== "boolean")
        throw new Error("Invalid terminal Studio state");
      break;
    default:
      throw new Error("Invalid conversation event type");
  }
}

export function assertCreatorConversationCommit(
  value: unknown,
): asserts value is CreatorConversationCommit {
  const record = assertRecord(value, "CreatorConversationCommit");
  assertKindIdentity(record, "CreatorConversationCommit");
  assertId(record.conversationId, "commit conversation");
  assertPositiveInteger(record.sequence, "commit sequence");
  assertOptionalReferencePair(record, "previousCommit", "previousCommitHash");
  if (
    record.sequence === 1 &&
    (record.previousCommit !== undefined || record.previousCommitHash !== undefined)
  )
    throw new Error("Initial conversation commit cannot have a predecessor");
  if (
    record.sequence > 1 &&
    (record.previousCommit === undefined || record.previousCommitHash === undefined)
  )
    throw new Error("Conversation commit is missing its predecessor");
  assertArtifactReferenceShape(record.conversation, "commit conversation artifact");
  assertHash(record.conversationHash, "commit conversation hash");
  assertArtifactReferenceShape(record.event, "commit event artifact");
  assertId(record.eventId, "commit event");
  assertHash(record.eventHash, "commit event hash");
  assertOptionalRecordBinding(record, "episodeSnapshot", "episodeId", "episodeHash");
  assertOptionalRecordBinding(record, "turn", "turnId", "turnHash");
  if (!Array.isArray(record.citations) || record.citations.length > 512)
    throw new Error("Invalid commit citations");
  const citationIds = new Set<string>();
  for (const citation of record.citations) {
    assertArtifactBinding(citation, "commit citation");
    if (citationIds.has(citation.id)) throw new Error("Duplicate commit citation");
    citationIds.add(citation.id);
  }
  assertOptionalRecordBinding(record, "memoryRevision", "memoryRevisionId", "memoryRevisionHash");
  assertOptionalRecordBinding(record, "planRevision", "planRevisionId", "planRevisionHash");
  assertOptionalRecordBinding(record, "job", "jobId", "jobHash");
  assertCanonicalIso(record.committedAt, "commit committedAt");
}

export function assertCreatorTurnContract(value: unknown): asserts value is CreatorTurnContract {
  const record = assertRecord(value, "CreatorTurnContract");
  assertKindIdentity(record, "CreatorTurnContract");
  assertId(record.conversationId, "turn contract conversation");
  optionalId(record.episodeId, "turn contract episode");
  if (
    !Array.isArray(record.allowedTurnTypes) ||
    record.allowedTurnTypes.length === 0 ||
    record.allowedTurnTypes.length > TURN_TYPES.length
  )
    throw new Error("Invalid turn contract turn types");
  const types = record.allowedTurnTypes.map((type) =>
    assertOneOf(type, TURN_TYPES, "turn contract type"),
  );
  if (new Set(types).size !== types.length) throw new Error("Duplicate turn contract type");
  optionalId(record.replyToEventId, "turn contract reply event");
  if ((record.planRevisionId === undefined) !== (record.planRevisionHash === undefined))
    throw new Error("Incomplete turn contract plan binding");
  optionalId(record.planRevisionId, "turn contract plan");
  optionalHash(record.planRevisionHash, "turn contract plan hash");
  optionalHash(record.projectRevisionHash, "turn contract project revision");
  assertHash(record.modelRegistryHash, "turn contract registry hash");
  assertPositiveInteger(record.minimumBytes, "turn contract minimum bytes");
  assertPositiveInteger(record.maximumBytes, "turn contract maximum bytes");
  if (
    Number(record.maximumBytes) < Number(record.minimumBytes) ||
    Number(record.maximumBytes) > MAX_TEXT_BYTES
  )
    throw new Error("Invalid turn contract text bounds");
  assertCanonicalIso(record.issuedAt, "turn contract issuedAt");
}

export function assertCreatorControlView(value: unknown): asserts value is CreatorControlView {
  const record = assertRecord(value, "CreatorControlView");
  assertKindIdentity(record, "CreatorControlView");
  assertId(record.conversationId, "control view conversation");
  assertHash(record.conversationHash, "control view conversation hash");
  assertNonNegativeInteger(record.eventSequence, "control view event sequence");
  optionalId(record.episodeId, "control view episode");
  assertOneOf(
    record.status,
    ["ready", "working", "awaiting_creator", "blocked", "recovery_required", "terminal"],
    "control view status",
  );
  assertBoundedText(record.title, "control view title", 1, 512);
  assertBoundedText(record.detail, "control view detail", 0, 16_384);
  if (record.turnContract !== undefined) {
    assertCreatorTurnContract(record.turnContract);
    if (record.turnContract.conversationId !== record.conversationId)
      throw new Error("Control-view turn contract is bound to another conversation");
  }
  if (!Array.isArray(record.actions) || record.actions.length > 16)
    throw new Error("Invalid control view actions");
  const instances = new Set<string>();
  for (const action of record.actions) {
    assertActionDescriptor(action);
    if (action.controlViewId !== record.id)
      throw new Error("Control action is bound to another control view");
    if (instances.has(action.actionInstanceId)) throw new Error("Duplicate action instance");
    instances.add(action.actionInstanceId);
  }
  if (record.activeActivity !== undefined) {
    const activity = assertRecord(record.activeActivity, "control view activity");
    assertId(activity.jobId, "activity job");
    assertOneOf(activity.status, JOB_STATUSES, "activity status");
    assertBoundedText(activity.phase, "activity phase", 1, 256);
    assertBoundedText(activity.message, "activity message", 1, 4096);
    assertCanonicalIso(activity.startedAt, "activity startedAt");
  }
  if (!Array.isArray(record.technicalAttachments) || record.technicalAttachments.length > 64)
    throw new Error("Invalid control view technical attachments");
  for (const attachment of record.technicalAttachments) assertTechnicalAttachment(attachment);
  if (record.gameBuild !== undefined) assertGameBuildControlView(record.gameBuild);
}

export const AGENT_ACTIVITY_DETAIL_MAX_BYTES = 240;

export function assertCreatorDashboardState(
  value: unknown,
): asserts value is CreatorDashboardState {
  const record = assertRecord(value, "CreatorDashboardState");
  if (record.kind !== "CreatorDashboardState")
    throw new Error("Invalid CreatorDashboardState kind");
  if (!Array.isArray(record.conversations) || record.conversations.length > 100_000)
    throw new Error("Invalid dashboard conversations");
  const conversationIds = new Set<string>();
  for (const summary of record.conversations) {
    assertConversationSummary(summary);
    if (conversationIds.has(summary.id)) throw new Error("Duplicate dashboard conversation");
    conversationIds.add(summary.id);
  }
  optionalId(record.selectedConversationId, "selected conversation");
  if (record.selectedConversation !== undefined) {
    assertCreatorProjectConversation(record.selectedConversation);
    if (record.selectedConversationId !== record.selectedConversation.id)
      throw new Error("Selected conversation binding mismatch");
  }
  if (record.eventPage !== undefined) assertEventPage(record.eventPage);
  if (!Array.isArray(record.episodes) || record.episodes.length > 100_000)
    throw new Error("Invalid dashboard episodes");
  for (const episode of record.episodes) assertEpisodeSummary(episode);
  if (!Array.isArray(record.memories) || record.memories.length > 100_000)
    throw new Error("Invalid dashboard memories");
  for (const memory of record.memories) assertMemorySummary(memory);
  if (record.projectSettings !== undefined) {
    const settings = assertRecord(record.projectSettings, "project settings");
    assertCreatorControlView(settings.controlView);
    if (!Array.isArray(settings.memories)) throw new Error("Invalid project preferences");
    for (const memory of settings.memories) assertMemorySummary(memory);
  }
  assertCreatorModelRegistry(record.modelRegistry);
  if (record.controlView !== undefined) {
    assertCreatorControlView(record.controlView);
    if (record.selectedConversationId !== record.controlView.conversationId)
      throw new Error("Dashboard control view binding mismatch");
  }
  assertPairedStudio(record.pairedStudio);
  if (record.agentActivities !== undefined && !Array.isArray(record.agentActivities))
    throw new Error("Invalid agent activities");
  for (const value of (record.agentActivities as unknown[] | undefined) ?? []) {
    const activity = assertRecord(value, "agent activity");
    assertId(activity.jobId, "agent activity job");
    assertNonNegativeInteger(activity.afterEventSequence, "agent activity event position");
    if (activity.agentRunId !== undefined) assertId(activity.agentRunId, "agent activity run");
    if (typeof activity.running !== "boolean") throw new Error("Invalid agent activity status");
    assertCanonicalIso(activity.startedAt, "agent activity start");
    assertCanonicalIso(activity.updatedAt, "agent activity update");
    assertBoundedText(activity.currentStep, "agent activity step", 1, 4096);
    if (!Array.isArray(activity.commentary)) throw new Error("Invalid agent commentary");
    for (const value of activity.commentary) {
      const message = assertRecord(value, "agent commentary");
      assertPositiveInteger(message.sequence, "agent commentary sequence");
      assertBoundedText(message.text, "agent commentary text", 1, 256 * 1024);
    }
    assertNonNegativeInteger(activity.modelTurns, "agent activity turns");
    if (activity.usage !== null) assertModelUsage(activity.usage, "agent activity usage");
    if (activity.requestSizes !== null) {
      const sizes = assertRecord(activity.requestSizes, "agent request sizes");
      for (const field of ["systemInstructions", "conversation", "toolSchemas", "toolResults"])
        assertNonNegativeInteger(sizes[field], field);
    }
    if (!Array.isArray(activity.steps) || activity.steps.length > 80)
      throw new Error("Invalid agent activity steps");
    for (const value of activity.steps) {
      const step = assertRecord(value, "agent step");
      assertPositiveInteger(step.sequence, "agent step sequence");
      assertBoundedText(step.label, "agent step label", 1, 256);
      assertBoundedText(step.detail, "agent step detail", 0, AGENT_ACTIVITY_DETAIL_MAX_BYTES);
      if (step.toolName !== undefined) assertBoundedText(step.toolName, "agent tool name", 1, 128);
      assertOneOf(step.status, ["complete", "failed"], "agent step status");
    }
  }
  assertCanonicalIso(record.serverTime, "dashboard serverTime");
}

export function assertCreatorTurnRequest(value: unknown): asserts value is CreatorTurnRequest {
  const record = assertRecord(value, "CreatorTurnRequest");
  if (record.kind !== "CreatorTurnRequest") throw new Error("Invalid CreatorTurnRequest kind");
  optionalId(record.conversationId, "turn-request conversation");
  assertId(record.turnContractId, "turn-request contract");
  assertHash(record.turnContractHash, "turn-request contract hash");
  assertOneOf(record.turnKind, TURN_TYPES, "turn-request kind");
  assertBoundedText(record.text, "turn-request text", 1, MAX_TEXT_BYTES);
  assertModelId(record.selectedModelId, "turn-request model");
  assertBoundedText(record.idempotencyKey, "turn-request idempotency key", 16, 256);
  if (record.visualObservations !== undefined) {
    if (!Array.isArray(record.visualObservations) || record.visualObservations.length > 4)
      throw new Error("A creator turn accepts up to four visual attachments");
    for (const observation of record.visualObservations)
      VISUAL_OBSERVATION_INPUT_SCHEMA.parse(observation);
  }
}

export function assertCreatorActionRequest(value: unknown): asserts value is CreatorActionRequest {
  const record = assertRecord(value, "CreatorActionRequest");
  if (record.kind !== "CreatorActionRequest") throw new Error("Invalid CreatorActionRequest kind");
  assertId(record.conversationId, "action-request conversation");
  assertId(record.viewId, "action-request view");
  assertHash(record.viewHash, "action-request view hash");
  assertId(record.actionInstanceId, "action-request instance");
  assertBoundedText(record.idempotencyKey, "action-request idempotency key", 16, 256);
  if (record.target !== undefined) {
    const target = assertRecord(record.target, "action-request target");
    if (target.kind !== "memory_head") throw new Error("Invalid action-request target");
    assertId(target.itemId, "action memory item");
    assertId(target.revisionId, "action memory revision");
    assertHash(target.revisionHash, "action memory revision hash");
  }
  if (record.input !== undefined) {
    const input = assertRecord(record.input, "action-request input");
    optionalBoundedText(input.report, "action report", 1, 4096);
    optionalBoundedText(input.text, "action text", 1, MAX_TEXT_BYTES);
    if (input.memoryCategory !== undefined)
      assertOneOf(
        input.memoryCategory,
        ["preference", "convention", "vocabulary", "goal", "unresolved"],
        "action memory category",
      );
    if ((input.selectedModelId === undefined) !== (input.modelRegistryHash === undefined))
      throw new Error("Action model selection binding is incomplete");
    if (input.selectedModelId !== undefined) {
      assertModelId(input.selectedModelId, "action selected model");
      assertHash(input.modelRegistryHash, "action model registry hash");
    }
    if ((input.report === undefined) === (input.text === undefined))
      throw new Error("Action-request input must contain exactly one value");
    if (input.memoryCategory !== undefined && input.text === undefined)
      throw new Error("Action memory category requires text input");
  }
}

export function assertCreatorWorkAdmission(value: unknown): asserts value is CreatorWorkAdmission {
  const record = assertRecord(value, "CreatorWorkAdmission");
  if (record.kind !== "CreatorWorkAdmission") throw new Error("Invalid CreatorWorkAdmission kind");
  assertId(record.jobId, "work-admission job");
  assertId(record.conversationId, "work-admission conversation");
  assertCanonicalIso(record.acceptedAt, "work-admission acceptedAt");
}

export function assertCreatorTurnRequestBinding(
  contract: CreatorTurnContract,
  registry: CreatorModelRegistry,
  request: CreatorTurnRequest,
  replayed = false,
): void {
  assertCreatorTurnContract(contract);
  assertCreatorModelRegistry(registry);
  assertCreatorTurnRequest(request);
  if (
    request.turnContractId !== contract.id ||
    request.turnContractHash !== contract.hash ||
    request.conversationId !== contract.conversationId
  )
    throw new Error("Creator turn request is stale or bound to another contract");
  if (!contract.allowedTurnTypes.includes(request.turnKind))
    throw new Error("Creator turn kind is not available in the current contract");
  if (contract.modelRegistryHash !== registry.hash)
    throw new Error("Creator turn contract is bound to another model registry");
  const selected = registry.models.find((model) => model.id === request.selectedModelId);
  if (selected === undefined || selected.availability !== "available")
    throw new Error("Selected creator model is unavailable");
  const bytes = utf8Bytes(request.text);
  if (bytes < contract.minimumBytes || bytes > contract.maximumBytes)
    throw new Error("Creator turn text is outside the current contract bounds");
  if (replayed) throw new Error("Creator turn request was already consumed");
}

export function assertCreatorActionRequestBinding(
  view: CreatorControlView,
  request: CreatorActionRequest,
  replayed = false,
): CreatorControlActionDescriptor {
  assertCreatorControlView(view);
  assertCreatorActionRequest(request);
  if (
    request.conversationId !== view.conversationId ||
    request.viewId !== view.id ||
    request.viewHash !== view.hash
  )
    throw new Error("Creator action request is stale or bound to another control view");
  const action = view.actions.find(
    (candidate) => candidate.actionInstanceId === request.actionInstanceId,
  );
  if (action === undefined || action.controlViewId !== view.id)
    throw new Error("Creator action is not available in the current control view");
  if ((action.target === "memory_head") !== (request.target?.kind === "memory_head"))
    throw new Error("Creator action target does not match its control contract");
  if (action.actionId === "revise_plan") {
    if (
      request.input?.selectedModelId === undefined ||
      request.input.modelRegistryHash !== view.turnContract?.modelRegistryHash
    )
      throw new Error("Plan refinement model is not bound to the current registry");
  } else if (
    request.input?.selectedModelId !== undefined ||
    request.input?.modelRegistryHash !== undefined
  ) {
    throw new Error("Creator action carries an unauthorized model selection");
  }
  if (replayed) throw new Error("Creator action request was already consumed");
  if (action.input.kind === "none") {
    if (request.input !== undefined) throw new Error("Creator action does not accept input");
    return action;
  }
  const supplied = action.input.field === "report" ? request.input?.report : request.input?.text;
  if (supplied === undefined) throw new Error("Creator action requires exact input");
  const bytes = utf8Bytes(supplied);
  if (bytes < action.input.minimumBytes || bytes > action.input.maximumBytes)
    throw new Error("Creator action input is outside the current bounds");
  return action;
}

export function assertArtifactReferenceShape(
  value: unknown,
  label = "artifact",
): asserts value is ArtifactReference {
  const record = assertRecord(value, label);
  assertHash(record.artifactHash, `${label} hash`);
  if (record.locator !== `artifacts/${String(record.artifactHash)}.json`)
    throw new Error(`Invalid ${label} locator`);
  assertPositiveInteger(record.bytes, `${label} bytes`);
}

function assertConversationSummary(value: unknown): asserts value is CreatorConversationSummary {
  const record = assertRecord(value, "conversation summary");
  assertId(record.id, "conversation summary ID");
  assertHash(record.hash, "conversation summary hash");
  assertBoundedText(record.title, "conversation summary title", 1, 512);
  assertBoundedText(record.projectName, "conversation project name", 1, 512);
  assertProjectIdentity(record.project, "conversation summary project");
  assertOneOf(
    record.status,
    ["ready", "working", "awaiting_creator", "blocked", "recovery_required", "terminal"],
    "conversation summary status",
  );
  optionalHash(record.currentProjectRevisionHash, "conversation summary project revision");
  assertNonNegativeInteger(record.latestEventSequence, "conversation summary sequence");
  assertNonNegativeInteger(record.episodeCount, "conversation summary episode count");
  assertCanonicalIso(record.updatedAt, "conversation summary updatedAt");
}

function assertEventPage(value: unknown): asserts value is CreatorConversationEventPage {
  const record = assertRecord(value, "conversation event page");
  assertId(record.conversationId, "event-page conversation");
  if (!Array.isArray(record.events) || record.events.length > 500)
    throw new Error("Invalid conversation event page length");
  let previous = 0;
  for (const event of record.events) {
    assertCreatorConversationEvent(event);
    if (event.conversationId !== record.conversationId || event.sequence <= previous)
      throw new Error("Conversation event page is not canonically ordered");
    previous = event.sequence;
  }
  optionalBoundedText(record.beforeCursor, "event before cursor", 1, 4096);
  optionalBoundedText(record.nextBeforeCursor, "event next cursor", 1, 4096);
  if (typeof record.complete !== "boolean") throw new Error("Invalid event page completeness");
}

function assertEpisodeSummary(value: unknown): asserts value is CreatorWorkEpisodeSummary {
  const record = assertRecord(value, "episode summary");
  assertId(record.id, "episode summary ID");
  assertHash(record.hash, "episode summary hash");
  assertPositiveInteger(record.ordinal, "episode summary ordinal");
  assertOneOf(record.status, EPISODE_STATUSES, "episode summary status");
  assertModelId(record.selectedModelId, "episode summary model");
  assertHash(record.currentProjectRevisionHash, "episode summary project revision");
  assertCanonicalIso(record.createdAt, "episode summary createdAt");
  assertCanonicalIso(record.updatedAt, "episode summary updatedAt");
}

function assertMemorySummary(value: unknown): asserts value is CreatorMemorySummary {
  const record = assertRecord(value, "memory summary");
  assertId(record.itemId, "memory summary item");
  assertId(record.revisionId, "memory summary revision");
  assertHash(record.revisionHash, "memory summary hash");
  assertOneOf(
    record.category,
    ["preference", "convention", "vocabulary", "goal", "unresolved"],
    "memory summary category",
  );
  assertBoundedText(record.text, "memory summary text", 0, 16_384);
  if (typeof record.pinned !== "boolean") throw new Error("Invalid memory summary pin state");
  assertOneOf(record.state, ["active", "forgotten"], "memory summary state");
}

function assertPairedStudio(value: unknown): void {
  const record = assertRecord(value, "paired Studio state");
  assertOneOf(
    record.status,
    ["unpaired", "connecting", "ready", "update_required", "attention"],
    "paired Studio status",
  );
  assertBoundedText(record.message, "paired Studio message", 1, 4096);
  if (record.project !== undefined) assertProjectIdentity(record.project, "paired Studio project");
  optionalBoundedText(record.projectName, "paired Studio project name", 1, 512);
  optionalHash(record.projectRevisionHash, "paired Studio project revision");
  if (record.indexStatus !== undefined)
    assertOneOf(
      record.indexStatus,
      ["indexing", "complete", "incomplete", "dirty"],
      "paired Studio index status",
    );
  assertOneOf(
    record.transactionStatus,
    ["clear", "pending", "blocked", "unavailable"],
    "paired Studio transaction status",
  );
}

function assertActionDescriptor(value: unknown): asserts value is CreatorControlActionDescriptor {
  const record = assertRecord(value, "control action descriptor");
  assertId(record.actionInstanceId, "action instance");
  assertOneOf(record.actionId, CONTROL_ACTIONS, "control action");
  assertBoundedText(record.label, "action label", 1, 128);
  assertOneOf(record.intent, ["primary", "secondary", "danger"], "action intent");
  assertId(record.controlViewId, "action control view");
  assertId(record.authorizingEventId, "authorizing event");
  assertHash(record.authorizingEventHash, "authorizing event hash");
  assertOneOf(record.target, ["none", "memory_head"], "control action target");
  const input = assertRecord(record.input, "action input requirement");
  if (input.kind === "none") return;
  if (input.kind !== "text") throw new Error("Invalid action input kind");
  assertOneOf(input.field, ["message", "report", "confirmation", "memory"], "action input field");
  assertBoundedText(input.label, "action input label", 1, 256);
  assertNonNegativeInteger(input.minimumBytes, "action minimum bytes");
  assertPositiveInteger(input.maximumBytes, "action maximum bytes");
  if (
    Number(input.maximumBytes) < Number(input.minimumBytes) ||
    Number(input.maximumBytes) > MAX_TEXT_BYTES
  )
    throw new Error("Invalid action input bounds");
  if (typeof input.multiline !== "boolean") throw new Error("Invalid action multiline flag");
}

function assertProjectIdentity(
  value: unknown,
  label: string,
): asserts value is CreatorProjectIdentity {
  const record = assertRecord(value, label);
  if (record.kind === "published") {
    assertNumericIdentifier(record.universeId, `${label} universe`);
    assertNumericIdentifier(record.placeId, `${label} place`);
    return;
  }
  if (record.kind === "local_linked") {
    assertId(record.forgeProjectId, `${label} Forge project`);
    return;
  }
  throw new Error(`Invalid ${label}`);
}

function assertAttachment(value: unknown): asserts value is CreatorConversationAttachment {
  const record = assertRecord(value, "conversation attachment");
  assertOneOf(record.role, ATTACHMENT_ROLES, "attachment role");
  assertBoundedText(record.label, "attachment label", 1, 256);
  assertArtifactBinding(record.binding, "attachment binding");
}

function assertTechnicalAttachment(value: unknown): asserts value is CreatorTechnicalAttachment {
  const record = assertRecord(value, "technical attachment");
  assertOneOf(record.role, ATTACHMENT_ROLES, "technical attachment role");
  assertBoundedText(record.label, "technical attachment label", 1, 256);
  const binding = assertRecord(record.binding, "technical attachment binding");
  if (binding.kind === "unbound_technical_reference") {
    assertId(binding.id, "unbound technical reference ID");
    assertHash(binding.hash, "unbound technical reference hash");
    assertArtifactReferenceShape(binding.artifact, "unbound technical reference artifact");
    if (
      binding.id !== `technical_reference:${String(binding.artifact.artifactHash)}` ||
      binding.hash !== binding.artifact.artifactHash
    )
      throw new Error("Unbound technical reference must be derived from its exact artifact");
    return;
  }
  assertArtifactBinding(binding, "technical attachment binding");
}

function assertEventBinding(value: unknown): asserts value is CreatorEventBinding {
  const record = assertRecord(value, "event binding");
  if ((record.sessionId === undefined) !== (record.sessionHash === undefined))
    throw new Error("Incomplete event session binding");
  if ((record.planRevisionId === undefined) !== (record.planRevisionHash === undefined))
    throw new Error("Incomplete event plan binding");
  if ((record.controlViewId === undefined) !== (record.controlViewHash === undefined))
    throw new Error("Incomplete event control-view binding");
  optionalId(record.sessionId, "event session");
  optionalHash(record.sessionHash, "event session hash");
  optionalId(record.planRevisionId, "event plan revision");
  optionalHash(record.planRevisionHash, "event plan hash");
  optionalId(record.controlViewId, "event control view");
  optionalHash(record.controlViewHash, "event control view hash");
}

function assertArtifactBinding(
  value: unknown,
  label: string,
): asserts value is CreatorArtifactBinding {
  const record = assertRecord(value, label);
  assertId(record.id, `${label} ID`);
  assertHash(record.hash, `${label} hash`);
  assertArtifactReferenceShape(record.artifact, `${label} reference`);
}

function assertIdentityBinding(value: unknown, label: string): void {
  const record = assertRecord(value, label);
  assertId(record.id, `${label} ID`);
  assertHash(record.hash, `${label} hash`);
}

function assertOptionalReferencePair(
  record: Record<string, unknown>,
  referenceKey: string,
  hashKey: string,
): void {
  const reference = record[referenceKey];
  const hash = record[hashKey];
  if ((reference === undefined) !== (hash === undefined))
    throw new Error(`Incomplete ${referenceKey} binding`);
  if (reference !== undefined) {
    assertArtifactReferenceShape(reference, referenceKey);
    assertHash(hash, hashKey);
  }
}

function assertOptionalRecordBinding(
  record: Record<string, unknown>,
  artifactKey: string,
  idKey: string,
  hashKey: string,
): void {
  const values = [record[artifactKey], record[idKey], record[hashKey]];
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== 3) throw new Error(`Incomplete ${artifactKey} binding`);
  if (present === 3) {
    assertArtifactReferenceShape(record[artifactKey], artifactKey);
    assertId(record[idKey], idKey);
    assertHash(record[hashKey], hashKey);
  }
}

function assertKindIdentity(record: Record<string, unknown>, kind: string): void {
  if (record.kind !== kind) throw new Error(`Invalid ${kind} kind`);
  assertId(record.id, `${kind} ID`);
  assertHash(record.hash, `${kind} hash`);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function optionalId(value: unknown, label: string): void {
  if (value !== undefined) assertId(value, label);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function optionalHash(value: unknown, label: string): void {
  if (value !== undefined) assertHash(value, label);
}

function assertInterval(value: unknown, label: string): void {
  const record = assertRecord(value, label);
  const startedAt = assertCanonicalIso(record.startedAt, `${label} startedAt`);
  const endedAt = assertCanonicalIso(record.endedAt, `${label} endedAt`);
  assertNonNegativeInteger(record.durationMs, `${label} duration`);
  if (endedAt < startedAt || endedAt - startedAt !== record.durationMs)
    throw new Error(`Invalid ${label}`);
}

function assertModelUsage(value: unknown, label: string): void {
  const record = assertRecord(value, label);
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
  ] as const) {
    const amount = record[field];
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0))
      throw new Error(`Invalid ${label} ${field}`);
  }
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const amount = record[field];
    if (typeof amount === "number" && !Number.isSafeInteger(amount))
      throw new Error(`Invalid ${label} ${field}`);
  }
}

function assertModelId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value))
    throw new Error(`Invalid ${label}`);
}

function assertNumericIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,31}$/.test(value))
    throw new Error(`Invalid ${label}`);
}

function assertCanonicalIso(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new Error(`Invalid ${label}`);
  return timestamp;
}

function assertBoundedText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const bytes = utf8Bytes(value);
  if (
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    (minimumBytes > 0 && value.trim().length === 0)
  )
    throw new Error(`Invalid ${label}`);
}

function optionalBoundedText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): void {
  if (value !== undefined) assertBoundedText(value, label, minimumBytes, maximumBytes);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${label}`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}`);
}

function assertOneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`Invalid ${label}`);
  return value as T;
}

function assertStringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumBytes: number,
): void {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Invalid ${label}`);
  for (const item of value) assertBoundedText(item, label, 1, maximumBytes);
}

function assertUniqueIds(
  value: unknown,
  label: string,
  maximumItems: number,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Invalid ${label}`);
  const ids = new Set<string>();
  for (const item of value) {
    assertId(item, label);
    if (ids.has(item)) throw new Error(`Duplicate ${label}`);
    ids.add(item);
  }
}

function requireAuthority(
  actual: unknown,
  expected: CreatorConversationAuthority,
  eventType: string,
): void {
  if (actual !== expected) throw new Error(`${eventType} requires ${expected} authority`);
}

const TURN_TYPES = ["new_work", "clarification", "plan_refinement", "follow_up"] as const;
const AGENT_OUTCOMES = ["answer", "clarification_requested", "plan_proposed"] as const;
const JOB_STATUSES = [
  "queued",
  "running",
  "awaiting_external",
  "outcome_unknown",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const EPISODE_STATUSES = [
  "indexing",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_decision",
  "refining_plan",
  "building",
  "awaiting_change_decision",
  "applying",
  "awaiting_play",
  "observing_play",
  "finalizing",
  "awaiting_verification_retry",
  "awaiting_review",
  "refresh_required",
  "refreshing",
  "recovery_required",
  "awaiting_source_sync",
  "accepted",
  "completed",
  "rejected",
  "superseded",
  "incomplete",
] as const;
const ATTACHMENT_ROLES = [
  "visual_observation",
  "project_index",
  "source_consultation",
  "agent_run",
  "build_trace",
  "plan",
  "change_set",
  "mutation",
  "runtime_evidence",
  "verification",
  "review_report",
  "refresh",
  "source_sync",
  "recovery",
  "project_identity",
  "technical_detail",
] as const;
const CONTROL_ACTIONS = [
  "new_conversation",
  "link_project",
  "fork_project",
  "continue_published_project",
  "start_published_project",
  "resume_work",
  "retry_work",
  "build_plan",
  "retry_build",
  "resume_build",
  "revise_plan",
  "reject_plan",
  "apply_changes",
  "reject_changes",
  "refresh_project",
  "retry_play",
  "cancel_changes",
  "undo_changes",
  "keep_changes",
  "cancel_recovery",
  "check_source_sync",
  "revert_source_changes",
  "remember",
  "correct_memory",
  "pin_memory",
  "unpin_memory",
  "forget_memory",
] as const;
/** A terminal message belongs to its outcome, not later receipt-cleanup revisions. */
export function creatorTerminalOutputKey(
  event: Pick<
    Extract<CreatorConversationEvent, { eventType: "terminal_output" }>,
    "episodeId" | "binding" | "projectRevisionHash" | "data"
  >,
): string {
  return JSON.stringify([
    event.episodeId,
    event.binding?.sessionId,
    event.projectRevisionHash,
    event.data.outcome,
    // Copy changes must not republish the same failure after restart. A genuinely
    // different failed attempt has a different immutable session hash.
    event.data.outcome === "incomplete" && event.binding?.sessionHash
      ? event.binding.sessionHash
      : event.data.message,
    event.data.studioHasAcceptedResult,
  ]);
}
