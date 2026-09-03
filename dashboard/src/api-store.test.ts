import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorDashboardStore, isDashboardState } from "./api-store";

const catalogSummary = {
  kind: "StudioCatalogSummary",
  catalog: {
    hash: "a".repeat(64),
    source: {
      repository: "https://github.com/Roblox/creator-docs.git",
      commit: "0123456789abcdef",
      engineReferencePath: "content/en-us/reference/engine",
      sourceTreeHash: "b".repeat(64),
    },
    counts: { classes: 638 },
  },
  coverage: {
    hash: "c".repeat(64),
    catalogHash: "a".repeat(64),
    policyHash: "d".repeat(64),
    manifestHash: "e".repeat(64),
    summary: {
      total: 1,
      byDisposition: {},
      byReason: {},
      authorableClasses: 0,
      authorableProperties: 0,
    },
    catalogBinding: "matched",
    manifestBinding: "matched",
  },
  manifest: {
    hash: "e".repeat(64),
    connectorBuildHash: "f".repeat(64),
    classCount: 0,
    writablePropertyCount: 0,
    roots: [],
    operationKinds: [],
  },
};

const capabilityPage = {
  kind: "StudioCapabilityExplorerPage",
  catalogHash: "a".repeat(64),
  coverageHash: "c".repeat(64),
  selection: { query: "anchored" },
  page: { cursor: 0, limit: 40, total: 0 },
  entries: [],
};

const sourceSearchPage = {
  indexId: "studio_source_index_0123456789abcdef",
  indexHash: "1".repeat(64),
  query: "require",
  matches: [
    {
      document: {
        documentId: "workspace:Catalog",
        path: "ReplicatedStorage/Catalog",
        className: "ModuleScript",
        executionContext: "shared",
        sourceHash: "2".repeat(64),
      },
      location: {
        startByte: 0,
        endByte: 7,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 8,
      },
      snippetRange: { startByte: 0, endByte: 20 },
      snippet: "require(Catalog)",
    },
  ],
};

const sourceReadPage = {
  indexId: "studio_source_index_0123456789abcdef",
  indexHash: "1".repeat(64),
  document: {
    documentId: "workspace:Catalog",
    path: "ReplicatedStorage/Catalog",
    className: "ModuleScript",
    executionContext: "shared",
    sourceHash: "2".repeat(64),
  },
  totalUtf8Bytes: 10,
  range: { startByte: 0, endByte: 10 },
  source: "return {}\n",
};

const sourceDependencyPage = {
  indexId: "studio_source_index_0123456789abcdef",
  indexHash: "1".repeat(64),
  root: sourceReadPage.document,
  direction: "closure",
  maxDepth: 16,
  dependencies: [],
  discoveredNodes: [sourceReadPage.document],
  truncated: false,
};

const exactSourceDiffPage = {
  kind: "CreatorExactSourceDiffPage",
  sessionId: "creator_session_source",
  sourceIndex: {
    id: sourceReadPage.indexId,
    hash: sourceReadPage.indexHash,
    snapshotHash: "3".repeat(64),
  },
  changeSet: { id: "creator_change_set_source", hash: "4".repeat(64) },
  operation: {
    id: "edit-source-1",
    document: sourceReadPage.document,
    beforeSourceHash: sourceReadPage.document.sourceHash,
    finalSourceHash: "5".repeat(64),
    finalByteCount: 12,
  },
  edit: {
    ordinal: 0,
    editCount: 1,
    before: {
      totalUtf8Bytes: 4,
      range: { startByte: 0, endByte: 4 },
      source: "old\n",
    },
    replacement: {
      sourceHash: "6".repeat(64),
      totalUtf8Bytes: 4,
      range: { startByte: 0, endByte: 4 },
      source: "new\n",
    },
  },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function dashboardState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "CreatorDashboardState",
    sessions: [],
    pairedStudio: {
      status: "unpaired",
      transactionInventoryStatus: "unavailable",
      message: "Open the Forge connector in Studio to pair this dashboard.",
    },
    stages: [],
    serverTime: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for dashboard state.");
}

