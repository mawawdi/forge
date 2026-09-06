import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  creatorGameCatalog,
  creatorGameComponentSchema,
  projectCreatorGameComponentInput,
} from "../packages/creator-session/src/game-authoring.js";
import {
  compileGamePlan,
  assertGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  type GameRecipeExpander,
} from "../packages/game-compiler/src/index.js";
import {
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
  type GameSourcePackage,
} from "../packages/game-ir/src/index.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";
import { GAME_COMPONENT_OUTPUT_ID_SCHEMA } from "../packages/game-ir/src/source.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";

const catalog = await creatorGameCatalog();
const project = { name: "Authored composition", placeId: 0, universeId: 0 };
const projectId = "component-output-project";
const initialTopology: CreatorTransactionTopologyNode[] = [
  "Workspace",
  "ReplicatedStorage",
  "StarterGui",
].map((path) => ({
  identity: { kind: "forge_attribute", stableId: `root-${path}` },
  path,
  name: path,
  className: path,
  engineContainer: { path, className: path },
}));
const recipe = (
  id: string,
  definitionId: string,
  config: GameJsonValue,
): GameDesignSpec["components"][number] => ({
  kind: "recipe_instance",
  id,
  definition: gameRecipeDefinitionLock(
    catalog.definitions.find((item) => item.id === definitionId)!,
  ),
  config,
});
function source(componentId: string, outputId: string, name = "Utility"): GameSourcePackage {
  return {
    kind: "source_package",
    id: "code",
    files: [
      {
        id: "utility",
        path: "Utility.luau",
        context: "shared",
        role: "module",
        content: { kind: "slot", maximumUtf8Bytes: 4096 },
        imports: [],
        placement: {
          kind: "create",
          operationId: "install-utility",
          parent: { kind: "component_output", componentId, outputId },
          name,
          className: "ModuleScript",
        },
      },
    ],
    ports: [],
    obligations: [],
  };
}
function design(components: GameDesignSpec["components"]): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "component-output",
    intent: "Place ordinary source inside creator-defined project objects.",
    components,
    connections: [],
    artifactDependencies: [],
  };
}
function patch() {
  const common = {
    kind: "create",
    className: "Folder",
    properties: [],
    valueSlots: [],
    attributes: [],
    removedAttributes: [],
    dependencies: [],
  };
  return recipe("containers", "studio-patch", {
    operations: [
      {
        ...common,
        id: "outer",
        name: "Outer",
        parent: { kind: "engine", id: "ReplicatedStorage" },
      },
      { ...common, id: "inner", name: "Inner", parent: { kind: "generated", id: "outer" } },
    ],
  });
}
function expand(spec: GameDesignSpec, recipeExpanders = catalog.expanders) {
  return expandGameDesign({
    design: spec,
    registry: catalog.registry,
    recipeExpanders,
    project,
    projectId,
    initialTopology,
  });
}
function compile(spec: GameDesignSpec, expanded = expand(spec)) {
  return compileGamePlan({
    design: expanded.design,
    registry: catalog.registry,
    inventory: expanded.inventory,
    observedSources: expanded.observedSources,
    project,
    projectId,
    initialTopology,
    sessionId: "component-output-session",
    observedRevisionHash: "a".repeat(64),
  });
}

test("derived source metadata preserves the complete canonical design, authority and plan hash", () => {
  const code = source("containers", "inner");
  const placement = code.files[0]!.placement;
  assert.ok(placement?.kind === "create");
  placement.parent = { kind: "engine_container", path: "StarterGui", className: "StarterGui" };
  const original = design([code]);
  const draft = new CreatorDesignDraft(catalog);
  const input = projectCreatorGameComponentInput(code);
  const ref = draft.define({ component: input });
  assert.equal(ref.componentHash, contentHash(stableJson(code)));
  const { components: _components, ...metadata } = original;
  const resolved = draft.assemble({ ...metadata, componentIds: [ref.componentId] });
  assert.deepEqual(resolved, original);
  assert.deepEqual(compile(resolved), compile(original));
  assert.deepEqual(draft.read({ componentIds: [code.id] }).components, [input]);
  assert.deepEqual(
    draft.define({ component: input }),
    ref,
    "Replaying an editable declaration retains its canonical authority hash",
  );
});

