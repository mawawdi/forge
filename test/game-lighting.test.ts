import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";
import {
  COMPOSITION_CONFIG_SCHEMAS,
  compileSceneLighting,
  SCENE_LIGHTING_CONFIG_SCHEMA,
  SCENE_LIGHTING_DEFINITION,
  SCENE_LIGHTING_EXPANDER,
  validateSceneLightingConfig,
  type SceneLightingConfig,
} from "../packages/game-composition/src/index.js";
import {
  assertStudioValueForProperty,
  canonicalStudioValue,
  STUDIO_CAPABILITY_MANIFEST,
} from "../packages/studio-evidence/src/index.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";
import { validateCreatorGameComponent } from "../packages/creator-session/src/game-authoring.js";

const context = {
  componentId: "lighting",
  projectId: "lighting-project",
  designHash: "a".repeat(64),
};
const project = { name: "Authored lighting", placeId: 0, universeId: 0 };
const initialTopology: CreatorTransactionTopologyNode[] = ["Workspace", "Lighting"].map((path) => ({
  identity: { kind: "forge_attribute", stableId: "test-" + path },
  path,
  name: path,
  className: path,
  engineContainer: { path, className: path },
}));
function config(): SceneLightingConfig {
  const common = {
    color: { r: 200, g: 220, b: 250 },
    brightness: 1.2,
    range: 40,
    enabled: true,
    shadows: false,
  };
  return {
    rootName: "Authored lights",
    fixtures: [
      {
        id: "point",
        name: "Point",
        position: { x: 1.1, y: 3, z: 4 },
        size: { x: 1, y: 1, z: 1 },
        light: { kind: "point", ...common },
      },
      {
        id: "spot",
        name: "Spot",
        position: { x: 10, y: 4, z: 5 },
        rotationDegrees: { x: 0, y: 90, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        light: { kind: "spot", ...common, shadows: true, face: "Front", angle: 45 },
      },
      {
        id: "surface",
        name: "Surface",
        position: { x: 0, y: 8, z: 0 },
        size: { x: 10, y: 1, z: 6 },
        light: { kind: "surface", ...common, enabled: false, face: "Bottom", angle: 90 },
      },
    ],
    atmosphere: {
      name: "Air",
      color: { r: 220, g: 220, b: 240 },
      decay: { r: 150, g: 160, b: 200 },
      density: 0.2,
      offset: 0.1,
      haze: 1,
      glare: 0,
    },
    bloom: { name: "Bloom", enabled: true, intensity: 0.3, size: 24, threshold: 0.9 },
    colorCorrection: {
      name: "Tone",
      enabled: true,
      brightness: -0.05,
      contrast: 0.1,
      saturation: 1.5,
      tintColor: { r: 255, g: 240, b: 220 },
    },
  };
}
function build(input: SceneLightingConfig, topology = initialTopology) {
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "lighting-study",
    intent: "Review deliberate light placement and material readability.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(SCENE_LIGHTING_DEFINITION),
        config: input as unknown as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const registry = createGameDefinitionRegistry([SCENE_LIGHTING_DEFINITION]);
  const expanded = expandGameDesign({
    design,
    registry,
    projectId: context.projectId,
    project,
    initialTopology: topology,
    recipeExpanders: [SCENE_LIGHTING_EXPANDER],
  });
  const plan = compileGamePlan({
    design,
    registry,
    projectId: context.projectId,
    project,
    initialTopology: topology,
    sessionId: "lighting-session",
    observedRevisionHash: "b".repeat(64),
    inventory: expanded.inventory,
  });
  return {
    plan,
    ...materializeGameBuildGraph({
      plan,
      acceptanceHash: "c".repeat(64),
      values: [],
      sources: [],
      checks: { status: "incomplete", artifactHashes: [] },
    }),
  };
}

test("lighting expands all supported kinds through canonical GamePlan and the shared build graph", () => {
  const { plan, graph } = build(config());
  assert.equal(graph.operations.length, 10);
  assert.equal(plan.inventory.length, 10);
  assert.deepEqual(
    plan.inventory.map((item) => item.change.kind),
    Array(10).fill("create"),
  );
  assert.equal(
    plan.inventory.some(
      (item) => item.change.kind === "create" && String(item.change.className) === "Lighting",
    ),
    false,
  );
  for (const item of plan.inventory) {
    assert.equal(item.change.kind, "create");
    if (item.change.kind !== "create") continue;
    const className = item.change.className;
    const definition = STUDIO_CAPABILITY_MANIFEST.classes.find(
      (entry) => entry.name === className,
    )!;
    assert.ok(definition.creatable);
    for (const [name, value] of Object.entries(item.lockedProperties)) {
      const property = definition.properties.find((entry) => entry.name === name)!;
      assert.ok(property, `${definition.name}.${name} has an admitted property`);
      assertStudioValueForProperty(value, property);
      assert.deepEqual(canonicalStudioValue(value, property), value);
    }
    if (["Atmosphere", "BloomEffect", "ColorCorrectionEffect"].includes(item.change.className)) {
      assert.equal(item.change.parent.kind, "engine_container");
      assert.equal(item.change.parent.path, "Lighting");
    }
  }
  const output = compileSceneLighting(context, config());
  assert.equal(output.obligations.length, 2);
  assert.ok(output.obligations.some((item) => item.evidence === "creator_review"));
});

test("light carriers are inactive physics geometry with explicit face, orientation and source aliases", () => {
  const output = compileSceneLighting(context, config());
  const spot = output.inventory.find((item) => item.outputId === "fixture/spot")!;
  assert.deepEqual(spot.lockedProperties.CFrame, {
    kind: "cframe_f32x12",
    components: [10, 4, 5, 0, 0, 1, 0, 1, 0, -1, 0, 0],
  });
  for (const name of ["CanCollide", "CanTouch", "CanQuery", "CastShadow"])
    assert.deepEqual(spot.lockedProperties[name], { kind: "boolean", value: false });
  assert.deepEqual(spot.lockedProperties.Anchored, { kind: "boolean", value: true });
  assert.deepEqual(spot.lockedProperties.Transparency, { kind: "number_f32", value: 1 });
  const light = output.inventory.find((item) => item.outputId === "light/spot")!;
  assert.deepEqual(light.dependencies, [spot.id]);
  assert.deepEqual(light.lockedProperties.Face, { kind: "enum_name", value: "Front" });
  assert.deepEqual(light.lockedProperties.Shadows, { kind: "boolean", value: true });
  const point = output.inventory.find((item) => item.outputId === "fixture/point")!;
  assert.equal(point.lockedProperties.CFrame?.kind, "cframe_f32x12");
  if (point.lockedProperties.CFrame?.kind === "cframe_f32x12")
    assert.equal(point.lockedProperties.CFrame.components[0], Math.fround(1.1));
  const correction = output.inventory.find((item) => item.outputId === "color-correction")!;
  assert.deepEqual(correction.lockedProperties.Saturation, { kind: "number_f32", value: 1.5 });
  assert.equal(output.sources.length, 0);
  assert.match(output.limitations.join(" "), /not GPU/);
});

test("lighting identity and inventory ordering are independent of fixture declaration order", () => {
  const input = config();
  const first = compileSceneLighting(context, input);
  input.fixtures.reverse();
  assert.deepEqual(compileSceneLighting(context, input), first);
});

test("effect-only composition creates no hidden world fixtures or compulsory effects", () => {
  const input: SceneLightingConfig = {
    rootName: "Unused",
    fixtures: [],
    bloom: { name: "Soft highlight", enabled: false, intensity: 0.5, size: 10, threshold: 1 },
  };
  const { graph } = build(input);
  assert.equal(graph.operations.length, 1);
  assert.equal(graph.operations[0]?.target.path, "Lighting/Soft highlight");
  const onlyFixture: SceneLightingConfig = { rootName: "One", fixtures: [config().fixtures[0]!] };
  assert.equal(build(onlyFixture).graph.operations.length, 3);
});

test("lighting rejects duplicate identity, path collisions and empty requests before authoring", () => {
  const duplicateId = config();
  duplicateId.fixtures[1]!.id = duplicateId.fixtures[0]!.id;
  assert.throws(() => validateSceneLightingConfig(duplicateId), /duplicate composition id/);
  const duplicateName = config();
  duplicateName.fixtures[1]!.name = duplicateName.fixtures[0]!.name;
  assert.throws(() => validateSceneLightingConfig(duplicateName), /name is repeated/);
  const duplicateEffect = config();
  duplicateEffect.bloom!.name = duplicateEffect.atmosphere!.name;
  assert.throws(() => validateSceneLightingConfig(duplicateEffect), /effect name is repeated/);
  assert.throws(
    () => validateSceneLightingConfig({ rootName: "Empty", fixtures: [] }),
    /at least one/,
  );
  assert.throws(
    () =>
      build(config(), [
        ...initialTopology,
        {
          identity: { kind: "forge_attribute", stableId: "existing" },
          path: "Lighting/Bloom",
          name: "Bloom",
          className: "BloomEffect",
          parentIdentity: initialTopology[1]!.identity,
        },
      ]),
    /collision|already|duplicate/i,
  );
});

test("provider schema and compiler share closed bounded lighting controls without clamping", () => {
  assert.equal(COMPOSITION_CONFIG_SCHEMAS.get("scene-lighting"), SCENE_LIGHTING_CONFIG_SCHEMA);
  assert.doesNotThrow(() =>
    z.toJSONSchema(SCENE_LIGHTING_CONFIG_SCHEMA, { target: "draft-7", io: "input" }),
  );
  for (const [path, value] of [
    ["range", 61],
    ["brightness", -1],
    ["range", Infinity],
  ] as const) {
    const input = config();
    input.fixtures[0]!.light[path] = value;
    assert.throws(() => compileSceneLighting(context, input));
  }
  for (const value of [-1.01, 4.01, NaN]) {
    const input = config();
    input.colorCorrection!.saturation = value;
    assert.throws(() => compileSceneLighting(context, input));
  }
  const invalidFace = config();
  assert.throws(() =>
    compileSceneLighting(context, {
      ...invalidFace,
      fixtures: [
        {
          ...invalidFace.fixtures[1]!,
          light: { ...invalidFace.fixtures[1]!.light, face: "Forward" },
        },
      ],
    }),
  );
  assert.throws(() =>
    compileSceneLighting(context, { ...config(), ambient: { r: 0, g: 0, b: 0 } }),
  );
  let reads = 0;
  assert.throws(() =>
    compileSceneLighting(context, {
      get fixtures() {
        reads++;
        return [];
      },
    }),
  );
  assert.equal(reads, 0);
});

test("maximum declared fixtures compile deterministically into bounded existing partitions", () => {
  const input = config();
  input.fixtures = Array.from({ length: 128 }, (_, index) => ({
    ...input.fixtures[0]!,
    id: `light-${index}`,
    name: `Light ${index}`,
    position: { x: index * 5, y: 4, z: 0 },
  }));
  const { graph } = build(input);
  assert.equal(graph.operations.length, 260);
  assert.ok(graph.partitions.length > 1);
  assert.ok(graph.partitions.every((partition) => partition.operationIds.length <= 128));
  input.fixtures.push({ ...input.fixtures[0]!, id: "excess", name: "Excess" });
  assert.throws(() => compileSceneLighting(context, input));
});

test("authored coordinate and orientation boundaries pass the real canonical graph", () => {
  const input: SceneLightingConfig = { rootName: "Boundary", fixtures: [config().fixtures[0]!] };
  input.fixtures[0]!.position = { x: 100_000, y: -100_000, z: 100_000 };
  input.fixtures[0]!.rotationDegrees = { x: 360, y: -360, z: 360 };
  input.fixtures[0]!.size = { x: 0.05, y: 2048, z: 1 };
  const { graph } = build(input);
  assert.equal(graph.operations.length, 3);
  input.fixtures[0]!.position.x = 100_001;
  assert.throws(() => compileSceneLighting(context, input));
});

test("creator catalog rejects invalid lighting before draft retention using the installed lock", () => {
  const input = config();
  const component = {
    kind: "recipe_instance" as const,
    id: "lighting",
    definition: gameRecipeDefinitionLock(SCENE_LIGHTING_DEFINITION),
    config: input as unknown as GameJsonValue,
  };
  assert.doesNotThrow(() => validateCreatorGameComponent(component));
  input.fixtures[1]!.name = input.fixtures[0]!.name;
  assert.throws(() => validateCreatorGameComponent(component), /name is repeated/);
  input.fixtures[1]!.name = "Unique";
  input.fixtures[0]!.position.x = 100_001;
  assert.throws(() => validateCreatorGameComponent(component));
  assert.throws(
    () =>
      validateCreatorGameComponent({
        ...component,
        definition: { ...component.definition, hash: "f".repeat(64) },
      }),
    /exact installed/,
  );
});
