import assert from "node:assert/strict";
import test from "node:test";
import { stableJson } from "../packages/contracts/src/index.js";
import {
  compileProjectAssembly,
  gameAssemblyOperationId,
  PROJECT_ASSEMBLY_DEFINITION,
  PROJECT_ASSEMBLY_EXPANDER,
  type GameAssemblyConfig,
} from "../packages/game-composition/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  gameGeneratedTarget,
  materializeGameBuildGraph,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";
import type { CreatorProjectIndexView } from "../packages/creator-session/src/index.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";

const project = { name: "Assembly fixture", placeId: 0, universeId: 0 };
const initialTopology: CreatorTransactionTopologyNode[] = [
  {
    identity: { kind: "forge_attribute", stableId: "workspace" },
    path: "Workspace",
    name: "Workspace",
    className: "Workspace",
    engineContainer: { path: "Workspace", className: "Workspace" },
  },
];
const context = {
  componentId: "workshop",
  projectId: "assembly-project",
  designHash: "a".repeat(64),
  initialTopology,
};
const named = (name: string, value: unknown) => ({ name, valueJson: JSON.stringify(value) });
function node(
  id: string,
  name: string,
  className: string,
  parentId?: string,
): GameAssemblyConfig["templates"][number]["nodes"][number] {
  return {
    id,
    name,
    className,
    ...(parentId ? { parentId } : {}),
    properties: [],
    references: [],
    valueSlots: [],
    attributes: [],
    dependencies: [],
  };
}
function assembly(): GameAssemblyConfig {
  return {
    templates: [
      {
        id: "arbitrary-object",
        nodes: [
          {
            ...node("root", "UnusedTemplateRootName", "Model"),
            references: [{ propertyName: "PrimaryPart", target: { kind: "local", id: "body" } }],
          },
          {
            ...node("body", "Body", "Part", "root"),
            properties: [named("Anchored", { kind: "boolean", value: true })],
            attributes: [named("Role", "creator-defined")],
          },
          node("socket", "Socket", "Attachment", "body"),
          {
            ...node("link", "Link", "ObjectValue", "root"),
            references: [{ propertyName: "Value", target: { kind: "local", id: "socket" } }],
          },
        ],
      },
    ],
    copies: [
      {
        id: "left",
        templateId: "arbitrary-object",
        name: "Left",
        parent: { kind: "engine", id: "Workspace" },
        overrides: [],
      },
      {
        id: "right",
        templateId: "arbitrary-object",
        name: "Right",
        parent: { kind: "engine", id: "Workspace" },
        overrides: [
          {
            nodeId: "body",
            name: "CustomBody",
            properties: [named("Anchored", { kind: "boolean", value: false })],
            attributes: [named("Role", "right-only")],
          },
        ],
      },
    ],
    sharedReferences: [],
  };
}
function inventory(config = assembly()) {
  return compileProjectAssembly(context, config).inventory;
}
function find(items: ReturnType<typeof inventory>, copyId: string, nodeId: string) {
  return items.find(
    (item) => item.id === gameAssemblyOperationId(context.componentId, copyId, nodeId),
  )!;
}
function design(config: GameAssemblyConfig): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "reusable-composition",
    intent: "Create two independent instances of this creator-defined assembly.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(PROJECT_ASSEMBLY_DEFINITION),
        config: config as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
}
function compile(spec: GameDesignSpec) {
  const input = {
    design: spec,
    registry: createGameDefinitionRegistry([PROJECT_ASSEMBLY_DEFINITION]),
    projectId: context.projectId,
    project,
    initialTopology,
    recipeExpanders: [PROJECT_ASSEMBLY_EXPANDER],
  };
  const expanded = expandGameDesign(input);
  return compileGamePlan({
    ...input,
    design: expanded.design,
    inventory: expanded.inventory,
    observedSources: expanded.observedSources,
    sessionId: "assembly-session",
    observedRevisionHash: "b".repeat(64),
  });
}

test("generic assembly copies remap local references and preserve independently overridden ownership", () => {
  const items = inventory();
  assert.equal(items.length, 8);
  for (const copyId of ["left", "right"]) {
    const root = find(items, copyId, "root");
    const body = find(items, copyId, "body");
    const socket = find(items, copyId, "socket");
    const link = find(items, copyId, "link");
    assert.equal(root.change.kind, "create");
    assert.equal(body.change.kind, "create");
    assert.equal(socket.change.kind, "create");
    const expected = (item: typeof body) =>
      gameGeneratedTarget({
        projectId: context.projectId,
        operationId: item.id,
        path: item.change.kind === "create" ? item.change.path : "",
        className: item.change.kind === "create" ? item.change.className : "",
      });
    const primary = root.lockedProperties.PrimaryPart;
    const reference = link.lockedProperties.Value;
    assert.equal(primary?.kind, "instance_ref");
    assert.equal(reference?.kind, "instance_ref");
    if (
      primary?.kind !== "instance_ref" ||
      primary.state !== "reference" ||
      reference?.kind !== "instance_ref" ||
      reference.state !== "reference"
    )
      assert.fail("exact references required");
    assert.deepEqual(primary.identity, expected(body).identity);
    assert.deepEqual(reference.identity, expected(socket).identity);
    assert.equal(
      reference.path,
      copyId === "left" ? "Workspace/Left/Body/Socket" : "Workspace/Right/CustomBody/Socket",
    );
  }
  assert.notEqual(find(items, "left", "body").id, find(items, "right", "body").id);
  assert.deepEqual(find(items, "left", "body").lockedProperties.Anchored, {
    kind: "boolean",
    value: true,
  });
  assert.deepEqual(find(items, "right", "body").lockedProperties.Anchored, {
    kind: "boolean",
    value: false,
  });
  assert.equal(find(items, "left", "body").attributes.Role, "creator-defined");
  assert.equal(find(items, "right", "body").attributes.Role, "right-only");
});

