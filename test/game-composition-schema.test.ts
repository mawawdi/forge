import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  COMPOSITION_CONFIG_SCHEMAS,
  PROJECT_ASSEMBLY_DEFINITION,
  RESPONSIVE_UI_DEFINITION,
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_ARRANGEMENT_DEFINITION,
  SCENE_LIGHTING_DEFINITION,
  STUDIO_PATCH_DEFINITION,
} from "../packages/game-composition/src/index.js";
import { compositionConfigDataSchema } from "../packages/game-composition/src/config-schema.js";
import {
  createGameDefinitionRegistry,
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameDataSchema,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";
import {
  canonicalGameDataSchema,
  gameDataMatchesSchema,
  GAME_DATA_SCHEMA,
} from "../packages/game-ir/src/recipes.js";
import {
  GAME_SOURCE_CONTENT_SCHEMA,
  GAME_SOURCE_PLACEMENT_SCHEMA,
} from "../packages/game-ir/src/source.js";
import { GAME_ADMISSION_POLICY_SCHEMA } from "../packages/game-ir/src/primitives.js";
import { STUDIO_CAPABILITY_MANIFEST } from "../packages/studio-evidence/src/index.js";

const definitions = [
  SCENE_ARRANGEMENT_DEFINITION,
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_LIGHTING_DEFINITION,
  RESPONSIVE_UI_DEFINITION,
  PROJECT_ASSEMBLY_DEFINITION,
  STUDIO_PATCH_DEFINITION,
];

test("scene Material provider schema and admission use the exact canonical property allowlist", () => {
  const allowed = STUDIO_CAPABILITY_MANIFEST.classes
    .find((entry) => entry.name === "Part")!
    .properties.find((property) => property.name === "Material")!.allowed!;
  const json = z.toJSONSchema(COMPOSITION_CONFIG_SCHEMAS.get("scene-primitives")!);
  const properties = (json.properties!.nodes as z.core.JSONSchema.BaseSchema)
    .items as z.core.JSONSchema.BaseSchema;
  assert.deepEqual((properties.properties!.material as z.core.JSONSchema.BaseSchema).enum, allowed);
  for (const material of allowed)
    parity("scene-primitives", mutate(scene, ["nodes", 0, "material"], material), true);
  for (const material of ["InventedMaterial", "", allowed[0]!.toLowerCase()])
    parity("scene-primitives", mutate(scene, ["nodes", 0, "material"], material), false);
});
const scene = {
  rootName: "A named collection",
  parentPath: "Workspace",
  nodes: [
    {
      id: "body",
      name: "Body",
      shape: "Block",
      size: { x: 1, y: 2, z: 3 },
      placement: { offset: { x: 0, y: 0, z: 0 } },
      color: { r: 0, g: 128, b: 255 },
      material: "Plastic",
      anchored: true,
      collidable: true,
    },
  ],
  constraints: [],
};
const ui = {
  rootName: "Tools",
  tokens: {
    colors: [{ id: "ink", value: { r: 0, g: 0, b: 0 } }],
    sizes: [{ id: "body", value: 18 }],
    semanticColors: [{ id: "surface", primitive: "ink" }],
    semanticSizes: [{ id: "label", primitive: "body" }],
    styles: [
      {
        id: "basic",
        background: "surface",
        foreground: "surface",
        textSize: "label",
        cornerRadius: "label",
      },
    ],
  },
  nodes: [
    {
      id: "label",
      name: "Label",
      kind: "text",
      style: "basic",
      text: "Label",
      layout: {
        xScale: 0,
        xOffset: 0,
        yScale: 0,
        yOffset: 0,
        widthScale: 1,
        widthOffset: 0,
        heightScale: 0,
        heightOffset: 48,
        anchorX: 0,
        anchorY: 0,
        minWidth: 0,
        minHeight: 0,
        maxWidth: 1024,
        maxHeight: 1024,
      },
      requireInsideParent: true,
      aspect: { ratio: 0.000001, axis: "Width" },
    },
  ],
  viewports: [
    {
      id: "phone",
      width: 320,
      height: 568,
      insetLeft: 0,
      insetRight: 0,
      insetTop: 0,
      insetBottom: 0,
    },
  ],
};
const assembly = {
  templates: [
    {
      id: "template",
      nodes: [
        {
          id: "root",
          name: "Template",
          className: "Model",
          properties: [],
          references: [],
          valueSlots: [],
          attributes: [],
          dependencies: [],
        },
      ],
    },
  ],
  copies: [
    {
      id: "copy",
      templateId: "template",
      name: "Placed",
      parent: { kind: "engine", id: "Workspace" },
      overrides: [],
    },
  ],
  sharedReferences: [],
};
const payload = {
  properties: [],
  valueSlots: [],
  attributes: [],
  removedAttributes: [],
  dependencies: [],
};
const patch = {
  operations: [
    {
      ...payload,
      id: "folder",
      kind: "create",
      name: "Folder",
      className: "Folder",
      parent: { kind: "engine", id: "Workspace" },
    },
  ],
};

function parity(id: string, config: unknown, expected: boolean): void {
  const schema = COMPOSITION_CONFIG_SCHEMAS.get(id)!;
  const definition = definitions.find((item) => item.id === id)!;
  assert.equal(schema.safeParse(config).success, expected, id + " compiler input");
  assert.equal(
    gameDataMatchesSchema(config as GameJsonValue, definition.configSchema),
    expected,
    id + " catalog contract",
  );
  const result = validateGameDesignSpec(
    {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "schema-parity",
      intent: "Check declared config shape only",
      components: [
        {
          kind: "recipe_instance",
          id: "component",
          definition: gameRecipeDefinitionLock(definition),
          config,
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
    { registry: createGameDefinitionRegistry([definition]), policy: DEFAULT_GAME_ADMISSION_POLICY },
  );
  assert.equal(result.status, expected ? "eligible" : "rejected", id + " design admission");
}
function mutate(base: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const result = structuredClone(base) as Record<string, unknown>;
  let target: Record<string | number, unknown> = result;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[path.at(-1)!] = value;
  return result;
}

test("every optional recipe catalog derives from its exported compiler input validator", () => {
  assert.equal(COMPOSITION_CONFIG_SCHEMAS.size, definitions.length);
  for (const definition of definitions)
    assert.deepEqual(
      definition.configSchema,
      compositionConfigDataSchema(COMPOSITION_CONFIG_SCHEMAS.get(definition.id)!),
    );
  for (const [id, config] of [
    ["scene-primitives", scene],
    ["responsive-ui", ui],
    ["project-assembly", assembly],
    ["studio-patch", patch],
  ] as const)
    parity(id, config, true);
  // Structural eligibility does not establish token semantics, contrast, native layout or gameplay.
});

test("numeric, integer, array and identifier failures are rejected before recipe expansion", () => {
  const cases: Array<[string, unknown, (string | number)[], unknown]> = [
    ["scene-primitives", scene, ["nodes", 0, "size", "x"], 0],
    ["scene-primitives", scene, ["nodes", 0, "size", "z"], 2048.01],
    ["scene-primitives", scene, ["nodes", 0, "color", "r"], 1.5],
    ["scene-primitives", scene, ["nodes", 0, "color", "b"], 256],
    ["scene-primitives", scene, ["nodes", 0, "id"], "Upper Case"],
    ["scene-primitives", scene, ["rootName"], "Unsafe/Path"],
    ["scene-primitives", scene, ["nodes"], []],
    ["responsive-ui", ui, ["tokens", "colors", 0, "value", "g"], -1],
    ["responsive-ui", ui, ["tokens", "sizes", 0, "value"], -1],
    ["responsive-ui", ui, ["nodes", 0, "layout", "xOffset"], 0.5],
    ["responsive-ui", ui, ["nodes", 0, "layout", "widthScale"], -1],
    ["responsive-ui", ui, ["nodes", 0, "layout", "anchorX"], 1.01],
    ["responsive-ui", ui, ["nodes", 0, "layout", "maxWidth"], 0],
    ["responsive-ui", ui, ["nodes", 0, "aspect", "ratio"], 0],
    ["responsive-ui", ui, ["nodes", 0, "order"], 1.5],
    ["responsive-ui", ui, ["nodes", 0, "order"], 100001],
    ["responsive-ui", ui, ["nodes", 0, "motionSeconds"], 1.01],
    ["responsive-ui", ui, ["nodes", 0, "text"], "x".repeat(4097)],
    ["responsive-ui", ui, ["viewports", 0, "width"], 0],
    ["responsive-ui", ui, ["nodes"], []],
    ["project-assembly", assembly, ["copies"], []],
    ["project-assembly", assembly, ["templates", 0, "nodes"], []],
    ["studio-patch", patch, ["operations"], []],
  ];
  for (const [id, config, path, value] of cases) parity(id, mutate(config, path, value), false);
  parity("responsive-ui", mutate(ui, ["nodes", 0, "text"], "😀".repeat(2049)), true);
  parity("scene-primitives", mutate(scene, ["rootName"], "A".repeat(96)), true);
  parity("scene-primitives", mutate(scene, ["rootName"], "A".repeat(97)), false);
});

test("branch-specific assembly references and patch operation payloads are exact", () => {
  parity(
    "project-assembly",
    mutate(assembly, ["copies", 0, "parent"], { kind: "copy", id: "other" }),
    false,
  );
  parity(
    "project-assembly",
    mutate(assembly, ["copies", 0, "parent"], { kind: "copy", id: "other", nodeId: "root" }),
    true,
  );
  parity(
    "project-assembly",
    mutate(assembly, ["copies", 0, "parent"], {
      kind: "engine",
      id: "Workspace",
      nodeId: "ignored",
    }),
    false,
  );
  for (const operation of [
    { ...payload, id: "edit", kind: "update", objectId: "host-issued-object" },
    {
      ...payload,
      id: "move",
      kind: "move",
      objectId: "host-issued-object",
      name: "Moved",
      parent: { kind: "object", id: "host-issued-parent" },
    },
    { ...payload, id: "delete", kind: "delete", objectId: "host-issued-object" },
  ])
    parity("studio-patch", { operations: [operation] }, true);
  for (const operation of [
    { ...payload, id: "create", kind: "create", className: "Folder" },
    { ...payload, id: "edit", kind: "update", objectId: "host-issued-object", className: "Part" },
    { ...payload, id: "edit", kind: "update", objectId: "host-issued-object", name: "Ignored" },
    { ...payload, id: "move", kind: "move", objectId: "host-issued-object", name: "Moved" },
    {
      ...payload,
      id: "delete",
      kind: "delete",
      objectId: "host-issued-object",
      properties: [{ name: "Anchored", valueJson: "true" }],
    },
  ])
    parity("studio-patch", { operations: [operation] }, false);
});

test("provider JSON Schema carries exact integer bounds, token guidance and required union fields", () => {
  const object = (value: unknown): z.core.JSONSchema.BaseSchema => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as z.core.JSONSchema.BaseSchema;
  };
  const json = z.toJSONSchema(COMPOSITION_CONFIG_SCHEMAS.get("responsive-ui")!, {
    target: "draft-7",
    io: "input",
  });
  const nodes = object(json.properties!.nodes);
  assert.equal(nodes.minItems, 1);
  const node = object(nodes.items);
  const layout = object(node.properties!.layout);
  assert.equal(object(layout.properties!.xOffset).type, "integer");
  assert.equal(object(layout.properties!.anchorX).minimum, 0);
  assert.equal(object(layout.properties!.anchorX).maximum, 1);
  assert.equal(object(layout.properties!.maxWidth).exclusiveMinimum, 0);
  assert.match(object(node.properties!.style).description!, /tokens.styles/);
  const assemblyJson = z.toJSONSchema(COMPOSITION_CONFIG_SCHEMAS.get("project-assembly")!, {
    target: "draft-7",
    io: "input",
  });
  const copy = object(object(assemblyJson.properties!.copies).items);
  const branches = object(copy.properties!.parent).oneOf!.map(object);
  const branch = branches.find((item) => object(item.properties?.kind).const === "copy")!;
  assert.deepEqual(branch.required, ["kind", "id", "nodeId"]);
  assert.equal(branch.additionalProperties, false);
});

test("schema derivation rejects unrepresentable, coercive and unchecked custom constraints", () => {
  for (const schema of [
    z.string(),
    z
      .string()
      .max(10)
      .refine((value) => value === "hidden"),
    z.string().max(10).default("default"),
    z.coerce.number(),
    z
      .string()
      .max(10)
      .transform((value) => value.toUpperCase()),
    z.record(z.string(), z.string().max(10)),
    z
      .string()
      .max(20)
      .regex(/^(a+)+$/),
  ])
    assert.throws(() => compositionConfigDataSchema(schema));
  const union = compositionConfigDataSchema(
    z.union([z.string().max(8), z.number().positive().max(4)]),
  );
  assert.equal(gameDataMatchesSchema(0, union), false);
  assert.equal(gameDataMatchesSchema(0.01, union), true);
  assert.equal(gameDataMatchesSchema("text", union), true);
  const reversed: GameDataSchema = {
    type: "union",
    anyOf: [...(union as Extract<GameDataSchema, { type: "union" }>).anyOf].reverse(),
  };
  assert.deepEqual(canonicalGameDataSchema(reversed, DEFAULT_GAME_ADMISSION_POLICY), union);
  for (const schema of [
    { type: "string", minLength: 4, maxLength: 3 },
    { type: "array", minItems: 2, maxItems: 1, items: { type: "boolean" } },
    { type: "number", exclusiveMinimum: 1, maximum: 1 },
  ])
    assert.throws(() =>
      canonicalGameDataSchema(GAME_DATA_SCHEMA.parse(schema), DEFAULT_GAME_ADMISSION_POLICY),
    );
});

test("advertised generic IR integer lower bounds agree with the runtime validators", () => {
  const records: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    records.push(record);
    Object.values(record).forEach(visit);
  };
  for (const schema of [
    GAME_SOURCE_CONTENT_SCHEMA,
    GAME_SOURCE_PLACEMENT_SCHEMA,
    GAME_DATA_SCHEMA,
    GAME_ADMISSION_POLICY_SCHEMA,
  ])
    visit(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
  for (const field of [
    "utf8Bytes",
    "beforeSourceBytes",
    "maxLength",
    "minLength",
    "maxItems",
    "minItems",
  ]) {
    const fields = records.flatMap((record) => {
      const properties = record.properties as Record<string, Record<string, unknown>> | undefined;
      return properties?.[field] ? [properties[field]] : [];
    });
    assert.ok(fields.length > 0, field);
    for (const schema of fields) {
      assert.equal(schema.type, "integer", field);
      assert.equal(schema.minimum, 0, field + " advertised lower bound");
      assert.equal(schema.maximum, Number.MAX_SAFE_INTEGER, field + " advertised upper bound");
    }
  }
  assert.equal(
    GAME_SOURCE_CONTENT_SCHEMA.safeParse({
      kind: "locked",
      sourceHash: "a".repeat(64),
      utf8Bytes: -1,
    }).success,
    false,
  );
  assert.equal(GAME_DATA_SCHEMA.safeParse({ type: "string", maxLength: -1 }).success, false);
  assert.equal(
    GAME_DATA_SCHEMA.safeParse({ type: "array", maxItems: -1, items: { type: "boolean" } }).success,
    false,
  );
});
