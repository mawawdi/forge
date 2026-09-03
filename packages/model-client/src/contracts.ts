export const MODEL_CONTINUATION_MAX_BYTES = 256 * 1024;

export interface ModelContinuation {
  transport: string;
  payload: unknown;
  hash: string;
  bytes: number;
}

export type ModelMessage =
  | { role: "user"; content: string }
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
}
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
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
      toolBatchExecution: "atomic_validate_then_sequential";
      toolNameEncoding: "openai_function_slug";
      maxRetries: 0;
      telemetry: false;
      timeoutPolicy: "remaining_runtime_budget";
      maxOutputTokensPerTurn: number;
    };
    continuation: { maxBytes: number };
  };
}

export interface ModelClient {
  readonly descriptor: ModelClientDescriptor;
  complete(request: ModelTurnRequest): Promise<ModelTurnResult>;
}
