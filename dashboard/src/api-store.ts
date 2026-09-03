import { useSyncExternalStore } from "react";
import type {
  CapabilityExplorerSnapshot,
  CreatorExactSourceDiffPage,
  CreatorDashboardState,
  DashboardActionRequest,
  DashboardSnapshot,
  SourceExplorerRequest,
  SourceExplorerResult,
  SourceExplorerSnapshot,
  StudioCapabilityExplorerPage,
  StudioCatalogSummary,
  StudioSourceDependencyPage,
  StudioSourceDocumentLocator,
  StudioSourceDocumentPage,
  StudioSourceLocation,
  StudioSourceReadPage,
  StudioSourceReferencePage,
  StudioSourceSearchPage,
  StudioSourceSymbolPage,
} from "./types";

const INITIAL_SNAPSHOT: DashboardSnapshot = {
  phase: "loading",
  catalog: { phase: "loading" },
  sources: { phase: "idle" },
};
const JSON_HEADERS = { "Content-Type": "application/json" };
const MAX_ATTESTATION_FINDINGS = 32;
const SOURCE_DOCUMENT_PAGE_SIZE = 50;
const SOURCE_SEARCH_PAGE_SIZE = 50;
const SOURCE_SYMBOL_PAGE_SIZE = 100;
const SOURCE_REFERENCE_PAGE_SIZE = 100;
const SOURCE_DEPENDENCY_PAGE_SIZE = 200;
const SOURCE_READ_PAGE_BYTES = 32 * 1024;
const SOURCE_MAX_DEPENDENCY_DEPTH = 16;
const AMBIGUOUS_ACTION_MESSAGE =
  "Forge could not confirm whether this action reached the local control plane. Its exact effect may already be recorded. Forge did not retry it; the dashboard reloaded the current evidence record.";

export class CreatorDashboardStore {
  private snapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private selectedSessionId: string | undefined;
  private eventSource: EventSource | undefined;
  private cursor = 0;
  private invalidations = 0;
  private refreshing = false;
  private refreshAgain = false;
  private catalogSummaryRequest = 0;
  private capabilityPageRequest = 0;
  private sourceExplorerRequest = 0;
  private started = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DashboardSnapshot => this.snapshot;

  start = (): void => {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.refresh();
    void this.refreshCatalog();
    this.connectEvents();
  };

  selectSession = (sessionId: string): void => {
    if (this.selectedSessionId === sessionId) return;
    this.selectedSessionId = sessionId;
    this.sourceExplorerRequest += 1;
    this.setSources({ phase: "idle" });
    void this.refresh();
  };

  submit = async (action: DashboardActionRequest): Promise<void> => {
    const pendingAction = action.action === "start" ? "start" : action.actionId;
    this.setSnapshot({ ...this.snapshot, pendingAction });
    let actionOutcomeKnown = false;
    try {
      const response = await fetch("/api/control/action", {
        method: "POST",
        credentials: "same-origin",
        headers: JSON_HEADERS,
        body: JSON.stringify(action),
      });
      const value = await readJson(response);
      if (!response.ok) {
        if (isActionOutcomeUnknown(value)) throw new Error(readError(value, response.status));
        actionOutcomeKnown = true;
        throw new Error(readError(value, response.status));
      }
      if (isDashboardState(value)) {
        actionOutcomeKnown = true;
        const nextSelectedSessionId = value.selectedSessionId ?? this.selectedSessionId;
        const sourceSessionChanged = nextSelectedSessionId !== this.selectedSessionId;
        this.selectedSessionId = nextSelectedSessionId;
        if (sourceSessionChanged) this.sourceExplorerRequest += 1;
        this.setSnapshot({
          ...this.snapshot,
          phase: "ready",
          data: value,
          ...(sourceSessionChanged ? { sources: { phase: "idle" } } : {}),
        });
      } else {
        throw new Error("The control plane returned an invalid dashboard state.");
      }
    } catch (error) {
      if (!actionOutcomeKnown) {
        // A lost POST response cannot prove the action was rejected: Studio may
        // already have received and durably recorded it. Observe canonical
        // state once, but never repeat a state-changing request automatically.
        await this.refresh();
        this.setSnapshot({
          ...this.snapshot,
          phase: "error",
          ...(this.snapshot.data ? { data: this.snapshot.data } : {}),
          error: AMBIGUOUS_ACTION_MESSAGE,
        });
        throw new Error(AMBIGUOUS_ACTION_MESSAGE);
      }
      this.setSnapshot({
        ...this.snapshot,
        phase: "error",
        ...(this.snapshot.data ? { data: this.snapshot.data } : {}),
        error: errorMessage(error),
      });
      throw error;
    } finally {
      if (this.snapshot.pendingAction) {
        const { pendingAction: _pendingAction, ...withoutPendingAction } = this.snapshot;
        this.setSnapshot(withoutPendingAction);
      }
    }
  };

