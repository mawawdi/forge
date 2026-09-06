import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CompositionError } from "../packages/game-composition/src/common.js";
import {
  compileScenePrimitives,
  SCENE_PRIMITIVES_CONFIG_SCHEMA,
  SCENE_PRIMITIVES_DEFINITION,
  type ScenePrimitivesConfig,
} from "../packages/game-composition/src/scene.js";
import {
  collectSceneValidationIssues,
  resolveScene,
} from "../packages/game-composition/src/scene-validation.js";
import {
  sceneEulerXyz,
  sceneHalfExtents,
  sceneTransformVector,
} from "../packages/game-composition/src/scene-geometry.js";
import { compileGamePlan, materializeGameBuildGraph } from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";

const context = { componentId: "objects", projectId: "scene-visual", designHash: "a".repeat(64) };
type Node = ScenePrimitivesConfig["nodes"][number];
function node(id: string, shape: Node["shape"] = "Block"): Node {
  return {
    id,
    name: id,
    shape,
    size: { x: 2, y: 2, z: 2 },
    placement: { offset: { x: 0, y: 0, z: 0 } },
    color: { r: 64, g: 128, b: 192 },
    material: "Metal",
    anchored: true,
    collidable: true,
  };
}
function scene(nodes: Node[]): ScenePrimitivesConfig {
  return { rootName: "Objects", parentPath: "Workspace", nodes, constraints: [] };
}