test("assembly output is independent of declaration order and unaffected copy IDs survive placement edits", () => {
  const original = assembly();
  const reordered = structuredClone(original);
  reordered.templates.reverse();
  reordered.templates[0]!.nodes.reverse();
  reordered.copies.reverse();
  assert.equal(stableJson(inventory(original)), stableJson(inventory(reordered)));
  const edited = structuredClone(original);
  edited.copies[0]!.name = "Renamed";
  const changed = inventory(edited);
  assert.deepEqual(find(changed, "right", "body"), find(inventory(original), "right", "body"));
  assert.equal(find(changed, "left", "body").id, find(inventory(original), "left", "body").id);
});

test("named shared references can intentionally target another copy while local references remain local", () => {
  const config = assembly();
  config.sharedReferences = [
    { id: "shared-socket", target: { kind: "copy", id: "left", nodeId: "socket" } },
  ];
  config.copies[1]!.overrides.push({
    nodeId: "link",
    references: [{ propertyName: "Value", target: { kind: "shared", id: "shared-socket" } }],
  });
  const items = inventory(config);
  assert.deepEqual(
    find(items, "right", "link").lockedProperties.Value,
    find(items, "left", "link").lockedProperties.Value,
  );
  assert.notDeepEqual(
    find(items, "right", "root").lockedProperties.PrimaryPart,
    find(items, "left", "root").lockedProperties.PrimaryPart,
  );
});

test("copies can be placed under other copies using the existing generated-parent topology", () => {
  const config = assembly();
  config.templates[0]!.nodes[1]!.dependencies = ["root"];
  config.copies[1]!.parent = { kind: "copy", id: "left", nodeId: "root" };
  const items = inventory(config);
  const root = find(items, "right", "root");
  assert.equal(root.change.kind === "create" && root.change.path, "Workspace/Left/Right");
  const body = find(items, "right", "body");
  assert.deepEqual(body.dependencies, [root.id]);
});

test("named shared observations preserve exact existing identity and require current topology", () => {
  const target = {
    identity: { kind: "forge_attribute" as const, stableId: "existing-shared" },
    objectId: "forge_attribute:existing-shared",
    path: "Workspace/Shared",
    name: "Shared",
    className: "Part",
    parentIdentity: initialTopology[0]!.identity,
    properties: {},
    attributes: {},
    tags: [],
  };
  const observation: CreatorProjectIndexView = {
    project,
    revision: { hash: "b".repeat(64) } as CreatorProjectIndexView["revision"],
    instances: [target],
    scripts: [],
  };
  const config = assembly();
  config.sharedReferences = [
    { id: "shared-target", target: { kind: "object", id: target.objectId } },
  ];
  config.copies[0]!.overrides.push({
    nodeId: "link",
    references: [{ propertyName: "Value", target: { kind: "shared", id: "shared-target" } }],
  });
  const result = compileProjectAssembly(
    { ...context, observation, initialTopology: [...initialTopology, target] },
    config,
  );
  const value = find(result.inventory, "left", "link").lockedProperties.Value;
  assert.equal(value?.kind, "instance_ref");
  if (value?.kind !== "instance_ref" || value.state !== "reference")
    assert.fail("expected bound reference");
  assert.deepEqual(value.identity, target.identity);
  assert.throws(() => compileProjectAssembly(context, config), /current observation/);
  assert.throws(() => compileProjectAssembly({ ...context, observation }, config));
});

