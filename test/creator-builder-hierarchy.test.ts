import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { createCreatorBuilderNavigation } from "../packages/creator-session/src/builder-hierarchy.js";
import { createGameSourceContextReader } from "../packages/creator-session/src/game-source-context.js";
import {
  compileGamePlan,
  gameGeneratedTarget,
  type GameInventoryItem,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
} from "../packages/game-ir/src/index.js";

const creatorPlanHash = contentHash("accepted creator authority");
const identity = (stableId: string) => ({ kind: "forge_attribute" as const, stableId });
const target = (
  id: string,
  path: string,
  className: "Folder" | "Part" | "ModuleScript" = "Folder",
) => ({
  kind: "instance" as const,
  identity: identity(id),
  path,
  className,
});
const definition: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  id: "hierarchy-fixture",
  abi: "1",
  configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  ports: [],
  obligations: [],
  sourceExports: [],
};
function fixture(reverse = false) {
  const root = { kind: "engine_container" as const, path: "Workspace", className: "Workspace" };
  const old = target("old", "Workspace/Old");
  const child = target("child", "Workspace/Old/Child", "Part");
  const worker = target("worker", "Workspace/Old/Worker", "ModuleScript");
  const removed = target("removed", "Workspace/RemoveMe");
  const base = {
    lockedProperties: {},
    valueSlots: [],
    attributes: {},
    removedAttributes: [],
    dependencies: [],
  };
  const inventory: GameInventoryItem[] = [
    {
      ...base,
      id: "move",
      componentId: "world",
      beforeHash: contentHash("old"),
      change: {
        id: "move",
        kind: "move",
        target: old,
        toPath: "Workspace/Renamed",
        parent: root,
        expectedClass: "Folder",
      },
    },
    {
      ...base,
      id: "update",
      componentId: "world",
      beforeHash: contentHash("child"),
      lockedProperties: { Color: { kind: "color3_rgb8", r: 255, g: 128, b: 0 } },
      change: { id: "update", kind: "update", target: child, expectedClass: "Part" },
    },
    {
      ...base,
      id: "remove",
      componentId: "world",
      beforeHash: contentHash("removed"),
      change: { id: "remove", kind: "delete", target: removed, expectedClass: "Folder" },
    },
    {
      ...base,
      id: "new",
      componentId: "ui",
      outputId: "NewRoot",
      change: {
        id: "new",
        kind: "create",
        path: "Workspace/New",
        parent: root,
        className: "Folder",
        initialization: "initial_properties",
      },
    },
    {
      ...base,
      id: "nested",
      componentId: "ui",
      outputId: "nested_child",
      dependencies: ["new"],
      change: {
        id: "nested",
        kind: "create",
        path: "Workspace/New/Nested",
        parent: gameGeneratedTarget({
          projectId: "hierarchy",
          operationId: "new",
          path: "Workspace/New",
          className: "Folder",
        }),
        className: "Folder",
        initialization: "initial_properties",
      },
    },
    {
      ...base,
      id: "source",
      componentId: "world",
      source: { fileId: "worker", content: { kind: "slot", maximumUtf8Bytes: 4096 } },
      beforeSourceHash: contentHash("return {}"),
      beforeSourceBytes: 9,
      change: {
        id: "source",
        kind: "edit_source",
        target: worker,
        expectedClass: "ModuleScript",
      },
    },
  ];
  const initialTopology = [
    {
      identity: identity("root"),
      name: "Workspace",
      path: "Workspace",
      className: "Workspace",
      engineContainer: { path: "Workspace", className: "Workspace" },
    },
    { ...old, name: "Old", parentIdentity: identity("root") },
    { ...child, name: "Child", parentIdentity: old.identity },
    { ...worker, name: "Worker", parentIdentity: old.identity },
    { ...removed, name: "RemoveMe", parentIdentity: identity("root") },
    {
      ...target("unrelated", "Workspace/NotApproved"),
      name: "NotApproved",
      parentIdentity: identity("root"),
    },
  ];
  return compileGamePlan({
    projectId: "hierarchy",
    project: { name: "Hierarchy", placeId: 0, universeId: 0 },
    sessionId: "hierarchy-session",
    observedRevisionHash: contentHash("revision"),
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "hierarchy",
      intent: "Navigate the exact accepted targets",
      components: ["world", "ui"].map((id) => ({
        kind: "recipe_instance" as const,
        id,
        definition: gameRecipeDefinitionLock(definition),
        config: {},
      })),
      connections: [],
      artifactDependencies: [],
    },
    registry: createGameDefinitionRegistry([definition]),
    inventory: reverse ? inventory.reverse() : inventory,
    initialTopology: reverse ? initialTopology.reverse() : initialTopology,
  });
}

