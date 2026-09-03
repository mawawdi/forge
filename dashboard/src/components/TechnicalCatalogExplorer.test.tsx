import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TechnicalCatalogExplorer } from "./TechnicalCatalogExplorer";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("TechnicalCatalogExplorer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads compact coverage totals and a bounded catalog page on demand", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input === "/api/control/catalog") {
          return Promise.resolve(
            json({
              coverage: {
                summary: { total: 9685, authorableClasses: 33, authorableProperties: 364 },
              },
            }),
          );
        }
        if (input.startsWith("/api/control/capabilities")) {
          return Promise.resolve(
            json({
              page: { total: 1, cursor: 0, limit: 20 },
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
        }
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    render(<TechnicalCatalogExplorer />);

    fireEvent.click(screen.getByRole("button", { name: "Load API coverage" }));
    expect(await screen.findByText("9,685")).toBeVisible();

    fireEvent.change(screen.getByLabelText("API search"), { target: { value: "ActionText" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect API coverage" }));
    expect(await screen.findByText("ProximityPrompt · ActionText · property")).toBeVisible();
    expect(screen.getByText("authorable · proof_closed")).toBeVisible();
  });
});
