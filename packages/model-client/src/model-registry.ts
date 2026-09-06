import { contentHash, stableJson } from "../../contracts/src/index.js";

export const CREATOR_MODEL_IDS = Object.freeze([
  "meta/muse-spark-1.3-contributor",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4-flash-0731",
  "openai/gpt-5.6-luna",
  "google/gemini-3.8-flash",
] as const);

export type CreatorModelId = (typeof CREATOR_MODEL_IDS)[number];
export type CreatorModelAvailability = "available" | "unavailable" | "unconfirmed";

export const DEFAULT_CREATOR_MODEL_ID: CreatorModelId = "meta/muse-spark-1.3-contributor";

export interface CreatorModelDefinition {
  id: CreatorModelId;
  label: string;
  requiredSupportedParameters: readonly ["tools"];
}

export interface CreatorModelRegistry {
  kind: "CreatorModelRegistry";
  defaultModelId: CreatorModelId;
  models: readonly CreatorModelDefinition[];
  hash: string;
}

const REQUIRED_TOOL_PARAMETER: readonly ["tools"] = Object.freeze(["tools"] as const);
const MODEL_DEFINITIONS: readonly CreatorModelDefinition[] = Object.freeze([
  Object.freeze({
    id: "meta/muse-spark-1.3-contributor",
    label: "Muse Spark 1.3",
    requiredSupportedParameters: REQUIRED_TOOL_PARAMETER,
  }),
  Object.freeze({
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    requiredSupportedParameters: REQUIRED_TOOL_PARAMETER,
  }),
  Object.freeze({
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    requiredSupportedParameters: REQUIRED_TOOL_PARAMETER,
  }),
  Object.freeze({
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    requiredSupportedParameters: REQUIRED_TOOL_PARAMETER,
  }),
  Object.freeze({
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    requiredSupportedParameters: REQUIRED_TOOL_PARAMETER,
  }),
]);

const REGISTRY_BODY = {
  kind: "CreatorModelRegistry" as const,
  defaultModelId: DEFAULT_CREATOR_MODEL_ID,
  models: MODEL_DEFINITIONS,
};

/** Canonical, secret-free admission policy for every creator model request. */
export const CREATOR_MODEL_REGISTRY: CreatorModelRegistry = Object.freeze({
  ...REGISTRY_BODY,
  hash: contentHash(stableJson(REGISTRY_BODY)),
});

export function assertCreatorModelRegistry(value: unknown): asserts value is CreatorModelRegistry {
  if (!isRecord(value) || value.kind !== "CreatorModelRegistry")
    throw new Error("Creator model registry kind is invalid.");
  if (value.defaultModelId !== DEFAULT_CREATOR_MODEL_ID || !Array.isArray(value.models))
    throw new Error("Creator model registry default or coverage is invalid.");
  if (stableJson(value.models) !== stableJson(MODEL_DEFINITIONS))
    throw new Error("Creator model registry definitions are invalid.");
  if (typeof value.hash !== "string") throw new Error("Creator model registry hash is invalid.");
  const { hash: _hash, ...body } = value;
  if (value.hash !== contentHash(stableJson(body)))
    throw new Error("Creator model registry hash is invalid.");
}

export type CreatorModelCatalogReason =
  | "catalog_confirmed"
  | "model_not_listed"
  | "tools_not_supported"
  | "tool_support_not_reported"
  | "duplicate_catalog_entry"
  | "catalog_response_invalid"
  | "catalog_response_too_large"
  | "catalog_request_failed"
  | `catalog_http_${number}`;

export interface CreatorModelCatalogEntry {
  modelId: CreatorModelId;
  status: CreatorModelAvailability;
  reason: CreatorModelCatalogReason;
  /** Null means the catalog did not establish a positive safe completion-token limit. */
  maxCompletionTokens: number | null;
  /** Exact sorted architecture.input_modalities; null means absent or malformed metadata. */
  inputModalities: string[] | null;
}

