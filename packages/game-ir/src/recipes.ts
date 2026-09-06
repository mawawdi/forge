import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertBoundedGameJson,
  compareGameStrings,
  DEFAULT_GAME_ADMISSION_POLICY,
  entityId,
  GameAdmissionError,
  GAME_ADMISSION_POLICY_SCHEMA,
  type GameAdmissionPolicy,
  type GameJsonValue,
} from "./primitives.js";

/** Bounded data contracts; no executable callbacks, references or schema loaders. */
export type GameDataSchema =
  | ({
      type: "string";
      minLength?: number | undefined;
      pattern?: string | undefined;
    } & (
      | { maxLength: number; enum?: readonly string[] | undefined }
      | { enum: readonly string[]; maxLength?: number | undefined }
    ))
  | {
      type: "number" | "integer";
      minimum?: number | undefined;
      maximum?: number | undefined;
      exclusiveMinimum?: number | undefined;
      exclusiveMaximum?: number | undefined;
    }
  | { type: "boolean" | "null" }
  | {
      type: "array";
      items: GameDataSchema;
      maxItems: number;
      minItems?: number | undefined;
      default?: readonly [] | undefined;
    }
  | { type: "union"; anyOf: readonly GameDataSchema[] }
  | {
      type: "object";
      properties: Readonly<Record<string, GameDataSchema>>;
      required: readonly string[];
      additionalProperties: false;
    };

// z.tuple([]) emits `prefixItems: []`, which is not valid JSON Schema and is
// rejected by OpenRouter before inference. max(0) accepts the same sole value
// while producing an ordinary array schema that provider tool validators accept.
const EMPTY_ARRAY_VALUE_SCHEMA = z.array(z.unknown()).max(0) as unknown as z.ZodType<readonly []>;

const GAME_DATA_SCALAR_SCHEMAS = [
  z
    .object({
      type: z.literal("string"),
      maxLength: z.number().int().safe().nonnegative(),
      minLength: z.number().int().safe().nonnegative().optional(),
      pattern: z.string().max(256).optional(),
      enum: z.array(z.string()).min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("string"),
      enum: z.array(z.string()).min(1),
      maxLength: z.number().int().safe().nonnegative().optional(),
      minLength: z.number().int().safe().nonnegative().optional(),
      pattern: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["number", "integer"]),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      exclusiveMinimum: z.number().finite().optional(),
      exclusiveMaximum: z.number().finite().optional(),
    })
    .strict(),
  z.object({ type: z.enum(["boolean", "null"]) }).strict(),
] as const;

export const GAME_DATA_SCHEMA: z.ZodType<GameDataSchema> = z.lazy(() =>
  z.union([
    ...GAME_DATA_SCALAR_SCHEMAS,
    z
      .object({
        type: z.literal("array"),
        items: GAME_DATA_SCHEMA,
        maxItems: z.number().int().safe().nonnegative(),
        minItems: z.number().int().safe().nonnegative().optional(),
        default: EMPTY_ARRAY_VALUE_SCHEMA.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("union"), anyOf: z.array(GAME_DATA_SCHEMA).min(2).max(32) })
      .strict(),
    z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), GAME_DATA_SCHEMA),
        required: z.array(z.string()),
        additionalProperties: z.literal(false),
      })
      .strict(),
  ]),
);

export const GAME_PORT_SCHEMA = z
  .object({
    id: entityId,
    direction: z.enum(["input", "output"]),
    schema: GAME_DATA_SCHEMA,
  })
  .strict();
export const GAME_OBLIGATION_SCHEMA = z
  .object({
    id: entityId,
    description: z.string().min(1),
    evidence: z.enum([
      "source_analysis",
      "isolated_test",
      "studio_edit",
      "studio_play",
      "published_client",
      "creator_review",
    ]),
  })
  .strict();
export type GamePort = z.infer<typeof GAME_PORT_SCHEMA>;
export type GameObligation = z.infer<typeof GAME_OBLIGATION_SCHEMA>;

const RECIPE_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("GameRecipeDefinition"),
    id: entityId,
    abi: z.string().min(1).max(128),
    configSchema: GAME_DATA_SCHEMA,
    sourceExports: z.array(
      z.object({ id: entityId, context: z.enum(["server", "client", "shared"]) }).strict(),
    ),
    ports: z.array(GAME_PORT_SCHEMA),
    obligations: z.array(GAME_OBLIGATION_SCHEMA),
  })
  .strict();
