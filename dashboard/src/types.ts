export type CreatorSessionStatus =
  | "indexing"
  | "planning"
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
  | "retry_play_verification"
  | "cancel_changes"
  | "refresh_project"
  | "check_source_sync"
  | "revert_source_changes"
  | "accept_result"
  | "reject_and_rollback"
  | "cancel_interrupted_recording";

export interface ArtifactReference {
  locator: string;
  artifactHash: string;
  bytes: number;
}

export interface CreatorSessionSummary {
  id: string;
  hash: string;
  prompt: string;
  promptHash: string;
  status: CreatorSessionStatus;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  projectName?: string;
  latestVerificationStatus?: "passed" | "failed" | "incomplete" | "not_run";
  failure?: { code: string; detailHash: string };
}

export interface CreatorArtifactSet {
  prompt?: ArtifactReference;
  plan?: ArtifactReference;
  changeSet?: ArtifactReference;
  capabilityManifest?: ArtifactReference;
  capabilityAttestation?: ArtifactReference;
  mutationProjection?: ArtifactReference;
  mutationPreflight?: ArtifactReference;
  mutationReadback?: ArtifactReference;
  projectState?: ArtifactReference;
  mutationReconciliation?: ArtifactReference;
  mutationFinalization?: ArtifactReference;
  studioExecutionPlan?: ArtifactReference;
  runtimeEvidence?: ArtifactReference;
  verification?: ArtifactReference;
  reviewReport?: ArtifactReference;
  agentRun?: ArtifactReference;
  trace?: ArtifactReference;
  projectIndex?: ArtifactReference;
  sourceConsultation?: ArtifactReference;
  projectChangeNotice?: ArtifactReference;
  projectDelta?: ArtifactReference;
  projectAuthorityMap?: ArtifactReference;
  rojoSourceChangeSet?: ArtifactReference;
  rojoMutationAttempt?: ArtifactReference;
  sourceSync?: ArtifactReference;
  sourceRevert?: ArtifactReference;
  sourceRevertSync?: ArtifactReference;
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
}

export interface PairedStudioState {
  status: "paired" | "unpaired" | "connecting";
  projectId?: string;
  projectName?: string;
  revisionHash?: string;
  capabilities?: string[];
  manifestHash?: string;
  connectorBuildHash?: string;
  attestationStatus?: "verified" | "pending" | "rejected" | "incomplete";
  attestationHash?: string;
  /** Immutable envelope emitted by Studio and retained for this live pairing. */
  attestationArtifact?: ArtifactReference;
  /**
   * A bounded, backend-verified account of the current attestation. This is
   * diagnostic evidence only: it never grants a dashboard action.
   */
  attestation?: StudioAttestationSummary;
  /** Backend-derived recovery gate; the dashboard never infers this. */
  transactionInventoryStatus: "clear" | "pending" | "blocked" | "unavailable";
  message: string;
}

/** A bounded JSON-safe value copied verbatim from backend verifier evidence. */
export type StudioAttestationEvidenceValue =
  | string
  | number
  | boolean
  | null
  | readonly StudioAttestationEvidenceValue[]
  | { readonly [key: string]: StudioAttestationEvidenceValue };

/** Raw expected or received metadata, including all reflected type dimensions. */
export type StudioAttestationEvidence = Readonly<Record<string, StudioAttestationEvidenceValue>>;

/**
 * A deterministic row-level verifier finding. `code`, `expected`, and
 * `received` are authored by backend verification; the dashboard only renders
 * them and deliberately does not reinterpret them as an authorization rule.
 */
export interface StudioAttestationFinding {
  key: string;
  code: string;
  expected?: StudioAttestationEvidence;
  received?: StudioAttestationEvidence;
}

/**
 * Bounded health data for the complete raw attestation artifact. Totals refer
 * to all verifier rows; `findings` may be truncated only by the backend.
 */
