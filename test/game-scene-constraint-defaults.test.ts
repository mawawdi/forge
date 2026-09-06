import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import { validateCreatorGameComponent } from "../packages/creator-session/src/game-authoring.js";
import { compileGamePlan, expandGameDesign } from "../packages/game-compiler/src/index.js";
import {
  SCENE_PRIMITIVES_CONFIG_SCHEMA,
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_PRIMITIVES_EXPANDER,
  SCENE_ARRANGEMENT_CONFIG_SCHEMA,
  SCENE_ARRANGEMENT_DEFINITION,
  SCENE_ARRANGEMENT_EXPANDER,
} from "../packages/game-composition/src/index.js";
import {
  compositionConfigDataSchema,
  emptyArrayDefault,
} from "../packages/game-composition/src/config-schema.js";
import {
  createGameDefinitionRegistry,
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameDesignSpec,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";
import {
  canonicalGameConfig,
  GAME_DATA_SCHEMA,
  canonicalGameDataSchema,
} from "../packages/game-ir/src/recipes.js";

const catalog = {
  definitions: [SCENE_PRIMITIVES_DEFINITION, SCENE_ARRANGEMENT_DEFINITION],
  registry: createGameDefinitionRegistry([
    SCENE_PRIMITIVES_DEFINITION,
    SCENE_ARRANGEMENT_DEFINITION,
  ]),
  expanders: [SCENE_PRIMITIVES_EXPANDER, SCENE_ARRANGEMENT_EXPANDER],
  lockedSources: new Map<string, string>(),
  validateComponent: validateCreatorGameComponent,
};
type Mode = "scene-primitives" | "scene-arrangement";
function design(mode: Mode, explicit: boolean, failure = false): GameDesignSpec {
  const geometry = (id: string) => ({
    id,
    name: id,
    shape: "Block",
    size: { x: 2, y: 2, z: 2 },
    placement: { offset: { x: 0, y: 0, z: 0 } },
    anchored: true,
    collidable: true,
  });
  const constraints = failure
    ? [{ kind: "separation", first: "First", second: "Second", clearance: 1 }]
    : [];
  const optional = explicit || failure ? { constraints } : {};
  const config =
    mode === "scene-primitives"
      ? {
          rootName: "Geometry",
          parentPath: "Workspace",
          nodes: ["First", "Second"].map((id) => ({
            ...geometry(id),
            color: { r: 0, g: 100, b: 200 },
            material: "Metal",
          })),
          ...optional,
        }
      : {
          rootName: "Geometry",
          parentPath: "Workspace",
          surfaces: [{ id: "Shell", color: { r: 0, g: 100, b: 200 }, material: "Metal" }],
          motifs: [
            {
              id: "Detail",
              nodes: ["First", "Second"].map((id) => ({ ...geometry(id), surfaceId: "Shell" })),
              ...optional,
            },
          ],
          arrangements: [
            {
              id: "Row",
              name: "Row",
              motifId: "Detail",
              frame: { offset: { x: 0, y: 0, z: 0 } },
              pattern: { kind: "linear", memberIds: ["One", "Two"], step: { x: 8, y: 0, z: 0 } },
            },
          ],
        };
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "Default_Constraints",
    intent: "Compile only explicitly requested spatial constraints.",
    components: [
      {
        kind: "recipe_instance",
        id: "Scene",
        definition: gameRecipeDefinitionLock(catalog.definitions.find((item) => item.id === mode)!),
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
    registry: catalog.registry,
    recipeExpanders: catalog.expanders,
    projectId: "default-constraints-project",
    project: { name: "Default constraints", placeId: 0, universeId: 0 },
    initialTopology: [
      {
        identity: { kind: "forge_attribute" as const, stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ],
  };
  return compileGamePlan({
    ...input,
    ...expandGameDesign(input),
    sessionId: "default-constraints-session",
    observedRevisionHash: contentHash("default-constraints-observation"),
  });
}

test("scene and nested motif omission canonicalizes to the same exact draft and approved authority as []", () => {
  for (const mode of ["scene-primitives", "scene-arrangement"] as const) {
    const omitted = design(mode, false);
    const explicit = design(mode, true);
    const before = stableJson(omitted);
    const first = validateGameDesignSpec(omitted, {
      registry: catalog.registry,
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    });
    const second = validateGameDesignSpec(explicit, {
      registry: catalog.registry,
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    });
    assert.equal(first.status, "eligible");
    assert.deepEqual(first, second);
    assert.equal(stableJson(omitted), before, "normalization must not mutate caller-owned intent");
    const draft = new CreatorDesignDraft(catalog);
    const omittedRef = draft.define({ component: omitted.components[0] });
    const explicitRef = draft.define({ component: explicit.components[0] });
    assert.deepEqual(omittedRef, explicitRef);
    assert.deepEqual(draft.snapshot().components, explicit.components);
    assert.deepEqual(compile(omitted), compile(explicit));
    assert.throws(
      () => compile(design(mode, true, true)),
      /unsatisfiable_constraint|separation failed/,
    );
  }
});

test("model-visible scene and motif schemas declare exactly the admitted empty constraint default", () => {
  const scene = z.toJSONSchema(SCENE_PRIMITIVES_CONFIG_SCHEMA, { io: "input" });
  const constraint = scene.properties!.constraints as z.core.JSONSchema.BaseSchema;
  assert.deepEqual(constraint.default, []);
  assert.equal(scene.required?.includes("constraints"), false);
  const arrangement = z.toJSONSchema(SCENE_ARRANGEMENT_CONFIG_SCHEMA, { io: "input" });
  const motif = (arrangement.properties!.motifs as z.core.JSONSchema.BaseSchema)
    .items as z.core.JSONSchema.BaseSchema;
  assert.deepEqual((motif.properties!.constraints as z.core.JSONSchema.BaseSchema).default, []);
  assert.equal(motif.required?.includes("constraints"), false);
  const explicit = design("scene-primitives", true).components[0]!;
  assert.equal(explicit.kind, "recipe_instance");
  if (explicit.kind !== "recipe_instance") throw new Error("Recipe fixture required");
  for (const invalid of [null, false, {}, "", [null]])
    assert.equal(
      SCENE_PRIMITIVES_CONFIG_SCHEMA.safeParse({
        ...(explicit.config as object),
        constraints: invalid,
      }).success,
      false,
    );
});

test("default admission never changes explicit values, unrelated optional fields or accepts arbitrary defaults", () => {
  const schema = compositionConfigDataSchema(
    z
      .object({
        values: emptyArrayDefault(z.array(z.string().max(4)).max(8)),
        note: z.string().max(8).optional(),
      })
      .strict(),
  );
  assert.deepEqual(canonicalGameConfig({}, schema, DEFAULT_GAME_ADMISSION_POLICY), { values: [] });
  assert.deepEqual(canonicalGameConfig({ values: ["A"] }, schema, DEFAULT_GAME_ADMISSION_POLICY), {
    values: ["A"],
  });
  assert.throws(
    () => canonicalGameConfig({ values: null }, schema, DEFAULT_GAME_ADMISSION_POLICY),
    /does not match/,
  );
  assert.throws(
    () =>
      canonicalGameConfig({}, schema, { ...DEFAULT_GAME_ADMISSION_POLICY, maximumJsonNodes: 1 }),
    /node budget/,
  );
  assert.throws(() => emptyArrayDefault(z.array(z.string().max(4)).min(1).max(8)), /must satisfy/);
  for (const unexpected of [
    z.array(z.string().max(4)).max(8).default(["A"]),
    z
      .array(z.string().max(4))
      .max(8)
      .default(() => []),
    z.array(z.string().max(4)).max(8).meta({ default: [] }),
    z.string().max(4).default("A"),
  ])
    assert.throws(() => compositionConfigDataSchema(unexpected));
  assert.throws(
    () =>
      canonicalGameDataSchema(
        GAME_DATA_SCHEMA.parse({
          type: "array",
          items: { type: "boolean" },
          minItems: 1,
          maxItems: 2,
          default: [],
        }),
        DEFAULT_GAME_ADMISSION_POLICY,
      ),
    /minimum length/,
  );
  assert.equal(
    GAME_DATA_SCHEMA.safeParse({
      type: "array",
      items: { type: "boolean" },
      maxItems: 2,
      default: [true],
    }).success,
    false,
  );
  const variant = (key: string) =>
    compositionConfigDataSchema(
      z
        .object({
          [key]: emptyArrayDefault(z.array(z.boolean()).max(2)),
        })
        .strict(),
    );
  assert.throws(
    () =>
      canonicalGameConfig(
        {},
        { type: "union", anyOf: [variant("a"), variant("b")] },
        DEFAULT_GAME_ADMISSION_POLICY,
      ),
    /different configuration defaults/,
  );
});
