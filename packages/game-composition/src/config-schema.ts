import { z } from "zod";
import { DEFAULT_GAME_ADMISSION_POLICY, entityId } from "../../game-ir/src/primitives.js";
import type { GameDataSchema } from "../../game-ir/src/recipes.js";
import { canonicalGameDataSchema, GAME_DATA_SCHEMA } from "../../game-ir/src/recipes.js";

export class CompositionError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}
const declaredEmptyArrayDefaults = new WeakSet<object>();

/** The only admitted parser default: an explicitly declared, valid empty array. */
export function emptyArrayDefault<T extends z.ZodType>(schema: z.ZodArray<T>) {
  if (!schema.safeParse([]).success)
    throw new CompositionError(
      "unsupported_config_schema",
      "An empty-array default must satisfy its array schema",
    );
  const result = schema.default([]);
  declaredEmptyArrayDefaults.add(result);
  return result;
}
export const COMPOSITION_ID_SCHEMA = entityId;
export const COMPOSITION_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,95}$/);
export const COMPOSITION_MEMBER_SCHEMA = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);

/** Derive the bounded declaration contract from the compiler's actual input validator. */
export function compositionConfigDataSchema(schema: z.ZodType): GameDataSchema {
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    cycles: "throw",
    reused: "inline",
    unrepresentable: "throw",
    override: ({ zodSchema, jsonSchema }) => {
      const definition = zodSchema._zod.def;
      if (jsonSchema.default !== undefined && !declaredEmptyArrayDefaults.has(zodSchema))
        throw new CompositionError(
          "unsupported_config_schema",
          "Defaults require the fixed empty-array declaration helper",
        );
      if (
        (![
          "object",
          "array",
          "string",
          "number",
          "boolean",
          "null",
          "optional",
          "union",
          "literal",
          "enum",
        ].includes(definition.type) &&
          !(definition.type === "default" && declaredEmptyArrayDefaults.has(zodSchema))) ||
        ("coerce" in definition && definition.coerce)
      )
        throw new CompositionError(
          "unsupported_config_schema",
          "Recipe schemas must validate plain input without coercion, transforms or undeclared defaults",
        );
      if (
        definition.type === "union" &&
        "inclusive" in definition &&
        definition.inclusive === false &&
        !("discriminator" in definition)
      )
        throw new CompositionError(
          "unsupported_config_schema",
          "Exclusive alternatives require a literal discriminator",
        );
      if (zodSchema._zod.def.checks?.some((check) => check._zod.def.check === "custom"))
        throw new CompositionError(
          "unsupported_config_schema",
          "Custom refinements cannot be advertised as structural recipe constraints",
        );
    },
  });
  const convert = (input: unknown): unknown => {
    const node = input as Record<string, unknown>;
    const allowed = new Set([
      "$schema",
      "description",
      "type",
      "const",
      "enum",
      "minLength",
      "maxLength",
      "pattern",
      "default",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "items",
      "minItems",
      "maxItems",
      "properties",
      "required",
      "additionalProperties",
      "anyOf",
      "oneOf",
    ]);
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(node).some((key) => !allowed.has(key))
    )
      throw new CompositionError(
        "unsupported_config_schema",
        "Recipe config uses an unsupported JSON Schema construct",
      );
    const { $schema: _dialect, description: _description, ...value } = node;
    if (value.oneOf !== undefined || value.anyOf !== undefined) {
      const alternatives = value.oneOf ?? value.anyOf;
      if (Object.keys(value).length !== 1 || !Array.isArray(alternatives))
        throw new CompositionError(
          "unsupported_config_schema",
          "Recipe alternatives must be standalone branches",
        );
      return { type: "union", anyOf: alternatives.map(convert) };
    }
    if (value.type === "string") {
      const { const: literal, ...rest } = value;
      const members = literal === undefined ? rest.enum : [literal];
      const maxLength =
        rest.maxLength ??
        (Array.isArray(members) && members.every((member) => typeof member === "string")
          ? Math.max(...members.map((member) => [...member].length))
          : undefined);
      if (maxLength === undefined)
        throw new CompositionError(
          "unsupported_config_schema",
          "Every recipe string needs an explicit maximum length",
        );
      return {
        ...rest,
        maxLength,
        ...(members === undefined ? {} : { enum: members }),
      };
    }
    if (value.type === "array") return { ...value, items: convert(value.items) };
    if (value.type === "object") {
      if (
        value.properties === null ||
        typeof value.properties !== "object" ||
        Array.isArray(value.properties)
      )
        throw new CompositionError(
          "unsupported_config_schema",
          "Recipe objects require explicit properties",
        );
      return {
        ...value,
        required: value.required ?? [],
        properties: Object.fromEntries(
          Object.entries(value.properties).map(([key, child]) => [key, convert(child)]),
        ),
      };
    }
    return value;
  };
  return canonicalGameDataSchema(
    GAME_DATA_SCHEMA.parse(convert(json)),
    DEFAULT_GAME_ADMISSION_POLICY,
  );
}
