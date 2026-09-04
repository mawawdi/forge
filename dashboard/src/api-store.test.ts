import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorDashboardStore, isDashboardState } from "./api-store";
import { makeTurnRequest } from "./derived";
import { HASH_B, dashboardState, event } from "./test/fixtures";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CreatorDashboardStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the conversation read model, not a partial control response", () => {
    expect(isDashboardState({ kind: "CreatorDashboardState", conversations: [] })).toBe(false);
    expect(isDashboardState(dashboardState())).toBe(true);
  });

  it("posts a hash-bound turn once and clears its draft only after a 202 admission", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/control/turn") {
          requests.push(JSON.parse(String(init?.body)));
          return Promise.resolve(
            json(
              {
                kind: "CreatorWorkAdmission",
                jobId: "job_01",
                conversationId: "conversation_01",
                acceptedAt: "2026-09-03T00:00:01.000Z",
              },
              202,
            ),
          );
        }
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(dashboardState()));
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    store.updateDraft("conversation_01", {
      text: "Add a safe door.",
      modelId: "openai/gpt-5.6-luna",
    });

    await store.submitTurn({
      conversationId: "conversation_01",
      turnContractId: "turn_contract_01",
      turnContractHash: HASH_B,
      turnKind: "follow_up",
      text: "Add a safe door.",
      selectedModelId: "openai/gpt-5.6-luna",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "CreatorTurnRequest",
      turnContractHash: HASH_B,
      turnKind: "follow_up",
      selectedModelId: "openai/gpt-5.6-luna",
    });
    expect(store.draftFor("conversation_01").text).toBe("");
    expect(store.draftFor("conversation_01").modelId).toBe("openai/gpt-5.6-luna");
  });

  it("keeps an unsent draft after an explicit rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ message: "Model unavailable" }, 409))),
    );
    const store = new CreatorDashboardStore();
    store.updateDraft("conversation_01", { text: "Keep this request." });

    await expect(
      store.submitTurn({
        conversationId: "conversation_01",
        turnContractId: "turn_contract_01",
        turnContractHash: HASH_B,
        turnKind: "follow_up",
        text: "Keep this request.",
        selectedModelId: "openai/gpt-5.6-luna",
      }),
    ).rejects.toThrow("Model unavailable");

    expect(store.draftFor("conversation_01").text).toBe("Keep this request.");
  });

  it("refreshes stale actions without resubmitting or losing the draft", async () => {
    const requests: string[] = [];
    const latest = dashboardState();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        requests.push(input);
        if (input === "/api/control/action")
          return Promise.resolve(
            json({ message: "Creator action became stale before durable admission" }, 400),
          );
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(latest));
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    store.updateActionDraft("action:action_01", { text: "Keep this revision." });
    await expect(
      store.submitAction({
        conversationId: "conversation_01",
        viewId: "control_01",
        viewHash: HASH_B,
        actionInstanceId: "action_01",
        input: {},
      }),
    ).rejects.toThrow(
      "This conversation changed while your request was being sent. Please try again.",
    );
    expect(requests).toEqual(["/api/control/action", "/api/control/state"]);
    expect(store.getSnapshot().data).toEqual(latest);
    expect(store.getSnapshot().pendingRequest).toBeUndefined();
    expect(store.actionDraftFor("action:action_01").text).toBe("Keep this revision.");
    expect(store.getSnapshot().unconfirmedTurns).toEqual([]);
  });

  it("requires an exact 202 before clearing an admitted turn draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({
            kind: "CreatorWorkAdmission",
            jobId: "job_01",
            conversationId: "conversation_01",
            acceptedAt: "2026-09-03T00:00:01.000Z",
          }),
        ),
      ),
    );
    const store = new CreatorDashboardStore();
    store.updateDraft("conversation_01", { text: "Retain this until an exact admission." });

    await expect(
      store.submitTurn({
        conversationId: "conversation_01",
        turnContractId: "turn_contract_01",
        turnContractHash: HASH_B,
        turnKind: "follow_up",
        text: "Retain this until an exact admission.",
        selectedModelId: "openai/gpt-5.6-luna",
      }),
    ).rejects.toThrow("couldn't confirm this request");

    expect(store.draftFor("conversation_01").text).toBe("Retain this until an exact admission.");
  });

  it("rejects a malformed 202 admission through the shared browser contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json(
            {
              kind: "CreatorWorkAdmission",
              jobId: "",
              conversationId: "conversation_01",
              acceptedAt: "not-a-time",
            },
            202,
          ),
        ),
      ),
    );
    const store = new CreatorDashboardStore();
    store.updateDraft("conversation_01", { text: "Retain malformed admissions." });

    await expect(
      store.submitTurn({
        conversationId: "conversation_01",
        turnContractId: "turn_contract_01",
        turnContractHash: HASH_B,
        turnKind: "follow_up",
        text: "Retain malformed admissions.",
        selectedModelId: "openai/gpt-5.6-luna",
      }),
    ).rejects.toThrow("incomplete confirmation");

    expect(store.draftFor("conversation_01").text).toBe("Retain malformed admissions.");
  });

  it("retries the original turn after a lost admission refreshes its contract", async () => {
    const requests: string[] = [];
    const jobs = new Map<string, string>();
    let stateReads = 0;
    const initial = dashboardState();
    const refreshed = dashboardState({
      controlView: {
        ...initial.controlView!,
        id: "control_after_job",
        hash: "c".repeat(64),
        turnContract: {
          ...initial.controlView!.turnContract!,
          id: "contract_after_job",
          hash: "d".repeat(64),
          allowedTurnTypes: ["new_work"],
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/control/turn") {
          const body = String(init?.body);
          const request = JSON.parse(body) as { idempotencyKey: string };
          requests.push(body);
          const existingJob = jobs.get(request.idempotencyKey);
          if (existingJob)
            return Promise.resolve(
              json(
                {
                  kind: "CreatorWorkAdmission",
                  jobId: existingJob,
                  conversationId: "conversation_01",
                  acceptedAt: "2026-09-03T00:00:01.000Z",
                },
                202,
              ),
            );
          jobs.set(request.idempotencyKey, "job_01");
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (input.startsWith("/api/control/state")) {
          stateReads += 1;
          return Promise.resolve(json(refreshed));
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    const input = {
      conversationId: "conversation_01",
      turnContractId: "turn_contract_01",
      turnContractHash: HASH_B,
      turnKind: "follow_up" as const,
      text: "Keep this exact request.",
      selectedModelId: "openai/gpt-5.6-luna",
    };
    store.updateDraft("conversation_01", { text: input.text });

    await expect(store.submitTurn(input)).rejects.toThrow("Delivery wasn't confirmed");
    expect(store.draftFor("conversation_01").text).toBe(input.text);
    await waitFor(() => stateReads === 1 && store.getSnapshot().data !== undefined);
    expect(store.getSnapshot().data!.controlView!.turnContract!.id).toBe("contract_after_job");
    expect(
      store.unconfirmedTurnFor(input.conversationId, input.text, input.selectedModelId),
    ).toMatchObject({ turnContractId: input.turnContractId });

    await store.submitTurn(
      makeTurnRequest(store.getSnapshot().data!, "new_work", input.text, input.selectedModelId),
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(jobs).toHaveLength(1);
    expect(store.draftFor("conversation_01").text).toBe("");
    expect(store.getSnapshot().unconfirmedTurns).toEqual([]);
  });

  it("retries an exact message without a current contract and preserves an edited draft", async () => {
    const original = dashboardState();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith("/api/control/state"))
          return Promise.resolve(
            json(
              dashboardState({
                controlView: { ...original.controlView, turnContract: undefined },
              }),
            ),
          );
        requests.push(String(init?.body));
        if (requests.length === 1) return Promise.reject(new TypeError("Lost response"));
        return Promise.resolve(
          json(
            {
              kind: "CreatorWorkAdmission",
              jobId: "job_01",
              conversationId: "conversation_01",
              acceptedAt: "2026-09-03T00:00:01.000Z",
            },
            202,
          ),
        );
      }),
    );
    const store = new CreatorDashboardStore();
    const input = makeTurnRequest(
      original,
      "follow_up",
      "Original message.",
      original.modelRegistry.defaultModelId,
    );
    await expect(store.submitTurn(input)).rejects.toThrow("Delivery wasn't confirmed");
    await waitFor(() => store.getSnapshot().data !== undefined);
    store.updateDraft("conversation_01", { text: "My next message." });
    const retained = store.getSnapshot().unconfirmedTurns![0]!;
    await store.retryTurn(retained.idempotencyKey);
    expect(requests[1]).toBe(requests[0]);
    expect(store.draftFor("conversation_01").text).toBe("My next message.");
  });

  it("shows the server's actionable rejection message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json(
            {
              kind: "CreatorControlError",
              message: "Selected model is unavailable: missing tools support",
            },
            400,
          ),
        ),
      ),
    );
    const state = dashboardState();
    const store = new CreatorDashboardStore();
    await expect(
      store.submitTurn(
        makeTurnRequest(
          state,
          "follow_up",
          "Explain this project.",
          state.modelRegistry.defaultModelId,
        ),
      ),
    ).rejects.toThrow("Selected model is unavailable: missing tools support");
    expect(store.getSnapshot().error).toBe("Selected model is unavailable: missing tools support");
    expect(store.getSnapshot().unconfirmedTurns).toEqual([]);
  });

  it("preserves an edited draft when the earlier turn is the one admitted", async () => {
    let resolveAdmission!: (response: Response) => void;
    const admission = new Promise<Response>((resolve) => {
      resolveAdmission = resolve;
    });
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input === "/api/control/turn") {
          posts += 1;
          return admission;
        }
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(dashboardState()));
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    const input = {
      conversationId: "conversation_01",
      turnContractId: "turn_contract_01",
      turnContractHash: HASH_B,
      turnKind: "follow_up" as const,
      text: "Original draft.",
      selectedModelId: "openai/gpt-5.6-luna",
    };
    store.updateDraft("conversation_01", { text: input.text });
    const submitted = store.submitTurn(input);
    await waitFor(() => posts === 1);
    store.updateDraft("conversation_01", { text: "Edited draft." });
    resolveAdmission(
      json(
        {
          kind: "CreatorWorkAdmission",
          jobId: "job_01",
          conversationId: "conversation_01",
          acceptedAt: "2026-09-03T00:00:01.000Z",
        },
        202,
      ),
    );

    await submitted;

    expect(store.draftFor("conversation_01").text).toBe("Edited draft.");
  });

  it("keeps an unconfirmed report request distinct from changed report text", async () => {
    const requests: string[] = [];
    const jobs = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input !== "/api/control/action") throw new Error(`Unexpected request ${input}`);
        const body = String(init?.body);
        const request = JSON.parse(body) as { idempotencyKey: string };
        requests.push(body);
        const existingJob = jobs.get(request.idempotencyKey);
        if (existingJob)
          return Promise.resolve(
            json(
              {
                kind: "CreatorWorkAdmission",
                jobId: existingJob,
                conversationId: "conversation_01",
                acceptedAt: "2026-09-03T00:00:01.000Z",
              },
              202,
            ),
          );
        jobs.set(request.idempotencyKey, `job_${jobs.size + 1}`);
        if (requests.length === 1) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(
          json(
            {
              kind: "CreatorWorkAdmission",
              jobId: jobs.get(request.idempotencyKey),
              conversationId: "conversation_01",
              acceptedAt: "2026-09-03T00:00:01.000Z",
            },
            202,
          ),
        );
      }),
    );
    const store = new CreatorDashboardStore();
    const first = {
      conversationId: "conversation_01",
      viewId: "control_01",
      viewHash: HASH_B,
      actionInstanceId: "action_01",
      input: { report: "Keep the original report." },
    };
    const changed = { ...first, input: { report: "Use this edited report instead." } };
    store.updateActionDraft("action:action_01", { text: first.input.report });

    await expect(store.submitAction(first)).rejects.toThrow("Delivery wasn't confirmed");
    expect(store.actionDraftFor("action:action_01").text).toBe(first.input.report);
    store.updateActionDraft("action:action_01", { text: changed.input.report });

    await store.submitAction(changed);
    await store.submitAction(first);

    expect(requests).toHaveLength(3);
    expect(JSON.parse(requests[1]!)).toMatchObject({ input: changed.input });
    expect(JSON.parse(requests[1]!).idempotencyKey).not.toBe(
      JSON.parse(requests[0]!).idempotencyKey,
    );
    expect(requests[2]).toBe(requests[0]);
    expect(jobs).toHaveLength(2);
  });

  it("marks disconnected activity as stale and refreshes on reconnect without losing drafts", async () => {
    const streams: EventSourceStub[] = [];
    class EventSourceStub {
      readyState = 1;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      constructor(_url: string) {
        streams.push(this);
      }
      addEventListener(_name: string, _listener: EventListener): void {}
    }
    vi.stubGlobal("EventSource", EventSourceStub);
    const fetch = vi.fn(async () => json(dashboardState()));
    vi.stubGlobal("fetch", fetch);
    const store = new CreatorDashboardStore();
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().phase).toBe("ready"));
    const stream = streams[0]!;
    store.updateDraft("conversation_01", { text: "Keep my draft." });
    stream.readyState = 0;
    stream.onerror?.();
    expect(store.getSnapshot().connectionLost).toBe(true);
    expect(store.getSnapshot().data).toBeDefined();
    stream.readyState = 1;
    stream.onopen?.();
    await vi.waitFor(() => expect(store.getSnapshot().connectionLost).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.draftFor("conversation_01").text).toBe("Keep my draft.");
    stream.readyState = 2;
    stream.onerror?.();
    expect(store.getSnapshot().connectionLost).toBe(true);
    expect(store.getSnapshot().error).toContain("latest dashboard link");
    expect(store.draftFor("conversation_01").text).toBe("Keep my draft.");
  });

  it("runs a queued conversation selection refresh after an in-flight refresh", async () => {
    class EventSourceStub {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {}
      addEventListener(_name: string, _listener: EventListener): void {}
    }
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requests.push(input);
        if (requests.length === 1) await firstGate;
        if (!input.includes("conversation_02")) return json(dashboardState());
        const second = dashboardState();
        return json({
          ...second,
          conversations: second.conversations.map((conversation) => ({
            ...conversation,
            id: "conversation_02",
          })),
          selectedConversationId: "conversation_02",
          eventPage: {
            conversationId: "conversation_02",
            events: [event({ conversationId: "conversation_02" })],
            complete: true,
          },
          controlView: {
            ...second.controlView!,
            conversationId: "conversation_02",
            turnContract: {
              ...second.controlView!.turnContract!,
              conversationId: "conversation_02",
            },
          },
        });
      }),
    );
    const store = new CreatorDashboardStore();
    store.start();
    store.selectConversation("conversation_02");
    releaseFirst();

    await waitFor(() => requests.length === 2);
    expect(requests[1]).toContain("conversationId=conversation_02");
    await waitFor(() => store.getSnapshot().data?.selectedConversationId === "conversation_02");
    expect(store.getSnapshot().data?.selectedConversationId).toBe("conversation_02");
  });

  it("keeps loaded history when a live snapshot invalidates the conversation", async () => {
    class EventSourceStub {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {}
      addEventListener(_name: string, _listener: EventListener): void {}
    }
    const newest = { ...event(), id: "event_02", sequence: 2 };
    const current = dashboardState({
      eventPage: {
        conversationId: "conversation_01",
        events: [newest],
        nextBeforeCursor: "before_01",
        complete: false,
      },
    });
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.startsWith("/api/control/state")) return Promise.resolve(json(current));
        if (input.includes("/api/conversations/conversation_01/events")) {
          return Promise.resolve(
            json({
              conversationId: "conversation_01",
              events: [event()],
              complete: true,
            }),
          );
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const store = new CreatorDashboardStore();
    store.start();
    await waitFor(() => store.getSnapshot().data?.eventPage?.events.length === 1);
    store.loadPreviousEvents();
    await waitFor(() => store.getSnapshot().data?.eventPage?.events.length === 2);

    expect(store.getSnapshot().data?.eventPage?.events.map((entry) => entry.sequence)).toEqual([
      1, 2,
    ]);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the dashboard store.");
}
