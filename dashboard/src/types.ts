/**
 * The dashboard deliberately consumes the coordinator's conversation contract
 * directly. It has no client-side status-to-action mapping or shadow transcript
 * shape: the read model is presentation data and the control view is authority.
 */
export type {
  CreatorActionRequest,
  CreatorAgentOutcome,
  CreatorArtifactBinding,
  CreatorCitation,
  CreatorCitationTarget,
  CreatorControlActionDescriptor,
  CreatorControlInputRequirement,
  CreatorControlView,
  CreatorConversationAttachment,
  CreatorConversationEvent,
  CreatorConversationEventPage,
  CreatorConversationSummary,
  CreatorDashboardState,
  CreatorMemorySummary,
  CreatorModelRegistry,
  CreatorModelRegistryEntry,
  CreatorProjectConversation,
  CreatorProjectIdentity,
  CreatorTurnContract,
  CreatorTurnRequest,
  CreatorTurnType,
  CreatorWorkAdmission,
  CreatorWorkEpisodeSummary,
} from "../../packages/creator-conversation/src/contracts.js";

import type {
  CreatorDashboardState,
  CreatorMemorySummary,
  CreatorModelRegistryEntry,
  CreatorTurnRequest,
} from "../../packages/creator-conversation/src/contracts.js";

export interface ConversationDraft {
  readonly text: string;
  readonly modelId?: string;
}

/**
 * Text supplied to an exact control-view action stays browser-local until the
 * control plane has confirmed admission. It is deliberately separate from a
 * conversation draft: an action descriptor is already bound to one immutable
 * event, while the composer applies to the next permitted turn.
 */
export interface ActionDraft {
  readonly text: string;
  readonly memoryCategory?: CreatorMemorySummary["category"];
}

export interface DashboardSnapshot {
  readonly draftStorageError?: string;
  readonly loadingHistoryFor?: string | undefined;
  readonly connectionLost?: boolean;
  readonly phase: "loading" | "ready" | "error";
  readonly data?: CreatorDashboardState;
  readonly error?: string;
  readonly pendingRequest?: {
    readonly kind: "turn" | "action";
    readonly id: string;
  };
  readonly drafts: Readonly<Record<string, ConversationDraft>>;
  readonly actionDrafts?: Readonly<Record<string, ActionDraft>>;
  /** Exact messages whose admission could not be confirmed. */
  readonly unconfirmedTurns?: readonly CreatorTurnRequest[];
}

export interface ModelChoice {
  readonly model: CreatorModelRegistryEntry;
  readonly selected: boolean;
}
