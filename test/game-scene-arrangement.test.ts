import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CompositionError } from "../packages/game-composition/src/common.js";
import {
  compileSceneArrangement,
  SCENE_ARRANGEMENT_CONFIG_SCHEMA,
  SCENE_ARRANGEMENT_DEFINITION,
  type SceneArrangementConfig,
} from "../packages/game-composition/src/scene-arrangement.js";
import { compileGamePlan, materializeGameBuildGraph } from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";
import { sceneTransformVector } from "../packages/game-composition/src/scene-geometry.js";

const context = {
  componentId: "structures",
  projectId: "arrangement-test",
  designHash: "a".repeat(64),
};
const zero = { x: 0, y: 0, z: 0 };
type Node = SceneArrangementConfig["motifs"][number]["nodes"][number];
function node(id: string): Node {
  return {
    id,
    name: id,
    surfaceId: "shell",
    shape: "Block",
    size: { x: 2, y: 2, z: 2 },
    placement: { offset: zero },
    anchored: true,
    collidable: true,
  };
}
function config(): SceneArrangementConfig {
  return {
    rootName: "Structures",
    parentPath: "Workspace",
    surfaces: [{ id: "shell", color: { r: 24, g: 48, b: 80 }, material: "Metal" }],
    motifs: [{ id: "authored-object", nodes: [node("body")], constraints: [] }],
    arrangements: [
      {
        id: "row",
        name: "Row",
        motifId: "authored-object",
        frame: { offset: zero },
        pattern: { kind: "linear", memberIds: ["first", "second"], step: { x: 4, y: 0, z: 0 } },
      },
    ],
  };
}
function frame(output: ReturnType<typeof compileSceneArrangement>, alias: string): number[] {
  const value = output.inventory.find((item) => item.outputId === alias)?.lockedProperties.CFrame;
  assert.equal(value?.kind, "cframe_f32x12");
  if (value?.kind !== "cframe_f32x12") throw new Error("Missing frame");
  return [...value.components];
}
function rejects(value: SceneArrangementConfig, code: string, detail: RegExp): void {
  assert.throws(
    () => compileSceneArrangement(context, value),
    (error) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, code);
      assert.match(error.message, detail);
      return true;
    },
  );
}

test("authored motifs share surfaces and preserve independent parent and placement frames", () => {
  const value = config();
  value.surfaces.push({
    id: "glass",
    color: { r: 80, g: 180, b: 200 },
    material: "Glass",
    transparency: 0.4,
    reflectance: 0.2,
    castShadow: false,
  });
  const inset = node("inset");
  inset.parentId = "body";
  inset.surfaceId = "glass";
  inset.placement = { relativeTo: "body", offset: { x: 2, y: 0, z: 0 } };
  value.motifs[0]!.nodes = [
    inset,
    {
      ...node("body"),
      shape: "Wedge",
      placement: { offset: { x: 0, y: 3, z: 0 }, rotationDegrees: { x: 0, y: 90, z: 0 } },
    },
  ];
  value.arrangements[0]!.frame = {
    offset: { x: 10, y: 0, z: 20 },
    rotationDegrees: { x: 0, y: 90, z: 0 },
  };
  const output = compileSceneArrangement(context, value);
  assert.equal(output.inventory.length, 8);
  assert.equal(output.provenance.length, 8);
  assert.deepEqual(
    frame(output, "arrangement/row/member/first/node/body").slice(0, 3),
    [10, 3, 20],
  );
  assert.deepEqual(
    frame(output, "arrangement/row/member/first/node/inset").slice(0, 3),
    [8, 3, 20],
  );
  assert.deepEqual(
    frame(output, "arrangement/row/member/second/node/inset").slice(0, 3),
    [8, 3, 16],
  );
  const body = output.inventory.find(
    (item) => item.outputId === "arrangement/row/member/first/node/body",
  )!;
  const child = output.inventory.find(
    (item) => item.outputId === "arrangement/row/member/first/node/inset",
  )!;
  assert.equal(body.change.kind === "create" && body.change.className, "WedgePart");
  assert.deepEqual(child.dependencies, [body.id]);
  assert.deepEqual(child.lockedProperties.Transparency, {
    kind: "number_f32",
    value: Math.fround(0.4),
  });
  assert.deepEqual(child.lockedProperties.CastShadow, { kind: "boolean", value: false });
  assert.deepEqual(
    output.provenance.find((entry) => entry.operationId === child.id),
    {
      operationId: child.id,
      outputId: "arrangement/row/member/first/node/inset",
      arrangementId: "row",
      memberId: "first",
      motifId: "authored-object",
      nodeId: "inset",
      surfaceId: "glass",
    },
  );
});

