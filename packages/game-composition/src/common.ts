import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  type GameDesignObligation,
} from "../../game-ir/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import { gameGeneratedTarget, type GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  assertStudioValueForProperty,
  canonicalStudioValue,
  sortedStudioMutationPropertyNames,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import type {
  StudioMutationParent,
  StudioNonScriptWritableClass,
} from "../../creator-session/src/index.js";

export interface CompositionContext {
  componentId: string;
  projectId: string;
  designHash: string;
}
export interface CompositionOutput {
  inventory: GameInventoryItem[];
  sources: Array<{ operationId: string; source: string }>;
  obligations: GameDesignObligation[];
  limitations: string[];
}
import { COMPOSITION_ID_SCHEMA, CompositionError } from "./config-schema.js";
export { CompositionError } from "./config-schema.js";

export function boundedConfig(input: unknown): void {
  assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
}
export function uniqueById<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    if (!COMPOSITION_ID_SCHEMA.safeParse(value.id).success || map.has(value.id))
      throw new CompositionError(
        "invalid_identity",
        `Invalid or duplicate composition id: ${value.id}`,
      );
    map.set(value.id, value);
  }
  return map;
}
export function itemId(context: CompositionContext, localId: string): string {
  return "composition-" + contentHash(stableJson([context.componentId, localId])).slice(0, 40);
}
export function engineParent(path: string): StudioMutationParent {
  const parent = STUDIO_CAPABILITY_MANIFEST.authoringContainers.find(
    (entry) => entry.path === path,
  );
  if (!parent)
    throw new CompositionError("unsupported_parent", `No admitted engine parent: ${path}`);
  return { kind: "engine_container", ...parent };
}
export function outputParent(
  context: CompositionContext,
  item: GameInventoryItem,
): StudioMutationParent {
  if (item.change.kind !== "create")
    throw new CompositionError("invalid_inventory", "Composition parent must be a create");
  return gameGeneratedTarget({
    projectId: context.projectId,
    designHash: context.designHash,
    operationId: item.id,
    path: item.change.path,
    className: item.change.className,
  });
}
export function createItem(
  context: CompositionContext,
  localId: string,
  name: string,
  className: StudioNonScriptWritableClass,
  parent: StudioMutationParent,
  properties: Record<string, StudioValue>,
  dependencies: string[] = [],
  outputId?: string,
): GameInventoryItem {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,95}$/.test(name))
    throw new CompositionError(
      "invalid_name",
      "Composition names must be safe single path segments",
    );
  const definition = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
  if (!definition?.creatable)
    throw new CompositionError(
      "unsupported_class",
      `No admitted detached constructor for ${className}`,
    );
  const canonical: Record<string, StudioValue> = {};
  for (const name of sortedStudioMutationPropertyNames(definition, properties)) {
    const property = definition.properties.find((entry) => entry.name === name)!;
    const value = canonicalStudioValue(properties[name]!, property);
    assertStudioValueForProperty(value, property);
    canonical[name] = value;
  }
  const id = itemId(context, localId);
  return {
    id,
    componentId: context.componentId,
    ...(outputId === undefined ? {} : { outputId }),
    change: {
      id,
      kind: "create",
      path: parent.path + "/" + name,
      parent,
      className,
      initialization: "initial_properties",
    },
    lockedProperties: canonical,
    valueSlots: [],
    attributes: {},
    removedAttributes: [],
    dependencies,
  };
}

export const bool = (value: boolean): StudioValue => ({ kind: "boolean", value });
export const num = (value: number): StudioValue => ({ kind: "number_f32", value });
export const integer = (value: number): StudioValue => ({ kind: "int32", value });
export const str = (value: string): StudioValue => ({ kind: "string_utf8", value });
export const enumeration = (value: string): StudioValue => ({ kind: "enum_name", value });
export const vec2 = (x: number, y: number): StudioValue => ({ kind: "vector2_f32", x, y });
export const vec3 = (value: { x: number; y: number; z: number }): StudioValue => ({
  kind: "vector3_f32",
  ...value,
});
export const color = (value: { r: number; g: number; b: number }): StudioValue => ({
  kind: "color3_rgb8",
  ...value,
});
export const udim2 = (xs: number, xo: number, ys: number, yo: number): StudioValue => ({
  kind: "udim2",
  x: { scale: xs, offset: xo },
  y: { scale: ys, offset: yo },
});
