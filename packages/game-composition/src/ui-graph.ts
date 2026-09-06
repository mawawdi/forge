import type {
  GameComponentCompilation,
  GameComponentCompilerInput,
} from "../../game-compiler/src/index.js";
import { RESPONSIVE_UI_CONFIG_SCHEMA, compileResponsiveUi } from "./ui.js";

export const UI_GRAPH_DECLARATION_SCHEMA = RESPONSIVE_UI_CONFIG_SCHEMA;
export type UiGraphDeclaration = ReturnType<typeof UI_GRAPH_DECLARATION_SCHEMA.parse>;

export function compileUiGraph(
  context: GameComponentCompilerInput,
  input: unknown,
): GameComponentCompilation {
  const output = compileResponsiveUi(context, UI_GRAPH_DECLARATION_SCHEMA.parse(input));
  return {
    inventory: output.inventory,
    outputs: output.inventory.flatMap((item) =>
      item.outputId ? [{ id: item.outputId, operationId: item.id }] : [],
    ),
    observedSources: [],
  };
}
