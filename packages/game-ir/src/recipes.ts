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
  | { type: "string"; maxLength: number; enum?: readonly string[] | undefined }
  | { type: "number" | "integer"; minimum?: number | undefined; maximum?: number | undefined }
  | { type: "boolean" | "null" }
  | { type: "array"; items: GameDataSchema; maxItems: number }
  | {
      type: "object";
      properties: Readonly<Record<string, GameDataSchema>>;
      required: readonly string[];
      additionalProperties: false;
    };

export const GAME_DATA_SCHEMA: z.ZodType<GameDataSchema> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("string"),
        maxLength: z.number().int().nonnegative().safe(),
        enum: z.array(z.string()).min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(["number", "integer"]),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
      })
      .strict(),
    z.object({ type: z.enum(["boolean", "null"]) }).strict(),
    z
      .object({
        type: z.literal("array"),
        items: GAME_DATA_SCHEMA,
        maxItems: z.number().int().nonnegative().safe(),
      })
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
        schema.type === "integer" &&
        [schema.minimum, schema.maximum].some(
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
      if (schema.maxLength > policy.maximumStringUtf8Bytes)
        throw new GameAdmissionError(
          "resource_limit",
          "schema",
          "String schema bound exceeds admission policy",
        );
      if (
        schema.enum &&
        (new Set(schema.enum).size !== schema.enum.length ||
          schema.enum.some((value) => [...value].length > schema.maxLength))
      )
        throw new GameAdmissionError(
          "invalid_definition",
          "schema",
          "String enum contains duplicate or oversized members",
        );
      return { ...schema, ...(schema.enum ? { enum: [...schema.enum].sort() } : {}) };
    }
    case "array":
      if (schema.maxItems > policy.maximumJsonNodes)
        throw new GameAdmissionError(
          "resource_limit",
          "schema",
          "Array schema bound exceeds admission policy",
        );
      return { ...schema, items: canonicalGameDataSchema(schema.items, policy) };
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
        [...value].length <= schema.maxLength &&
        (!schema.enum || schema.enum.includes(value))
      );
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.every((item) => gameDataMatchesSchema(item, schema.items))
      );
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
