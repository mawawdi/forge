import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardStore } from "../api-store";
import { ChatComposer } from "./ChatComposer";
import type { CreatorDashboardState, CreatorTurnRequest, DashboardSnapshot } from "../types";
import { dashboardState } from "../test/fixtures";

describe("ChatComposer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    dashboardStore.updateDraft("conversation_01", { text: "" });
  });

  it("lets the user draft while the agent works without admitting another turn", () => {
    const state = dashboardState({
      controlView: { ...dashboardState().controlView, turnContract: undefined },
    }) as CreatorDashboardState;
    const submit = vi.spyOn(dashboardStore, "submitTurn");
    render(<ChatComposer state={state} snapshot={{ phase: "ready", data: state, drafts: {} }} />);
    const input = screen.getByRole("textbox", { name: "Message Forge" });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "And keep the door color." } });
    fireEvent.submit(screen.getByRole("form", { name: "Message Forge" }));
    expect(dashboardStore.draftFor("conversation_01").text).toBe("And keep the door color.");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows readable model names and preserves an unsent message when the selected engine is unavailable", () => {
    const state = dashboardState({
      modelRegistry: {
        ...dashboardState().modelRegistry,
        models: [
          {
            id: "openai/gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            availability: "unavailable",
            detail: "This engine is temporarily unavailable.",
            requiredCapabilities: ["tools"],
            providerFallback: "disabled",
          },
        ],
      },
    }) as CreatorDashboardState;
    dashboardStore.updateDraft("conversation_01", {
      text: "Keep this request for the next available engine.",
      modelId: "openai/gpt-5.6-luna",
    });
    const snapshot: DashboardSnapshot = { phase: "ready", data: state, drafts: {} };

    render(<ChatComposer state={state} snapshot={snapshot} />);

    expect(
      screen.getByDisplayValue("Keep this request for the next available engine."),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /GPT-5\.6 Luna/ })).toBeDisabled();
    expect(screen.getByText("This engine is temporarily unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("does not offer a send that the current turn contract would reject for length", () => {
    const state = dashboardState({
      controlView: {
        ...dashboardState().controlView,
        turnContract: {
          ...dashboardState().controlView!.turnContract!,
          minimumBytes: 4,
          maximumBytes: 5,
        },
      },
    }) as CreatorDashboardState;
    dashboardStore.updateDraft("conversation_01", {
      text: "too long",
      modelId: "openai/gpt-5.6-luna",
    });
    const snapshot: DashboardSnapshot = { phase: "ready", data: state, drafts: {} };

    render(<ChatComposer state={state} snapshot={snapshot} />);

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("This message is too long. Shorten it before sending.")).toBeVisible();
  });

  it("offers an explicit exact retry while the current contract is unavailable", async () => {
    const state = dashboardState({
      controlView: { ...dashboardState().controlView, turnContract: undefined },
    });
    const original: CreatorTurnRequest = {
      kind: "CreatorTurnRequest",
      conversationId: "conversation_01",
      turnContractId: "old_contract",
      turnContractHash: "a".repeat(64),
      turnKind: "new_work",
      text: "Explain this project.",
      selectedModelId: state.modelRegistry.defaultModelId,
      idempotencyKey: "original-key",
    };
    dashboardStore.updateDraft("conversation_01", { text: original.text });
    vi.spyOn(dashboardStore, "unconfirmedTurnFor").mockReturnValue(original);
    const retry = vi.spyOn(dashboardStore, "retryTurn").mockResolvedValue();
    const submit = vi.spyOn(dashboardStore, "submitTurn");
    render(<ChatComposer state={state} snapshot={{ phase: "ready", data: state, drafts: {} }} />);
    const button = screen.getByRole("button", { name: "Retry message" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("original-key"));
    expect(submit).not.toHaveBeenCalled();
  });
});
