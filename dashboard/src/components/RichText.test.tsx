import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichText } from "./RichText";

describe("readable agent replies", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("renders structured replies and copies source without the code toolbar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <RichText
        text={
          '## Changes\n\n- **Doors** stay closed.\n\n```lua\nprint("Hello")\n```\n\n| Part | State |\n| --- | --- |\n| Door | Ready |'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Changes" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('print("Hello")\n'));
    expect(screen.getByText("Copied")).toBeVisible();
  });
  it("never injects HTML, executes URLs, or fetches images from an agent reply", () => {
    const { container } = render(
      <RichText
        text={
          "<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n![remote image](https://example.com/tracker.png)\n\n[Docs](https://example.com/docs)"
        }
      />,
    );
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });
  it("formats Roblox paths in prose while leaving code and links exact", () => {
    const { container } = render(
      <RichText
        text={
          'Edit Workspace/Airlock/OuterDoor.\n\nUse `StarterGui/HUD/Control Panel`.\n\n```luau\nlocal path = "Workspace/Airlock"\n```\n\n[Workspace/Door](https://example.com/Workspace/Door)'
        }
      />,
    );
    expect(screen.getByText("Edit Workspace.Airlock.OuterDoor.")).toBeVisible();
    expect(screen.getByText('StarterGui.HUD["Control Panel"]')).toBeVisible();
    expect(container.querySelector("pre")).toHaveTextContent('local path = "Workspace/Airlock"');
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com/Workspace/Door");
  });
});
