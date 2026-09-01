export type CreatorSessionStatus =
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_change_approval"
  | "applying"
  | "awaiting_verification"
  | "verifying"
  | "repairing"
  | "awaiting_review"
  | "creator_accepted"
  | "creator_rejected"
  | "rolled_back"
  | "incomplete"
  | "recovery_required";

export type CreatorActionId =
  | "approve_plan"
  | "reject_plan"
  | "approve_and_apply_changes"
  | "reject_changes"
  | "start_checks"
  | "cancel_changes"
  | "accept_result"
  | "reject_and_rollback";

export interface ArtifactReference {
  locator: string;
  artifactHash: string;
  bytes: number;
}

export interface CreatorSessionSummary {
  id: string;
  prompt: string;
  status: CreatorSessionStatus;
  updatedAt: string;
  projectId: string;
  projectName?: string;
  latestVerificationStatus?: "passed" | "failed" | "incomplete" | "not_run";
}

export interface CreatorArtifactSet {
  prompt?: ArtifactReference;
  plan?: ArtifactReference;
  changeSet?: ArtifactReference;
  studioExecutionPlan?: ArtifactReference;
  runtimeObservation?: ArtifactReference;
  verification?: ArtifactReference;
  reviewReport?: ArtifactReference;
  agentRun?: ArtifactReference;
  trace?: ArtifactReference;
}

export interface CreatorStage {
  id: "request" | "plan" | "change" | "studio" | "review";
  label: "Request" | "Plan" | "Change" | "Studio" | "Review";
  status: "complete" | "active" | "blocked" | "pending" | "failed";
  authority: "creator" | "agent" | "studio" | "forge";
  detail: string;
}

export interface CreatorControlAction {
  id: CreatorActionId;
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
  creatorReviewPrompts?: string[];
  primaryAction?: CreatorControlAction;
  secondaryAction?: CreatorControlAction;
  artifacts?: CreatorArtifactSet;
  verification?: {
    id: string;
    status: "passed" | "failed" | "incomplete" | "not_run";
    failureFacts: Array<{ statement: string; hash: string }>;
    replayable: boolean;
  };
}

export interface PairedStudioState {
  status: "paired" | "unpaired" | "connecting";
  projectId?: string;
  projectName?: string;
  revisionHash?: string;
  capabilities?: string[];
  message: string;
}

export interface CreatorDashboardState {
  kind: "CreatorDashboardState";
  selectedSessionId?: string;
  sessions: CreatorSessionSummary[];
  pairedStudio: PairedStudioState;
  controlView?: CreatorControlView;
  stages: CreatorStage[];
  serverTime: string;
}

export type DashboardActionRequest =
  | { action: "start"; prompt: string }
  | {
      action: "act";
      sessionId: string;
      viewId: string;
      viewHash: string;
      actionId: CreatorActionId;
      report?: string;
    };

export interface CreatorVerificationReplay {
  kind: "CreatorVerificationReplay";
  sessionId: string;
  verificationId: string;
  result: "exact_match" | "mismatch" | "missing_or_incomplete";
  recordedStatus: "passed" | "failed" | "incomplete";
  replayedStatus?: "passed" | "failed";
  recordedFailureFactHashes: string[];
  replayedFailureFactHashes?: string[];
  detail: string;
}

export interface DashboardSnapshot {
  phase: "loading" | "ready" | "error";
  data?: CreatorDashboardState;
  error?: string;
  pendingAction?: CreatorActionId | "start";
}
