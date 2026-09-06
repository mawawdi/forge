import assert from "node:assert/strict";
import test from "node:test";
import { CompositionError } from "../packages/game-composition/src/common.js";
import {
  compileScenePrimitives,
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_PRIMITIVES_EXPANDER,
  type ScenePrimitivesConfig,
} from "../packages/game-composition/src/scene.js";
import {
  collectSceneValidationIssues,
  resolveScene,
  type SceneValidationDiagnostics,
} from "../packages/game-composition/src/scene-validation.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import { validateCreatorGameComponent } from "../packages/creator-session/src/game-authoring.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";

const context = { componentId: "world", projectId: "scene-test", designHash: "a".repeat(64) };
function node(id: string): ScenePrimitivesConfig["nodes"][number] {
  return {
    id,
    name: id,
    shape: "Block",
    size: { x: 2, y: 2, z: 2 },
    placement: { offset: { x: 0, y: 0, z: 0 } },
    color: { r: 20, g: 30, b: 40 },
    material: "Plastic",
    anchored: true,
    collidable: true,
  };
}
function scene(ids = ["floor", "marker"]): ScenePrimitivesConfig {
  return {
    rootName: "Objects",
    parentPath: "Workspace",
    nodes: ids.map(node),
    constraints: [],
  };
}
function report(action: () => unknown): SceneValidationDiagnostics {
  let result: SceneValidationDiagnostics | undefined;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CompositionError);
    assert.equal(error.code, "invalid_scene");
    result = JSON.parse(error.message) as SceneValidationDiagnostics;
    return true;
  });
  return result!;
}

test("scene reports undeclared root and independent references with exact component paths", () => {
  const config = scene();
  // Minimal regression for the trial's scene-local/output-alias namespace confusion.
  config.nodes[0]!.placement.relativeTo = "root";
  config.nodes[1]!.parentId = "elsewhere";
  config.constraints = [
    { kind: "containment", first: "unknown-first", second: "unknown-second", clearance: 0 },
  ];
  const before = structuredClone(config);
  const diagnostics = collectSceneValidationIssues(config, context.componentId);
  assert.equal(diagnostics.componentId, "world");
  assert.deepEqual(diagnostics.validIds.nodes, ["floor", "marker"]);
  assert.deepEqual(
    diagnostics.issues.map((issue) => [issue.path, issue.actual]),
    [
      ["nodes[0].placement.relativeTo", "root"],
      ["nodes[1].parentId", "elsewhere"],
      ["constraints[0].first", "unknown-first"],
      ["constraints[0].second", "unknown-second"],
    ],
  );
  assert.deepEqual(
    report(() => compileScenePrimitives(context, config)),
    diagnostics,
  );
  assert.deepEqual(config, before);
});

test("scene cycles, duplicate identities and sibling conflicts aggregate without blaming dependents", () => {
  const config = scene(["a", "b", "child", "c", "d", "duplicate", "duplicate"]);
  config.nodes[0]!.placement.relativeTo = "b";
  config.nodes[1]!.placement.relativeTo = "a";
  config.nodes[2]!.placement.relativeTo = "a";
  config.nodes[3]!.parentId = "d";
  config.nodes[4]!.parentId = "c";
  config.nodes[2]!.parentId = "duplicate";
  config.nodes[0]!.name = "same";
  config.nodes[1]!.name = "same";
  const diagnostics = collectSceneValidationIssues(config, "geometry");
  assert.deepEqual(
    diagnostics.issues
      .filter((issue) => issue.code === "placement_cycle")
      .map((issue) => issue.nodeId)
      .sort(),
    ["a", "b"],
  );
  assert.deepEqual(
    diagnostics.issues
      .filter((issue) => issue.code === "parent_cycle")
      .map((issue) => issue.nodeId)
      .sort(),
    ["c", "d"],
  );
  assert.equal(diagnostics.issues.filter((issue) => issue.code === "duplicate_id").length, 2);
  assert.equal(diagnostics.issues.filter((issue) => issue.code === "duplicate_path").length, 2);
  assert.ok(
    diagnostics.issues.some(
      (issue) => issue.code === "ambiguous_reference" && issue.path === "nodes[2].parentId",
    ),
  );
  assert.deepEqual(diagnostics.unresolvedPlacementNodeIds, ["a", "b", "child", "duplicate"]);
});