  exploreCapabilities = (input: { className?: string; query?: string; cursor?: number }): void => {
    void this.refreshCapabilities(input);
  };

  exploreSources = (input: SourceExplorerRequest): void => {
    const sessionId = this.snapshot.data?.selectedSessionId ?? this.selectedSessionId;
    const request = ++this.sourceExplorerRequest;
    if (!sessionId) {
      this.setSources({
        phase: "error",
        request: input,
        error: "Select a creator session before exploring its immutable source index.",
      });
      return;
    }
    void this.refreshSources(sessionId, input, request);
  };

  private connectEvents(): void {
    this.eventSource = new EventSource(`/api/control/events?after=${this.cursor}`);
    this.eventSource.onmessage = (event) => {
      this.cursor = readCursor(event.data, event.lastEventId, this.cursor);
      this.invalidations += 1;
      void this.consumeInvalidations();
    };
    // An event cursor is intentionally bounded server-side. A reset is a
    // protocol-level resync, not an error that should make EventSource retry an
    // expired cursor forever.
    (this.eventSource as Partial<EventSource>).addEventListener?.("reset", (event) => {
      const message = event as MessageEvent<string>;
      this.cursor = readCursor(message.data, message.lastEventId, this.cursor);
      this.invalidations = 0;
      void this.refresh();
    });
    this.eventSource.onerror = () => {
      // Native EventSource reconnects automatically. State remains visible until
      // the next successful invalidation fetch.
    };
  }

