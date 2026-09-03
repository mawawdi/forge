import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardStore } from "../api-store";
import type { CreatorDashboardState } from "../types";
import { HASH_B, dashboardState } from "../test/fixtures";
import { ProjectSettings } from "./ProjectSettings";

describe("ProjectSettings memory controls", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the exact current memory head when it submits a coordinator-authorized pin", async () => {
    const submit = vi.spyOn(dashboardStore, "submitAction").mockResolvedValue();
    const state = dashboardState({
      memories: [
        {
          itemId: "memory_item_01",
          revisionId: "memory_revision_01",
          revisionHash: HASH_B,
          category: "convention",
          text: "Keep all remotes server-owned.",
          pinned: false,
          state: "active",
        },
      ],
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
    }) as CreatorDashboardState;

    render(
      <ProjectSettings
        state={state}
        open={true}
        returnFocusTo={undefined}
        onClose={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      actionInstanceId: "action_pin_memory",
      target: {
        kind: "memory_head",
        itemId: "memory_item_01",
        revisionId: "memory_revision_01",
        revisionHash: HASH_B,
      },
    });
  });

  it("keeps a new memory draft until its hash-bound action confirms admission", async () => {
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const submit = vi.spyOn(dashboardStore, "submitAction").mockReturnValue(admitted);
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_remember_memory",
            actionId: "remember",
            label: "Remember",
            intent: "secondary",
            controlViewId: "control_01",
            authorizingEventId: "event_01",
            authorizingEventHash: HASH_B,
            target: "none",
            input: {
              kind: "text",
              field: "memory",
              label: "What should Forge remember for this project?",
              minimumBytes: 1,
              maximumBytes: 16_384,
              multiline: true,
            },
          },
        ],
      },
    }) as CreatorDashboardState;

    render(
      <ProjectSettings
        state={state}
        open={true}
        returnFocusTo={undefined}
        onClose={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    const memory = screen.getByLabelText("Add a preference");
    fireEvent.change(memory, { target: { value: "Keep the airlock's server boundary intact." } });
    fireEvent.click(screen.getByRole("button", { name: "Save preference" }));

    expect(memory).toHaveValue("Keep the airlock's server boundary intact.");
    admit();
    await waitFor(() => expect(memory).toHaveValue(""));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not leave an empty memory list after the final active memory is forgotten", () => {
    const state = dashboardState({
      memories: [
        {
          itemId: "memory_item_forgotten",
          revisionId: "memory_revision_forgotten",
          revisionHash: HASH_B,
          category: "preference",
          text: "Use quiet warning lights.",
          pinned: false,
          state: "forgotten",
        },
      ],
    }) as CreatorDashboardState;

    render(
      <ProjectSettings
        state={state}
        open={true}
        returnFocusTo={undefined}
        onClose={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("No preferences saved yet.")).toBeVisible();
    expect(screen.queryByRole("list", { name: /remembered/i })).not.toBeInTheDocument();
  });
});