test("arrangement frame DAG composes rotations without reparenting repeated objects", () => {
  const value = config();
  value.arrangements[0]!.frame = {
    offset: { x: 10, y: 20, z: 30 },
    rotationDegrees: { x: 0, y: 90, z: 0 },
  };
  value.arrangements.push({
    id: "raised",
    name: "Raised",
    motifId: "authored-object",
    frame: {
      relativeTo: "row",
      offset: { x: 4, y: 2, z: 1 },
      rotationDegrees: { x: 90, y: 0, z: 0 },
    },
    pattern: { kind: "explicit", members: [{ id: "only", offset: { x: 0, y: 0, z: 2 } }] },
  });
  const output = compileSceneArrangement(context, value);
  assert.deepEqual(
    frame(output, "arrangement/raised/member/only/node/body").slice(0, 3),
    [11, 20, 26],
  );
  const raised = output.inventory.find((item) => item.outputId === "arrangement/raised")!;
  assert.equal(
    raised.change.kind === "create" && raised.change.path,
    "Workspace/Structures/Raised",
  );
});

test("radial placements support authored plane and orientation without changing primitive bounds", () => {
  const value = config();
  value.arrangements[0]!.pattern = {
    kind: "radial",
    memberIds: ["east", "north", "west", "south"],
    radiusStuds: 10,
    startDegrees: 0,
    stepDegrees: 90,
    orientation: "outward",
  };
  const output = compileSceneArrangement(context, value);
  for (const [id, expected] of [
    ["east", [10, 0, 0]],
    ["north", [0, 0, -10]],
    ["west", [-10, 0, 0]],
    ["south", [0, 0, 10]],
  ] as const) {
    const cframe = frame(output, `arrangement/row/member/${id}/node/body`);
    cframe
      .slice(0, 3)
      .forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-5));
    const facing = sceneTransformVector(
      cframe.slice(3) as unknown as Parameters<typeof sceneTransformVector>[0],
      { x: 0, y: 0, z: -1 },
    );
    assert.ok(Math.abs(facing.x - expected[0] / 10) < 1e-6);
    assert.ok(Math.abs(facing.z - expected[2] / 10) < 1e-6);
  }
  value.arrangements[0]!.frame.rotationDegrees = { x: 90, y: 0, z: 0 };
  const tilted = frame(
    compileSceneArrangement(context, value),
    "arrangement/row/member/north/node/body",
  );
  assert.ok(Math.abs(tilted[1]! - 10) < 1e-5);
  assert.ok(Math.abs(tilted[2]!) < 1e-5);
});

test("stable placement identities survive declaration reordering and local edits", () => {
  const value = config();
  value.arrangements[0]!.pattern = {
    kind: "explicit",
    members: [
      { id: "second", offset: { x: 8, y: 0, z: 0 } },
      { id: "first", offset: zero },
    ],
  };
  value.motifs[0]!.nodes.push({
    ...node("cap"),
    parentId: "body",
    placement: { offset: { x: 0, y: 2, z: 0 } },
  });
  const before = compileSceneArrangement(context, value);
  value.motifs[0]!.nodes.reverse();
  value.arrangements[0]!.pattern.members.reverse();
  assert.equal(
    contentHash(stableJson(compileSceneArrangement(context, value))),
    contentHash(stableJson(before)),
  );
  value.arrangements[0]!.pattern.members.find((entry) => entry.id === "second")!.offset.x = 12;
  const after = compileSceneArrangement(context, value);
  for (const original of before.inventory) {
    const current = after.inventory.find((item) => item.outputId === original.outputId)!;
    assert.equal(current.id, original.id);
    if (!original.outputId!.startsWith("arrangement/row/member/second/node/"))
      assert.deepEqual(current, original);
  }
});

