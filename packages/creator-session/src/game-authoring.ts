import {
  createGameDefinitionRegistry,
  GAME_DESIGN_SPEC_SCHEMA,
  GAME_SOURCE_PACKAGE_SCHEMA,
  GAME_RECIPE_INSTANCE_SCHEMA,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
  type GameDesignSpec,
} from "../../game-ir/src/index.js";
import { z } from "zod";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  entityId,
  hashSchema,
  type GameAdmissionPolicy,
} from "../../game-ir/src/primitives.js";
import { canonicalGameDataSchema } from "../../game-ir/src/recipes.js";
import {
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_PRIMITIVES_EXPANDER,
  SCENE_PRIMITIVES_CONFIG_SCHEMA,
  SCENE_LIGHTING_DEFINITION,
  SCENE_LIGHTING_EXPANDER,
  SCENE_ARRANGEMENT_DEFINITION,
  SCENE_ARRANGEMENT_EXPANDER,
  compileSceneArrangement,
  validateSceneLightingConfig,
  RESPONSIVE_UI_DEFINITION,
  RESPONSIVE_UI_EXPANDER,
  RESPONSIVE_UI_CONFIG_SCHEMA,
  UI_CONTROLLER_SOURCE,
  STUDIO_PATCH_DEFINITION,
  STUDIO_PATCH_EXPANDER,
  PROJECT_ASSEMBLY_DEFINITION,
  PROJECT_ASSEMBLY_EXPANDER,
  COMPOSITION_CONFIG_SCHEMAS,
} from "../../game-composition/src/index.js";
import { contentHash } from "../../contracts/src/index.js";
import type { GameRecipeExpander } from "../../game-compiler/src/index.js";
import { loadForgeRuntimeBundle, createForgeRuntimeRecipe } from "../../game-runtime/src/index.js";
import { assertUiValid } from "../../game-composition/src/ui-validation.js";
import { resolveScene } from "../../game-composition/src/scene-validation.js";
import { CompositionError } from "../../game-composition/src/config-schema.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
} from "../../studio-evidence/src/index.js";

export type CreatorGameCatalog = Awaited<ReturnType<typeof creatorGameCatalog>>;
const CREATOR_GAME_DATA_ENVELOPE_SCHEMA = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "null", "array", "union", "object"]),
  })
  .loose();
const CREATOR_RECIPE_CONFIG_ENVELOPE_SCHEMA = z.object({}).loose();

/** Host-only semantic admission for one declaration, before retaining a draft component.
 * This repeats the compiler's same pure checks; it supplies no editor or execution authority. */
export function validateCreatorGameComponent(
  component: GameDesignSpec["components"][number],
): void {
  if (component.kind === "source_package") {
    const allowedEngineContainers = STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(
      ({ className, path }) => ({ className, path }),
    );
    const issues = component.files.flatMap((file, index) => {
      const placement = file.placement;
      if (placement?.kind !== "create" || placement.parent.kind !== "engine_container") return [];
      const { className, path } = placement.parent;
      if (
        allowedEngineContainers.some(
          (container) => container.className === className && container.path === path,
        )
      )
        return [];
      return [
        {
          code: "invalid_engine_container",
          fileId: file.id,
          path: `files[${index}].placement.parent`,
          actual: { className, path },
          expected: "one exact className/path pair from allowedEngineContainers",
          detail:
            "Engine-container paths include their full ancestry; className names the parent container, not the new script.",
        },
      ];
    });
    if (issues.length)
      throw new CompositionError(
        "invalid_source_placement",
        JSON.stringify({
          componentId: component.id,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
          issues,
          allowedEngineContainers,
        }),
      );
    return;
  }
  if (component.kind !== "recipe_instance") return;
  const definition = [
    RESPONSIVE_UI_DEFINITION,
    SCENE_PRIMITIVES_DEFINITION,
    SCENE_LIGHTING_DEFINITION,
    SCENE_ARRANGEMENT_DEFINITION,
  ].find((entry) => entry.id === component.definition.id);
  if (!definition) return;
  const expected = gameRecipeDefinitionLock(definition);
  if (component.definition.abi !== expected.abi || component.definition.hash !== expected.hash)
    throw new Error(
      `${definition.id} semantic validation requires the exact installed recipe definition lock`,
    );
  if (definition.id === SCENE_PRIMITIVES_DEFINITION.id)
    resolveScene(SCENE_PRIMITIVES_CONFIG_SCHEMA.parse(component.config), component.id);
  else if (definition.id === SCENE_ARRANGEMENT_DEFINITION.id)
    compileSceneArrangement(
      { componentId: component.id, projectId: "catalog-validation", designHash: "0".repeat(64) },
      component.config,
    );
  else if (definition.id === SCENE_LIGHTING_DEFINITION.id)
    validateSceneLightingConfig(component.config);
  else assertUiValid(RESPONSIVE_UI_CONFIG_SCHEMA.parse(component.config), component.id);
}

