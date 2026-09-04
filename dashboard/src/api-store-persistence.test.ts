import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatorDashboardStore } from "./api-store";
import { dashboardState } from "./test/fixtures";
import { makeTurnRequest } from "./derived";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const accepted = (): Response =>
  json(
    {
      kind: "CreatorWorkAdmission",
      jobId: "job_01",
      conversationId: "conversation_01",
      acceptedAt: "2026-09-04T00:00:00.000Z",
    },
    202,
  );

describe("draft recovery in the same browser tab", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("restores separate conversation and action drafts without making a request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const store = new CreatorDashboardStore(sessionStorage);
    store.updateDraft("conversation_01", {
      text: "Keep this unsent request 🛠️",
      modelId: "openai/gpt-5.6-luna",
    });
    store.updateDraft("conversation_02", { text: "A different context" });
    store.updateActionDraft("review-bound-to-an-event", {
      text: "The HUD needs work",
      memoryCategory: "unresolved",
    });
    const restored = new CreatorDashboardStore(sessionStorage);
    expect(restored.draftFor("conversation_01")).toEqual(store.draftFor("conversation_01"));
    expect(restored.draftFor("conversation_02").text).toBe("A different context");
    expect(restored.actionDraftFor("review-bound-to-an-event")).toEqual({
      text: "The HUD needs work",
      memoryCategory: "unresolved",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries the exact original body after a lost acknowledgement and a page reload", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/control/turn") {
          bodies.push(String(init?.body));
          return bodies.length === 1
            ? Promise.reject(new TypeError("connection lost"))
            : Promise.resolve(accepted());
        }
        return Promise.resolve(json(dashboardState()));
      }),
    );
    const state = dashboardState();
    const request = makeTurnRequest(
      state,
      "follow_up",
      "Keep this exact message.",
      state.modelRegistry.defaultModelId,
    );
    const store = new CreatorDashboardStore(sessionStorage);
    store.updateDraft("conversation_01", { text: request.text, modelId: request.selectedModelId });
    await expect(store.submitTurn(request)).rejects.toThrow("Delivery wasn't confirmed");
    const restored = new CreatorDashboardStore(sessionStorage);
    expect(bodies).toHaveLength(1);
    await restored.submitTurn({
      ...request,
      turnContractId: "new_contract",
      turnContractHash: "f".repeat(64),
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(new CreatorDashboardStore(sessionStorage).draftFor("conversation_01").text).toBe("");
    expect(new CreatorDashboardStore(sessionStorage).getSnapshot().unconfirmedTurns).toEqual([]);
  });

  it("keeps a newer draft when the earlier message is accepted", async () => {
    let resolve: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/control/turn"
          ? new Promise<Response>((done) => {
              resolve = done;
            })
          : Promise.resolve(json(dashboardState())),
      ),
    );
    const state = dashboardState();
    const store = new CreatorDashboardStore(sessionStorage);
    store.updateDraft("conversation_01", { text: "First message" });
    const pending = store.submitTurn(
      makeTurnRequest(state, "follow_up", "First message", state.modelRegistry.defaultModelId),
    );
    store.updateDraft("conversation_01", { text: "Drafting the next message" });
    resolve(accepted());
    await pending;
    expect(new CreatorDashboardStore(sessionStorage).draftFor("conversation_01").text).toBe(
      "Drafting the next message",
    );
  });

  it("keeps writing available and explains when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const store = new CreatorDashboardStore(sessionStorage);
    store.updateDraft("conversation_01", { text: "Do not lose this" });
    expect(store.draftFor("conversation_01").text).toBe("Do not lose this");
    expect(store.getSnapshot().draftStorageError).toContain("Keep this tab open");
  });
});