describe("CreatorDashboardStore catalog requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a partial dashboard response instead of treating it as actionable state", () => {
    expect(isDashboardState({ kind: "CreatorDashboardState", sessions: [] })).toBe(false);
    expect(
      isDashboardState(
        dashboardState({
          sessions: [
            {
              id: "creator_session_missing_project",
              hash: "a".repeat(64),
              prompt: "Add a door",
              promptHash: "b".repeat(64),
              status: "planning",
              createdAt: "2026-09-03T00:00:00.000Z",
              updatedAt: "2026-09-03T00:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isDashboardState(
        dashboardState({
          pairedStudio: {
            status: "paired",
            projectId: "studio_project_test",
            projectName: "Test",
            capabilities: [],
            manifestHash: "a".repeat(64),
            connectorBuildHash: "b".repeat(64),
            attestationStatus: "verified",
            transactionInventoryStatus: "clear",
            message: "Connected",
          },
        }),
      ),
    ).toBe(true);
  });

  it("observes canonical state after an ambiguous action transport failure without replaying it", async () => {
    let actionPosts = 0;
    let stateReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/control/action" && init?.method === "POST") {
          actionPosts += 1;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (input.startsWith("/api/control/state")) {
          stateReads += 1;
          return Promise.resolve(
            json(dashboardState({ selectedSessionId: "creator_session_observed" })),
          );
        }
        throw new Error(`Unexpected request: ${input}`);
      }),
    );

    const store = new CreatorDashboardStore();
    await expect(store.submit({ action: "start", prompt: "Add a guarded door." })).rejects.toThrow(
      "could not confirm whether this action reached",
    );

    expect(actionPosts).toBe(1);
    expect(stateReads).toBe(1);
    expect(store.getSnapshot().data?.selectedSessionId).toBe("creator_session_observed");
    expect(store.getSnapshot().error).toContain("Forge did not retry it");
    expect(store.getSnapshot().pendingAction).toBeUndefined();
  });

  it("observes canonical state after an explicit post-action state failure without replaying it", async () => {
    let actionPosts = 0;
    let stateReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/control/action" && init?.method === "POST") {
          actionPosts += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                kind: "CreatorControlActionOutcomeUnknown",
                message: "The action completed, but its resulting view failed.",
              }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (input.startsWith("/api/control/state")) {
          stateReads += 1;
          return Promise.resolve(
            json(dashboardState({ selectedSessionId: "creator_session_observed_after_action" })),
          );
        }
        throw new Error(`Unexpected request: ${input}`);
      }),
    );

    const store = new CreatorDashboardStore();
    await expect(store.submit({ action: "start", prompt: "Add a guarded door." })).rejects.toThrow(
      "could not confirm whether this action reached",
    );

    expect(actionPosts).toBe(1);
    expect(stateReads).toBe(1);
    expect(store.getSnapshot().data?.selectedSessionId).toBe(
      "creator_session_observed_after_action",
    );
    expect(store.getSnapshot().error).toContain("Forge did not retry it");
  });

  it("contains a broken store listener without blocking other dashboard subscribers", async () => {
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(dashboardState()));
        if (input === "/api/control/catalog") return Promise.resolve(json(catalogSummary));
        if (input.startsWith("/api/control/capabilities"))
          return Promise.resolve(json(capabilityPage));
        throw new Error(`Unexpected request: ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    let healthyNotifications = 0;
    store.subscribe(() => {
      throw new Error("broken dashboard subscriber");
    });
    store.subscribe(() => {
      healthyNotifications += 1;
    });

    store.start();
    await waitFor(
      () => store.getSnapshot().phase === "ready" && store.getSnapshot().catalog.phase === "ready",
    );

    expect(healthyNotifications).toBeGreaterThan(0);
    expect(store.getSnapshot().data).toMatchObject({ kind: "CreatorDashboardState" });
  });

  it("resyncs state exactly once when the bounded SSE cursor is reset", async () => {
    let emitReset: ((cursor: number) => void) | undefined;
    let stateReads = 0;
    class TestEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | undefined;
      onerror: (() => void) | undefined;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();

      constructor(_url: string) {
        emitReset = (cursor) => this.emitReset(cursor);
      }

      addEventListener(type: string, listener: (event: Event) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emitReset(cursor: number): void {
        const event = {
          data: JSON.stringify({ cursor }),
          lastEventId: String(cursor),
        } as MessageEvent<string> as Event;
        for (const listener of this.listeners.get("reset") ?? []) listener(event);
      }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.startsWith("/api/control/state")) {
          stateReads += 1;
          return Promise.resolve(json(dashboardState()));
        }
        if (input === "/api/control/catalog") return Promise.resolve(json(catalogSummary));
        if (input.startsWith("/api/control/capabilities"))
          return Promise.resolve(json(capabilityPage));
        throw new Error(`Unexpected request: ${input}`);
      }),
    );

    const store = new CreatorDashboardStore();
    store.start();
    await waitFor(() => stateReads === 1 && emitReset !== undefined);
    emitReset?.(257);
    await waitFor(() => stateReads === 2);
    expect(stateReads).toBe(2);
  });

  it("keeps a catalog summary that resolves after an independently requested capability page", async () => {
    const summary = deferred<Response>();
    const page = deferred<Response>();
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(dashboardState()));
        if (input === "/api/control/catalog") return summary.promise;
        if (input.startsWith("/api/control/capabilities")) return page.promise;
        throw new Error(`Unexpected request: ${input}`);
      }),
    );

    const store = new CreatorDashboardStore();
    store.start();
    store.exploreCapabilities({ query: "anchored" });

    page.resolve(json(capabilityPage));
    await waitFor(() => store.getSnapshot().catalog.page !== undefined);
    summary.resolve(json(catalogSummary));
    await waitFor(() => store.getSnapshot().catalog.summary !== undefined);

    const snapshot = store.getSnapshot();
    expect(snapshot.catalog.summary).toEqual(catalogSummary);
    expect(snapshot.catalog.page).toEqual(capabilityPage);
  });

  it("makes a session-bound authenticated GET only after a source explorer action", async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input.startsWith("/api/control/state"))
        return Promise.resolve(
          json(
            dashboardState({
              selectedSessionId: "creator_session_source",
              sessions: [],
            }),
          ),
        );
      if (input === "/api/control/catalog") return Promise.resolve(json(catalogSummary));
      if (input.startsWith("/api/control/capabilities"))
        return Promise.resolve(json(capabilityPage));
      if (input.startsWith("/api/sources/search")) return Promise.resolve(json(sourceSearchPage));
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal("fetch", fetchMock);

    const store = new CreatorDashboardStore();
    store.start();
    await waitFor(() => store.getSnapshot().data?.selectedSessionId === "creator_session_source");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/sources/"))).toBe(
      false,
    );

    store.exploreSources({ operation: "search", query: "require" });
    await waitFor(() => store.getSnapshot().sources.phase === "ready");

    const sourceCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/sources/search"),
    );
    expect(sourceCall).toBeDefined();
    expect(sourceCall?.[0]).toBe(
      "/api/sources/search?sessionId=creator_session_source&query=require&limit=50",
    );
    expect(sourceCall?.[1]).toEqual({
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(store.getSnapshot().sources.result).toEqual({
      operation: "search",
      page: sourceSearchPage,
    });
  });

  it("uses opaque document IDs, not display paths, for exact reads and dependency roots", async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input.startsWith("/api/control/state"))
        return Promise.resolve(
          json(
            dashboardState({
              selectedSessionId: "creator_session_source",
              sessions: [],
            }),
          ),
        );
      if (input === "/api/control/catalog") return Promise.resolve(json(catalogSummary));
      if (input.startsWith("/api/control/capabilities"))
        return Promise.resolve(json(capabilityPage));
      if (input.startsWith("/api/sources/read")) return Promise.resolve(json(sourceReadPage));
      if (input.startsWith("/api/sources/dependencies"))
        return Promise.resolve(json(sourceDependencyPage));
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal("fetch", fetchMock);

    const store = new CreatorDashboardStore();
    store.start();
    await waitFor(() => store.getSnapshot().data?.selectedSessionId === "creator_session_source");

    store.exploreSources({
      operation: "read",
      documentId: "workspace:Catalog",
    });
    await waitFor(() => store.getSnapshot().sources.result?.operation === "read");
    store.exploreSources({
      operation: "dependencies",
      documentId: "workspace:Catalog",
      direction: "closure",
    });
    await waitFor(() => store.getSnapshot().sources.result?.operation === "dependencies");

    const readCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/sources/read"),
    );
    const dependenciesCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/sources/dependencies"),
    );
    expect(readCall?.[0]).toBe(
      "/api/sources/read?sessionId=creator_session_source&documentId=workspace%3ACatalog&limit=32768",
    );
    expect(dependenciesCall?.[0]).toBe(
      "/api/sources/dependencies?sessionId=creator_session_source&documentId=workspace%3ACatalog&direction=closure&maxDepth=16&limit=200",
    );
  });

  it("requests only an authenticated, server-produced sealed source diff", async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input.startsWith("/api/control/state"))
        return Promise.resolve(
          json(
            dashboardState({
              selectedSessionId: "creator_session_source",
              sessions: [],
            }),
          ),
        );
      if (input === "/api/control/catalog") return Promise.resolve(json(catalogSummary));
      if (input.startsWith("/api/control/capabilities"))
        return Promise.resolve(json(capabilityPage));
      if (input.startsWith("/api/sources/diff")) return Promise.resolve(json(exactSourceDiffPage));
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal("fetch", fetchMock);

    const store = new CreatorDashboardStore();
    store.start();
    await waitFor(() => store.getSnapshot().data?.selectedSessionId === "creator_session_source");
    store.exploreSources({
      operation: "diff",
      operationId: "edit-source-1",
      changeSetId: "creator_change_set_source",
    });
    await waitFor(() => store.getSnapshot().sources.result?.operation === "diff");

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/sources/diff"),
    );
    expect(call?.[0]).toBe(
      "/api/sources/diff?sessionId=creator_session_source&operationId=edit-source-1&changeSetId=creator_change_set_source&limit=32768",
    );
    expect(call?.[1]).toEqual({
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(store.getSnapshot().sources.result).toEqual({
      operation: "diff",
      page: exactSourceDiffPage,
    });
  });
});