test("scene XYZ convention agrees with fixed offline Lune CFrame cases", () => {
  const result = spawnSync("lune", ["run", "test/game-scene-geometry.luau"], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const cases = JSON.parse(result.stdout) as { angles: number[]; components: number[] }[];
  assert.equal(cases.length, 6);
  for (const sample of cases) {
    const actual = sceneEulerXyz({
      x: sample.angles[0]!,
      y: sample.angles[1]!,
      z: sample.angles[2]!,
    });
    const expected = sample.components.slice(3);
    assert.equal(expected.length, 9);
    for (let index = 0; index < 9; index++)
      assert.ok(
        Math.abs(actual[index]! - expected[index]!) < 5e-7,
        `${sample.angles.join(",")} matrix entry ${index}: ${actual[index]} != ${expected[index]}`,
      );
  }
  // Lune's datatype implementation is a numeric cross-check, not native Studio evidence.
});

test("reference frames rotate offsets and compose local rotation independently of hierarchy", () => {
  const reference = node("reference");
  reference.placement = { offset: { x: 10, y: 20, z: 30 }, rotationDegrees: { x: 0, y: 90, z: 0 } };
  const child = node("child");
  child.placement = {
    relativeTo: "reference",
    offset: { x: 4, y: 2, z: 1 },
    rotationDegrees: { x: 90, y: 0, z: 0 },
  };
  const hierarchyOnly = node("hierarchy-only");
  hierarchyOnly.parentId = "reference";
  hierarchyOnly.placement.offset = { x: 1, y: 2, z: 3 };
  const config = scene([child, hierarchyOnly, reference]);
  const resolved = resolveScene(config, context.componentId);
  assert.deepEqual(resolved.positions.get("reference"), { x: 10, y: 20, z: 30 });
  assert.deepEqual(resolved.positions.get("child"), { x: 11, y: 22, z: 26 });
  assert.deepEqual(resolved.rotations.get("child"), [0, 1, 0, 0, 0, -1, -1, 0, 0]);
  assert.deepEqual(resolved.positions.get("hierarchy-only"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(resolved.rotations.get("hierarchy-only"), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const output = compileScenePrimitives(context, config);
  config.nodes.reverse();
  assert.deepEqual(compileScenePrimitives(context, config).inventory, output.inventory);
  const childItem = output.inventory.find((item) => item.outputId === "node/child")!;
  const change = childItem.change;
  assert.equal(change.kind, "create");
  if (change.kind === "create")
    assert.deepEqual(childItem.lockedProperties.CFrame, {
      kind: "cframe_f32x12",
      components: [11, 22, 26, 0, 1, 0, 0, 0, -1, -1, 0, 0],
    });
});

test("scene ABI 3 materializes admitted wedge classes and optional surface controls through the real graph", () => {
  const config = scene([
    node("wedge", "Wedge"),
    node("corner", "CornerWedge"),
    node("ball", "Ball"),
    node("cylinder", "Cylinder"),
  ]);
  Object.assign(config.nodes[0]!, { transparency: 0.3, reflectance: 0.1, castShadow: false });
  config.nodes[0]!.placement.rotationDegrees = { x: 30, y: 45, z: 60 };
  assert.equal(SCENE_PRIMITIVES_DEFINITION.abi, "3");
  assert.deepEqual(SCENE_PRIMITIVES_CONFIG_SCHEMA.parse(config), config);
  const output = compileScenePrimitives(context, config);
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "sculpture",
    intent: "Compose authored primitive geometry.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(SCENE_PRIMITIVES_DEFINITION),
        config: config as unknown as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const plan = compileGamePlan({
    design,
    registry: createGameDefinitionRegistry([SCENE_PRIMITIVES_DEFINITION]),
    projectId: context.projectId,
    project: { name: "Scene visual", placeId: 0, universeId: 0 },
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ],
    sessionId: "scene-visual",
    observedRevisionHash: "b".repeat(64),
    inventory: output.inventory,
  });
  const material = materializeGameBuildGraph({
    plan,
    acceptanceHash: "c".repeat(64),
    sources: [],
    values: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(material.graph.operations.length, 5);
  assert.equal(material.graph.localChecks.status, "incomplete");
  for (const [id, className] of [
    ["wedge", "WedgePart"],
    ["corner", "CornerWedgePart"],
    ["ball", "Part"],
    ["cylinder", "Part"],
  ]) {
    const item = output.inventory.find((item) => item.outputId === "node/" + id)!;
    const change = item.change;
    assert.equal(change.kind, "create");
    if (change.kind !== "create") continue;
    assert.equal(change.className, className);
    assert.equal("Shape" in item.lockedProperties, className === "Part");
    if (id === "wedge") {
      assert.deepEqual(item.lockedProperties.Transparency, {
        kind: "number_f32",
        value: Math.fround(0.3),
      });
      assert.deepEqual(item.lockedProperties.Reflectance, {
        kind: "number_f32",
        value: Math.fround(0.1),
      });
      assert.deepEqual(item.lockedProperties.CastShadow, { kind: "boolean", value: false });
    } else assert.equal("Transparency" in item.lockedProperties, false);
  }
  assert.match(output.limitations.join(" "), /native evidence/);
});

test("rotated separation uses conservative world bounds rather than unrotated Size", () => {
  const beam = node("beam");
  beam.size = { x: 10, y: 2, z: 2 };
  beam.placement.rotationDegrees = { x: 0, y: 45, z: 0 };
  const nearby = node("nearby");
  nearby.placement.offset.z = 3;
  const config = scene([beam, nearby]);
  config.constraints = [{ kind: "separation", first: "beam", second: "nearby", clearance: 0 }];
  const report = collectSceneValidationIssues(config, "objects");
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.path, "constraints[0]");
  assert.throws(() => compileScenePrimitives(context, config), CompositionError);
  nearby.placement.offset.z = 8;
  assert.equal(collectSceneValidationIssues(config, "objects").issues.length, 0);
});

test("non-axis containment rejects a box inside the outer world AABB but outside its oriented box", () => {
  const outer = node("outer");
  outer.size = { x: 10, y: 2, z: 2 };
  outer.placement.rotationDegrees = { x: 0, y: 45, z: 0 };
  const inner = node("inner");
  inner.size = { x: 0.5, y: 0.5, z: 0.5 };
  inner.placement.offset = { x: 3, y: 0, z: 3 };
  const config = scene([inner, outer]);
  config.constraints = [{ kind: "containment", first: "inner", second: "outer", clearance: 0 }];
  const outerAabb = sceneHalfExtents(sceneEulerXyz(outer.placement.rotationDegrees), outer.size);
  assert.ok(3.25 < outerAabb.x && 3.25 < outerAabb.z);
  const invalid = collectSceneValidationIssues(config, context.componentId);
  assert.equal(invalid.issues.length, 1);
  assert.match(invalid.issues[0]!.detail, /containment failed/);
  inner.placement = {
    relativeTo: "outer",
    offset: { x: 2, y: 0, z: 0 },
    rotationDegrees: { x: 0, y: 15, z: 0 },
  };
  assert.equal(collectSceneValidationIssues(config, context.componentId).issues.length, 0);
  assert.equal(compileScenePrimitives(context, config).inventory.length, 3);
});

test("conservative rotated extents enclose every authored Size corner", () => {
  const angles = { x: -37, y: 121, z: -83 };
  const rotation = sceneEulerXyz(angles);
  const size = { x: 19.3, y: 7.1, z: 0.45 };
  const half = sceneHalfExtents(rotation, size);
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1]) {
        const corner = sceneTransformVector(rotation, {
          x: (x * Math.fround(size.x)) / 2,
          y: (y * Math.fround(size.y)) / 2,
          z: (z * Math.fround(size.z)) / 2,
        });
        for (const axis of ["x", "y", "z"] as const)
          assert.ok(Math.abs(corner[axis]) <= half[axis]);
      }
});