test("authored patch output aliases resolve nested source placement into exact accepted identities", () => {
  const spec = design([source("containers", "inner"), patch()]);
  assert.equal(
    spec.components.every(
      (component) =>
        creatorGameComponentSchema(catalog).safeParse(projectCreatorGameComponentInput(component))
          .success,
    ),
    true,
  );
  const expanded = expand(spec);
  const parent = expanded.inventory.find((item) => item.outputId === "inner")!;
  const installed = expanded.inventory.find((item) => item.id === "install-utility")!;
  assert.ok(parent.id.startsWith("composition-"));
  assert.ok(parent.change.kind === "create" && installed.change.kind === "create");
  assert.equal(installed.change.path, "ReplicatedStorage/Outer/Inner/Utility");
  assert.equal(installed.change.parent.path, parent.change.path);
  assert.equal(installed.change.parent.kind, "instance");
  assert.ok(installed.dependencies.includes(parent.id));
  const plan = compile(spec, expanded);
  const built = materializeGameBuildGraph({
    plan,
    acceptanceHash: "b".repeat(64),
    values: [],
    sources: [{ slotId: "install-utility", source: "--!strict\nreturn {}\n" }],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, 3);
  const reordered = expand(design([...spec.components].reverse()));
  assert.deepEqual(reordered.inventory, expanded.inventory);
});

test("local scene IDs retain exact case and underscores through hierarchy, references and build identities", () => {
  const ids = ["dock-pad", "DockPad", "dockPad", "dock_pad"];
  const config = {
    rootName: "Objects",
    parentPath: "Workspace",
    nodes: ids.map((id, index) => ({
      id,
      name: `Object ${index}`,
      ...(index ? { parentId: ids[index - 1]! } : {}),
      shape: "Block",
      size: { x: 1, y: 1, z: 1 },
      placement: {
        ...(index ? { relativeTo: ids[index - 1]! } : {}),
        offset: { x: index ? 2 : 0, y: 0, z: 0 },
      },
      color: { r: 12, g: 24, b: 48 },
      material: "Concrete",
      anchored: true,
      collidable: true,
    })),
    constraints: ids.slice(1).map((second, index) => ({
      kind: "separation",
      first: ids[index]!,
      second,
      clearance: 0.5,
    })),
  };
  const scene = recipe("scene", "scene-primitives", config);
  const spec = design([scene, source("scene", "node/dock_pad")]);
  const schema = creatorGameComponentSchema(catalog);
  assert.ok(
    spec.components.every(
      (entry) => schema.safeParse(projectCreatorGameComponentInput(entry)).success,
    ),
  );
  const expanded = expand(spec);
  const nodeItems = ids.map((id) => {
    const item = expanded.inventory.find((entry) => entry.outputId === `node/${id}`)!;
    assert.ok(item, `exact output alias node/${id}`);
    assert.equal(
      item.id,
      "composition-" + contentHash(stableJson(["scene", `node-${id}`])).slice(0, 40),
    );
    return item;
  });
  assert.equal(new Set(nodeItems.map((item) => item.id)).size, ids.length);
  for (const [index, item] of nodeItems.entries()) {
    const frame = item.lockedProperties.CFrame;
    assert.ok(frame?.kind === "cframe_f32x12");
    assert.equal(frame.components[0], index * 2);
    if (index) assert.deepEqual(item.dependencies, [nodeItems[index - 1]!.id]);
  }
  const installed = expanded.inventory.find((item) => item.id === "install-utility")!;
  assert.ok(installed.change.kind === "create");
  assert.equal(
    installed.change.path,
    "Workspace/Objects/Object 0/Object 1/Object 2/Object 3/Utility",
  );
  assert.ok(installed.dependencies.includes(nodeItems[3]!.id));
  const plan = compile(spec, expanded);
  const buildInput = {
    plan,
    acceptanceHash: "b".repeat(64),
    values: [],
    sources: [{ slotId: "install-utility", source: "--!strict\nreturn {}\n" }],
    checks: { status: "incomplete" as const, artifactHashes: [] },
  };
  assert.deepEqual(materializeGameBuildGraph(buildInput), materializeGameBuildGraph(buildInput));
  const reordered = structuredClone(config);
  reordered.nodes.reverse();
  assert.deepEqual(
    expand(
      design([source("scene", "node/dock_pad"), recipe("scene", "scene-primitives", reordered)]),
    ).inventory,
    expanded.inventory,
  );
  assert.throws(
    () => expand(design([scene, source("scene", "node/DOCK_pad")])),
    /Unknown recipe component output/,
    "case changes never select another object implicitly",
  );
  const duplicate = structuredClone(config);
  duplicate.nodes[1]!.id = duplicate.nodes[0]!.id;
  assert.throws(
    () => expand(design([recipe("scene", "scene-primitives", duplicate)])),
    /duplicate/i,
  );
  for (const invalid of ["dock/pad", "dock pad", " dock", "dock\n", "1dock", "_dock"]) {
    const malformed = structuredClone(config);
    malformed.nodes[0]!.id = invalid;
    assert.equal(
      schema.safeParse(recipe("scene", "scene-primitives", malformed)).success,
      false,
      invalid,
    );
  }
  assert.equal(
    schema.parse({ ...scene, id: "Scene" }).id,
    "Scene",
    "top-level IDs preserve their exact case",
  );
  for (const invalid of ["node//DockPad", "node/../DockPad", "/node/DockPad", "node/Dock Pad"])
    assert.equal(GAME_COMPONENT_OUTPUT_ID_SCHEMA.safeParse(invalid).success, false, invalid);
});

test("scene and UI node output aliases use the same generic source parent resolver", () => {
  const scene = recipe("scene", "scene-primitives", {
    rootName: "Objects",
    parentPath: "Workspace",
    nodes: [
      {
        id: "body",
        name: "Body",
        shape: "Block",
        size: { x: 4, y: 2, z: 4 },
        placement: { offset: { x: 0, y: 0, z: 0 } },
        color: { r: 12, g: 24, b: 48 },
        material: "Concrete",
        anchored: true,
        collidable: true,
      },
    ],
    constraints: [],
  });
  const ui = recipe("interface", "responsive-ui", {
    rootName: "Interface",
    tokens: {
      colors: [
        { id: "black", value: { r: 0, g: 0, b: 0 } },
        { id: "white", value: { r: 255, g: 255, b: 255 } },
      ],
      sizes: [
        { id: "body", value: 18 },
        { id: "zero", value: 0 },
      ],
      semanticColors: [
        { id: "surface", primitive: "black" },
        { id: "content", primitive: "white" },
      ],
      semanticSizes: [
        { id: "label", primitive: "body" },
        { id: "square", primitive: "zero" },
      ],
      styles: [
        {
          id: "plain",
          background: "surface",
          foreground: "content",
          textSize: "label",
          cornerRadius: "square",
        },
      ],
    },
    nodes: [
      {
        id: "panel",
        name: "Panel",
        kind: "panel",
        style: "plain",
        requireInsideParent: true,
        layout: {
          xScale: 0,
          xOffset: 0,
          yScale: 0,
          yOffset: 0,
          widthScale: 0,
          widthOffset: 300,
          heightScale: 0,
          heightOffset: 200,
          anchorX: 0,
          anchorY: 0,
          minWidth: 48,
          minHeight: 48,
          maxWidth: 800,
          maxHeight: 800,
        },
      },
    ],
    viewports: [],
  });
  for (const [component, outputId, expectedPath] of [
    [scene, "node/body", "Workspace/Objects/Body/Utility"],
    [ui, "node/panel", "StarterGui/Interface/Panel/Utility"],
  ] as const) {
    const spec = design([component, source(component.id, outputId)]);
    const result = expand(spec);
    const installed = result.inventory.find((item) => item.id === "install-utility")!;
    assert.ok(installed.change.kind === "create");
    assert.equal(installed.change.path, expectedPath);
    assert.doesNotThrow(() => compile(spec, result));
  }
});

test("unknown component and output aliases fail before a plan can be accepted", () => {
  for (const [componentId, outputId] of [
    ["absent", "inner"],
    ["containers", "absent"],
  ]) {
    assert.throws(
      () => expand(design([patch(), source(componentId!, outputId!)])),
      /output|component/i,
    );
  }
});

test("duplicate output aliases from a trusted expander cannot select an arbitrary parent", () => {
  const recipeExpanders: GameRecipeExpander[] = catalog.expanders.map((expander) =>
    expander.definition.id === "studio-patch"
      ? {
          ...expander,
          expand: (input) => expander.expand(input).map((item) => ({ ...item, outputId: "same" })),
        }
      : expander,
  );
  assert.throws(
    () => expand(design([patch(), source("containers", "same")]), recipeExpanders),
    /duplicate.*output|output.*duplicate/i,
  );
});

test("component output references do not turn an update into a generated creation parent", () => {
  const recipeExpanders: GameRecipeExpander[] = catalog.expanders.map((expander) =>
    expander.definition.id === "studio-patch"
      ? {
          ...expander,
          expand: (input) =>
            expander.expand(input).map((item) =>
              item.outputId === "inner"
                ? {
                    ...item,
                    change: {
                      id: item.id,
                      kind: "update" as const,
                      expectedClass: "Folder" as const,
                      target: {
                        kind: "instance" as const,
                        identity: { kind: "forge_attribute" as const, stableId: "existing-folder" },
                        path: "ReplicatedStorage/Existing",
                        className: "Folder",
                      },
                    },
                  }
                : item,
            ),
        }
      : expander,
  );
  assert.throws(
    () => expand(design([patch(), source("containers", "inner")]), recipeExpanders),
    /create|creation/i,
  );
});

test("resolved component aliases retain final topology collision checks", () => {
  const spec = design([patch(), source("containers", "outer", "Inner")]);
  assert.throws(() => compile(spec), /collision|ambiguous|duplicate|same.*path|sibling/i);
});

test("persisted plans reject a rehashed source moved away from its declared component output", () => {
  const plan = compile(design([patch(), source("containers", "inner")]));
  const { id: _id, hash: _hash, ...payload } = plan;
  const forgedPayload = {
    ...payload,
    inventory: plan.inventory.map((item) =>
      item.id === "install-utility"
        ? {
            ...item,
            change: {
              id: item.id,
              kind: "create" as const,
              className: "ModuleScript" as const,
              path: "ReplicatedStorage/Utility",
              parent: {
                kind: "engine_container" as const,
                path: "ReplicatedStorage",
                className: "ReplicatedStorage",
              },
              initialization: "inline_source_required" as const,
            },
            dependencies: [],
          }
        : item,
    ),
  };
  const hash = contentHash(stableJson(forgedPayload));
  const forged = { ...forgedPayload, id: "game_plan_" + hash.slice(0, 24), hash };
  assert.throws(() => assertGamePlan(forged), /output/i);
});