export type GameRecipeDefinition = z.infer<typeof RECIPE_DEFINITION_SCHEMA>;
export interface GameDefinitionLock {
  readonly id: string;
  readonly abi: string;
  readonly hash: string;
}

declare const registryBrand: unique symbol;
export interface GameDefinitionRegistry {
  readonly [registryBrand]: true;
}
interface RegisteredDefinition {
  definition: GameRecipeDefinition;
  lock: GameDefinitionLock;
}
const registries = new WeakMap<GameDefinitionRegistry, ReadonlyMap<string, RegisteredDefinition>>();

export function uniqueGameIds(values: readonly { id: string }[], subject: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new GameAdmissionError(
      "duplicate_id",
      subject,
      "IDs must be unique within their declaration scope",
    );
}

export function canonicalGameDataSchema(
  schema: GameDataSchema,
  policy: GameAdmissionPolicy,
): GameDataSchema {
  switch (schema.type) {
    case "number":
    case "integer":
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Schema minimum exceeds maximum",
        );
      if (
        (schema.exclusiveMinimum !== undefined &&
          schema.maximum !== undefined &&
          schema.exclusiveMinimum >= schema.maximum) ||
        (schema.exclusiveMaximum !== undefined &&
          schema.minimum !== undefined &&
          schema.exclusiveMaximum <= schema.minimum) ||
        (schema.exclusiveMinimum !== undefined &&
          schema.exclusiveMaximum !== undefined &&
          schema.exclusiveMinimum >= schema.exclusiveMaximum)
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Schema exclusive bounds leave no values",
        );
      if (
        schema.type === "integer" &&
        [schema.minimum, schema.maximum, schema.exclusiveMinimum, schema.exclusiveMaximum].some(
          (value) => value !== undefined && !Number.isSafeInteger(value),
        )
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Integer schema bounds must be safe integers",
        );
      return { ...schema };
    case "string": {
      const maxLength = gameStringMaximumLength(schema);
      if (schema.minLength !== undefined && schema.minLength > maxLength)
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "String minimum exceeds maximum",
        );
      if (schema.pattern !== undefined) assertGameDataPattern(schema.pattern);
      if (maxLength > policy.maximumStringUtf8Bytes)
        throw new GameAdmissionError(
          "resource_limit",
          "schema",
          "String schema bound exceeds admission policy",
        );
      if (
        schema.enum &&
        (new Set(schema.enum).size !== schema.enum.length ||
          schema.enum.some(
            (value) =>
              [...value].length > maxLength ||
              [...value].length < (schema.minLength ?? 0) ||
              (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)),
          ))
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "String enum contains duplicate or oversized members",
        );
      return { ...schema, maxLength, ...(schema.enum ? { enum: [...schema.enum].sort() } : {}) };
    }
    case "array":
      if (schema.default !== undefined && (schema.minItems ?? 0) > 0)
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "An empty-array default must satisfy the array's minimum length",
        );
      if (schema.minItems !== undefined && schema.minItems > schema.maxItems)
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Array minimum exceeds maximum",
        );
      if (schema.maxItems > policy.maximumJsonNodes)
        throw new GameAdmissionError(
          "resource_limit",
          "schema",
          "Array schema bound exceeds admission policy",
        );
      return { ...schema, items: canonicalGameDataSchema(schema.items, policy) };
    case "union": {
      const alternatives = schema.anyOf.map((item) => canonicalGameDataSchema(item, policy));
      const entries = alternatives
        .map((item) => [stableJson(item), item] as const)
        .sort(([a], [b]) => compareGameStrings(a, b));
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Union alternatives must be distinct",
        );
      return { type: "union", anyOf: entries.map(([, item]) => item) };
    }
    case "object": {
      if (
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some((key) => !Object.hasOwn(schema.properties, key))
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "Required keys must uniquely resolve declared properties",
        );
      return {
        ...schema,
        properties: Object.fromEntries(
          Object.entries(schema.properties)
            .sort(([a], [b]) => compareGameStrings(a, b))
            .map(([key, value]) => [key, canonicalGameDataSchema(value, policy)]),
        ),
        required: [...schema.required].sort(),
      };
    }
    case "null":
    case "boolean":
      return { ...schema };
  }
}

