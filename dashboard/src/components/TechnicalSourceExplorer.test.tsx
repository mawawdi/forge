import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TechnicalSourceExplorer } from "./TechnicalSourceExplorer";

const HISTORICAL_ANCHOR = {
  conversationId: "conversation_01",
  eventId: "event_historical",
  eventHash: "a".repeat(64),
  sourceIndexHash: "b".repeat(64),
} as const;
const CURRENT_ANCHOR = {
  conversationId: "conversation_01",
  eventId: "event_current",
  eventHash: "c".repeat(64),
  sourceIndexHash: "d".repeat(64),
} as const;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("TechnicalSourceExplorer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("disables source browsing when the selected event has no exact immutable source index", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(<TechnicalSourceExplorer anchor={undefined} changeSets={[]} />);

    expect(
      screen.getByText("This event has no exact immutable source-index citation to inspect."),
    ).toBeVisible();
    const list = screen.getByRole("button", { name: "List project source" });
    expect(list).toBeDisabled();
    fireEvent.click(list);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("navigates only paged source evidence bound to one immutable event and index", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        requests.push(input);
        if (input.startsWith("/api/sources/documents")) {
          return Promise.resolve(
            json({
              documents: [
                {
                  documentId: "document_01",
                  path: "ServerScriptService/Airlock.server.lua",
                  className: "Script",
                  executionContext: "server",
                },
              ],
            }),
          );
        }
        if (input.startsWith("/api/sources/read")) {
          return Promise.resolve(json({ source: "local Airlock = {}\nreturn Airlock" }));
        }
        if (input.startsWith("/api/sources/dependencies")) {
          if (input.includes("cursor=dependency-next")) {
            return Promise.resolve(
              json({
                dependencies: [
                  {
                    id: "dependency_02",
                    source: { path: "ReplicatedStorage/AirlockConfig.lua" },
                    target: { path: "ReplicatedStorage/SharedConfig.lua" },
                    resolution: "resolved",
                  },
                ],
              }),
            );
          }
          return Promise.resolve(
            json({
              dependencies: [
                {
                  id: "dependency_01",
                  source: { path: "ServerScriptService/Airlock.server.lua" },
                  target: { path: "ReplicatedStorage/AirlockConfig.lua" },
                  resolution: "resolved",
                },
              ],
              nextCursor: "dependency-next",
            }),
          );
        }
        if (input.startsWith("/api/sources/references")) {
          return Promise.resolve(
            json({
              references: [
                {
                  id: "reference_01",
                  name: "Airlock",
                  role: "reference",
                  document: { path: "ServerScriptService/Airlock.server.lua" },
                  location: { startLine: 4 },
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );

    render(<TechnicalSourceExplorer anchor={HISTORICAL_ANCHOR} changeSets={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "List project source" }));
    const document = await screen.findByRole("button", {
      name: /ServerScriptService\/Airlock\.server\.lua/,
    });
    fireEvent.click(document);
    expect(await screen.findByText(/local Airlock = \{\}\s*return Airlock/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Inspect dependencies" }));
    expect(
      await screen.findByText(
        "ServerScriptService/Airlock.server.lua → ReplicatedStorage/AirlockConfig.lua",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more dependencies" }));
    expect(
      await screen.findByText(
        "ReplicatedStorage/AirlockConfig.lua → ReplicatedStorage/SharedConfig.lua",
      ),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Find in source"), { target: { value: "Airlock" } });
    fireEvent.change(screen.getByLabelText("Source analysis"), { target: { value: "references" } });
    fireEvent.click(screen.getByRole("button", { name: "Search source" }));
    expect(
      await screen.findByText("Airlock · ServerScriptService/Airlock.server.lua"),
    ).toBeVisible();
    await waitFor(() =>
      expect(requests.some((request) => request.startsWith("/api/sources/references"))).toBe(true),
    );
    expect(
      requests.every(
        (request) =>
          request.includes("conversationId=conversation_01") &&
          request.includes("eventId=event_historical") &&
          request.includes(`eventHash=${HISTORICAL_ANCHOR.eventHash}`) &&
          request.includes(`sourceIndexHash=${HISTORICAL_ANCHOR.sourceIndexHash}`),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.includes("cursor=dependency-next"))).toBe(true);
  });

  it("discards a historical-index response after the selected event changes to current evidence", async () => {
    let releaseOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.includes("eventId=event_historical")) return oldResponse;
        if (input.includes("eventId=event_current")) {
          return Promise.resolve(
            json({
              documents: [
                {
                  documentId: "document_new",
                  path: "ServerScriptService/NewProject.server.lua",
                  className: "Script",
                  executionContext: "server",
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );

    const view = render(<TechnicalSourceExplorer anchor={HISTORICAL_ANCHOR} changeSets={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "List project source" }));
    view.rerender(<TechnicalSourceExplorer anchor={CURRENT_ANCHOR} changeSets={[]} />);
    const list = screen.getByRole("button", { name: "List project source" });
    await waitFor(() => expect(list).toBeEnabled());
    fireEvent.click(list);
    expect(
      await screen.findByRole("button", { name: /ServerScriptService\/NewProject\.server\.lua/ }),
    ).toBeVisible();

    releaseOld(
      json({
        documents: [
          {
            documentId: "document_old",
            path: "ServerScriptService/OldProject.server.lua",
            className: "Script",
            executionContext: "server",
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /ServerScriptService\/OldProject\.server\.lua/,
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("reads a sealed edit-source diff from its exact change-set artifact", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        requests.push(input);
        if (input.startsWith("/api/artifacts/")) {
          return Promise.resolve(
            json({
              operations: [
                {
                  kind: "edit_source",
                  id: "edit_01",
                  target: { path: "ServerScriptService/Airlock.server.lua" },
                },
              ],
            }),
          );
        }
        if (input.startsWith("/api/sources/diff")) {
          return Promise.resolve(
            json({
              edit: {
                before: { source: "local open = false" },
                replacement: { source: "local open = true" },
              },
            }),
          );
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );

    render(
      <TechnicalSourceExplorer
        anchor={HISTORICAL_ANCHOR}
        changeSets={[
          {
            id: "change_set_01",
            hash: "a".repeat(64),
            artifact: {
              locator: `artifacts/${"a".repeat(64)}.json`,
              artifactHash: "a".repeat(64),
              bytes: 90,
            },
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find sealed source edits" }));
    const edit = await screen.findByRole("button", {
      name: /ServerScriptService\/Airlock\.server\.lua/,
    });
    fireEvent.click(edit);
    expect(await screen.findByText(/— before\s+local open = false/)).toBeVisible();
    expect(screen.getByText(/— replacement\s+local open = true/)).toBeVisible();
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.startsWith("/api/sources/diff") &&
            request.includes("conversationId=conversation_01") &&
            request.includes("eventId=event_historical") &&
            request.includes(`eventHash=${HISTORICAL_ANCHOR.eventHash}`) &&
            request.includes(`sourceIndexHash=${HISTORICAL_ANCHOR.sourceIndexHash}`) &&
            request.includes("operationId=edit_01") &&
            request.includes("changeSetId=change_set_01"),
        ),
      ).toBe(true),
    );
  });
});
