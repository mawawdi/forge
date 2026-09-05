import assert from "node:assert/strict";
import test from "node:test";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  type GameInventoryItem,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
  type GameRecipeDefinition,
} from "../packages/game-ir/src/index.js";
import {
  compileResponsiveUi,
  compileScenePrimitives,
  compileStudioPatch,
  RESPONSIVE_UI_DEFINITION,
  RESPONSIVE_UI_EXPANDER,
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_PRIMITIVES_EXPANDER,
  STUDIO_PATCH_DEFINITION,
  STUDIO_PATCH_EXPANDER,
  type ResponsiveUiConfig,
  type ScenePrimitivesConfig,
} from "../packages/game-composition/src/index.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";

const context = {
  componentId: "composition",
  projectId: "composition-project",
  designHash: "a".repeat(64),
};
const project = { name: "Composition test", placeId: 0, universeId: 0 };
const initialTopology: CreatorTransactionTopologyNode[] = ["Workspace", "StarterGui"].map(
  (path) => ({
    identity: { kind: "forge_attribute", stableId: "test-" + path },
    path,
    name: path,
    className: path,
    engineContainer: { path, className: path },
  }),
);
function spec(definition: GameRecipeDefinition, config: unknown): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    id: "optional-composition",
    intent: "Compose only the requested objects and controls.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(definition),
        config: config as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
}
function plan(definition: GameRecipeDefinition, config: unknown, inventory: GameInventoryItem[]) {
  return compileGamePlan({
    design: spec(definition, config),
    registry: createGameDefinitionRegistry([definition]),
    projectId: context.projectId,
    project,
    initialTopology,
    sessionId: "composition-session",
    observedRevisionHash: "b".repeat(64),
    inventory,
  });
}
function scene(): ScenePrimitivesConfig {
  return {
    rootName: "Sculptures",
    parentPath: "Workspace",
    nodes: [
      {
        id: "base",
        name: "Base",
        shape: "Block",
        size: { x: 20, y: 2, z: 20 },
        placement: { offset: { x: 0, y: 0, z: 0 } },
        color: { r: 30, g: 40, b: 50 },
        material: "Concrete",
        anchored: true,
        collidable: true,
      },
      {
        id: "sphere",
        name: "Sphere",
        parentId: "base",
        shape: "Ball",
        size: { x: 4, y: 4, z: 4 },
        placement: { relativeTo: "base", offset: { x: 0, y: 3, z: 0 } },
        color: { r: 230, g: 150, b: 50 },
        material: "Metal",
        anchored: true,
        collidable: true,
      },
    ],
    constraints: [{ kind: "separation", first: "base", second: "sphere", clearance: 0 }],
  };
}
function ui(): ResponsiveUiConfig {
  return {
    rootName: "Tools",
    tokens: {
      colors: [
        { id: "ink", value: { r: 10, g: 20, b: 30 } },
        { id: "paper", value: { r: 250, g: 250, b: 250 } },
      ],
      sizes: [
        { id: "body", value: 18 },
        { id: "rounded", value: 8 },
      ],
      semanticColors: [
        { id: "surface", primitive: "ink" },
        { id: "content", primitive: "paper" },
      ],
      semanticSizes: [
        { id: "label", primitive: "body" },
        { id: "curve", primitive: "rounded" },
      ],
      styles: [
        {
          id: "control",
          background: "surface",
          foreground: "content",
          textSize: "label",
          cornerRadius: "curve",
        },
      ],
    },
    nodes: [
      {
        id: "action",
        name: "Inspect",
        kind: "button",
        style: "control",
        text: "Inspect object",
        action: "inspect",
        layout: {
          xScale: 0.5,
          xOffset: 0,
          yScale: 0,
          yOffset: 16,
          widthScale: 1,
          widthOffset: -32,
          heightScale: 0,
          heightOffset: 48,
          anchorX: 0.5,
          anchorY: 0,
          minWidth: 48,
          minHeight: 48,
          maxWidth: 400,
          maxHeight: 48,
        },
        requireInsideParent: true,
      },
    ],
    viewports: [
      {
        id: "phone",
        width: 320,
        height: 568,
        insetLeft: 0,
        insetTop: 24,
        insetRight: 0,
        insetBottom: 16,
      },
      {
        id: "wide",
        width: 1280,
        height: 720,
        insetLeft: 16,
        insetTop: 36,
        insetRight: 16,
        insetBottom: 0,
      },
    ],
  };
}

test("scene recipe compiles nested generated parents through the full shared GamePlan and build graph", () => {
  const config = scene();
  const output = compileScenePrimitives(context, config);
  const compiled = plan(SCENE_PRIMITIVES_DEFINITION, config, output.inventory);
  const built = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: "c".repeat(64),
    values: [],
    sources: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, 3);
  assert.ok(
    built.graph.operations.some(
      (operation) => operation.target.path === "Workspace/Sculptures/Base/Sphere",
    ),
  );
  assert.equal(output.sources.length, 0);
  assert.match(output.limitations.join(" "), /navigation/);
  const reordered = scene();
  reordered.nodes.reverse();
  assert.deepEqual(compileScenePrimitives(context, reordered).inventory, output.inventory);
});

test("scene only enforces declared constraints and rejects bad relative placement and parent cycles", () => {
  const config = scene();
  config.nodes[1]!.placement.offset.y = 0;
  assert.throws(() => compileScenePrimitives(context, config), /separation failed/);
  config.constraints = [];
  compileScenePrimitives(context, config);
  config.nodes[0]!.placement.relativeTo = "sphere";
  assert.throws(() => compileScenePrimitives(context, config), /cycle/);
  const badParent = scene();
  badParent.nodes[0]!.parentId = "sphere";
  assert.throws(() => compileScenePrimitives(context, badParent), /cycle/);
  const missing = scene();
  missing.nodes[1]!.placement.relativeTo = "missing";
  assert.throws(() => compileScenePrimitives(context, missing), /Unknown placement/);
  const badMaterial = scene();
  badMaterial.nodes[0]!.material = "InventedMaterial";
  assert.throws(() => compileScenePrimitives(context, badMaterial), /allowlist/);
});