test("builder hierarchy contains every accepted target at its final path and separates deletions", () => {
  const plan = fixture();
  const { hierarchy, sourcePaths } = createCreatorBuilderNavigation(plan, creatorPlanHash);
  assert.equal(hierarchy.available, true);
  if (!hierarchy.available) throw new Error("Hierarchy unavailable");
  assert.equal(hierarchy.creatorPlanHash, creatorPlanHash);
  assert.equal(hierarchy.planHash, plan.hash);
  assert.equal(hierarchy.operationCount, plan.inventory.length);
  assert.deepEqual(hierarchy.components, [
    {
      componentId: "ui",
      instances: [
        ["Workspace/New", "Folder", "NewRoot"],
        ["Workspace/New/Nested", "Folder", "nested_child"],
      ],
      removed: [],
    },
    {
      componentId: "world",
      instances: [
        ["Workspace/Renamed", "Folder"],
        ["Workspace/Renamed/Child", "Part"],
        ["Workspace/Renamed/Worker", "ModuleScript"],
      ],
      removed: [["Workspace/RemoveMe", "Folder"]],
    },
  ]);
  assert.equal(
    hierarchy.components.reduce(
      (sum, group) => sum + group.instances.length + group.removed.length,
      0,
    ),
    plan.inventory.length,
  );
  assert.doesNotMatch(
    stableJson(hierarchy),
    /NotApproved|lockedProperties|Color|attributes|sourceHash/,
  );
  const { hash, ...payload } = hierarchy;
  assert.equal(hash, contentHash(stableJson(payload)));
  const source = createGameSourceContextReader(plan)({
    planHash: plan.hash,
    operationId: "source",
    offset: 0,
  });
  assert.equal(sourcePaths.get("source"), source.source.path);
  assert.equal(sourcePaths.size, plan.inventory.filter((item) => item.source).length);
  assert.ok(
    hierarchy.components.some((group) =>
      group.instances.some(
        (row) => row[0] === source.source.path && row[1] === source.source.className,
      ),
    ),
  );
});

test("builder hierarchy sorting and hashes are reproducible and bind exact plan identity", () => {
  const plan = fixture();
  assert.deepEqual(
    createCreatorBuilderNavigation(plan, creatorPlanHash),
    createCreatorBuilderNavigation(fixture(true), creatorPlanHash),
  );
  assert.notDeepEqual(
    createCreatorBuilderNavigation(plan, creatorPlanHash),
    createCreatorBuilderNavigation(plan, contentHash("other creator plan")),
  );
  const changed = structuredClone(plan);
  (changed.inventory[0]!.change as { path: string }).path = "Workspace/Tampered";
  assert.throws(() => createCreatorBuilderNavigation(changed, creatorPlanHash), /identity/);
});

test("an oversized complete hierarchy is explicitly unavailable and never silently truncated", () => {
  const plan = fixture();
  const full = createCreatorBuilderNavigation(plan, creatorPlanHash).hierarchy;
  assert.equal(full.available, true);
  const requiredBytes = Buffer.byteLength(stableJson(full));
  assert.deepEqual(
    createCreatorBuilderNavigation(plan, creatorPlanHash, requiredBytes).hierarchy,
    full,
  );
  const { hierarchy: oversized, sourcePaths } = createCreatorBuilderNavigation(
    plan,
    creatorPlanHash,
    requiredBytes - 1,
  );
  assert.equal(sourcePaths.get("source"), "Workspace/Renamed/Worker");
  assert.equal(oversized.available, false);
  if (oversized.available) throw new Error("Expected unavailable hierarchy");
  assert.equal(oversized.requiredBytes, requiredBytes);
  assert.equal("components" in oversized, false);
  assert.match(oversized.reason, /no rows were included.*game.inspect_inventory/);
  for (const bound of [0, -1, NaN, 1024 * 1024 + 1])
    assert.throws(() => createCreatorBuilderNavigation(plan, creatorPlanHash, bound), /byte bound/);
});
