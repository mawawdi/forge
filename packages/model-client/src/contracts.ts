import type { ModelImage } from "./images.js";
export type { ModelImage } from "./images.js";

export const MODEL_CONTINUATION_MAX_BYTES = 4 * 1024 * 1024;

export interface ModelContinuation {
  transport: string;
  payload: unknown;
  hash: string;
  bytes: number;
}

export type ModelMessage =
  | { role: "user"; content: string; images?: readonly ModelImage[] }
  | {
      role: "assistant";
      content: string;
      toolCalls: ModelToolCall[];
      continuation?: ModelContinuation;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Present only for raw argument text that the transport could not parse as JSON. */
  argumentSyntaxError?: ModelToolArgumentSyntaxError;
}

export interface ModelToolArgumentSyntaxError {
  kind: "invalid_json";
  /** JSON.parse offsets count UTF-16 code units, not UTF-8 bytes. */
  positionUtf16: number | null;
  line: number | null;
  column: number | null;
  vicinity: { startUtf16: number; text: string } | null;
}
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface ModelRequestSizes {
  systemInstructions: number;
  conversation: number;
  toolSchemas: number;
  toolResults: number;
}

export interface ModelTurnRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ModelResponseFacts {
  requestedModel: string;
  /** Exact model reported by the response envelope, never inferred from the request. */
  resolvedModel: string | null;
  /** Exact serving provider reported by OpenRouter, or null when no response established it. */
  servingProvider: string | null;
  responseId: string | null;
  latencyMs: number;
  retryCount: 0;
  finishReason: string | null;
  continuationHash: string | null;
  continuationBytes: number | null;
  /** Digests of the received first-choice tool-call envelope, before argument parsing. */
  toolCallWireEvidence?: ModelToolCallWireEvidence;
}

export interface ModelToolCallWireEvidence {
  kind: "ModelToolCallWireEvidence";
  envelopeHash: string;
  totalCalls: number;
  omittedCalls: number;
  calls: {
    index: number;
    /** Null when absent or outside the bounded diagnostic identifier length. */
    id: string | null;
    name: string | null;
    argumentsHash: string | null;
    argumentsBytes: number | null;
    jsonValidity: "valid" | "invalid" | "unavailable";
    /** Only populated for malformed JSON when the adapter returned the corresponding input. */
    invalidInputMatchesWire: boolean | null;
  }[];
}

interface ModelTurnBase {
  usage: ModelUsage;
  requestHash: string;
  providerMetadataHash?: string;
}

export type ModelTurnResult =
  | (ModelTurnBase & {
      kind: "assistant";
      message: Extract<ModelMessage, { role: "assistant" }>;
      stopReason: "end_turn" | "tool_calls" | "max_tokens" | "refusal" | "other";
      responseHash: string;
      responseFacts: ModelResponseFacts;
    })
  | (ModelTurnBase & {
      kind: "invalid_model_response";
      errorClass: string;
      message: string;
      responseFacts: ModelResponseFacts;
    })
  | (ModelTurnBase & {
      kind: "provider_error";
      errorClass: string;
      message: string;
      retryable: boolean;
      responseFacts: ModelResponseFacts;
    });

export interface ModelClientDescriptor {
  transport: string;
  configuration: {
    aiSdk: { package: string };
    providerAdapter: { package: string };
    routing: {
      modelRegistryHash: string;
      allowlistedModels: readonly string[];
      providerAllowlist: "none";
      modelFallbacks: false;
      providerFallbacks: false;
      requireParameters: true;
      requireTools: true;
    };
    reasoning: { effort: "medium"; exclude: false };
    request: {
      steps: 1;
      toolChoice: "auto";
      providerParallelToolCalls: "not_requested";
      toolBatchExecution: "host_validated_then_sequential";
      toolNameEncoding: "openai_function_slug";
      maxRetries: 0;
      telemetry: false;
      timeoutPolicy: "bounded_turn_and_remaining_runtime_budget";
      maxDurationMsPerTurn: number;
      maxOutputTokensPerTurn: number;
      /** Selected-model limits observed in the bounded provider metadata probe. */
      maxOutputTokensByModel: Readonly<Record<string, number>>;
      outputTokenLimitCatalogHash: string | null;
      inputModalitiesByModel: Readonly<Record<string, readonly string[] | null>>;
      inputModalityCatalogHash: string | null;
    };
    continuation: { maxBytes: number };
  };
}

export interface ModelClient {
  readonly descriptor: ModelClientDescriptor;
  complete(request: ModelTurnRequest): Promise<ModelTurnResult>;
}

/** A selected model needs explicit catalog evidence; absence never means image support. */
export function supportsModelImages(descriptor: ModelClientDescriptor, model: string): boolean {
  const request = descriptor.configuration.request;
  return (
    typeof request.inputModalityCatalogHash === "string" &&
    /^[0-9a-f]{64}$/.test(request.inputModalityCatalogHash) &&
    Object.hasOwn(request.inputModalitiesByModel, model) &&
    request.inputModalitiesByModel[model]?.includes("image") === true
  );
}

/** Select the exact cap before journaling a request; transports must not silently change it. */
export function modelOutputTokenLimit(descriptor: ModelClientDescriptor, model: string): number {
  const limits = descriptor.configuration.request;
  const limit = Object.hasOwn(limits.maxOutputTokensByModel, model)
    ? limits.maxOutputTokensByModel[model]!
    : limits.maxOutputTokensPerTurn;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxOutputTokensPerTurn)
    throw new Error("Model output-token limit is outside its declared transport bounds.");
  return limit;
}