test("declared separation uses complete transformed member bounds and names conflicting members", () => {
  const value = config();
  value.separation = [
    {
      first: { arrangementId: "row", memberId: "first" },
      second: { arrangementId: "row", memberId: "second" },
      clearanceStuds: 2,
    },
  ];
  assert.equal(compileSceneArrangement(context, value).inventory.length, 6);
  value.separation[0]!.clearanceStuds = 2.001;
  rejects(value, "unsatisfiable_constraint", /row\/member\/first.*row\/member\/second/);
  delete value.separation;
  value.arrangements[0]!.pattern = { kind: "linear", memberIds: ["first", "second"], step: zero };
  assert.equal(
    compileSceneArrangement(context, value).inventory.length,
    6,
    "Compound detail may intentionally overlap without a separation obligation",
  );
  value.separation = [
    {
      first: { arrangementId: "row", memberId: "missing" },
      second: { arrangementId: "row", memberId: "second" },
      clearanceStuds: 0,
    },
  ];
  rejects(value, "unknown_reference", /missing/);
});

test("motif topology, missing references, duplicate paths and cycles fail before producing authority", () => {
  const value = config();
  value.motifs[0]!.nodes[0]!.parentId = "missing";
  rejects(value, "invalid_scene", /motifs\/authored-object.*missing/);
  delete value.motifs[0]!.nodes[0]!.parentId;
  value.arrangements[0]!.frame.relativeTo = "row";
  rejects(value, "placement_cycle", /row -> row/);
  value.arrangements[0]!.frame.relativeTo = "missing";
  rejects(value, "unknown_reference", /row.*missing/);
  delete value.arrangements[0]!.frame.relativeTo;
  value.arrangements.push({ ...structuredClone(value.arrangements[0]!), id: "other" });
  rejects(value, "duplicate_path", /other.*Row/);
  value.arrangements.pop();
  value.arrangements[0]!.pattern = { kind: "linear", memberIds: ["first", "first"], step: zero };
  rejects(value, "duplicate_id", /row\/members\/first/);
  value.arrangements[0]!.pattern.memberIds = ["first"];
  value.motifs[0]!.nodes[0]!.surfaceId = "missing";
  rejects(value, "unknown_reference", /authored-object.*body.*missing/);
});

test("arrangement exact expansion budget includes folders and rejects overflowing frames", () => {
  const value = config();
  value.motifs[0]!.nodes = Array.from({ length: 15 }, (_, index) => node(`detail-${index}`));
  value.arrangements[0]!.pattern = {
    kind: "linear",
    memberIds: Array.from({ length: 511 }, (_, index) => `copy-${index}`),
    step: { x: 4, y: 0, z: 0 },
  };
  value.motifs.push({
    id: "smaller",
    nodes: Array.from({ length: 12 }, (_, index) => node(`part-${index}`)),
    constraints: [],
  });
  value.arrangements.push({
    id: "last",
    name: "Last",
    motifId: "smaller",
    frame: { offset: zero },
    pattern: { kind: "explicit", members: [{ id: "only", offset: zero }] },
  });
  assert.equal(compileSceneArrangement(context, value).inventory.length, 8192);
  value.arrangements[0]!.pattern.memberIds.push("overflow");
  rejects(value, "resource_limit", /arrangements\/row.*maximum 8192/);
  const outOfBounds = config();
  outOfBounds.arrangements[0]!.pattern = {
    kind: "linear",
    memberIds: ["first", "second"],
    step: { x: 200000, y: 0, z: 0 },
  };
  rejects(outOfBounds, "placement_bounds", /second.*100000/);
});

