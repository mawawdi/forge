import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceExplorer } from "./SourceExplorer";
import type { SourceExplorerSnapshot } from "../types";

const hash = "a".repeat(64);
const document = {
  documentId: "workspace:InventoryService",
  path: "ServerScriptService/Systems/InventoryService",
  className: "ModuleScript",
  executionContext: "server" as const,
  sourceHash: "b".repeat(64),
};

const searchSource: SourceExplorerSnapshot = {
  phase: "ready",
  sessionId: "creator_session_0123456789abcdef",
  request: { operation: "search", query: "require" },
  result: {
    operation: "search",
    page: {
      indexId: "studio_source_index_0123456789abcdef",
      indexHash: hash,
      query: "require",
      nextCursor: "authenticated-search-cursor",
      matches: [
        {
          document,
          location: {
            startByte: 14,
            endByte: 21,
            startLine: 2,
            startColumn: 7,
            endLine: 2,
            endColumn: 14,
          },
          snippetRange: { startByte: 0, endByte: 42 },
          snippet: "local Catalog = require(script.Parent.Catalog)",
        },
      ],
    },
  },
};

describe("SourceExplorer", () => {
  afterEach(() => cleanup());

  it("keeps source navigation index-bound and offers only server-produced sealed diffs", () => {
    render(
      <SourceExplorer source={searchSource} controlView={undefined} onExplore={() => undefined} />,
    );

    expect(screen.getByText("Studio source map")).toBeVisible();
    expect(screen.getByText(/1 source match for “require”/)).toBeVisible();
    expect(screen.getByText("local Catalog = require(script.Parent.Catalog)")).toBeVisible();
    expect(screen.getByText("Exact source diff")).toBeVisible();
    expect(
      screen.getByText(
        /reads the immutable before blob and immutable replacement blob on the server/i,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Source edit operation ID")).toBeVisible();
  });

  it("sends bounded lazy read, symbol, reference, dependency, and cursor requests through the store callback", () => {
    const onExplore = vi.fn();
    render(<SourceExplorer source={searchSource} controlView={undefined} onExplore={onExplore} />);

    fireEvent.change(screen.getByLabelText("Path / prefix"), {
      target: { value: "ServerScriptService/Systems" },
    });
    fireEvent.change(screen.getByLabelText("Text / symbol"), {
      target: { value: "InventoryService" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Read exact page" }));
    fireEvent.click(screen.getByRole("button", { name: "Find symbols" }));
    fireEvent.click(screen.getByRole("button", { name: "Find references" }));
    fireEvent.click(screen.getByRole("button", { name: "Trace dependencies" }));
    fireEvent.click(screen.getByRole("button", { name: "Read selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));

    expect(onExplore).toHaveBeenNthCalledWith(1, {
      operation: "read",
      documentId: "workspace:InventoryService",
    });
    expect(onExplore).toHaveBeenNthCalledWith(2, {
      operation: "symbols",
      query: "InventoryService",
      pathPrefix: "ServerScriptService/Systems",
    });
    expect(onExplore).toHaveBeenNthCalledWith(3, {
      operation: "references",
      symbol: "InventoryService",
      pathPrefix: "ServerScriptService/Systems",
    });
    expect(onExplore).toHaveBeenNthCalledWith(4, {
      operation: "dependencies",
      documentId: "workspace:InventoryService",
      direction: "closure",
    });
    expect(onExplore).toHaveBeenNthCalledWith(5, {
      operation: "read",
      documentId: "workspace:InventoryService",
    });
    expect(onExplore).toHaveBeenNthCalledWith(6, {
      operation: "search",
      query: "require",
      cursor: "authenticated-search-cursor",
    });
  });

  it("opens an exact read page only when the user selects a returned document", () => {
    const onExplore = vi.fn();
    render(<SourceExplorer source={searchSource} controlView={undefined} onExplore={onExplore} />);

    fireEvent.click(screen.getByRole("button", { name: "Read exact page" }));

    expect(onExplore).toHaveBeenCalledWith({
      operation: "read",
      documentId: "workspace:InventoryService",
    });
  });

  it("does not carry a selected opaque document into a different session", () => {
    const onExplore = vi.fn();
    const { rerender } = render(
      <SourceExplorer source={searchSource} controlView={undefined} onExplore={onExplore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read exact page" }));
    rerender(
      <SourceExplorer
        source={{ ...searchSource, sessionId: "creator_session_rebound" }}
        controlView={undefined}
        onExplore={onExplore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read selected" }));

    expect(onExplore).toHaveBeenCalledTimes(1);
  });

  it("requests a sealed operation diff by opaque operation and optional change-set identities", () => {
    const onExplore = vi.fn();
    render(<SourceExplorer source={searchSource} controlView={undefined} onExplore={onExplore} />);

    fireEvent.change(screen.getByLabelText("Source edit operation ID"), {
      target: { value: "operation-source-1" },
    });
    fireEvent.change(screen.getByLabelText("Change set ID (if needed)"), {
      target: { value: "change-set-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Read sealed diff" }));

    expect(onExplore).toHaveBeenCalledWith({
      operation: "diff",
      operationId: "operation-source-1",
      changeSetId: "change-set-1",
    });
  });
});