test("scene preserves float32 placement and declared separation/containment comparisons", () => {
  const config = scene(["outer", "inner", "separate"]);
  config.nodes[0]!.size = { x: 10, y: 10, z: 10 };
  config.nodes[0]!.placement.offset.x = 0.1;
  config.nodes[1]!.placement = { relativeTo: "outer", offset: { x: 0.2, y: 0, z: 0 } };
  config.nodes[2]!.placement.offset.x = 20;
  config.constraints = [
    { kind: "containment", first: "inner", second: "outer", clearance: 1 },
    { kind: "separation", first: "outer", second: "separate", clearance: 2 },
  ];
  const resolved = resolveScene(config, "geometry");
  assert.equal(resolved.positions.get("inner")!.x, Math.fround(Math.fround(0.1) + 0.2));
  const output = compileScenePrimitives(context, config);
  const reversed = structuredClone(config);
  reversed.nodes.reverse();
  assert.deepEqual(compileScenePrimitives(context, reversed).inventory, output.inventory);
  config.constraints[0]!.clearance = 5;
  config.constraints[1]!.clearance = 20;
  const diagnostics = collectSceneValidationIssues(config, "geometry");
  assert.deepEqual(
    diagnostics.issues.map((issue) => issue.path),
    ["constraints[0]", "constraints[1]"],
  );
  assert.ok(diagnostics.issues.every((issue) => issue.code === "unsatisfiable_constraint"));
  assert.match(diagnostics.issues[0]!.detail, /containment failed/);
  assert.match(diagnostics.issues[1]!.detail, /separation failed/);
  config.nodes[2]!.placement.offset.x = 100001;
  const bounds = collectSceneValidationIssues(config, "geometry");
  assert.ok(
    bounds.issues.some(
      (issue) => issue.code === "placement_bounds" && issue.path === "nodes[2].placement",
    ),
  );
  assert.ok(
    !bounds.issues.some((issue) => issue.path === "constraints[1]"),
    "unresolved positions must not invent constraint measurements",
  );
});

test("root is an ordinary declared node ID and hierarchy does not scope relative placement", () => {
  const config = scene(["root", "child", "other"]);
  config.nodes[0]!.placement.offset.x = 8;
  config.nodes[1]!.parentId = "other";
  config.nodes[1]!.placement.relativeTo = "root";
  const resolved = resolveScene(config, "geometry");
  assert.equal(resolved.positions.get("child")!.x, 8);
  assert.equal(resolved.positions.get("other")!.x, 0);
  assert.ok(resolved.parentOrder.indexOf("other") < resolved.parentOrder.indexOf("child"));
  assert.equal(compileScenePrimitives(context, config).inventory.length, 4);
});

test("real draft scene admission shares compiler diagnostics and preserves failed replacements", () => {
  const draft = new CreatorDesignDraft({
    definitions: [SCENE_PRIMITIVES_DEFINITION],
    registry: createGameDefinitionRegistry([SCENE_PRIMITIVES_DEFINITION]),
    expanders: [SCENE_PRIMITIVES_EXPANDER],
    lockedSources: new Map(),
    validateComponent: validateCreatorGameComponent,
  });
  const component = (config: ScenePrimitivesConfig) => ({
    kind: "recipe_instance" as const,
    id: context.componentId,
    definition: gameRecipeDefinitionLock(SCENE_PRIMITIVES_DEFINITION),
    config: config as unknown as GameJsonValue,
  });
  const invalid = scene();
  invalid.nodes[0]!.placement.relativeTo = "root";
  const expected = report(() => compileScenePrimitives(context, invalid));
  const initial = draft.snapshot();
  assert.deepEqual(
    report(() => draft.define({ component: component(invalid) })),
    expected,
  );
  assert.deepEqual(draft.snapshot(), initial);
  draft.define({ component: component(scene()) });
  const retained = draft.snapshot();
  assert.deepEqual(
    report(() => draft.define({ component: component(invalid) })),
    expected,
  );
  assert.deepEqual(draft.snapshot(), retained);
});
