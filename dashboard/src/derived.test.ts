import { describe, expect, it } from "vitest";
import { formatTimestamp, makeActionRequest, makeTurnRequest } from "./derived";
import { HASH_B, dashboardState } from "./test/fixtures";

describe("conversation request derivation", () => {
  it("shows time for today and a date without time for older messages", () => {
    const now = new Date(2026, 8, 4, 12);
    const today = new Date(2026, 8, 4, 8, 35);
    const yesterday = new Date(2026, 8, 3, 23, 59);
    expect(formatTimestamp(today.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(today),
    );
    expect(formatTimestamp(yesterday.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(yesterday),
    );
    const previousYear = new Date(2025, 8, 4);
    expect(formatTimestamp(previousYear.toISOString(), now)).toContain("2025");
  });
  it("preserves every creator-message byte while rejecting whitespace-only text", () => {
    const state = dashboardState();
    const text = "  Keep this exact line.\n";
    const request = makeTurnRequest(state, "follow_up", text, "openai/gpt-5.6-luna");

    expect(request.text).toBe(text);
    expect(() => makeTurnRequest(state, "follow_up", " \n ", "openai/gpt-5.6-luna")).toThrow(
      "non-whitespace",
    );
  });

  it("requires and preserves an exact coordinator-produced memory head target", () => {
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_pin_memory",
            actionId: "pin_memory",
            label: "Pin",
            intent: "secondary",
            controlViewId: "control_01",
            authorizingEventId: "event_01",
            authorizingEventHash: HASH_B,
            target: "memory_head",
            input: { kind: "none" },
          },
        ],
      },
    });
    const action = state.controlView!.actions[0]!;
    const target = {
      kind: "memory_head" as const,
      itemId: "memory_item_01",
      revisionId: "memory_revision_01",
      revisionHash: HASH_B,
    };

    expect(makeActionRequest(state, action, "", { target }).target).toEqual(target);
    expect(() => makeActionRequest(state, action, "")).toThrow("exact current memory revision");
  });

  it("preserves creator report bytes instead of normalizing a final decision", () => {
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_keep",
            actionId: "keep_changes",
            label: "Keep changes",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: "event_01",
            authorizingEventHash: HASH_B,
            target: "none",
            input: {
              kind: "text",
              field: "report",
              label: "What did you observe?",
              minimumBytes: 1,
              maximumBytes: 4096,
              multiline: true,
            },
          },
        ],
      },
    });
    const report = "  It worked in Play mode.\n";

    expect(makeActionRequest(state, state.controlView!.actions[0]!, report).input).toEqual({
      report,
    });
  });

  it("binds plan refinement to the creator-selected available model and exact registry", () => {
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_revise",
            actionId: "revise_plan",
            label: "Change the plan",
            intent: "secondary",
            controlViewId: "control_01",
            authorizingEventId: "event_01",
            authorizingEventHash: HASH_B,
            target: "none",
            input: {
              kind: "text",
              field: "message",
              label: "What should change?",
              minimumBytes: 1,
              maximumBytes: 65_536,
              multiline: true,
            },
          },
        ],
      },
    });

    expect(
      makeActionRequest(state, state.controlView!.actions[0]!, "Keep the outer door closed.", {
        selectedModelId: "openai/gpt-5.6-luna",
      }).input,
    ).toEqual({
      text: "Keep the outer door closed.",
      selectedModelId: "openai/gpt-5.6-luna",
      modelRegistryHash: state.modelRegistry.hash,
    });
    expect(() =>
      makeActionRequest(state, state.controlView!.actions[0]!, "Try again.", {
        selectedModelId: "unknown/model",
      }),
    ).toThrow("available model");
  });
});