  private async consumeInvalidations(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshAgain = false;
    while (this.invalidations > 0) {
      this.invalidations -= 1;
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    const previous = this.snapshot.data;
    this.setSnapshot({
      ...this.snapshot,
      phase: "loading",
      ...(previous ? { data: previous } : {}),
    });
    try {
      const search = this.selectedSessionId
        ? `?sessionId=${encodeURIComponent(this.selectedSessionId)}`
        : "";
      const response = await fetch(`/api/control/state${search}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(readError(value, response.status));
      if (!isDashboardState(value))
        throw new Error("The control plane returned an invalid dashboard state.");
      const nextSelectedSessionId = value.selectedSessionId ?? this.selectedSessionId;
      const sourceSessionChanged = nextSelectedSessionId !== this.selectedSessionId;
      this.selectedSessionId = nextSelectedSessionId;
      if (sourceSessionChanged) this.sourceExplorerRequest += 1;
      this.setSnapshot({
        ...this.snapshot,
        phase: "ready",
        data: value,
        ...(sourceSessionChanged ? { sources: { phase: "idle" } } : {}),
      });
    } catch (error) {
      this.setSnapshot({
        ...this.snapshot,
        phase: "error",
        ...(previous ? { data: previous } : {}),
        error: errorMessage(error),
      });
    } finally {
      this.refreshing = false;
      if (this.invalidations > 0) {
        void this.consumeInvalidations();
      } else if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private async refreshCatalog(): Promise<void> {
    const request = ++this.catalogSummaryRequest;
    const capabilityPageRequestAtStart = this.capabilityPageRequest;
    const previous = this.snapshot.catalog;
    this.setCatalog({
      phase: "loading",
      ...(previous.summary ? { summary: previous.summary } : {}),
      ...(previous.page ? { page: previous.page } : {}),
    });
    try {
      const response = await fetch("/api/control/catalog", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(readError(value, response.status));
      if (!isCatalogSummary(value))
        throw new Error("The control plane returned an invalid catalog summary.");
      if (request !== this.catalogSummaryRequest) return;
      const current = this.snapshot.catalog;
      this.setCatalog({
        phase: "ready",
        summary: value,
        ...(current.page ? { page: current.page } : {}),
      });
      if (!current.page && capabilityPageRequestAtStart === this.capabilityPageRequest)
        void this.refreshCapabilities({});
    } catch (error) {
      if (request !== this.catalogSummaryRequest) return;
      const current = this.snapshot.catalog;
      this.setCatalog({
        phase: "error",
        ...(current.summary ? { summary: current.summary } : {}),
        ...(current.page ? { page: current.page } : {}),
        error: errorMessage(error),
      });
    }
  }

  private async refreshCapabilities(input: {
    className?: string;
    query?: string;
    cursor?: number;
  }): Promise<void> {
    const request = ++this.capabilityPageRequest;
    const previous = this.snapshot.catalog;
    this.setCatalog({
      phase: "loading",
      ...(previous.summary ? { summary: previous.summary } : {}),
      ...(previous.page ? { page: previous.page } : {}),
    });
    const search = new URLSearchParams();
    if (input.className?.trim()) search.set("class", input.className.trim());
    if (input.query?.trim()) search.set("query", input.query.trim());
    if (input.cursor !== undefined) search.set("cursor", String(input.cursor));
    search.set("limit", "40");
    try {
      const response = await fetch(`/api/control/capabilities?${search.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(readError(value, response.status));
      if (!isCapabilityPage(value))
        throw new Error("The control plane returned an invalid capability page.");
      if (request !== this.capabilityPageRequest) return;
      const current = this.snapshot.catalog;
      this.setCatalog({
        phase: "ready",
        ...(current.summary ? { summary: current.summary } : {}),
        page: value,
      });
    } catch (error) {
      if (request !== this.capabilityPageRequest) return;
      const current = this.snapshot.catalog;
      this.setCatalog({
        phase: "error",
        ...(current.summary ? { summary: current.summary } : {}),
        ...(current.page ? { page: current.page } : {}),
        error: errorMessage(error),
      });
    }
  }

  private async refreshSources(
    sessionId: string,
    input: SourceExplorerRequest,
    request: number,
  ): Promise<void> {
    const previous = this.snapshot.sources;
    this.setSources({
      phase: "loading",
      sessionId,
      request: input,
      ...(previous.sessionId === sessionId && previous.result ? { result: previous.result } : {}),
    });
    try {
      const response = await fetch(sourceExplorerUrl(sessionId, input), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(readError(value, response.status));
      const result = sourceExplorerResult(input.operation, value);
      if (request !== this.sourceExplorerRequest) return;
      this.setSources({ phase: "ready", sessionId, request: input, result });
    } catch (error) {
      if (request !== this.sourceExplorerRequest) return;
      const current = this.snapshot.sources;
      this.setSources({
        phase: "error",
        sessionId,
        request: input,
        ...(current.sessionId === sessionId && current.result ? { result: current.result } : {}),
        error: errorMessage(error),
      });
    }
  }

  private setCatalog(value: CapabilityExplorerSnapshot): void {
    this.setSnapshot({ ...this.snapshot, catalog: value });
  }

  private setSources(value: SourceExplorerSnapshot): void {
    this.setSnapshot({ ...this.snapshot, sources: value });
  }

  private setSnapshot(value: DashboardSnapshot): void {
    this.snapshot = value;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Store subscribers only render local state. A broken consumer must
        // not interrupt fetch completion, event resynchronization, or another
        // subscriber receiving the canonical snapshot.
      }
    }
  }
}

export function isDashboardState(value: unknown): value is CreatorDashboardState {
  if (!isRecord(value) || value.kind !== "CreatorDashboardState") return false;
  return (
    (value.selectedSessionId === undefined || isIdentifier(value.selectedSessionId)) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isCreatorSessionSummary) &&
    isPairedStudioState(value.pairedStudio) &&
    (value.controlView === undefined || isCreatorControlView(value.controlView)) &&
    Array.isArray(value.stages) &&
    value.stages.every(isCreatorStage) &&
    isIsoTimestamp(value.serverTime)
  );
}

function isCreatorSessionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isContentHash(value.hash) &&
    isIdentifier(value.projectId) &&
    typeof value.prompt === "string" &&
    isContentHash(value.promptHash) &&
    isCreatorSessionStatus(value.status) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.latestVerificationStatus === undefined ||
      ["passed", "failed", "incomplete", "not_run"].includes(
        value.latestVerificationStatus as string,
      )) &&
    (value.failure === undefined ||
      (isRecord(value.failure) &&
        typeof value.failure.code === "string" &&
        value.failure.code.length > 0 &&
        isContentHash(value.failure.detailHash)))
  );
}

