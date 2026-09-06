import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  validateGameDesignSpec,
} from "../packages/game-ir/src/index.js";
import { robloxAssetCapabilityProfile } from "../packages/roblox-assets/src/index.js";
import { blenderSceneSpecHandle, solveBlenderScene } from "../packages/visual-world/src/index.js";

test("Last Light ordinary-workflow seed contains no prepared world or source", async () => {
  const seedText = await readFile("examples/last-light/default.project.json", "utf8");
  const seed = JSON.parse(seedText) as { name: string; tree: unknown };
  assert.equal(seed.name, "ForgeLastLightCleanSeed");
  assert.doesNotMatch(seedText, /\$path|scene|source/i);
  assert.deepEqual(Object.keys((seed.tree as { Workspace: object }).Workspace), ["$className"]);
});

test("Last Light predecessor fixture remains bound to its deterministic visual scene", async () => {
  const intent = JSON.parse(
    await readFile("examples/last-light/predecessor/scene.intent.json", "utf8"),
  );
  const design = JSON.parse(
    await readFile("examples/last-light/predecessor/game-design.json", "utf8"),
  );
  const solved = solveBlenderScene(intent);
  assert.equal(solved.status, "eligible", JSON.stringify(solved));
  if (solved.status !== "eligible") return;
  const admitted = validateGameDesignSpec(design, { policy: DEFAULT_GAME_ADMISSION_POLICY });
  assert.equal(admitted.status, "eligible", JSON.stringify(admitted));
  if (admitted.status !== "eligible") return;

  const sceneComponent = admitted.spec.components.find(
    (component) => component.kind === "scene_handle",
  );
  assert.ok(sceneComponent?.kind === "scene_handle");
  if (sceneComponent?.kind !== "scene_handle") return;
  assert.deepEqual(sceneComponent.scene, blenderSceneSpecHandle(solved.spec));
  assert.equal(solved.spec.seed, 42017);
  assert.equal(solved.spec.objects.length, 28);
  assert.deepEqual([...new Set(solved.spec.partitions.map((partition) => partition.role))].sort(), [
    "Effects",
    "GameplayAnchors",
    "InteractiveProps",
    "WorldCollision",
    "WorldStatic",
  ]);
  assert.ok(
    solved.spec.partitions.filter((partition) => partition.role === "WorldStatic").length >= 5,
  );
  assert.deepEqual(
    solved.spec.reviewViews.map((view) => view.id),
    ["opening-view", "reactor-restored", "reactor-shuttle-approach", "warning-interaction"],
  );
  assert.deepEqual(
    admitted.spec.visualDirection?.views
      .filter((view) => view.sceneViewId)
      .map((view) => view.sceneViewId)
      .sort(),
    solved.spec.reviewViews.map((view) => view.id).sort(),
  );
  assert.equal(
    solved.spec.expectedOutputs.some(
      (output) => output.relativePath.endsWith(".obj") || output.relativePath.endsWith(".fbx"),
    ),
    false,
  );
  assert.equal(robloxAssetCapabilityProfile().openCloudGlbUpload.status, "available");
});

test("Last Light gameplay source accepts bounded intents while retaining game state on the server", async () => {
  const [config, server, client] = await Promise.all([
    readFile("examples/last-light/predecessor/src/shared/Config.luau", "utf8"),
    readFile("examples/last-light/predecessor/src/server/LastLightServer.server.luau", "utf8"),
    readFile("examples/last-light/predecessor/src/client/LastLightClient.client.luau", "utf8"),
  ]);
  for (const contract of [
    "RoundSeconds = 120",
    "CountdownSeconds = 3",
    "MaximumIntegrity = 2",
    "RequiredCells = 3",
    "CarryCapacity = 1",
    "DepositScore = 100",
    "ExtractionSeconds = 3",
    "HazardWarningSeconds = 1.5",
    "HazardActiveSeconds = 2",
    "HazardRestSeconds = 4.5",
    "HazardTimePenalty = 8",
  ])
    assert.match(config, new RegExp(contract.replace(".", "\\.")));
  assert.match(server, /OnServerEvent:Connect\(function\(player: Player, intent: unknown\)/);
  assert.doesNotMatch(server, /OnServerEvent:Connect\(function\([^\n]*state/);
  assert.match(server, /state\.integrity -= 1/);
  assert.match(server, /state\.runDeadline -= Config\.HazardTimePenalty/);
  assert.match(server, /state\.depositedCells == Config\.RequiredCells/);
  assert.match(server, /now - state\.extractionStartedAt >= Config\.ExtractionSeconds/);
  assert.match(client, /UDim2\.fromOffset\(172, 56\)/);
  assert.match(client, /Enum\.KeyCode\.ButtonX/);
  assert.match(client, /ScreenInsets = Enum\.ScreenInsets\.CoreUISafeInsets/);
});
