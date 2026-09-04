import type { Page } from "@playwright/test";
import type { CreatorConversationEvent, CreatorDashboardState } from "../src/types";
import { HASH, HASH_B, dashboardState, event } from "../src/test/fixtures";

export interface DashboardApi {
  state: CreatorDashboardState;
  readonly turns: unknown[];
  readonly actions: unknown[];
  readonly renames: { scope: "project" | "conversation"; conversationId: string; name: string }[];
  readonly replays: { readonly kind: "verification" | "mutation"; readonly id: string }[];
  historyFailure?: { readonly status: number; readonly detail: string };
  turnGate?: Promise<void>;
  actionGate?: Promise<void>;
}

export function conversationState(overrides: Record<string, unknown> = {}): CreatorDashboardState {
  const creator = event();
  const answer: CreatorConversationEvent = {
    ...event(),
    id: "event_answer",
    hash: HASH_B,
    sequence: 2,
    authority: "agent",
    episodeId: "episode_historical",
    eventType: "agent_turn",
    attachments: [
      {
        role: "verification",
        label: "Verification evidence",
        binding: {
          id: "verification_01",
          hash: HASH_B,
          artifact: { locator: `artifacts/${HASH_B}.json`, artifactHash: HASH_B, bytes: 90 },
        },
      },
    ],
    data: {
      turn: {
        id: "turn_agent_01",
        hash: HASH_B,
        artifact: { locator: `artifacts/${HASH_B}.json`, artifactHash: HASH_B, bytes: 90 },
      },
      outcome: "answer",
      text: "The existing airlock routes power through a server-owned module. I can preserve that boundary.",
      modelId: "openai/gpt-5.6-luna",
      providerId: "openrouter",
      responseModelId: "openai/gpt-5.6-luna",
      agentRunId: "agent_run_01",
      timing: {
        startedAt: "2026-09-03T00:00:00.000Z",
        endedAt: "2026-09-03T00:00:01.000Z",
        durationMs: 1000,
      },
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0,
      },
      citations: [
        {
          kind: "CreatorCitation",
          id: "citation_airlock_source",
          hash: HASH_B,
          conversationId: "conversation_01",
          issuedForAgentRunId: "agent_run_01",
          handle: "source_range_airlock",
          label: "Airlock server module",
          target: {
            kind: "source_range",
            projectRevisionHash: HASH,
            sourceIndexHash: HASH,
            sourceHash: HASH,
            displayPath: "ServerScriptService/Airlock.server.lua",
            startByte: 0,
            endByte: 29,
          },
          authority: "forge",
        },
      ],
    },
  } as CreatorConversationEvent;
  const plan: CreatorConversationEvent = {
    ...event(),
    id: "event_plan",
    hash: "c".repeat(64),
    sequence: 3,
    authority: "agent",
    eventType: "plan_revision",
    data: {
      planRevision: {
        id: "plan_01",
        hash: HASH,
        artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
      },
      revision: 1,
      summary:
        "1. Add an interaction to the airlock console.\n\n2. Validate requests on the server and preserve the existing alarm.\n\nChecks\n- Check Luau syntax and the new prompt.\n\nYour review\n- Try the interaction and review the warning light in Studio.",
    },
    attachments: [
      {
        role: "plan",
        label: "Plan revision",
        binding: {
          id: "plan_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
      },
      {
        role: "verification",
        label: "Verification evidence",
        binding: {
          id: "verification_01",
          hash: HASH_B,
          artifact: { locator: `artifacts/${HASH_B}.json`, artifactHash: HASH_B, bytes: 90 },
        },
      },
      {
        role: "mutation",
        label: "Mutation evidence",
        binding: {
          id: "mutation_01",
          hash: "d".repeat(64),
          artifact: {
            locator: `artifacts/${"d".repeat(64)}.json`,
            artifactHash: "d".repeat(64),
            bytes: 90,
          },
        },
      },
    ],
  } as CreatorConversationEvent;
  return dashboardState({
    eventPage: {
      conversationId: "conversation_01",
      events: [creator, answer, plan],
      nextBeforeCursor: "before_event_01",
      complete: false,
    },
    controlView: {
      ...dashboardState().controlView,
      eventSequence: 3,
      actions: [
        {
          actionInstanceId: "action_new_conversation",
          actionId: "new_conversation",
          label: "New conversation",
          intent: "secondary",
          controlViewId: "control_01",
          authorizingEventId: "event_plan",
          authorizingEventHash: "c".repeat(64),
          target: "none",
          input: { kind: "none" },
        },
        {
          actionInstanceId: "action_build",
          actionId: "build_plan",
          label: "Accept plan",
          intent: "primary",
          controlViewId: "control_01",
          authorizingEventId: "event_plan",
          authorizingEventHash: "c".repeat(64),
          target: "none",
          input: { kind: "none" },
        },
        {
          actionInstanceId: "action_revise",
          actionId: "revise_plan",
          label: "Change the plan",
          intent: "secondary",
          controlViewId: "control_01",
          authorizingEventId: "event_plan",
          authorizingEventHash: "c".repeat(64),
          target: "none",
          input: {
            kind: "text",
            field: "message",
            label: "What should change?",
            minimumBytes: 1,
            maximumBytes: 4096,
            multiline: true,
          },
        },
        {
          actionInstanceId: "action_reject",
          actionId: "reject_plan",
          label: "Reject plan",
          intent: "danger",
          controlViewId: "control_01",
          authorizingEventId: "event_plan",
          authorizingEventHash: "c".repeat(64),
          target: "none",
          input: { kind: "none" },
        },
      ],
    },
    ...overrides,
  }) as CreatorDashboardState;
}