function isCreatorStage(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["request", "plan", "change", "studio", "review"].includes(value.id as string) &&
    ["Request", "Plan", "Change", "Studio", "Review"].includes(value.label as string) &&
    ["pending", "active", "complete", "blocked", "failed"].includes(value.status as string) &&
    ["creator", "agent", "forge", "studio"].includes(value.authority as string) &&
    typeof value.detail === "string"
  );
}

function isPairedStudioState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status !== "paired" && value.status !== "unpaired" && value.status !== "connecting")
    return false;
  if (
    typeof value.message !== "string" ||
    !["clear", "pending", "blocked", "unavailable"].includes(
      value.transactionInventoryStatus as string,
    )
  )
    return false;
  if (
    value.status === "paired" &&
    (!isIdentifier(value.projectId) ||
      typeof value.projectName !== "string" ||
      (value.revisionHash !== undefined && !isContentHash(value.revisionHash)) ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.every((capability) => typeof capability === "string") ||
      !isContentHash(value.manifestHash) ||
      !isContentHash(value.connectorBuildHash) ||
      !["verified", "pending", "rejected", "incomplete"].includes(
        value.attestationStatus as string,
      ))
  )
    return false;
  return (
    (value.attestationHash === undefined || isContentHash(value.attestationHash)) &&
    (value.attestationArtifact === undefined || isArtifactReference(value.attestationArtifact)) &&
    (value.attestation === undefined || isAttestationSummary(value.attestation))
  );
}

function isCreatorControlView(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorControlView" ||
    !isIdentifier(value.id) ||
    !isContentHash(value.hash) ||
    !isIdentifier(value.creatorSessionId) ||
    !isContentHash(value.creatorSessionHash) ||
    !isCreatorSessionStatus(value.status) ||
    typeof value.title !== "string" ||
    typeof value.detail !== "string"
  )
    return false;
  if (value.artifact !== undefined && !isReviewArtifact(value.artifact)) return false;
  if (
    value.creatorReviewPrompts !== undefined &&
    (!Array.isArray(value.creatorReviewPrompts) ||
      !value.creatorReviewPrompts.every((prompt) => typeof prompt === "string"))
  )
    return false;
  if (value.primaryAction !== undefined && !isCreatorAction(value.primaryAction, "primary"))
    return false;
  if (value.secondaryAction !== undefined && !isCreatorAction(value.secondaryAction, "secondary"))
    return false;
  if (
    value.artifacts !== undefined &&
    (!isRecord(value.artifacts) || !Object.values(value.artifacts).every(isArtifactReference))
  )
    return false;
  if (value.verification !== undefined && !isVerification(value.verification)) return false;
  if (value.mutation !== undefined && !isMutation(value.mutation)) return false;
  if (value.projectIndex !== undefined && !isProjectIndex(value.projectIndex)) return false;
  if (value.sourceConsultation !== undefined && !isSourceConsultation(value.sourceConsultation))
    return false;
  if (value.projectChange !== undefined && !isProjectChange(value.projectChange)) return false;
  return value.sourceSync === undefined || isSourceSync(value.sourceSync);
}

function isReviewArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "plan" || value.kind === "change_set") &&
    isIdentifier(value.id) &&
    isContentHash(value.hash) &&
    isContentHash(value.presentationHash) &&
    value.presentation !== undefined
  );
}