export interface StudioAttestationSummary {
  detail: string;
  totalFacts: number;
  observedFacts: number;
  unavailableFacts: number;
  readErrorFacts: number;
  mismatchedFacts: number;
  missingFacts: number;
  findingsTruncated: boolean;
  findings: readonly StudioAttestationFinding[];
}

export interface StudioCatalogSummary {
  kind: "StudioCatalogSummary";
  catalog: {
    hash: string;
    source: {
      repository: string;
      commit: string;
      engineReferencePath: string;
      sourceTreeHash: string;
    };
    counts: Record<string, number>;
  };
  coverage: {
    hash: string;
    catalogHash: string;
    policyHash: string;
    manifestHash: string;
    summary: {
      total: number;
      byDisposition: Record<string, number>;
      byReason: Record<string, number | undefined>;
      authorableClasses: number;
      authorableProperties: number;
    };
    catalogBinding: "matched" | "mismatched";
    manifestBinding: "matched" | "mismatched";
  };
  manifest: {
    hash: string;
    connectorBuildHash: string;
    classCount: number;
    writablePropertyCount: number;
    roots: string[];
    operationKinds: string[];
  };
}

export interface StudioCapabilityExplorerEntry {
  catalogEntryId: string;
  entryKind: string;
  owner?: string;
  name: string;
  disposition: string;
  reason: string;
  authoringGroup?: string;
  codec?: string;
  inheritedBy?: string[];
  proofObligations?: string[];
  deprecated: boolean;
  tags: string[];
  sourceFile: string;
  sourceFileHash: string;
  superclass?: string;
  valueType?: string;
  parameters?: Array<{
    name: string;
    type: string;
    default?: string | number | boolean;
  }>;
  returns?: Array<{ type: string }>;
  operandTypes?: string[];
  security?: { read?: string; write?: string };
  serialization?: { canLoad: boolean; canSave: boolean };
  threadSafety?: string;
  capabilities?: string[];
  enumValue?: number;
}

export interface StudioCapabilityExplorerPage {
  kind: "StudioCapabilityExplorerPage";
  catalogHash: string;
  coverageHash: string;
  selection: {
    className?: string;
    query?: string;
  };
  page: {
    cursor: number;
    limit: number;
    total: number;
    nextCursor?: number;
  };
  entries: StudioCapabilityExplorerEntry[];
}

export interface CapabilityExplorerSnapshot {
  phase: "loading" | "ready" | "error";
  summary?: StudioCatalogSummary;
  page?: StudioCapabilityExplorerPage;
  error?: string;
}

/** A stable, read-only address within one immutable Studio source index. */
export interface StudioSourceDocumentLocator {
  documentId: string;
  path: string;
  className: string;
  executionContext: "client" | "server" | "shared";
  sourceHash: string;
}

