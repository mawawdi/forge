import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TechnicalReplay } from "./TechnicalReplay";
import type { CreatorConversationAttachment } from "../types";
import { HASH, event } from "../test/fixtures";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("TechnicalReplay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the attached immutable IDs for provider-free verification and mutation replay", async () => {
    const requests: RequestInfo[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo) => {
        requests.push(input);
        return Promise.resolve(json({ status: "exact" }));
      }),
    );
    const attachments: readonly CreatorConversationAttachment[] = [
      {
        role: "verification",
        label: "Verification",
        binding: {
          id: "verification_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
      },
      {
        role: "mutation",
        label: "Mutation",
        binding: {
          id: "mutation_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
      },
    ];
    render(<TechnicalReplay event={event()} attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "Replay verification" }));
    expect(await screen.findByText(/"status": "exact"/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Replay mutation" }));
    expect(await screen.findByText(/"status": "exact"/)).toBeVisible();
    expect(requests).toEqual([
      "/api/verifications/verification_01/replay",
      "/api/mutations/mutation_01/replay",
    ]);
  });
});