function isCreatorAction(value: unknown, intent: "primary" | "secondary"): boolean {
  return (
    isRecord(value) &&
    [
      "approve_plan",
      "reject_plan",
      "approve_and_apply_changes",
      "reject_changes",
      "retry_play_verification",
      "cancel_changes",
      "refresh_project",
      "check_source_sync",
      "revert_source_changes",
      "accept_result",
      "reject_and_rollback",
      "cancel_interrupted_recording",
    ].includes(value.id as string) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.intent === intent &&
    (value.requiresReport === undefined || value.requiresReport === true)
  );
}

function isArtifactReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.locator === "string" &&
    value.locator.length > 0 &&
    isContentHash(value.artifactHash) &&
    isNonNegativeInteger(value.bytes)
  );
}

function isVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    ["passed", "failed", "incomplete", "not_run"].includes(value.status as string) &&
    typeof value.replayable === "boolean" &&
    isFailureFacts(value.failureFacts) &&
    (value.runtimeSummary === undefined || isRuntimeSummary(value.runtimeSummary))
  );
}

function isRuntimeSummary(value: unknown): boolean {
  if (!isRecord(value) || !isIsoTimestamp(value.startedAt) || !isIsoTimestamp(value.endedAt))
    return false;
  if (
    ![
      value.observedFacts,
      value.absentFacts,
      value.unavailableFacts,
      value.readErrorFacts,
      value.diagnosticCount,
    ].every(isNonNegativeInteger)
  )
    return false;
  return (
    Array.isArray(value.issues) &&
    value.issues.every(
      (issue) =>
        isRecord(issue) &&
        typeof issue.key === "string" &&
        ["unavailable", "read_error"].includes(issue.status as string) &&
        typeof issue.code === "string",
    )
  );
}

function isMutation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.attemptId) &&
    [
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
    ].includes(value.status as string) &&
    typeof value.replayable === "boolean" &&
    isNonNegativeInteger(value.projectionFactCount) &&
    isFailureFacts(value.failureFacts, true)
  );
}

function isFailureFacts(value: unknown, requireCode = false): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.statement === "string" &&
        isContentHash(fact.hash) &&
        (!requireCode || (typeof fact.code === "string" && fact.code.length > 0)),
    )
  );
}

function isProjectIndex(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["indexing", "complete", "incomplete", "dirty"].includes(value.status as string) &&
    ["studio_document", "rojo_source"].includes(value.authorityMode as string) &&
    isIdentifier(value.connectorEpoch) &&
    isNonNegativeInteger(value.indexedInstances) &&
    isNonNegativeInteger(value.indexedBytes) &&
    isNonNegativeInteger(value.sourceBlobs) &&
    typeof value.dirty === "boolean" &&
    (value.manifestHash === undefined || isContentHash(value.manifestHash)) &&
    (value.rootHash === undefined || isContentHash(value.rootHash)) &&
    (value.artifact === undefined || isArtifactReference(value.artifact))
  );
}

function isSourceConsultation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isArtifactReference(value.artifact) &&
    isContentHash(value.sourceIndexHash) &&
    isNonNegativeInteger(value.sourceCount) &&
    isNonNegativeInteger(value.rangeCount) &&
    isNonNegativeInteger(value.dependencyNodeCount)
  );
}

function isProjectChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.detectedAt) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    (value.notice === undefined || isArtifactReference(value.notice)) &&
    (value.delta === undefined || isArtifactReference(value.delta)) &&
    (value.predecessorSessionId === undefined || isIdentifier(value.predecessorSessionId)) &&
    (value.successorSessionId === undefined || isIdentifier(value.successorSessionId))
  );
}

function isSourceSync(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["awaiting", "matched", "mismatched", "reverted"].includes(value.status as string) &&
    isIdentifier(value.attemptId) &&
    (value.artifact === undefined || isArtifactReference(value.artifact))
  );
}

function isCreatorSessionStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
      "indexing",
      "planning",
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
      "creator_accepted",
      "creator_rejected",
      "rolled_back",
      "incomplete",
      "recovery_required",
    ].includes(value)
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]+$/u.test(value);
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAttestationSummary(value: unknown): boolean {
  if (!isRecord(value) || typeof value.detail !== "string") return false;
  if (typeof value.findingsTruncated !== "boolean") return false;
  if (!Array.isArray(value.findings) || value.findings.length > MAX_ATTESTATION_FINDINGS)
    return false;
  for (const key of [
    "totalFacts",
    "observedFacts",
    "unavailableFacts",
    "readErrorFacts",
    "mismatchedFacts",
    "missingFacts",
  ]) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false;
  }
  return value.findings.every(isAttestationFinding);
}