function creatorSourceFilesSchema() {
  const file = GAME_SOURCE_PACKAGE_SCHEMA.shape.files.element;
  const [observed, create, edit] = file.shape.placement.unwrap().options;
  const [instanceParent, engineParent, generatedParent, componentParent] =
    create.shape.parent.options;
  const createInput = create.omit({ className: true }).extend({
    parent: z.union([
      instanceParent,
      engineParent.omit({ className: true }).extend({
        path: z.enum(STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(({ path }) => path)),
      }),
      generatedParent,
      componentParent,
    ]),
  });
  const installedFile = (
    role: "module" | "entrypoint",
    className: "ModuleScript" | "Script" | "LocalScript",
    context: z.ZodType<"server" | "client" | "shared"> = file.shape.context,
  ) =>
    file.extend({
      role: z.literal(role),
      context,
      placement: z
        .discriminatedUnion("kind", [
          createInput,
          edit.extend({ target: edit.shape.target.extend({ className: z.literal(className) }) }),
        ])
        .describe(
          "Required editor installation target. Forge derives a new script's class from its file role and context, and an engine_container parent's class from its exact offered path. Do not supply className for these creates or engine parents. Existing instance parents and targets retain their exact observed metadata. Use component_output for recipe-created parents; generated refers to an authored source placement operationId.",
        ),
    });
  return z
    .array(
      z.union([
        installedFile("module", "ModuleScript"),
        installedFile("entrypoint", "Script", z.enum(["server"])),
        installedFile("entrypoint", "LocalScript", z.enum(["client"])),
        file.extend({
          role: z.literal("module"),
          content: file.shape.content.options[0],
          placement: observed.extend({
            target: observed.shape.target.extend({ className: z.literal("ModuleScript") }),
          }),
        }),
      ]),
    )
    .min(1);
}

/** Exact host validator used for draft retention and canonical component hashing. */
export function creatorGameComponentSchema(catalog: CreatorGameCatalog) {
  const sourcePackage = GAME_SOURCE_PACKAGE_SCHEMA.extend({
    files: creatorSourceFilesSchema(),
  });
  const recipes = catalog.definitions.map((definition) => {
    const lock = gameRecipeDefinitionLock(definition);
    return GAME_RECIPE_INSTANCE_SCHEMA.extend({
      definition: z
        .object({ id: z.literal(lock.id), abi: z.literal(lock.abi), hash: z.literal(lock.hash) })
        .strict(),
      config: creatorRecipeConfigSchema(definition),
    });
  });
  return z.union([sourcePackage, ...recipes]);
}

/** Exact installed recipe input contract, shared by host validation and catalog detail reads. */
export function creatorRecipeConfigSchema(definition: GameRecipeDefinition): z.ZodType {
  const schema =
    definition.id === "forge-runtime"
      ? z.object({}).strict()
      : COMPOSITION_CONFIG_SCHEMAS.get(definition.id);
  if (!schema) throw new Error(`Missing planner config schema for ${definition.id}`);
  return schema;
}

/** Shallow provider guidance; exact nested declarations are validated by the host above. */
export function creatorGameComponentEnvelopeSchema(catalog: CreatorGameCatalog) {
  const sourcePort = GAME_SOURCE_PACKAGE_SCHEMA.shape.ports.element.extend({
    schema: CREATOR_GAME_DATA_ENVELOPE_SCHEMA,
  });
  const sourcePackage = GAME_SOURCE_PACKAGE_SCHEMA.extend({
    ports: z.array(sourcePort),
    files: creatorSourceFilesSchema(),
  });
  const recipes = catalog.definitions.map((definition) => {
    const lock = gameRecipeDefinitionLock(definition);
    return GAME_RECIPE_INSTANCE_SCHEMA.extend({
      definition: z
        .object({ id: z.literal(lock.id), abi: z.literal(lock.abi), hash: z.literal(lock.hash) })
        .strict(),
      config: CREATOR_RECIPE_CONFIG_ENVELOPE_SCHEMA,
    });
  });
  return z.union([sourcePackage, ...recipes]);
}

export type CreatorGameComponentInput = z.infer<ReturnType<typeof creatorGameComponentSchema>>;