export function createDashboardApi(state = conversationState()): DashboardApi {
  return { state, turns: [], actions: [], renames: [], replays: [] };
}

/** All browser coverage uses this local response double; no call reaches Studio or a model provider. */
export async function installDashboardApi(page: Page, api: DashboardApi): Promise<void> {
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(_url: string) {
        super();
        window.addEventListener("fixture-update", () => {
          this.onmessage?.(new MessageEvent("message", { data: "{}" }));
        });
        window.addEventListener("fixture-disconnect", () => {
          this.readyState = 0;
          this.onerror?.();
        });
        window.addEventListener("fixture-reconnect", () => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
  });
  await page.route("**/api/control/state**", async (route) => {
    await route.fulfill(json(api.state));
  });
  await page.route("**/api/conversations/*/events**", async (route) => {
    if (api.historyFailure) {
      await route.fulfill({
        status: api.historyFailure.status,
        contentType: "application/json",
        body: JSON.stringify({ detail: api.historyFailure.detail }),
      });
      return;
    }
    await route.fulfill(
      json({
        conversationId: "conversation_01",
        events: [event()],
        complete: true,
      }),
    );
  });
  await page.route("**/api/control/rename", async (route) => {
    const request = route.request().postDataJSON() as DashboardApi["renames"][number];
    api.renames.push(request);
    const project = api.state.conversations.find(
      (item) => item.id === request.conversationId,
    )?.project;
    api.state = {
      ...api.state,
      conversations: api.state.conversations.map((item) =>
        request.scope === "project" && JSON.stringify(item.project) === JSON.stringify(project)
          ? { ...item, projectName: request.name }
          : request.scope === "conversation" && item.id === request.conversationId
            ? { ...item, title: request.name }
            : item,
      ),
    };
    await route.fulfill(json({ name: request.name }));
  });
  await page.route("**/api/control/turn", async (route) => {
    api.turns.push(route.request().postDataJSON());
    await api.turnGate;
    await route.fulfill(
      json(
        {
          kind: "CreatorWorkAdmission",
          jobId: "job_turn_01",
          conversationId: "conversation_01",
          acceptedAt: "2026-09-03T00:00:01.000Z",
        },
        202,
      ),
    );
  });
  await page.route("**/api/control/action", async (route) => {
    api.actions.push(route.request().postDataJSON());
    await api.actionGate;
    await route.fulfill(
      json(
        {
          kind: "CreatorWorkAdmission",
          jobId: "job_action_01",
          conversationId: "conversation_01",
          acceptedAt: "2026-09-03T00:00:01.000Z",
        },
        202,
      ),
    );
  });
  await page.route("**/api/sources/documents**", async (route) => {
    await route.fulfill(
      json({
        indexId: "source_index_01",
        indexHash: HASH,
        documents: [
          {
            documentId: "document_01",
            path: "ServerScriptService/Airlock.server.lua",
            className: "Script",
            executionContext: "server",
            sourceHash: HASH,
          },
        ],
      }),
    );
  });
  await page.route("**/api/sources/read**", async (route) => {
    await route.fulfill(
      json({
        document: { documentId: "document_01" },
        source: "local Airlock = {}\nreturn Airlock",
        range: { startByte: 0, endByte: 29 },
      }),
    );
  });
  await page.route("**/api/sources/search**", async (route) => {
    await route.fulfill(
      json({
        matches: [
          {
            document: { path: "ServerScriptService/Airlock.server.lua" },
            location: { startLine: 1 },
            snippet: "local Airlock = {}",
          },
        ],
      }),
    );
  });
  await page.route("**/api/sources/symbols**", async (route) => {
    await route.fulfill(
      json({
        symbols: [
          {
            id: "symbol_01",
            name: "Airlock",
            kind: "local",
            document: { path: "ServerScriptService/Airlock.server.lua" },
            location: { startLine: 1 },
          },
        ],
      }),
    );
  });
  await page.route("**/api/sources/references**", async (route) => {
    await route.fulfill(
      json({
        references: [
          {
            id: "reference_01",
            name: "Airlock",
            role: "reference",
            document: { path: "ServerScriptService/Airlock.server.lua" },
            location: { startLine: 1 },
          },
        ],
      }),
    );
  });
  await page.route("**/api/sources/dependencies**", async (route) => {
    await route.fulfill(
      json({
        dependencies: [
          {
            id: "dependency_01",
            source: { path: "ServerScriptService/Airlock.server.lua" },
            target: { path: "ReplicatedStorage/AirlockConfig.lua" },
            resolution: "resolved",
          },
        ],
      }),
    );
  });
  await page.route("**/api/sources/diff**", async (route) => {
    await route.fulfill(
      json({
        edit: {
          before: { source: "local open = false" },
          replacement: { source: "local open = true" },
        },
      }),
    );
  });
  await page.route("**/api/control/catalog", async (route) => {
    await route.fulfill(
      json({
        coverage: {
          summary: { total: 9685, authorableClasses: 33, authorableProperties: 364 },
        },
      }),
    );
  });
  await page.route("**/api/control/capabilities**", async (route) => {
    await route.fulfill(
      json({
        page: { cursor: 0, limit: 20, total: 1 },
        entries: [
          {
            catalogEntryId: "class_member:ProximityPrompt:property:ActionText",
            owner: "ProximityPrompt",
            name: "ActionText",
            entryKind: "property",
            disposition: "authorable",
            reason: "proof_closed",
          },
        ],
      }),
    );
  });
  await page.route("**/api/verifications/*/replay", async (route) => {
    const id = route.request().url().split("/").at(-2) ?? "unknown";
    api.replays.push({
      kind: "verification",
      id,
    });
    await route.fulfill(json({ status: "exact", id }));
  });
  await page.route("**/api/mutations/*/replay", async (route) => {
    const id = route.request().url().split("/").at(-2) ?? "unknown";
    api.replays.push({
      kind: "mutation",
      id,
    });
    await route.fulfill(json({ status: "exact", id }));
  });
  await page.route("**/api/artifacts/*", async (route) => {
    await route.fulfill(json({ kind: "sealed evidence", hash: HASH }));
  });
}

function json(value: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}
