import { z } from "zod";
import type {
  GameComponentCompilation,
  GameComponentCompilerInput,
} from "../../game-compiler/src/index.js";
import { PROJECT_ASSEMBLY_CONFIG_SCHEMA, compileProjectAssembly } from "./assembly.js";
import { SCENE_LIGHTING_CONFIG_SCHEMA, compileSceneLighting } from "./lighting.js";
import { STUDIO_PATCH_CONFIG_SCHEMA, compileStudioPatch } from "./patch.js";

export const NATIVE_GRAPH_DECLARATION_SCHEMA = z.discriminatedUnion("kind", [
  STUDIO_PATCH_CONFIG_SCHEMA.extend({ kind: z.literal("studio_objects") }).strict(),
  PROJECT_ASSEMBLY_CONFIG_SCHEMA.extend({ kind: z.literal("collections") }).strict(),
  SCENE_LIGHTING_CONFIG_SCHEMA.extend({ kind: z.literal("lighting") }).strict(),
]);
export type NativeGraphDeclaration = z.infer<typeof NATIVE_GRAPH_DECLARATION_SCHEMA>;

export function compileNativeGraph(
  context: GameComponentCompilerInput,
  input: unknown,
): GameComponentCompilation {
  const declaration = NATIVE_GRAPH_DECLARATION_SCHEMA.parse(input);
  const { kind: _kind, ...config } = declaration;
  const output =
    declaration.kind === "studio_objects"
      ? compileStudioPatch(context, config)
      : declaration.kind === "collections"
        ? compileProjectAssembly(context, config)
        : compileSceneLighting(context, config);
  return {
    inventory: output.inventory,
    outputs: output.inventory.flatMap((item) =>
      item.outputId ? [{ id: item.outputId, operationId: item.id }] : [],
    ),
    observedSources: [],
  };
}