test("motif clearances are rechecked after final float32 placement and constraint work is bounded", () => {
  const value = config();
  const first = node("first");
  const second = node("second");
  first.size = { x: 0.001, y: 0.001, z: 0.001 };
  second.size = first.size;
  second.placement = { offset: { x: 0.002, y: 0, z: 0 } };
  value.motifs[0]!.nodes = [first, second];
  value.motifs[0]!.constraints = [
    { kind: "separation", first: "first", second: "second", clearance: 0.0009 },
  ];
  value.arrangements[0]!.pattern = { kind: "linear", memberIds: ["only"], step: zero };
  assert.equal(compileSceneArrangement(context, value).inventory.length, 5);
  value.arrangements[0]!.frame.offset = { x: 100000, y: 0, z: 0 };
  rejects(value, "unsatisfiable_constraint", /row\/member\/only.*float32 placement.*first.*second/);
  value.arrangements[0]!.frame.offset = zero;
  value.motifs[0]!.constraints = Array.from({ length: 1024 }, () => ({
    kind: "separation",
    first: "first",
    second: "second",
    clearance: 0.0009,
  }));
  value.arrangements[0]!.pattern.memberIds = Array.from(
    { length: 65 },
    (_, index) => `member-${index}`,
  );
  rejects(value, "resource_limit", /constraint checks.*65536/);
});

test("a detailed authored motif expands through the ordinary multi-partition game graph", () => {
  const value = config();
  value.motifs[0]!.nodes = [node("body"), { ...node("cap"), parentId: "body" }];
  value.arrangements[0]!.pattern = {
    kind: "linear",
    memberIds: Array.from({ length: 50 }, (_, index) => `placement-${index}`),
    step: { x: 4, y: 0, z: 0 },
  };
  assert.deepEqual(SCENE_ARRANGEMENT_CONFIG_SCHEMA.parse(value), value);
  const output = compileSceneArrangement(context, value);
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "authored-environment",
    intent: "Repeat creator-authored detailed objects with fixed relative frames.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(SCENE_ARRANGEMENT_DEFINITION),
        config: value as unknown as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const plan = compileGamePlan({
    design,
    registry: createGameDefinitionRegistry([SCENE_ARRANGEMENT_DEFINITION]),
    projectId: context.projectId,
    project: { name: "Scene arrangement", placeId: 0, universeId: 0 },
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ],
    sessionId: "scene-arrangement",
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
  assert.equal(material.graph.operations.length, 152);
  assert.ok(material.graph.partitions.length >= 2);
  assert.equal(material.graph.localChecks.status, "incomplete");
  assert.equal(new Set(output.inventory.map((item) => item.outputId)).size, 152);
  assert.deepEqual(output.sources, []);
});

test("public host-authored observatory expands varied geometry through exact reviewed partitions", async () => {
  const value = JSON.parse(
    await readFile("examples/visual-composition/observatory.scene.json", "utf8"),
  ) as SceneArrangementConfig;
  assert.equal(
    value.motifs.reduce((count, motif) => count + motif.nodes.length, 0),
    40,
  );
  const output = compileSceneArrangement(context, value);
  assert.equal(output.inventory.length, 346);
  assert.equal(output.inventory.filter((item) => "CFrame" in item.lockedProperties).length, 307);
  const classes = new Set(
    output.inventory
      .filter((item) => item.change.kind === "create")
      .map((item) => (item.change.kind === "create" ? item.change.className : "")),
  );
  assert.deepEqual([...classes].sort(), ["CornerWedgePart", "Folder", "Part", "WedgePart"]);
  assert.ok(
    output.inventory.some(
      (item) =>
        item.lockedProperties.Transparency?.kind === "number_f32" &&
        item.lockedProperties.Transparency.value > 0,
    ),
  );
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "public-observatory-example",
    intent: "Inspect a disclosed host-authored visual composition through the ordinary compiler.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(SCENE_ARRANGEMENT_DEFINITION),
        config: value as unknown as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const plan = compileGamePlan({
    design,
    registry: createGameDefinitionRegistry([SCENE_ARRANGEMENT_DEFINITION]),
    projectId: context.projectId,
    project: { name: "Public visual example", placeId: 0, universeId: 0 },
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ],
    sessionId: "visual-example",
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
  assert.equal(material.graph.operations.length, 346);
  assert.ok(material.graph.partitions.length >= 3);
  assert.equal(material.graph.localChecks.status, "incomplete");
  value.motifs.reverse();
  value.surfaces.reverse();
  value.arrangements.reverse();
  assert.deepEqual(compileSceneArrangement(context, value), output);
});