function isAttestationFinding(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.code !== "string")
    return false;
  return (
    (value.expected === undefined || isAttestationEvidence(value.expected)) &&
    (value.received === undefined || isAttestationEvidence(value.received))
  );
}

function isAttestationEvidence(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isAttestationEvidence);
  return isRecord(value) && Object.values(value).every(isAttestationEvidence);
}

function isCatalogSummary(value: unknown): value is StudioCatalogSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "StudioCatalogSummary" &&
    isRecord(candidate.catalog) &&
    isRecord(candidate.coverage) &&
    isRecord(candidate.manifest)
  );
}

function isCapabilityPage(value: unknown): value is StudioCapabilityExplorerPage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "StudioCapabilityExplorerPage" &&
    Array.isArray(candidate.entries) &&
    isRecord(candidate.page) &&
    isRecord(candidate.selection)
  );
}

function sourceExplorerUrl(sessionId: string, input: SourceExplorerRequest): string {
  const search = new URLSearchParams({ sessionId });
  if (input.cursor !== undefined) search.set("cursor", input.cursor);
  switch (input.operation) {
    case "documents":
      search.set("limit", String(SOURCE_DOCUMENT_PAGE_SIZE));
      return `/api/sources/documents?${search.toString()}`;
    case "search":
      search.set("query", requiredSourceText(input.query, "Source search query", 512));
      if (input.pathPrefix?.trim()) search.set("pathPrefix", input.pathPrefix.trim());
      search.set("limit", String(SOURCE_SEARCH_PAGE_SIZE));
      return `/api/sources/search?${search.toString()}`;
    case "read":
      search.set(
        "documentId",
        requiredSourceText(input.documentId, "Source document identity", 256),
      );
      search.set("limit", String(SOURCE_READ_PAGE_BYTES));
      return `/api/sources/read?${search.toString()}`;
    case "symbols":
      search.set("query", requiredSourceText(input.query, "Symbol query", 256));
      if (input.pathPrefix?.trim()) search.set("pathPrefix", input.pathPrefix.trim());
      search.set("limit", String(SOURCE_SYMBOL_PAGE_SIZE));
      return `/api/sources/symbols?${search.toString()}`;
    case "references":
      search.set("symbol", requiredSourceText(input.symbol, "Reference symbol", 256));
      if (input.pathPrefix?.trim()) search.set("pathPrefix", input.pathPrefix.trim());
      search.set("limit", String(SOURCE_REFERENCE_PAGE_SIZE));
      return `/api/sources/references?${search.toString()}`;
    case "dependencies":
      search.set(
        "documentId",
        requiredSourceText(input.documentId, "Dependency root identity", 256),
      );
      search.set("direction", input.direction);
      search.set("maxDepth", String(SOURCE_MAX_DEPENDENCY_DEPTH));
      search.set("limit", String(SOURCE_DEPENDENCY_PAGE_SIZE));
      return `/api/sources/dependencies?${search.toString()}`;
    case "diff":
      search.set(
        "operationId",
        requiredSourceText(input.operationId, "Source edit operation identity", 256),
      );
      if (input.changeSetId?.trim())
        search.set(
          "changeSetId",
          requiredSourceText(input.changeSetId, "Change-set identity", 256),
        );
      search.set("limit", String(SOURCE_READ_PAGE_BYTES));
      return `/api/sources/diff?${search.toString()}`;
  }
}