test("UI tokens and arbitrary component trees compile without Workspace or a prescribed screen flow", () => {
  const config = ui();
  const output = compileResponsiveUi(context, config);
  assert.ok(
    output.inventory.every(
      (item) => item.change.kind === "create" && item.change.path.startsWith("StarterGui/Tools"),
    ),
  );
  const compiled = plan(RESPONSIVE_UI_DEFINITION, config, output.inventory);
  const built = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: "c".repeat(64),
    values: [],
    sources: output.sources.map((source) => ({
      slotId: source.operationId,
      source: source.source,
    })),
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, output.inventory.length);
  assert.equal(output.sources.length, 1);
  assert.match(output.sources[0]!.source, /Activated:Connect/);
  assert.match(output.sources[0]!.source, /connection:Disconnect/);
  assert.match(output.limitations.join(" "), /caller/);
  assert.throws(
    () =>
      materializeGameBuildGraph({
        plan: compiled,
        acceptanceHash: "c".repeat(64),
        values: [],
        sources: [],
        checks: { status: "incomplete", artifactHashes: [] },
      }),
    /Missing source/,
  );
});

test("responsive UI rejects missing tokens, poor contrast, small controls, overflow and hierarchy cycles", () => {
  const token = ui();
  token.tokens.semanticColors[0]!.primitive = "unknown";
  assert.throws(() => compileResponsiveUi(context, token), /unknown primitive/);
  const contrast = ui();
  contrast.tokens.styles[0]!.foreground = "surface";
  assert.throws(() => compileResponsiveUi(context, contrast), /contrast/);
  const touch = ui();
  touch.nodes[0]!.layout.minHeight = 24;
  assert.throws(() => compileResponsiveUi(context, touch), /48 by 48/);
  const overflow = ui();
  overflow.nodes[0]!.layout.xOffset = 500;
  assert.throws(() => compileResponsiveUi(context, overflow), /exceeds its parent/);
  const cycle = ui();
  cycle.nodes[0]!.parentId = "action";
  assert.throws(() => compileResponsiveUi(context, cycle), /cycle/);
  const noAction = ui();
  delete noAction.nodes[0]!.action;
  assert.equal(compileResponsiveUi(context, noAction).sources.length, 0);
});

test("trusted expanders accept only their exact optional definition locks", () => {
  for (const [definition, expander, config] of [
    [SCENE_PRIMITIVES_DEFINITION, SCENE_PRIMITIVES_EXPANDER, scene()],
    [RESPONSIVE_UI_DEFINITION, RESPONSIVE_UI_EXPANDER, ui()],
  ] as const) {
    const input = {
      design: spec(definition, config),
      registry: createGameDefinitionRegistry([definition]),
      projectId: context.projectId,
      project,
      initialTopology,
    };
    assert.throws(() => expandGameDesign(input), /no admitted compiler/);
    const expanded = expandGameDesign({ ...input, recipeExpanders: [expander] });
    assert.ok(expanded.inventory.length > 0);
    assert.doesNotThrow(() => plan(definition, config, expanded.inventory));
  }
});

test("studio patch uses generated parents and typed value slots through shared compilation", () => {
  const base = {
    properties: [],
    valueSlots: [],
    attributes: [],
    removedAttributes: [],
    dependencies: [],
  };
  const config = {
    operations: [
      {
        ...base,
        id: "folder",
        kind: "create",
        className: "Folder",
        name: "Independent",
        parent: { kind: "engine", id: "Workspace" },
      },
      {
        ...base,
        id: "part",
        kind: "create",
        className: "Part",
        name: "Object",
        parent: { kind: "generated", id: "folder" },
        properties: [
          { name: "Anchored", valueJson: JSON.stringify({ kind: "boolean", value: true }) },
        ],
        valueSlots: [
          {
            id: "opacity",
            propertyName: "Transparency",
            schemaJson: JSON.stringify({
              type: "object",
              properties: {
                kind: { type: "string", maxLength: 16, enum: ["number_f32"] },
                value: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["kind", "value"],
              additionalProperties: false,
            }),
          },
        ],
      },
    ],
  };
  const output = compileStudioPatch(context, config);
  const compiled = plan(STUDIO_PATCH_DEFINITION, config, output.inventory);
  const slot = output.inventory.flatMap((item) => item.valueSlots)[0]!;
  const built = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: "c".repeat(64),
    values: [{ slotId: slot.id, value: { kind: "number_f32", value: 0.5 } }],
    sources: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, 2);
  assert.equal(
    expandGameDesign({
      design: spec(STUDIO_PATCH_DEFINITION, config),
      registry: createGameDefinitionRegistry([STUDIO_PATCH_DEFINITION]),
      projectId: context.projectId,
      project,
      initialTopology,
      recipeExpanders: [STUDIO_PATCH_EXPANDER],
    }).inventory.length,
    2,
  );
  assert.throws(
    () =>
      compileStudioPatch(context, {
        operations: [{ ...base, id: "edit", kind: "update", objectId: "invented" }],
      }),
    /current host observation/,
  );
  assert.throws(
    () =>
      compileStudioPatch(context, {
        operations: [
          {
            ...base,
            id: "source",
            kind: "create",
            className: "Script",
            name: "Injected",
            parent: { kind: "engine", id: "Workspace" },
          },
        ],
      }),
    /source_package/,
  );
});