test("assembly uses one production recipe registration and ordinary per-copy source packages without rewriting bytes", () => {
  const spec = design(assembly());
  for (const copyId of ["left", "right"]) {
    const componentId = copyId + "-behavior";
    spec.components.push({
      kind: "source_package",
      id: componentId,
      ports: [],
      obligations: [],
      files: ["data", "logic"].map((id) => ({
        id,
        path: id + ".luau",
        context: "shared",
        role: "module",
        content: { kind: "slot", maximumUtf8Bytes: 1024 },
        placement: {
          kind: "create",
          operationId: componentId + "-" + id,
          className: "ModuleScript",
          name: id === "data" ? "Data" : "Logic",
          parent: {
            kind: "generated",
            operationId: gameAssemblyOperationId(context.componentId, copyId, "root"),
          },
        },
        imports: id === "logic" ? [{ componentId, fileId: "data" }] : [],
      })),
    });
  }
  const plan = compile(spec);
  assert.equal(plan.inventory.length, 12);
  const sources = ["left", "right"].flatMap((copyId) => [
    { slotId: copyId + "-behavior-data", source: "return {}" },
    { slotId: copyId + "-behavior-logic", source: "return require(script.Parent.Data)" },
  ]);
  const built = materializeGameBuildGraph({
    plan,
    acceptanceHash: "c".repeat(64),
    sources,
    values: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, 12);
  assert.equal(
    plan.design.components.filter((component) => component.kind === "recipe_instance").length,
    1,
  );
  for (const copyId of ["left", "right"]) {
    const logic = plan.inventory.find((item) => item.id === copyId + "-behavior-logic")!;
    const data = plan.inventory.find((item) => item.id === copyId + "-behavior-data")!;
    assert.ok(logic.dependencies.includes(data.id));
    assert.ok(
      !logic.dependencies.includes((copyId === "left" ? "right" : "left") + "-behavior-data"),
    );
  }
  const hashes = built.graph.artifacts
    .filter((artifact) => artifact.kind === "source" && artifact.fileId === "logic")
    .map((artifact) => artifact.hash);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1]);
  assert.equal(built.graph.localChecks.status, "incomplete");
});

test("property slots are distinct per copy and a locked per-copy override binds only its own slot", () => {
  const config = assembly();
  config.templates[0]!.nodes[1]!.valueSlots = [
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
  ];
  config.copies[1]!.overrides[0]!.properties!.push(
    named("Transparency", { kind: "number_f32", value: 0.25 }),
  );
  const plan = compile(design(config));
  const slots = plan.inventory.flatMap((item) => item.valueSlots);
  assert.equal(slots.length, 1);
  const built = materializeGameBuildGraph({
    plan,
    acceptanceHash: "c".repeat(64),
    sources: [],
    values: [{ slotId: slots[0]!.id, value: { kind: "number_f32", value: 0.75 } }],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  const values = built.graph.operations
    .filter((operation) => operation.kind === "create" && operation.className === "Part")
    .map((operation) =>
      operation.kind === "create" ? operation.properties.Transparency : undefined,
    );
  assert.deepEqual(
    new Set(values.map(stableJson)),
    new Set([
      stableJson({ kind: "number_f32", value: 0.25 }),
      stableJson({ kind: "number_f32", value: 0.75 }),
    ]),
  );
});

test("assembly rejects missing references, duplicate identities, collisions and parent/dependency cycles", () => {
  const bad: Array<(config: GameAssemblyConfig) => void> = [
    (config) => {
      config.copies[1]!.id = "left";
    },
    (config) => {
      config.copies[1]!.name = "Left";
    },
    (config) => {
      config.copies[0]!.templateId = "missing";
    },
    (config) => {
      config.templates[0]!.nodes[2]!.parentId = "missing";
    },
    (config) => {
      config.templates[0]!.nodes[1]!.parentId = "socket";
    },
    (config) => {
      config.templates[0]!.nodes[0]!.dependencies = ["body"];
    },
    (config) => {
      config.templates[0]!.nodes[3]!.references[0]!.target.id = "missing";
    },
    (config) => {
      config.copies[0]!.overrides = [{ nodeId: "missing" }];
    },
    (config) => {
      config.copies[0]!.parent = { kind: "copy", id: "right", nodeId: "root" };
      config.copies[1]!.parent = { kind: "copy", id: "left", nodeId: "root" };
    },
  ];
  for (const mutate of bad) {
    const config = assembly();
    mutate(config);
    assert.throws(() => inventory(config));
  }
});

test("assembly rejects reference type confusion, raw identity injection and inline source creation", () => {
  const wrongType = assembly();
  wrongType.templates[0]!.nodes[0]!.references[0]!.target.id = "socket";
  assert.throws(() => inventory(wrongType), /reference/);
  const raw = assembly();
  raw.templates[0]!.nodes[3]!.references = [];
  raw.templates[0]!.nodes[3]!.properties = [
    named("Value", {
      kind: "instance_ref",
      state: "reference",
      identity: { kind: "forge_attribute", stableId: "forged" },
      path: "Workspace/Forged",
      className: "Part",
      expectedClass: "Instance",
    }),
  ];
  assert.throws(() => inventory(raw), /named local\/shared/);
  const source = assembly();
  source.templates[0]!.nodes[3]!.className = "ModuleScript";
  source.templates[0]!.nodes[3]!.references = [];
  assert.throws(() => inventory(source), /source_package/);
});

test("assembly fails closed on hostile non-JSON and bounded expansion without executing getters", () => {
  let calls = 0;
  const input = {
    get templates() {
      calls++;
      return [];
    },
  };
  assert.throws(() => compileProjectAssembly(context, input));
  assert.equal(calls, 0);
  const config = assembly();
  config.copies = Array.from({ length: 1025 }, (_, index) => ({
    ...config.copies[0]!,
    id: "copy-" + index,
    name: "Copy " + index,
  }));
  assert.throws(() => inventory(config), /4096-operation/);
});