function requiredSourceText(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximumLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function sourceExplorerResult(
  operation: SourceExplorerRequest["operation"],
  value: unknown,
): SourceExplorerResult {
  switch (operation) {
    case "documents":
      if (!isSourceDocumentPage(value)) break;
      return { operation, page: value };
    case "search":
      if (!isSourceSearchPage(value)) break;
      return { operation, page: value };
    case "read":
      if (!isSourceReadPage(value)) break;
      return { operation, page: value };
    case "symbols":
      if (!isSourceSymbolPage(value)) break;
      return { operation, page: value };
    case "references":
      if (!isSourceReferencePage(value)) break;
      return { operation, page: value };
    case "dependencies":
      if (!isSourceDependencyPage(value)) break;
      return { operation, page: value };
    case "diff":
      if (!isExactSourceDiffPage(value)) break;
      return { operation, page: value };
  }
  throw new Error("The control plane returned an invalid source explorer page.");
}

function isSourceDocumentPage(value: unknown): value is StudioSourceDocumentPage {
  return (
    hasSourcePageBinding(value) &&
    Array.isArray(value.documents) &&
    value.documents.length <= 200 &&
    value.documents.every(isSourceDocumentLocator)
  );
}

function isSourceSearchPage(value: unknown): value is StudioSourceSearchPage {
  return (
    hasSourcePageBinding(value) &&
    typeof value.query === "string" &&
    Array.isArray(value.matches) &&
    value.matches.length <= 100 &&
    value.matches.every(
      (match) =>
        isRecord(match) &&
        isSourceDocumentLocator(match.document) &&
        isSourceLocation(match.location) &&
        isSourceRange(match.snippetRange) &&
        typeof match.snippet === "string",
    )
  );
}

function isSourceReadPage(value: unknown): value is StudioSourceReadPage {
  return (
    hasSourcePageBinding(value) &&
    isSourceDocumentLocator(value.document) &&
    isNonNegativeInteger(value.totalUtf8Bytes) &&
    isSourceRange(value.range) &&
    value.range.endByte <= value.totalUtf8Bytes &&
    typeof value.source === "string" &&
    utf8Bytes(value.source) === value.range.endByte - value.range.startByte &&
    utf8Bytes(value.source) <= SOURCE_READ_PAGE_BYTES
  );
}

function isSourceSymbolPage(value: unknown): value is StudioSourceSymbolPage {
  return (
    hasSourcePageBinding(value) &&
    typeof value.query === "string" &&
    Array.isArray(value.symbols) &&
    value.symbols.length <= 200 &&
    value.symbols.every(
      (symbol) =>
        isRecord(symbol) &&
        typeof symbol.id === "string" &&
        typeof symbol.name === "string" &&
        (symbol.kind === "local" ||
          symbol.kind === "function" ||
          symbol.kind === "type" ||
          symbol.kind === "export_type") &&
        isSourceDocumentLocator(symbol.document) &&
        isSourceLocation(symbol.location),
    )
  );
}

function isSourceReferencePage(value: unknown): value is StudioSourceReferencePage {
  return (
    hasSourcePageBinding(value) &&
    typeof value.symbol === "string" &&
    Array.isArray(value.references) &&
    value.references.length <= 200 &&
    value.references.every(
      (reference) =>
        isRecord(reference) &&
        typeof reference.id === "string" &&
        typeof reference.name === "string" &&
        (reference.role === "declaration" || reference.role === "reference") &&
        isSourceDocumentLocator(reference.document) &&
        isSourceLocation(reference.location),
    )
  );
}

function isSourceDependencyPage(value: unknown): value is StudioSourceDependencyPage {
  return (
    hasSourcePageBinding(value) &&
    isSourceDocumentLocator(value.root) &&
    (value.direction === "imports" ||
      value.direction === "importers" ||
      value.direction === "closure") &&
    isNonNegativeInteger(value.maxDepth) &&
    value.maxDepth <= SOURCE_MAX_DEPENDENCY_DEPTH &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.dependencies) &&
    value.dependencies.length <= 1_024 &&
    value.dependencies.every(isSourceDependency) &&
    Array.isArray(value.discoveredNodes) &&
    value.discoveredNodes.length <= 1_024 &&
    value.discoveredNodes.every(isSourceDocumentLocator)
  );
}