export interface CreatorModelCatalog {
  kind: "CreatorModelCatalog";
  registryHash: string;
  source: "openrouter_models_api";
  checkedAt: string;
  models: CreatorModelCatalogEntry[];
  hash: string;
}

export interface CreatorModelSelection {
  requestedModel: string;
  definition: CreatorModelDefinition | null;
  availability: CreatorModelAvailability;
  reason: "model_not_allowlisted" | "catalog_not_supplied" | CreatorModelCatalogReason;
}

export function isCreatorModelId(value: string): value is CreatorModelId {
  return (CREATOR_MODEL_IDS as readonly string[]).includes(value);
}

export function creatorModelDefinition(modelId: string): CreatorModelDefinition | null {
  return CREATOR_MODEL_REGISTRY.models.find((model) => model.id === modelId) ?? null;
}

/**
 * Resolve one explicit selection without ever substituting the default or a
 * different available model. Catalog health is advisory until the caller
 * chooses to enforce it at a product boundary.
 */
export function resolveCreatorModelSelection(
  requestedModel: string,
  catalog?: CreatorModelCatalog,
): CreatorModelSelection {
  const definition = creatorModelDefinition(requestedModel);
  if (!definition)
    return {
      requestedModel,
      definition: null,
      availability: "unavailable",
      reason: "model_not_allowlisted",
    };
  if (!catalog)
    return {
      requestedModel,
      definition,
      availability: "unconfirmed",
      reason: "catalog_not_supplied",
    };
  assertCreatorModelCatalog(catalog);
  const entry = catalog.models.find((candidate) => candidate.modelId === requestedModel);
  if (!entry) throw new Error(`Creator model catalog omitted ${requestedModel}.`);
  return {
    requestedModel,
    definition,
    availability: entry.status,
    reason: entry.reason,
  };
}

export function parseOpenRouterModelCatalog(
  payload: unknown,
  checkedAt: string,
): CreatorModelCatalog {
  assertIsoTimestamp(checkedAt);
  if (!isRecord(payload) || !Array.isArray(payload.data))
    return materializeCatalog(checkedAt, () => ({
      status: "unconfirmed",
      reason: "catalog_response_invalid",
    }));

  const records = new Map<string, unknown[]>();
  for (const value of payload.data) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    const existing = records.get(value.id);
    if (existing) existing.push(value);
    else records.set(value.id, [value]);
  }
  return materializeCatalog(checkedAt, (modelId) => {
    const matches = records.get(modelId) ?? [];
    if (matches.length === 0) return { status: "unavailable", reason: "model_not_listed" };
    if (matches.length !== 1) return { status: "unconfirmed", reason: "duplicate_catalog_entry" };
    const candidate = matches[0];
    if (!isRecord(candidate) || !Array.isArray(candidate.supported_parameters))
      return { status: "unconfirmed", reason: "tool_support_not_reported" };
    const supported = candidate.supported_parameters.filter(
      (parameter): parameter is string => typeof parameter === "string",
    );
    const advertised = isRecord(candidate.top_provider)
      ? candidate.top_provider.max_completion_tokens
      : undefined;
    const maxCompletionTokens =
      typeof advertised === "number" && Number.isSafeInteger(advertised) && advertised > 0
        ? advertised
        : null;
    const modalities = isRecord(candidate.architecture)
      ? candidate.architecture.input_modalities
      : undefined;
    const inputModalities =
      Array.isArray(modalities) &&
      modalities.length > 0 &&
      modalities.length <= 32 &&
      modalities.every(
        (item) => typeof item === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(item),
      ) &&
      new Set(modalities).size === modalities.length
        ? ([...modalities].sort() as string[])
        : null;
    return supported.includes("tools")
      ? { status: "available", reason: "catalog_confirmed", maxCompletionTokens, inputModalities }
      : {
          status: "unavailable",
          reason: "tools_not_supported",
          maxCompletionTokens,
          inputModalities,
        };
  });
}

