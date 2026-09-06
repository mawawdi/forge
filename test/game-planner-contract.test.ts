import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  creatorGameCatalog,
  creatorGameComponentEnvelopeSchema,
  creatorGameComponentSchema,
  projectCreatorGameComponentInput,
} from "../packages/creator-session/src/game-authoring.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameSourcePackage,
} from "../packages/game-ir/src/index.js";

const catalog = await creatorGameCatalog();
const schema = creatorGameComponentSchema(catalog);
const providerSchema = creatorGameComponentEnvelopeSchema(catalog);
const nestedArraySchema = (depth: number): unknown => {
  let value: unknown = { type: "boolean" };
  for (let index = 0; index < depth; index++) value = { type: "array", items: value, maxItems: 1 };
  return value;
};
const recursiveSchemaDefinitions = (root: unknown): string[] => {
  if (root === null || typeof root !== "object") return [];
  const definitions = (root as Record<string, unknown>)["$defs"];
  if (definitions === null || typeof definitions !== "object" || Array.isArray(definitions))
    return [];
  const edges = new Map<string, Set<string>>(
    Object.keys(definitions).map((name) => [name, new Set<string>()]),
  );
  const collect = (value: unknown, targets: Set<string>): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, targets));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/"))
      targets.add(record.$ref.slice(8).split("/")[0]!.replaceAll("~1", "/").replaceAll("~0", "~"));
    Object.values(record).forEach((item) => collect(item, targets));
  };
  for (const [name, value] of Object.entries(definitions)) collect(value, edges.get(name)!);
  const reaches = (target: string, current: string, seen: Set<string>): boolean => {
    if (current === target) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return [...(edges.get(current) ?? [])].some((next) => reaches(target, next, seen));
  };
  return [...edges]
    .filter(([name, targets]) =>
      [...targets].some((target) => reaches(name, target, new Set<string>())),
    )
    .map(([name]) => name);
};
const design = (components: unknown[]) => ({
  kind: "GameDesignSpec",
  worldAuthoring: { mode: "none" },
  id: "workshop",
  intent: "Create an interactive workshop.",
  components,
  connections: [],
  artifactDependencies: [],
});
const scene = () => ({
  kind: "recipe_instance",
  id: "objects",
  definition: gameRecipeDefinitionLock(
    catalog.definitions.find((item) => item.id === "scene-primitives")!,
  ),
  config: {
    rootName: "Workshop",
    parentPath: "Workspace",
    nodes: [
      {
        id: "plinth",
        name: "Plinth",
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
  },
});

test("planner exposes installed recipe constraints and locks before the first model request", () => {
  const json = z.toJSONSchema(providerSchema, { reused: "ref" });
  const encoded = JSON.stringify(json);
  const emptyPrefixItems: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.prefixItems) && record.prefixItems.length === 0)
      emptyPrefixItems.push(record.prefixItems);
    Object.values(record).forEach(visit);
  };
  visit(json);
  assert.deepEqual(emptyPrefixItems, [], "provider tool schemas cannot contain prefixItems: []");
  assert.deepEqual(
    recursiveSchemaDefinitions(json),
    [],
    "provider tool schemas cannot contain recursive references",
  );
  const exactBytes = Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema, { reused: "ref" })));
  const providerBytes = Buffer.byteLength(JSON.stringify(json));
  assert.ok(
    providerBytes < exactBytes * 0.4,
    `provider guidance should stay materially smaller than host validation: ${exactBytes} → ${providerBytes}`,
  );
  for (const definition of catalog.definitions) {
    assert.ok(encoded.includes(gameRecipeDefinitionLock(definition).hash), definition.id);
  }
  assert.equal(schema.safeParse(scene()).success, true);
  const fractional = scene();
  fractional.config.nodes[0]!.color.r = 0.5;
  assert.equal(schema.safeParse(fractional).success, false);
  assert.equal(
    validateGameDesignSpec(design([fractional]), {
      registry: catalog.registry,
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    }).status,
    "rejected",
  );
  const stale = scene();
  stale.definition = { ...stale.definition, hash: "0".repeat(64) };
  assert.equal(schema.safeParse(stale).success, false);
  const missing = scene();
  Reflect.deleteProperty(missing.config, "constraints");
  assert.deepEqual(schema.parse(missing), schema.parse(scene()));
  assert.equal(
    schema.safeParse({ ...missing, config: { ...missing.config, constraints: null } }).success,
    false,
    "only omission receives the declared empty-array default",
  );
});

test("general source packages remain available and source paths fail together before compilation", () => {
  const source = {
    kind: "source_package",
    id: "interaction",
    ports: [],
    obligations: [],
    files: ["Services/Interaction.luau", "Utilities.luau"].map((path, index) => ({
      id: `file-${index}`,
      path,
      role: "module",
      context: "server",
      content: { kind: "slot", maximumUtf8Bytes: 4096 },
      imports: [],
      placement: {
        kind: "create",
        operationId: `create-file-${index}`,
        parent: {
          kind: "engine_container",
          path: "ServerScriptService",
          className: "ServerScriptService",
        },
        name: `Module${index}`,
        className: "ModuleScript",
      },
    })),
  };
  const input = projectCreatorGameComponentInput(source as GameSourcePackage);
  assert.equal(schema.safeParse(input).success, true);
  const nestedPortInput = {
    ...input,
    ports: [{ id: "state", direction: "output", fileId: "file-0", schema: nestedArraySchema(9) }],
  };
  assert.equal(providerSchema.safeParse(nestedPortInput).success, true);
  assert.equal(schema.safeParse(nestedPortInput).success, true);
  source.files[0]!.path = "ServerScriptService.Forge.Interaction";
  source.files[1]!.path = "../Utilities.luau";
  const rejected = validateGameDesignSpec(design([source]), {
    registry: catalog.registry,
    policy: DEFAULT_GAME_ADMISSION_POLICY,
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status !== "rejected") return;
  assert.deepEqual(
    rejected.diagnostics.map((issue) => issue.subject),
    ["components.0.files.0.path", "components.0.files.1.path"],
  );
  const json = JSON.stringify(z.toJSONSchema(providerSchema));
  assert.ok(json.includes("Relative source file path ending in .luau"));
});
