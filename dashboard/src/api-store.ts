import { useSyncExternalStore } from "react";
import type {
  CreatorDashboardState,
  DashboardActionRequest,
  DashboardSnapshot,
} from "./types";

const INITIAL_SNAPSHOT: DashboardSnapshot = { phase: "loading" };
const JSON_HEADERS = { "Content-Type": "application/json" };

class CreatorDashboardStore {
  private snapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private selectedSessionId: string | undefined;
  private eventSource: EventSource | undefined;
  private cursor = 0;
  private invalidations = 0;
  private refreshing = false;
  private refreshAgain = false;
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
        this.setSnapshot({ phase: "ready", data: value });
      } else {
        await this.refresh();
      }
    } catch (error) {
      this.setSnapshot({
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
    this.setSnapshot({ phase: "loading", ...(previous ? { data: previous } : {}) });
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
      this.setSnapshot({ phase: "ready", data: value });
    } catch (error) {
      this.setSnapshot({
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

  private setSnapshot(value: DashboardSnapshot): void {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
}

function isDashboardState(value: unknown): value is CreatorDashboardState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "CreatorDashboardState" && Array.isArray(candidate.sessions);
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

export const dashboardStore = new CreatorDashboardStore();

export function useDashboardSnapshot(): DashboardSnapshot {
  return useSyncExternalStore(
    dashboardStore.subscribe,
    dashboardStore.getSnapshot,
    dashboardStore.getSnapshot,
  );
}