export interface StudioSourceLocation {
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface StudioSourceDocumentPage {
  indexId: string;
  indexHash: string;
  documents: StudioSourceDocumentLocator[];
  nextCursor?: string;
}

export interface StudioSourceSearchPage {
  indexId: string;
  indexHash: string;
  query: string;
  matches: Array<{
    document: StudioSourceDocumentLocator;
    location: StudioSourceLocation;
    snippetRange: { startByte: number; endByte: number };
    snippet: string;
  }>;
  nextCursor?: string;
}

export interface StudioSourceReadPage {
  indexId: string;
  indexHash: string;
  document: StudioSourceDocumentLocator;
  totalUtf8Bytes: number;
  range: { startByte: number; endByte: number };
  source: string;
  nextCursor?: string;
}

export interface StudioSourceSymbol {
  id: string;
  document: StudioSourceDocumentLocator;
  name: string;
  kind: "local" | "function" | "type" | "export_type";
  location: StudioSourceLocation;
}

export interface StudioSourceSymbolPage {
  indexId: string;
  indexHash: string;
  query: string;
  symbols: StudioSourceSymbol[];
  nextCursor?: string;
}

export interface StudioSourceReference {
  id: string;
  document: StudioSourceDocumentLocator;
  name: string;
  role: "declaration" | "reference";
  location: StudioSourceLocation;
}

export interface StudioSourceReferencePage {
  indexId: string;
  indexHash: string;
  symbol: string;
  references: StudioSourceReference[];
  nextCursor?: string;
}

export interface StudioSourceDependency {
  id: string;
  source: StudioSourceDocumentLocator;
  expressionHash: string;
  location: StudioSourceLocation;
  resolution: "resolved" | "dynamic" | "unresolved";
  target?: StudioSourceDocumentLocator;
  reason?: string;
}

export interface StudioSourceDependencyPage {
  indexId: string;
  indexHash: string;
  root: StudioSourceDocumentLocator;
  direction: "imports" | "importers" | "closure";
  maxDepth: number;
  dependencies: StudioSourceDependency[];
  discoveredNodes: StudioSourceDocumentLocator[];
  truncated: boolean;
  nextCursor?: string;
}

/** Exact, server-produced bytes for one bounded slice of a sealed source edit. */
export interface CreatorExactSourceDiffPage {
  kind: "CreatorExactSourceDiffPage";
  sessionId: string;
  sourceIndex: { id: string; hash: string; snapshotHash: string };
  changeSet: { id: string; hash: string };
  operation: {
    id: string;
    document: StudioSourceDocumentLocator;
    beforeSourceHash: string;
    finalSourceHash: string;
    finalByteCount: number;
  };
  edit: {
    ordinal: number;
    editCount: number;
    before: {
      totalUtf8Bytes: number;
      range: { startByte: number; endByte: number };
      source: string;
    };
    replacement: {
      sourceHash: string;
      totalUtf8Bytes: number;
      range: { startByte: number; endByte: number };
      source: string;
    };
  };
  nextCursor?: string;
}

/**
 * Dashboard requests are intentionally capability-free: they can only read a
 * session's immutable source index. The control server derives authority from
 * the authenticated session and rejects any cursor that is not bound to this
 * exact query/index.
 */
export type SourceExplorerRequest =
  | { operation: "documents"; cursor?: string }
  | { operation: "search"; query: string; pathPrefix?: string; cursor?: string }
  | { operation: "read"; documentId: string; cursor?: string }
  | {
      operation: "symbols";
      query: string;
      pathPrefix?: string;
      cursor?: string;
    }
  | {
      operation: "references";
      symbol: string;
      pathPrefix?: string;
      cursor?: string;
    }
  | {
      operation: "diff";
      operationId: string;
      changeSetId?: string;
      cursor?: string;
    }
  | {
      operation: "dependencies";
      documentId: string;
      direction: "imports" | "importers" | "closure";
      cursor?: string;
    };

export type SourceExplorerResult =
  | { operation: "documents"; page: StudioSourceDocumentPage }
  | { operation: "search"; page: StudioSourceSearchPage }
  | { operation: "read"; page: StudioSourceReadPage }
  | { operation: "symbols"; page: StudioSourceSymbolPage }
  | { operation: "references"; page: StudioSourceReferencePage }
  | { operation: "diff"; page: CreatorExactSourceDiffPage }
  | { operation: "dependencies"; page: StudioSourceDependencyPage };

export interface SourceExplorerSnapshot {
  phase: "idle" | "loading" | "ready" | "error";
  /** The session to which `result` is cryptographically index-bound. */
  sessionId?: string;
  request?: SourceExplorerRequest;
  result?: SourceExplorerResult;
  error?: string;
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

export interface CreatorMutationReplay {
  kind: "CreatorMutationReplay";
  sessionId: string;
  attemptId: string;
  result: "exact_match" | "mismatch" | "missing_or_incomplete";
  recordedStatus: string;
  replayedStatus?: string;
  recordedFailureFactHashes: string[];
  replayedFailureFactHashes?: string[];
  detail: string;
}

export interface DashboardSnapshot {
  phase: "loading" | "ready" | "error";
  data?: CreatorDashboardState;
  error?: string;
  pendingAction?: CreatorActionId | "start";
  catalog: CapabilityExplorerSnapshot;
  sources: SourceExplorerSnapshot;
}
