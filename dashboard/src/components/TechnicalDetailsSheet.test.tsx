import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TechnicalDetailsSheet from "./TechnicalDetailsSheet";
import type { CreatorConversationEvent } from "../types";
import { HASH, dashboardState, event } from "../test/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TechnicalDetailsSheet", () => {
  it("is a focus-managed dialog and returns focus to the event that opened it", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open technical details";
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const withAttachment = {
      ...event(),
      attachments: [
        {
          role: "plan",
          label: "Full plan",
          binding: {
            id: "plan_01",
            hash: HASH,
            artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
          },
        },
      ],
    } as CreatorConversationEvent;
    const view = render(
      <TechnicalDetailsSheet
        open
        event={withAttachment}
        state={dashboardState()}
        returnFocusTo={trigger}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /creator message/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "View raw JSON" })).toBeVisible();
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
      ),
    );
    expect(focusable[0]).toHaveFocus();
    const last = focusable.at(-1)!;
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <TechnicalDetailsSheet
        open={false}
        event={withAttachment}
        state={dashboardState()}
        returnFocusTo={trigger}
        onClose={onClose}
      />,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("labels each citation by its actual evidence authority", () => {
    const agent = {
      ...event(),
      authority: "agent",
      eventType: "agent_turn",
      data: {
        turn: {
          id: "turn_agent_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        outcome: "answer",
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
        text: "The door remains anchored.",
        citations: [
          {
            kind: "CreatorCitation",
            id: "citation_01",
            hash: HASH,
            conversationId: "conversation_01",
            issuedForAgentRunId: "agent_run_01",
            handle: "project_fact_01",
            label: "Door anchored property",
            target: {
              kind: "project_fact",
              projectRevisionHash: HASH,
              factKey: "Workspace/Door.Anchored",
              factHash: HASH,
            },
            authority: "forge",
          },
        ],
      },
    } as CreatorConversationEvent;

    render(
      <TechnicalDetailsSheet
        open
        event={agent}
        state={dashboardState()}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Evidence Forge used" })).toBeVisible();
    expect(screen.getByText(/Studio project evidence · Workspace\/Door\.Anchored/)).toBeVisible();
    expect(screen.getByRole("button", { name: "List project source" })).toBeDisabled();
  });

  it("binds source inspection to the selected event's cited immutable source index", async () => {
    const sourceIndexHash = "b".repeat(64);
    const agent = {
      ...event(),
      id: "event_historical_source",
      hash: "c".repeat(64),
      authority: "agent",
      episodeId: "episode_historical",
      eventType: "agent_turn",
      data: {
        turn: {
          id: "turn_agent_source",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        outcome: "answer",
        modelId: "openai/gpt-5.6-luna",
        providerId: "openrouter",
        responseModelId: "openai/gpt-5.6-luna",
        agentRunId: "agent_run_source",
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
        text: "The airlock source is sealed.",
        citations: [
          {
            kind: "CreatorCitation",
            id: "citation_source_01",
            hash: HASH,
            conversationId: "conversation_01",
            issuedForAgentRunId: "agent_run_source",
            handle: "source_range_01",
            label: "Airlock service",
            target: {
              kind: "source_range",
              projectRevisionHash: HASH,
              sourceIndexHash,
              sourceHash: HASH,
              displayPath: "ServerScriptService/Airlock",
              startByte: 0,
              endByte: 24,
            },
            authority: "forge",
          },
        ],
      },
    } as CreatorConversationEvent;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        requests.push(input);
        return Promise.resolve(
          new Response(JSON.stringify({ documents: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    render(
      <TechnicalDetailsSheet
        open
        event={agent}
        state={dashboardState()}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "List project source" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toContain("conversationId=conversation_01");
    expect(requests[0]).toContain("eventId=event_historical_source");
    expect(requests[0]).toContain(`eventHash=${agent.hash}`);
    expect(requests[0]).toContain(`sourceIndexHash=${sourceIndexHash}`);
  });

  it("retains every folded activity boundary in technical details", () => {
    const job = {
      id: "job_01",
      hash: HASH,
      artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
    };
    const reading = {
      ...event(),
      id: "activity_reading",
      eventType: "activity",
      authority: "forge",
      data: {
        job,
        status: "running",
        phase: "Reading project",
        message: "Forge is reading the project index.",
      },
    } as CreatorConversationEvent;
    const planning = {
      ...reading,
      id: "activity_planning",
      sequence: 2,
      data: {
        ...reading.data,
        phase: "Planning",
        message: "Forge is producing the plan.",
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: {
        conversationId: "conversation_01",
        events: [reading, planning],
        complete: true,
      },
    });

    render(
      <TechnicalDetailsSheet
        open
        event={planning}
        state={state}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Run history" })).toBeVisible();
    expect(screen.getByText("Forge is reading the project index.")).toBeVisible();
    expect(screen.getByText("Forge is producing the plan.")).toBeVisible();
  });

  it("does not show an event from a previously selected conversation", () => {
    const oldEvent = event();
    const newState = dashboardState({
      conversations: [
        {
          ...dashboardState().conversations[0],
          id: "conversation_02",
          title: "Newly selected project",
        },
      ],
      selectedConversationId: "conversation_02",
      eventPage: {
        conversationId: "conversation_02",
        events: [event({ conversationId: "conversation_02" })],
        complete: true,
      },
      controlView: {
        ...dashboardState().controlView!,
        conversationId: "conversation_02",
      },
    });

    render(
      <TechnicalDetailsSheet
        open
        event={oldEvent}
        state={newState}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: /project context/i })).toBeVisible();
    expect(screen.queryByText(oldEvent.id)).not.toBeInTheDocument();
  });

  it("offers the sealed revision behind a memory event for inspection", () => {
    const memory = {
      ...event(),
      eventType: "memory",
      data: {
        memoryRevision: {
          id: "memory_revision_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        operation: "forget",
      },
    } as CreatorConversationEvent;

    render(
      <TechnicalDetailsSheet
        open
        event={memory}
        state={dashboardState()}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Sealed memory revision")).toBeVisible();
    expect(screen.getByRole("button", { name: "View raw JSON" })).toBeVisible();
  });

  it("does not mix current control evidence into a selected historical event", () => {
    const historical = {
      ...event(),
      attachments: [
        {
          role: "plan",
          label: "Historical plan",
          binding: {
            id: "historical_plan_01",
            hash: HASH,
            artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
          },
        },
      ],
    } as CreatorConversationEvent;
    const currentHash = "c".repeat(64);
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView!,
        technicalAttachments: [
          {
            role: "technical_detail",
            label: "Current transaction control",
            binding: {
              id: "current_transaction_01",
              hash: currentHash,
              artifact: {
                locator: `artifacts/${currentHash}.json`,
                artifactHash: currentHash,
                bytes: 90,
              },
            },
          },
        ],
      },
    });

    render(
      <TechnicalDetailsSheet
        open
        event={historical}
        state={state}
        returnFocusTo={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Historical plan")).toBeVisible();
    expect(screen.queryByText("Current transaction control")).not.toBeInTheDocument();
  });
});
