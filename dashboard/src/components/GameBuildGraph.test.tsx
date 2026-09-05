import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GameBuildGraph } from "./GameBuildGraph";
import { GameSystemExplorer } from "./GameSystemExplorer";
import { ConversationTimeline } from "./ConversationTimeline";
import { dashboardState } from "../test/fixtures";
import type { GameBuildControlView } from "../../../packages/creator-conversation/src/game-build-contract";

import { GRAPH_VIEW } from "../test/game-build-fixture";
const HASH = "a".repeat(64);

afterEach(cleanup);
describe("GameBuildGraph", () => {
  it("starts with component groups and preserves source dependencies that have no editor writes", () => {
    render(
      <GameBuildGraph
        view={{
          ...GRAPH_VIEW,
          components: [
            ...GRAPH_VIEW.components,
            { id: "library", kind: "recipe_instance", observedSources: 1 },
          ],
          componentDependencies: [
            ...GRAPH_VIEW.componentDependencies,
            { from: "logic", to: "library" },
          ],
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Controller, ModuleScript, Stopped" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand component scene, 2 objects" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand component library, 0 objects" }),
    ).toHaveTextContent("1 observed sources");
    fireEvent.click(screen.getByRole("button", { name: "Expand component logic, 1 object" }));
    expect(screen.getByRole("button", { name: "Controller, ModuleScript, Stopped" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Components" }));
    expect(
      screen.getByRole("button", { name: "Expand component library, 0 objects" }),
    ).toBeVisible();
  });
  it("keeps the graph out of the conversation timeline", () => {
    const state = dashboardState();
    render(
      <ConversationTimeline
        state={{ ...state, controlView: { ...state.controlView!, gameBuild: GRAPH_VIEW } }}
        snapshot={{ phase: "ready", drafts: {} }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Current game map" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Technical details" })).not.toBeInTheDocument();
  });
  it("shows declared system names, purpose and directed relationships before technical metadata", () => {
    render(<GameSystemExplorer view={GRAPH_VIEW} />);
    expect(screen.getByRole("region", { name: "Game system map" })).toBeVisible();
    expect(screen.queryByText("Controller")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Component")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select system Tool interactions" }));
    const details = screen.getByRole("region", { name: "Selected system details" });
    expect(
      within(details).getByText("Connects player actions to changes in the shared workshop."),
    ).toBeVisible();
    fireEvent.click(
      within(details).getByRole("button", { name: "To Building surfaces, Edits surfaces" }),
    );
    const relatedDetails = screen.getByRole("region", { name: "Selected system details" });
    expect(
      within(relatedDetails).getByRole("heading", { name: "Building surfaces" }),
    ).toBeVisible();
    expect(within(relatedDetails).queryByText(/source|receipt/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show system list" }));
    expect(screen.getByRole("list", { name: "Game systems" })).toBeVisible();
  });
  it("does not invent a semantic map from implementation names when architecture is absent", () => {
    const { architecture: _architecture, ...view } = GRAPH_VIEW;
    render(<GameSystemExplorer view={view} />);
    expect(screen.getByRole("heading", { name: "No game system map declared" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Game system map" })).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Expand component scene, 2 objects" }),
    ).not.toBeInTheDocument();
  });
  it("expands named children in place and keeps siblings visible without build status", () => {
    render(
      <GameSystemExplorer
        view={{
          ...GRAPH_VIEW,
          components: [
            ...GRAPH_VIEW.components,
            { id: "library", kind: "recipe_instance", observedSources: 1 },
          ],
          architecture: {
            ...GRAPH_VIEW.architecture!,
            nodes: [
              {
                id: "group",
                name: "Creation",
                description: "All creative interactions.",
                componentIds: [],
                operationIds: ["root", "part", "script"],
                status: "stopped",
                appliedOperations: 1,
              },
              ...GRAPH_VIEW.architecture!.nodes.map((node) => ({ ...node, parentId: "group" })),
              {
                id: "library",
                name: "Existing tools",
                description: "Tools already present in the project.",
                componentIds: ["library"],
                operationIds: [],
                status: "no_changes",
                appliedOperations: 0,
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Select system Existing tools" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select system Tool interactions" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Creation" }));
    expect(
      screen.queryByRole("button", { name: "Select system Tool interactions" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Creation" }));
    expect(screen.getByRole("button", { name: "Select system Tool interactions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select system Existing tools" })).toBeVisible();
    expect(screen.queryByText("No editor changes")).not.toBeInTheDocument();
  });
  it("clears hidden system selection and restores keyboard focus when details close", () => {
    render(<GameSystemExplorer view={GRAPH_VIEW} />);
    const node = screen.getByRole("button", { name: "Select system Tool interactions" });
    fireEvent.click(node);
    const close = screen.getByRole("button", { name: "Close system details" });
    close.focus();
    fireEvent.click(close);
    expect(node).toHaveFocus();
    fireEvent.click(node);
    const search = screen.getByLabelText("Find a system");
    search.focus();
    fireEvent.change(search, { target: { value: "no-matching-system" } });
    expect(screen.getByText("No matching systems")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Selected system details" }),
    ).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "" } });
    expect(
      screen.queryByRole("region", { name: "Selected system details" }),
    ).not.toBeInTheDocument();
  });
  it("clears technical selection when object filters or checkpoints hide the selected item", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand component logic, 1 object" }));
    fireEvent.click(screen.getByRole("button", { name: "Controller, ModuleScript, Stopped" }));
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "missing" } });
    expect(
      screen.queryByRole("region", { name: "Selected object details" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Controller, ModuleScript, Stopped" }));
    fireEvent.click(screen.getByRole("button", { name: "Checkpoint 1, Applied" }));
    expect(
      screen.queryByRole("region", { name: "Selected object details" }),
    ).not.toBeInTheDocument();
  });
  it("selects source and property details, and follows dependencies by their exact object IDs", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand component logic, 1 object" }));
    fireEvent.click(screen.getByRole("button", { name: "Controller, ModuleScript, Stopped" }));
    const details = screen.getByRole("region", { name: "Selected object details" });
    expect(within(details).getByText("Source slot · up to 2048 UTF-8 bytes")).toBeVisible();
    expect(within(details).getByText("Source package")).toBeVisible();
    fireEvent.click(within(details).getByRole("button", { name: "Worktop, dependency" }));
    const relatedDetails = screen.getByRole("region", { name: "Selected object details" });
    expect(within(relatedDetails).getByRole("heading", { name: "Worktop" })).toBeVisible();
    expect(within(relatedDetails).getByText("Color")).toBeVisible();
    expect(within(relatedDetails).getByText("scene.primitives")).toBeVisible();
  });
  it("filters by component, checkpoint and query, with a keyboard-accessible list alternative", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} />);

    fireEvent.change(screen.getByLabelText("Component"), { target: { value: "logic" } });
    expect(screen.getByText("1–1 of 1 objects")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(
      within(screen.getByRole("list", { name: "Build objects" })).getByRole("button", {
        name: /Controller/,
      }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "missing" } });
    expect(screen.getByText("No matching objects")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Checkpoint 1, Applied" }));
    expect(screen.getByText("No matching objects")).toBeVisible();
  });
  it("updates live checkpoint state while keeping the selected source detail", () => {
    const { rerender } = render(<GameBuildGraph view={GRAPH_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand component logic, 1 object" }));
    fireEvent.click(screen.getByRole("button", { name: "Controller, ModuleScript, Stopped" }));
    const applying: GameBuildControlView = {
      ...GRAPH_VIEW,
      status: "applying",
      nodes: GRAPH_VIEW.nodes.map((node) =>
        node.id === "script" ? { ...node, status: "applying" } : node,
      ),
    };
    delete (applying as { stoppedReason?: string }).stoppedReason;
    rerender(<GameBuildGraph view={applying} />);
    expect(
      screen.getByRole("button", { name: "Controller, ModuleScript, Applying" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Selected object details" })).toHaveTextContent(
      "Controller",
    );
  });
  it("bounds rendered objects and makes paging explicit for a large inventory", () => {
    const nodes = Array.from({ length: 181 }, (_, index) => ({
      ...GRAPH_VIEW.nodes[0]!,
      id: `node-${index}`,
      label: `Node ${index}`,
      status: "planned" as const,
    }));
    render(
      <GameBuildGraph
        view={{
          planHash: HASH,
          status: "planned",
          nodes,
          components: [GRAPH_VIEW.components[0]!],
          componentDependencies: [],
          edges: [],
          partitions: [],
          receipts: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand component scene, 181 objects" }));
    expect(screen.getByText("1–80 of 181 objects")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Node 80, Folder, Planned" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next objects" }));
    expect(screen.getByText("81–160 of 181 objects")).toBeVisible();
    expect(screen.getByRole("button", { name: "Node 80, Folder, Planned" })).toBeVisible();
  });
  it("shows checkpoint completion without exposing hashes until their disclosure opens", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} historical />);
    expect(screen.getByRole("region", { name: "Saved build implementation" })).toBeVisible();
    expect(screen.getByText("Saved snapshot · Read only")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Applied checkpoints" })).toHaveAttribute(
      "value",
      "1",
    );
    expect(screen.getByRole("progressbar", { name: "Applied checkpoints" })).toHaveAttribute(
      "max",
      "2",
    );
    expect(screen.getByText("1 of 2 applied")).toHaveAttribute("role", "status");
    expect(screen.getByText(GRAPH_VIEW.graphHash!)).not.toBeVisible();
    fireEvent.click(screen.getByText("Plan and build identifiers"));
    expect(screen.getByText(GRAPH_VIEW.planHash)).toBeVisible();
    expect(screen.getByText(GRAPH_VIEW.graphHash!)).toBeVisible();
    expect(screen.getByText(/gameplay checks are separate/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /apply|retry|rollback/i })).not.toBeInTheDocument();
  });
  it("bounds checkpoint cards and can jump directly to any retained checkpoint", () => {
    const nodes = Array.from({ length: 128 }, (_, index) => ({
      ...GRAPH_VIEW.nodes[0]!,
      id: `node-${index}`,
      label: `Node ${index + 1}`,
      path: `Workspace/Node${index + 1}`,
      status: index < 10 ? ("applied" as const) : ("pending" as const),
    }));
    const partitions = nodes.map((node, ordinal) => ({
      id: `checkpoint-${ordinal}`,
      ordinal,
      nodeIds: [node.id],
      status: ordinal < 10 ? ("applied" as const) : ("pending" as const),
      ...(ordinal < 10 ? { receiptHash: HASH } : {}),
    }));
    render(
      <GameBuildGraph
        view={{
          planHash: HASH,
          graphHash: "b".repeat(64),
          status: "materialized",
          nodes,
          components: [GRAPH_VIEW.components[0]!],
          componentDependencies: [],
          edges: [],
          partitions,
          receipts: partitions
            .slice(0, 10)
            .map((partition) => ({ partitionId: partition.id, hash: HASH, status: "verified" })),
        }}
      />,
    );
    const checkpointRegion = screen.getByRole("region", { name: "Build checkpoints" });
    expect(
      within(checkpointRegion).getAllByRole("button", { name: /^Checkpoint \d/ }),
    ).toHaveLength(7);
    expect(screen.getByText("10 of 128 applied")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Jump to checkpoint" }), {
      target: { value: "checkpoint-127" },
    });
    expect(screen.getByRole("button", { name: "Checkpoint 128, Pending" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Node 128, Folder, Pending" })).toBeVisible();
    expect(
      within(checkpointRegion).getAllByRole("button", { name: /^Checkpoint \d/ }),
    ).toHaveLength(7);
  });
  it("clears all filters with an announced result and restores focus after closing object details", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const list = screen.getByRole("list", { name: "Build objects" });
    fireEvent.click(within(list).getByRole("button", { name: /Controller/ }));
    const close = screen.getByRole("button", { name: "Close object details" });
    close.focus();
    fireEvent.click(close);
    expect(within(list).getByRole("button", { name: /Controller/ })).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "missing" } });
    expect(screen.getByText("No matching objects")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Show all objects" }));
    expect(screen.getByLabelText("Find an object")).toHaveValue("");
    expect(screen.getByText("1–3 of 3 objects")).toHaveAttribute("aria-atomic", "true");
  });
  it("keeps source and property schema detail behind focused, independent disclosures", () => {
    render(<GameBuildGraph view={GRAPH_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(
      within(screen.getByRole("list", { name: "Build objects" })).getByRole("button", {
        name: /Worktop/,
      }),
    );
    const details = screen.getByRole("region", { name: "Selected object details" });
    expect(within(details).getByLabelText("Color slot schema")).not.toBeVisible();
    fireEvent.click(within(details).getByText("Schema"));
    expect(within(details).getByLabelText("Color slot schema")).toBeVisible();
    expect(within(details).getByText(HASH)).not.toBeVisible();
    fireEvent.click(within(details).getByText("Evidence identifiers"));
    expect(within(details).getByText(HASH)).toBeVisible();
  });
  it("presents an empty sealed inventory without inventing progress", () => {
    render(
      <GameBuildGraph
        view={{
          planHash: HASH,
          status: "planned",
          nodes: [],
          components: [],
          edges: [],
          componentDependencies: [],
          partitions: [],
          receipts: [],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No editor changes in this plan" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Object dependency graph" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });
});
