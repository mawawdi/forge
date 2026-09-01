import { useSyncExternalStore } from "react";
import type {
  CapabilityExplorerSnapshot,
  CreatorDashboardState,
  DashboardActionRequest,
  DashboardSnapshot,
  StudioCapabilityExplorerPage,
  StudioCatalogSummary,
} from "./types";

const INITIAL_SNAPSHOT: DashboardSnapshot = {
  phase: "loading",
  catalog: { phase: "loading" },
};
const JSON_HEADERS = { "Content-Type": "application/json" };
const MAX_ATTESTATION_FINDINGS = 32;

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
    void this.refresh();
  };

  submit = async (action: DashboardActionRequest): Promise<void> => {
    const pendingAction = action.action === "start" ? "start" : action.actionId;
    this.setSnapshot({ ...this.snapshot, pendingAction });
    try {
      const response = await fetch("/api/control/action", {
        method: "POST",
        credentials: "same-origin",
        headers: JSON_HEADERS,
        body: JSON.stringify(action),
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(readError(value, response.status));
      if (isDashboardState(value)) {
        this.selectedSessionId = value.selectedSessionId ?? this.selectedSessionId;
        this.setSnapshot({ ...this.snapshot, phase: "ready", data: value });
      } else {
        await this.refresh();
      }
    } catch (error) {
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

  exploreCapabilities = (input: {
    className?: string;
    query?: string;
    cursor?: number;
  }): void => {
    void this.refreshCapabilities(input);
  };

  private connectEvents(): void {
    this.eventSource = new EventSource(`/api/control/events?after=${this.cursor}`);
    this.eventSource.onmessage = (event) => {
      this.cursor = readCursor(event.data, event.lastEventId, this.cursor);
      this.invalidations += 1;
      void this.consumeInvalidations();
    };
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
      if (!isDashboardState(value)) throw new Error("The control plane returned an invalid dashboard state.");
      this.selectedSessionId = value.selectedSessionId ?? this.selectedSessionId;
      this.setSnapshot({ ...this.snapshot, phase: "ready", data: value });
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

  private setCatalog(value: CapabilityExplorerSnapshot): void {
    this.setSnapshot({ ...this.snapshot, catalog: value });
  }

  private setSnapshot(value: DashboardSnapshot): void {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
}

function isDashboardState(value: unknown): value is CreatorDashboardState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "CreatorDashboardState" &&
    Array.isArray(candidate.sessions) &&
    (candidate.pairedStudio === undefined || isPairedStudioState(candidate.pairedStudio))
  );
}

function isPairedStudioState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.status !== "paired" &&
    value.status !== "unpaired" &&
    value.status !== "connecting"
  ) return false;
  if (typeof value.message !== "string") return false;
  return value.attestation === undefined || isAttestationSummary(value.attestation);
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
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return false;
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
  ) return true;
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
