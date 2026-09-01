import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorDashboardStore } from "./api-store";

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

  it("keeps a catalog summary that resolves after an independently requested capability page", async () => {
    const summary = deferred<Response>();
    const page = deferred<Response>();
    vi.stubGlobal("EventSource", class EventSource {});
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input.startsWith("/api/control/state"))
        return Promise.resolve(json({ kind: "CreatorDashboardState", sessions: [] }));
      if (input === "/api/control/catalog") return summary.promise;
      if (input.startsWith("/api/control/capabilities")) return page.promise;
      throw new Error(`Unexpected request: ${input}`);
    }));

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
});
