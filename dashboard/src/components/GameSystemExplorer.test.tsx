import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GameSystemExplorer } from "./GameSystemExplorer";
import { GRAPH_VIEW, MAP_SHOWCASE } from "../test/game-build-fixture";

afterEach(cleanup);

describe("game map exploration", () => {
  it("keeps the search query when opening a matching concept and clears hidden details on a new query", () => {
    render(<GameSystemExplorer view={MAP_SHOWCASE} />);
    const search = screen.getByRole("searchbox", { name: "Find a system" });
    fireEvent.change(search, { target: { value: "Morph" } });
    fireEvent.click(screen.getByRole("button", { name: "Select system Morph" }));
    expect(search).toHaveValue("Morph");
    expect(
      screen.queryByRole("button", { name: "Select system Leaderboard" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Selected system details" })).toHaveTextContent(
      "Take on different forms",
    );
    fireEvent.change(search, { target: { value: "no matching concept" } });
    expect(
      screen.queryByRole("region", { name: "Selected system details" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("No matching systems");
    fireEvent.click(
      within(screen.getByRole("status", { name: "" })).getByRole("button", {
        name: "Clear search",
      }),
    );
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
  });

  it("reveals a relationship target outside the search and preserves keyboard position on close", () => {
    render(<GameSystemExplorer view={GRAPH_VIEW} />);
    const search = screen.getByRole("searchbox", { name: "Find a system" });
    fireEvent.change(search, { target: { value: "Tool interactions" } });
    fireEvent.click(screen.getByRole("button", { name: "Select system Tool interactions" }));
    fireEvent.click(screen.getByRole("button", { name: "To Building surfaces, Edits surfaces" }));
    expect(search).toHaveValue("");
    const target = screen.getByRole("button", { name: "Select system Building surfaces" });
    expect(target).toHaveFocus();
    expect(screen.getByRole("region", { name: "Selected system details" })).toHaveTextContent(
      "Places where players assemble",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close system details" }));
    expect(target).toHaveFocus();
  });

  it("reveals authored children without replacing their sibling systems", () => {
    render(<GameSystemExplorer view={MAP_SHOWCASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Select system Levels" }));
    fireEvent.click(
      within(screen.getByRole("region", { name: "Selected system details" })).getByRole("button", {
        name: "Bronze",
      }),
    );
    expect(screen.getByRole("button", { name: "Select system Bronze" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Select system Morph" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Selected system details" })).toHaveTextContent(
      "The first level of mastery",
    );
  });

  it("offers visible Graph and List controls and a keyboard search shortcut", () => {
    render(<GameSystemExplorer view={GRAPH_VIEW} />);
    const graph = screen.getByRole("button", { name: "Show system map" });
    const list = screen.getByRole("button", { name: "Show system list" });
    expect(graph).toHaveTextContent("Graph");
    expect(graph).toHaveAttribute("aria-pressed", "true");
    expect(list).toHaveTextContent("List");
    fireEvent.click(list);
    expect(screen.getByRole("list", { name: "Game systems" })).toBeVisible();
    expect(list).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(list, { key: "/" });
    expect(screen.getByRole("searchbox", { name: "Find a system" })).toHaveFocus();
  });

  it("makes the central game node reset a deliberately panned canvas", () => {
    render(<GameSystemExplorer view={GRAPH_VIEW} />);
    const game = screen.getByRole("button", { name: "Game map overview" });
    const initial = game.style.left;
    expect(game).toHaveAttribute("data-selected", "false");
    fireEvent.keyDown(screen.getByRole("region", { name: "Game system map" }), {
      key: "ArrowRight",
    });
    expect(game.style.left).not.toEqual(initial);
    fireEvent.click(game);
    expect(game.style.left).toEqual(initial);
  });
});