export function canonicalGamePorts(
  ports: readonly GamePort[],
  policy: GameAdmissionPolicy,
): GamePort[] {
  uniqueGameIds(ports, "ports");
  return ports
    .map((port) => ({ ...port, schema: canonicalGameDataSchema(port.schema, policy) }))
    .sort((a, b) => compareGameStrings(a.id, b.id));
}

function admitDefinition(input: unknown, policy: GameAdmissionPolicy): RegisteredDefinition {
  assertBoundedGameJson(input, policy);
  const parsed = RECIPE_DEFINITION_SCHEMA.safeParse(input);
  if (!parsed.success)
    throw new GameAdmissionError(
      "invalid_definition",
      "definition",
      "Invalid strict recipe definition",
    );
  uniqueGameIds(parsed.data.obligations, "obligations");
  uniqueGameIds(parsed.data.sourceExports, "sourceExports");
  const definition: GameRecipeDefinition = {
    ...parsed.data,
    configSchema: canonicalGameDataSchema(parsed.data.configSchema, policy),
    ports: canonicalGamePorts(parsed.data.ports, policy),
    sourceExports: [...parsed.data.sourceExports].sort((a, b) => compareGameStrings(a.id, b.id)),
    obligations: [...parsed.data.obligations].sort((a, b) => compareGameStrings(a.id, b.id)),
  };
  return {
    definition,
    lock: { id: definition.id, abi: definition.abi, hash: contentHash(stableJson(definition)) },
  };
}

/** Derives identity only; it does not admit a compiler, execute source or grant authority. */
export function gameRecipeDefinitionLock(
  input: unknown,
  policy: GameAdmissionPolicy = DEFAULT_GAME_ADMISSION_POLICY,
): GameDefinitionLock {
  return admitDefinition(input, GAME_ADMISSION_POLICY_SCHEMA.parse(policy)).lock;
}

/** Only trusted host code supplies this registry; model input cannot construct it. */
export function createGameDefinitionRegistry(
  inputs: readonly unknown[],
  policy: GameAdmissionPolicy = DEFAULT_GAME_ADMISSION_POLICY,
): GameDefinitionRegistry {
  policy = GAME_ADMISSION_POLICY_SCHEMA.parse(policy);
  assertBoundedGameJson(inputs, policy);
  if (inputs.length > policy.maximumDefinitions)
    throw new GameAdmissionError(
      "resource_limit",
      "definitions",
      "Definition count exceeds admission policy",
    );
  const definitions = new Map<string, RegisteredDefinition>();
  for (const input of inputs) {
    const admitted = admitDefinition(input, policy);
    const key = stableJson(admitted.lock);
    if (definitions.has(key))
      throw new GameAdmissionError("duplicate_id", admitted.lock.id, "Duplicate definition pin");
    definitions.set(key, admitted);
  }
  const registry = Object.freeze({}) as GameDefinitionRegistry;
  registries.set(registry, definitions);
  return registry;
}

export function resolveGameDefinition(
  registry: GameDefinitionRegistry,
  lock: GameDefinitionLock,
  policy: GameAdmissionPolicy,
): GameRecipeDefinition {
  const registered = registries.get(registry);
  if (!registered)
    throw new GameAdmissionError(
      "invalid_definition",
      "registry",
      "Only a host-created definition registry is admissible",
    );
  const entry = registered.get(stableJson(lock));
  if (!entry)
    throw new GameAdmissionError(
      "definition_not_found",
      lock.id,
      "Exact definition ID, ABI and hash are not admitted",
    );
  // Re-admit under this call's policy, which may be tighter than registry construction.
  return admitDefinition(entry.definition, policy).definition;
}

export function assertGameDefinitionRegistry(registry: GameDefinitionRegistry): void {
  if (!registries.has(registry))
    throw new GameAdmissionError(
      "invalid_definition",
      "registry",
      "Only a host-created definition registry is admissible",
    );
}

/** JSON Schema length counts Unicode code points, independently of UTF-8 admission bytes. */
function gameStringMaximumLength(schema: Extract<GameDataSchema, { type: "string" }>): number {
  if (schema.maxLength !== undefined) return schema.maxLength;
  if (!schema.enum?.length)
    throw new GameAdmissionError(
      "invalid_definition",
      "schema",
      "Open strings require a maximum length",
    );
  let maximum = 0;
  for (const member of schema.enum) maximum = Math.max(maximum, [...member].length);
  return maximum;
}

