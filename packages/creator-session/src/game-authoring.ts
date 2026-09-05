import {
  createGameDefinitionRegistry,
  type GameRecipeDefinition,
} from "../../game-ir/src/index.js";
import {
  SCENE_PRIMITIVES_DEFINITION,
  SCENE_PRIMITIVES_EXPANDER,
  RESPONSIVE_UI_DEFINITION,
  RESPONSIVE_UI_EXPANDER,
  UI_ACTION_BINDINGS_SOURCE,
  STUDIO_PATCH_DEFINITION,
  STUDIO_PATCH_EXPANDER,
} from "../../game-composition/src/index.js";
import { contentHash } from "../../contracts/src/index.js";
import type { GameRecipeExpander } from "../../game-compiler/src/index.js";
import { loadForgeRuntimeBundle, createForgeRuntimeRecipe } from "../../game-runtime/src/index.js";

/** Trusted compiler catalog. Candidate data can select definitions, never install one. */
export async function creatorGameCatalog(): Promise<{
  definitions: GameRecipeDefinition[];
  registry: ReturnType<typeof createGameDefinitionRegistry>;
  expanders: GameRecipeExpander[];
  lockedSources: ReadonlyMap<string, string>;
}> {
  const runtime = createForgeRuntimeRecipe(await loadForgeRuntimeBundle());
  const definitions = [
    SCENE_PRIMITIVES_DEFINITION,
    RESPONSIVE_UI_DEFINITION,
    STUDIO_PATCH_DEFINITION,
    runtime.definition,
  ];
  return {
    definitions,
    registry: createGameDefinitionRegistry(definitions),
    expanders: [
      SCENE_PRIMITIVES_EXPANDER,
      RESPONSIVE_UI_EXPANDER,
      STUDIO_PATCH_EXPANDER,
      runtime.expander,
    ],
    lockedSources: new Map([
      ...runtime.lockedSources,
      [contentHash(UI_ACTION_BINDINGS_SOURCE), UI_ACTION_BINDINGS_SOURCE],
    ]),
  };
}