/** Resolve host-owned facts after parsing the authoring input, before canonical hashing. */
export function resolveCreatorGameComponentInput(
  input: CreatorGameComponentInput,
  policy: GameAdmissionPolicy = DEFAULT_GAME_ADMISSION_POLICY,
): GameDesignSpec["components"][number] {
  if (input.kind !== "source_package")
    return structuredClone(input) as GameDesignSpec["components"][number];
  return GAME_SOURCE_PACKAGE_SCHEMA.parse({
    ...input,
    ports: input.ports.map((port) => ({
      ...port,
      schema: canonicalGameDataSchema(port.schema, policy),
    })),
    files: input.files.map((file) => {
      const placement = file.placement;
      if (placement.kind !== "create") return file;
      const parent = placement.parent;
      const engineContainer =
        parent.kind === "engine_container"
          ? STUDIO_CAPABILITY_MANIFEST.authoringContainers.find(({ path }) => path === parent.path)
          : undefined;
      if (parent.kind === "engine_container" && !engineContainer)
        throw new CompositionError(
          "invalid_engine_container",
          `Unknown engine parent: ${parent.path}`,
        );
      return {
        ...file,
        placement: {
          ...placement,
          className:
            file.role === "module"
              ? "ModuleScript"
              : file.context === "server"
                ? "Script"
                : "LocalScript",
          parent: engineContainer ? { ...parent, className: engineContainer.className } : parent,
        },
      };
    }),
  });
}

/** Return the editable declaration shape; retained components and their hashes stay canonical. */
export function projectCreatorGameComponentInput(
  component: GameDesignSpec["components"][number],
): CreatorGameComponentInput {
  if (component.kind !== "source_package")
    return structuredClone(component) as CreatorGameComponentInput;
  return {
    ...structuredClone(component),
    files: component.files.map((file) => {
      const placement = file.placement;
      if (placement?.kind !== "create") return structuredClone(file);
      const { className: _className, ...create } = placement;
      const parent = create.parent;
      if (parent.kind === "engine_container") {
        const { className: _parentClass, ...engineParent } = parent;
        return structuredClone({ ...file, placement: { ...create, parent: engineParent } });
      }
      return structuredClone({ ...file, placement: create });
    }),
  } as CreatorGameComponentInput;
}

export const CREATOR_COMPONENT_REF_SCHEMA = z
  .object({ componentId: entityId, componentHash: hashSchema })
  .strict();
export type CreatorComponentRef = z.infer<typeof CREATOR_COMPONENT_REF_SCHEMA>;

/** The model selects semantic IDs; the host binds their current validated bytes before review. */
export function creatorGameProposalDesignSchema() {
  return GAME_DESIGN_SPEC_SCHEMA.omit({ components: true }).extend({
    componentIds: z
      .array(entityId)
      .min(1)
      .describe(
        "Exact stable IDs of the saved components to include. Forge resolves their current versions and seals the complete plan for creator review; do not copy component hashes.",
      ),
  });
}

/** Trusted compiler catalog. Candidate data can select definitions, never install one. */
export async function creatorGameCatalog(): Promise<{
  definitions: GameRecipeDefinition[];
  registry: ReturnType<typeof createGameDefinitionRegistry>;
  expanders: GameRecipeExpander[];
  lockedSources: ReadonlyMap<string, string>;
  validateComponent?: (component: GameDesignSpec["components"][number]) => void;
}> {
  const runtime = createForgeRuntimeRecipe(await loadForgeRuntimeBundle());
  const definitions = [
    SCENE_PRIMITIVES_DEFINITION,
    SCENE_LIGHTING_DEFINITION,
    SCENE_ARRANGEMENT_DEFINITION,
    RESPONSIVE_UI_DEFINITION,
    STUDIO_PATCH_DEFINITION,
    PROJECT_ASSEMBLY_DEFINITION,
    runtime.definition,
  ];
  return {
    validateComponent: validateCreatorGameComponent,
    definitions,
    registry: createGameDefinitionRegistry(definitions),
    expanders: [
      SCENE_PRIMITIVES_EXPANDER,
      SCENE_LIGHTING_EXPANDER,
      SCENE_ARRANGEMENT_EXPANDER,
      RESPONSIVE_UI_EXPANDER,
      STUDIO_PATCH_EXPANDER,
      PROJECT_ASSEMBLY_EXPANDER,
      runtime.expander,
    ],
    lockedSources: new Map([
      ...runtime.lockedSources,
      [contentHash(UI_CONTROLLER_SOURCE), UI_CONTROLLER_SOURCE],
    ]),
  };
}
