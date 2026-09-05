import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameBuildWindow } from "./GameBuildWindow";
import { ConversationHeader } from "./ConversationHeader";
import { GRAPH_VIEW } from "../test/game-build-fixture";
import { dashboardState } from "../test/fixtures";
afterEach(cleanup);
describe("GameBuildWindow", () => {
  it("opens from the icon beside Settings and receives the exact source control", () => {
    const onOpen = vi.fn();
    render(
      <ConversationHeader
        state={dashboardState()}
        connectionLost={false}
        projectsVisible
        onOpenProjects={() => {}}
        onOpenContext={() => {}}
        onOpenDetails={() => {}}
        onOpenGraph={onOpen}
      />,
    );
    const button = screen.getByRole("button", { name: "Open game map" });
    expect(button.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Project settings" }),
    );
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(button);
  });
  it("supports window expansion, native cancellation, and returns focus to its opener", () => {
    const source = document.createElement("button");
    document.body.append(source);
    source.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <GameBuildWindow view={GRAPH_VIEW} returnFocusTo={source} onClose={onClose} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Shared workshop" });
    expect(screen.getByRole("button", { name: "Close game map" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Expand graph window" }));
    expect(dialog).toHaveClass("game-build-window--expanded");
    fireEvent.click(screen.getByRole("button", { name: "Restore graph window" }));
    expect(dialog).not.toHaveClass("game-build-window--expanded");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(source).toHaveFocus();
    source.remove();
  });
  it("has an honest empty state when the conversation has no game plan", () => {
    const onClose = vi.fn();
    render(<GameBuildWindow view={undefined} returnFocusTo={undefined} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "No game plan yet" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Game system map" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("identifies a saved map and exposes the full authored game name", () => {
    const name = "A very long authored game name ".repeat(5).trim();
    render(
      <GameBuildWindow
        view={{ ...GRAPH_VIEW, architecture: { ...GRAPH_VIEW.architecture!, name } }}
        historical
        returnFocusTo={undefined}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Saved map")).toBeVisible();
    expect(screen.getByRole("heading", { name })).toHaveAttribute("title", name);
  });
});
