import assert from "node:assert/strict";
import test from "node:test";
import { robloxPath, robloxPathsInText } from "../packages/studio-path/src/index.js";

test("Roblox display paths use members and quoted names without changing file paths or URLs", () => {
  assert.equal(robloxPath("Workspace/Airlock/OuterDoor"), "Workspace.Airlock.OuterDoor");
  assert.equal(
    robloxPath("StarterGui/HUD/Control Panel/end/a.b/שלום"),
    'StarterGui.HUD["Control Panel"]["end"]["a.b"]["שלום"]',
  );
  for (const path of [
    "examples/orbital/game.rbxlx",
    "/tmp/Workspace/Door",
    "https://example.com/Workspace/Door",
    "Workspace/../Door",
  ])
    assert.equal(robloxPath(path), path);
  assert.equal(
    robloxPathsInText(
      "Check Workspace/Airlock/OuterDoor. See https://host/Workspace/Door and /tmp/Workspace/Door.",
    ),
    "Check Workspace.Airlock.OuterDoor. See https://host/Workspace/Door and /tmp/Workspace/Door.",
  );
});