/** Materialize only declared empty-array defaults, before authority hashing; never infer values. */
export function canonicalGameConfig(
  value: GameJsonValue,
  schema: GameDataSchema,
  policy: GameAdmissionPolicy,
): GameJsonValue {
  if (!gameDataMatchesSchema(value, schema))
    throw new GameAdmissionError(
      "invalid_recipe_config",
      "config",
      "Recipe configuration does not match its declared schema",
    );
  let visits = 0;
  const defaults = new Map<GameDataSchema, Array<[string, GameDataSchema]>>();
  const visit = (item: GameJsonValue, declaration: GameDataSchema): GameJsonValue => {
    if (++visits > policy.maximumJsonNodes)
      throw new GameAdmissionError(
        "resource_limit",
        "config",
        "Configuration default expansion exceeds its node budget",
      );
    if (declaration.type === "array")
      return (item as GameJsonValue[]).map((entry) => visit(entry, declaration.items));
    if (declaration.type === "object") {
      const fields = item as Record<string, GameJsonValue>;
      const entries = Object.entries(fields).map(
        ([key, child]) => [key, visit(child, declaration.properties[key]!)] as const,
      );
      let declared = defaults.get(declaration);
      if (!declared) {
        declared = Object.entries(declaration.properties).filter(
          ([, child]) => child.type === "array" && child.default !== undefined,
        );
        defaults.set(declaration, declared);
      }
      for (const [key, child] of declared)
        if (!Object.hasOwn(fields, key)) entries.push([key, visit([], child)]);
      return Object.fromEntries(entries);
    }
    if (declaration.type === "union") {
      const candidates = declaration.anyOf
        .filter((alternative) => gameDataMatchesSchema(item, alternative))
        .map((alternative) => visit(item, alternative));
      if (new Set(candidates.map((candidate) => stableJson(candidate))).size !== 1)
        throw new GameAdmissionError(
          "invalid_recipe_config",
          "config",
          "Matching union branches declare different configuration defaults",
        );
      return candidates[0]!;
    }
    return item;
  };
  const normalized = visit(value, schema);
  assertBoundedGameJson(normalized, policy);
  return normalized;
}

/** Checks declared configuration data, never candidate source exports or behavior. */
export function gameDataMatchesSchema(value: GameJsonValue, schema: GameDataSchema): boolean {
  switch (schema.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return (
        typeof value === "string" &&
        [...value].length <= gameStringMaximumLength(schema) &&
        [...value].length >= (schema.minLength ?? 0) &&
        (schema.pattern === undefined || matchesGameDataPattern(value, schema.pattern)) &&
        (!schema.enum || schema.enum.includes(value))
      );
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum) &&
        (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) &&
        (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum)
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.length >= (schema.minItems ?? 0) &&
        value.every((item) => gameDataMatchesSchema(item, schema.items))
      );
    case "union":
      return schema.anyOf.some((alternative) => gameDataMatchesSchema(value, alternative));
    case "object":
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      return (
        schema.required.every((key) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(
          ([key, item]) =>
            Object.hasOwn(schema.properties, key) &&
            gameDataMatchesSchema(item, schema.properties[key]!),
        )
      );
  }
}

/** Bounded identifier patterns only: no groups, alternation, backreferences or unbounded repeats. */
function assertGameDataPattern(pattern: string): void {
  const match = /^\^(\[[A-Za-z0-9 _-]+\])(\[[A-Za-z0-9 _-]+\])?(?:\{(\d+)(?:,(\d+))?\})?\$$/.exec(
    pattern,
  );
  if (
    !match ||
    pattern.length > 256 ||
    (match[3] !== undefined &&
      (Number(match[3]) > Number(match[4] ?? match[3]) || Number(match[4] ?? match[3]) > 65536))
  )
    throw new GameAdmissionError(
      "invalid_definition",
      "schema",
      "Pattern must be a bounded linear identifier expression",
    );
  try {
    new RegExp(pattern);
  } catch {
    throw new GameAdmissionError("invalid_definition", "schema", "Invalid identifier pattern");
  }
}
function matchesGameDataPattern(value: string, pattern: string): boolean {
  assertGameDataPattern(pattern);
  return new RegExp(pattern).test(value);
}