export function unconfirmedCreatorModelCatalog(
  checkedAt: string,
  reason: Exclude<
    CreatorModelCatalogReason,
    | "catalog_confirmed"
    | "model_not_listed"
    | "tools_not_supported"
    | "tool_support_not_reported"
    | "duplicate_catalog_entry"
  >,
): CreatorModelCatalog {
  assertIsoTimestamp(checkedAt);
  return materializeCatalog(checkedAt, () => ({ status: "unconfirmed", reason }));
}

export function assertCreatorModelCatalog(value: unknown): asserts value is CreatorModelCatalog {
  if (!isRecord(value)) throw new Error("Creator model catalog is invalid.");
  if (
    value.kind !== "CreatorModelCatalog" ||
    value.registryHash !== CREATOR_MODEL_REGISTRY.hash ||
    value.source !== "openrouter_models_api"
  )
    throw new Error("Creator model catalog binding is invalid.");
  if (typeof value.checkedAt !== "string" || !Array.isArray(value.models))
    throw new Error("Creator model catalog shape is invalid.");
  assertIsoTimestamp(value.checkedAt);
  if (
    value.models.length !== CREATOR_MODEL_IDS.length ||
    value.models.some((entry, index) => !validCatalogEntry(entry, CREATOR_MODEL_IDS[index]))
  )
    throw new Error("Creator model catalog coverage or order is invalid.");
  if (typeof value.hash !== "string") throw new Error("Creator model catalog hash is invalid.");
  const { hash: _hash, ...body } = value;
  if (value.hash !== contentHash(stableJson(body)))
    throw new Error("Creator model catalog hash is invalid.");
}

function validCatalogEntry(value: unknown, expectedModelId: CreatorModelId | undefined): boolean {
  if (!isRecord(value) || value.modelId !== expectedModelId || typeof value.reason !== "string")
    return false;
  if (
    value.inputModalities !== null &&
    (!Array.isArray(value.inputModalities) ||
      value.inputModalities.length < 1 ||
      value.inputModalities.length > 32 ||
      !value.inputModalities.every(
        (item) => typeof item === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(item),
      ) ||
      stableJson(value.inputModalities) !== stableJson([...new Set(value.inputModalities)].sort()))
  )
    return false;
  if (
    value.maxCompletionTokens !== null &&
    (typeof value.maxCompletionTokens !== "number" ||
      !Number.isSafeInteger(value.maxCompletionTokens) ||
      value.maxCompletionTokens < 1)
  )
    return false;
  if (value.status === "available") return value.reason === "catalog_confirmed";
  if (value.status === "unavailable")
    return value.reason === "model_not_listed" || value.reason === "tools_not_supported";
  if (value.status !== "unconfirmed") return false;
  return (
    [
      "tool_support_not_reported",
      "duplicate_catalog_entry",
      "catalog_response_invalid",
      "catalog_response_too_large",
      "catalog_request_failed",
    ].includes(value.reason) || /^catalog_http_[1-5][0-9]{2}$/.test(value.reason)
  );
}

function materializeCatalog(
  checkedAt: string,
  statusFor: (modelId: CreatorModelId) => {
    status: CreatorModelAvailability;
    reason: CreatorModelCatalogReason;
    maxCompletionTokens?: number | null;
    inputModalities?: string[] | null;
  },
): CreatorModelCatalog {
  const body = {
    kind: "CreatorModelCatalog" as const,
    registryHash: CREATOR_MODEL_REGISTRY.hash,
    source: "openrouter_models_api" as const,
    checkedAt,
    models: CREATOR_MODEL_IDS.map((modelId) => ({
      modelId,
      maxCompletionTokens: null,
      inputModalities: null,
      ...statusFor(modelId),
    })),
  };
  return { ...body, hash: contentHash(stableJson(body)) };
}

function assertIsoTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error("Creator model catalog timestamp must be canonical ISO 8601.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