function isExactSourceDiffPage(value: unknown): value is CreatorExactSourceDiffPage {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorExactSourceDiffPage" ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !isRecord(value.sourceIndex) ||
    typeof value.sourceIndex.id !== "string" ||
    !isContentHash(value.sourceIndex.hash) ||
    !isContentHash(value.sourceIndex.snapshotHash) ||
    !isRecord(value.changeSet) ||
    typeof value.changeSet.id !== "string" ||
    !isContentHash(value.changeSet.hash) ||
    !isRecord(value.operation) ||
    typeof value.operation.id !== "string" ||
    !isSourceDocumentLocator(value.operation.document) ||
    !isContentHash(value.operation.beforeSourceHash) ||
    !isContentHash(value.operation.finalSourceHash) ||
    !isNonNegativeInteger(value.operation.finalByteCount) ||
    !isRecord(value.edit) ||
    !isNonNegativeInteger(value.edit.ordinal) ||
    !isNonNegativeInteger(value.edit.editCount) ||
    value.edit.editCount < 1 ||
    value.edit.ordinal >= value.edit.editCount ||
    !isExactSourceDiffSide(value.edit.before, false) ||
    !isExactSourceDiffSide(value.edit.replacement, true) ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== "string" || value.nextCursor.length === 0))
  )
    return false;
  return true;
}

function isExactSourceDiffSide(value: unknown, replacement: boolean): boolean {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.totalUtf8Bytes) ||
    !isSourceRange(value.range) ||
    value.range.endByte > value.totalUtf8Bytes ||
    typeof value.source !== "string" ||
    utf8Bytes(value.source) > SOURCE_READ_PAGE_BYTES ||
    utf8Bytes(value.source) !== value.range.endByte - value.range.startByte
  )
    return false;
  return !replacement || isContentHash(value.sourceHash);
}

function hasSourcePageBinding(value: unknown): value is Record<string, unknown> & {
  indexId: string;
  indexHash: string;
} {
  return (
    isRecord(value) &&
    typeof value.indexId === "string" &&
    value.indexId.length > 0 &&
    isContentHash(value.indexHash) &&
    (value.nextCursor === undefined ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0))
  );
}

function isSourceDocumentLocator(value: unknown): value is StudioSourceDocumentLocator {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    value.documentId.length > 0 &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.className === "string" &&
    value.className.length > 0 &&
    (value.executionContext === "client" ||
      value.executionContext === "server" ||
      value.executionContext === "shared") &&
    isContentHash(value.sourceHash)
  );
}

function isSourceLocation(value: unknown): value is StudioSourceLocation {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.startByte) &&
    isNonNegativeInteger(value.endByte) &&
    value.endByte >= value.startByte &&
    isNonNegativeInteger(value.startLine) &&
    isNonNegativeInteger(value.startColumn) &&
    isNonNegativeInteger(value.endLine) &&
    isNonNegativeInteger(value.endColumn) &&
    (value.endLine > value.startLine ||
      (value.endLine === value.startLine && value.endColumn >= value.startColumn))
  );
}

function isSourceRange(value: unknown): value is { startByte: number; endByte: number } {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.startByte) &&
    isNonNegativeInteger(value.endByte) &&
    value.endByte >= value.startByte
  );
}

function isSourceDependency(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isSourceDocumentLocator(value.source) &&
    isContentHash(value.expressionHash) &&
    isSourceLocation(value.location) &&
    (value.resolution === "resolved" ||
      value.resolution === "dynamic" ||
      value.resolution === "unresolved") &&
    (value.target === undefined || isSourceDocumentLocator(value.target)) &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function readError(value: unknown, status: number): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return `Control request failed (${status}).`;
}

function isActionOutcomeUnknown(value: unknown): boolean {
  return isRecord(value) && value.kind === "CreatorControlActionOutcomeUnknown";
}

function readCursor(data: string, lastEventId: string, fallback: number): number {
  if (lastEventId && Number.isInteger(Number(lastEventId))) return Number(lastEventId);
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === "object" && "cursor" in value) {
      const cursor = (value as { cursor?: unknown }).cursor;
      if (typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0) return cursor;
    }
  } catch {
    // The control plane may use an event name without a JSON body.
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The control request failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const dashboardStore = new CreatorDashboardStore();

export function useDashboardSnapshot(): DashboardSnapshot {
  return useSyncExternalStore(
    dashboardStore.subscribe,
    dashboardStore.getSnapshot,
    dashboardStore.getSnapshot,
  );
}
