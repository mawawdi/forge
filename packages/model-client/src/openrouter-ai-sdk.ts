import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  generateText,
  jsonSchema,
  modelMessageSchema,
  stepCountIs,
  tool,
  type JSONValue,
  type ModelMessage as AiModelMessage,
  type ToolSet,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  MODEL_CONTINUATION_MAX_BYTES,
  modelOutputTokenLimit,
  supportsModelImages,
  type ModelClient,
  type ModelContinuation,
  type ModelMessage,
  type ModelResponseFacts,
  type ModelToolDefinition,
  type ModelToolCallWireEvidence,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ModelUsage,
} from "./contracts.js";
import {
  CREATOR_MODEL_REGISTRY,
  assertCreatorModelCatalog,
  isCreatorModelId,
  type CreatorModelCatalog,
} from "./model-registry.js";
import { safeProviderErrorMessage } from "./provider-error.js";
import { diagnoseToolArgumentJson } from "./tool-argument-syntax.js";
import { assertModelMessageImages } from "./images.js";
import { captureToolCallWireEvidence } from "./tool-call-wire-evidence.js";

const TRANSPORT = "openrouter-ai-sdk-core";
const ALLOWLISTED_MODELS = Object.freeze(CREATOR_MODEL_REGISTRY.models.map((model) => model.id));

/** Public, secret-free transport identity used to preregister a treatment. */
export const OPENROUTER_MODEL_CLIENT_DESCRIPTOR = {
  transport: TRANSPORT,
  configuration: {
    aiSdk: { package: "ai" },
    providerAdapter: { package: "@openrouter/ai-sdk-provider" },
    routing: {
      modelRegistryHash: CREATOR_MODEL_REGISTRY.hash,
      allowlistedModels: ALLOWLISTED_MODELS,
      providerAllowlist: "none" as const,
      modelFallbacks: false as const,
      providerFallbacks: false as const,
      requireParameters: true as const,
      requireTools: true as const,
    },
    reasoning: { effort: "medium" as const, exclude: false as const },
    request: {
      steps: 1 as const,
      toolChoice: "auto" as const,
      providerParallelToolCalls: "not_requested" as const,
      toolBatchExecution: "host_validated_then_sequential" as const,
      toolNameEncoding: "openai_function_slug" as const,
      toolSchemaMode: "explicit_non_strict" as const,
      maxRetries: 0 as const,
      telemetry: false as const,
      timeoutPolicy: "bounded_turn_and_remaining_runtime_budget" as const,
      maxDurationMsPerTurn: 1_200_000,
      maxOutputTokensPerTurn: 32_768,
      maxOutputTokensByModel: Object.freeze(
        Object.fromEntries(ALLOWLISTED_MODELS.map((model) => [model, 32_768])),
      ),
      outputTokenLimitCatalogHash: null as string | null,
      inputModalitiesByModel: Object.freeze(
        Object.fromEntries(ALLOWLISTED_MODELS.map((model) => [model, null])),
      ) as Readonly<Record<string, readonly string[] | null>>,
      inputModalityCatalogHash: null as string | null,
    },
    continuation: { maxBytes: MODEL_CONTINUATION_MAX_BYTES },
  },
};

export interface OpenRouterAiSdkClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseURL?: string;
  modelCatalog?: CreatorModelCatalog;
}

export class OpenRouterModelClient implements ModelClient {
  readonly descriptor: typeof OPENROUTER_MODEL_CLIENT_DESCRIPTOR;

  private readonly provider: ReturnType<typeof createOpenRouter>;

  constructor(options: OpenRouterAiSdkClientOptions) {
    if (!options.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    if (options.modelCatalog) assertCreatorModelCatalog(options.modelCatalog);
    const caps = Object.freeze(
      Object.fromEntries(
        ALLOWLISTED_MODELS.map((model) => [
          model,
          options.modelCatalog?.models.find((entry) => entry.modelId === model)
            ?.maxCompletionTokens ?? 32_768,
        ]),
      ),
    );
    this.descriptor = {
      ...OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
      configuration: {
        ...OPENROUTER_MODEL_CLIENT_DESCRIPTOR.configuration,
        request: {
          ...OPENROUTER_MODEL_CLIENT_DESCRIPTOR.configuration.request,
          maxOutputTokensPerTurn: Math.max(...Object.values(caps)),
          maxOutputTokensByModel: caps,
          outputTokenLimitCatalogHash: options.modelCatalog?.hash ?? null,
          inputModalitiesByModel: Object.freeze(
            Object.fromEntries(
              ALLOWLISTED_MODELS.map((model) => {
                const entry = options.modelCatalog?.models.find((entry) => entry.modelId === model);
                return [
                  model,
                  entry?.status === "available" && entry.inputModalities
                    ? Object.freeze([...entry.inputModalities])
                    : null,
                ];
              }),
            ),
          ),
          inputModalityCatalogHash: options.modelCatalog?.hash ?? null,
        },
      },
    };
    this.provider = createOpenRouter({
      apiKey: options.apiKey,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      compatibility: "strict",
    });
  }

  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const startedAt = Date.now();
    const requestHash = contentHash(
      stableJson({
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        maxOutputTokens: request.maxOutputTokens,
        timeoutMs: request.timeoutMs,
        transport: this.descriptor,
      }),
    );
    if (!isCreatorModelId(request.model)) {
      return providerFailure(
        "model_not_allowlisted",
        `Requested model ${request.model.slice(0, 200)} is not in the creator model registry.`,
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }
    let wireTools: WireTools;
    try {
      assertModelMessageImages(request.messages);
      if (
        request.messages.some(
          (message) => message.role === "user" && (message.images?.length ?? 0) > 0,
        ) &&
        !supportsModelImages(this.descriptor, request.model)
      )
        return providerFailure(
          "model_image_input_unconfirmed",
          "The selected model has no confirmed image-input capability in the current catalog. Select an image-capable model explicitly; Forge will not drop images or switch models.",
          false,
          requestHash,
          emptyUsage(),
          responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
        );
      if (
        !Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens < 1 ||
        request.maxOutputTokens > modelOutputTokenLimit(this.descriptor, request.model)
      )
        throw new Error("Requested output tokens exceed the declared selected-model limit.");
      wireTools = toWireTools(request.tools);
    } catch (error) {
      return providerFailure(
        "request_configuration",
        boundedTransportMessage(
          error,
          "Forge request does not match the declared provider configuration.",
        ),
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }

    let messages: AiModelMessage[];
    try {
      messages = toAiMessages(request.messages, wireTools.publicToWire);
    } catch (error) {
      return providerFailure(
        "invalid_continuation",
        boundedTransportMessage(error, "Model continuation was malformed."),
        false,
        requestHash,
        emptyUsage(),
        responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
      );
    }

    let receivedResponse:
      | {
          model: string | null;
          provider: string | null;
          id: string | null;
          finishReason: string | null;
        }
      | undefined;
    let wireEvidence: ModelToolCallWireEvidence | undefined;
    const failureFacts = (latencyMs: number, finishReason: string | null) =>
      responseFacts(
        request.model,
        receivedResponse?.model ?? null,
        receivedResponse?.provider ?? null,
        receivedResponse?.id ?? null,
        latencyMs,
        receivedResponse?.finishReason ?? finishReason,
        undefined,
        wireEvidence,
      );
    try {
      const result = await generateText({
        model: this.provider.chat(request.model, {
          provider: { allow_fallbacks: false, require_parameters: true },
          reasoning: { effort: "medium", exclude: false },
          usage: { include: true },
        }),
        system: request.system,
        messages,
        tools: wireTools.tools,
        // The pinned OpenRouter adapter drops AI SDK's per-tool `strict` flag.
        // Its documented call-level passthrough must carry the exact same tools
        // with strict:false, preserving omission in Forge's optional fields.
        providerOptions: { openrouter: { tools: wireTools.providerTools } },
        toolOrder: wireTools.order,
        toolChoice: "auto",
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        maxOutputTokens: request.maxOutputTokens,
        timeout: request.timeoutMs,
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        // Inspect the received tool envelope before discarding the response body.
        // Only bounded digests leave this adapter; prose/reasoning/headers do not.
        include: { responseBody: true },
      });

      const latencyMs = Date.now() - startedAt;
      const usage = usageFrom(result.usage, result.providerMetadata);
      const servingProvider = providerName(result.providerMetadata);
      receivedResponse = {
        model: result.response.modelId,
        provider: servingProvider,
        id: result.response.id,
        finishReason: result.finishReason,
      };
      wireEvidence = wireEvidenceFromResponse(
        result.response.body,
        result.toolCalls.map((call) => call.input),
      );
      if (result.response.modelId !== request.model || servingProvider === null) {
        return providerFailure(
          "response_identity_mismatch",
          "OpenRouter response did not establish the exact requested model and serving provider.",
          false,
          requestHash,
          usage,
          responseFacts(
            request.model,
            result.response.modelId,
            servingProvider,
            result.response.id,
            latencyMs,
            result.finishReason,
            undefined,
            wireEvidence,
          ),
        );
      }
      const continuation = createContinuation(result.responseMessages);
      if (!continuation.ok) {
        return providerFailure(
          "continuation_too_large",
          continuation.message,
          false,
          requestHash,
          usage,
          responseFacts(
            request.model,
            result.response.modelId,
            servingProvider,
            result.response.id,
            latencyMs,
            result.finishReason,
            continuation.identity,
            wireEvidence,
          ),
        );
      }
      const calls = result.toolCalls.map((call) => {
        // InvalidToolInputError retains the actual wire text. A parsed JSON string
        // is a different value and must never be reparsed into a tool object.
        const syntaxError =
          call.invalid && InvalidToolInputError.isInstance(call.error)
            ? diagnoseToolArgumentJson(call.error.toolInput)
            : null;
        return {
          id: call.toolCallId,
          name: wireTools.wireToPublic.get(call.toolName) ?? call.toolName,
          arguments: call.input,
          ...(syntaxError === null ? {} : { argumentSyntaxError: syntaxError }),
        };
      });
      const message: Extract<ModelMessage, { role: "assistant" }> = {
        role: "assistant",
        content: result.text,
        toolCalls: calls,
        continuation: continuation.value,
      };
      const facts = responseFacts(
        request.model,
        result.response.modelId,
        servingProvider,
        result.response.id,
        latencyMs,
        result.finishReason,
        continuation.value,
        wireEvidence,
      );
      return {
        kind: "assistant",
        message,
        stopReason: normalizeStop(result.finishReason, calls.length),
        usage,
        requestHash,
        responseHash: contentHash(stableJson(message)),
        responseFacts: facts,
        ...metadataHash(facts, usage),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (APICallError.isInstance(error) && error.responseBody) {
        // A malformed outer envelope can fail before generateText returns.
        // Preserve only attributable identity and tool digests if it was JSON.
        try {
          const body: unknown = JSON.parse(error.responseBody);
          wireEvidence ??= wireEvidenceFromResponse(body);
          if (isRecord(body)) {
            const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
            receivedResponse ??= {
              model: responseIdentifier(body.model),
              provider: responseIdentifier(body.provider),
              id: responseIdentifier(body.id),
              finishReason: isRecord(choice) ? responseIdentifier(choice.finish_reason) : null,
            };
          }
        } catch {
          // Invalid outer JSON provides no independently attributable tool envelope.
        }
      }
      if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
        const facts = failureFacts(latencyMs, "invalid-tool-call");
        const usage = emptyUsage();
        return {
          kind: "invalid_model_response",
          errorClass: InvalidToolInputError.isInstance(error)
            ? "invalid_tool_input"
            : "unknown_tool",
          message: "The provider returned an invalid Forge tool request.",
          usage,
          requestHash,
          responseFacts: facts,
          ...metadataHash(facts, usage),
        };
      }
      if (
        (!APICallError.isInstance(error) && isAbort(error)) ||
        (APICallError.isInstance(error) && isAbort(error.cause))
      )
        return providerFailure(
          "timeout",
          "OpenRouter request timed out before a valid assistant envelope was received.",
          true,
          requestHash,
          emptyUsage(),
          failureFacts(latencyMs, null),
        );
      if (APICallError.isInstance(error)) {
        const status = error.statusCode ?? null;
        if (status !== null && status >= 200 && status < 300) {
          const data = error.data;
          const code =
            typeof data === "object" && data !== null && "code" in data ? String(data.code) : "";
          const providerCode = /^[45][0-9]{2}$/.test(code) ? code : null;
          const errorEnvelope = typeof data === "object" && data !== null && "message" in data;
          return providerFailure(
            errorEnvelope
              ? `provider_response_error${providerCode ? `_${providerCode}` : ""}`
              : "invalid_response_schema",
            safeProviderErrorMessage(
              errorEnvelope
                ? `OpenRouter returned an error response${providerCode ? ` (code ${providerCode})` : ""}.`
                : "OpenRouter returned a response that could not be read.",
              error,
            ),
            error.isRetryable,
            requestHash,
            emptyUsage(),
            failureFacts(latencyMs, null),
          );
        }
        return providerFailure(
          status === null ? "provider_api" : `http_${status}`,
          safeProviderErrorMessage(
            status === null
              ? "OpenRouter request failed."
              : `OpenRouter request failed with HTTP ${status}.`,
            error,
          ),
          error.isRetryable,
          requestHash,
          emptyUsage(),
          failureFacts(latencyMs, null),
        );
      }
      return providerFailure(
        "transport",
        boundedTransportMessage(
          error,
          "OpenRouter transport failed before a valid assistant envelope was received.",
        ),
        false,
        requestHash,
        emptyUsage(),
        failureFacts(latencyMs, null),
      );
    }
  }
}

interface WireTools {
  tools: ToolSet;
  providerTools: JSONValue[];
  order: string[];
  publicToWire: ReadonlyMap<string, string>;
  wireToPublic: ReadonlyMap<string, string>;
}

function toWireTools(definitions: ModelToolDefinition[]): WireTools {
  const tools: ToolSet = {};
  const providerTools: JSONValue[] = [];
  const order: string[] = [];
  const publicToWire = new Map<string, string>();
  const wireToPublic = new Map<string, string>();
  for (const definition of definitions) {
    const wireName = definition.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (wireName.length === 0 || wireName.length > 64 || !/^[A-Za-z0-9_-]+$/.test(wireName))
      throw new Error(`Forge tool ${definition.name} has no valid provider wire name.`);
    if (wireToPublic.has(wireName))
      throw new Error(
        `Forge tools ${wireToPublic.get(wireName)} and ${definition.name} collide on provider wire name ${wireName}.`,
      );
    publicToWire.set(definition.name, wireName);
    wireToPublic.set(wireName, definition.name);
    order.push(wireName);
    const description = `Forge tool ${definition.name}. ${definition.description}`;
    const parameters = providerJsonSchema(definition.parameters, definition.name);
    tools[wireName] = tool({
      description,
      inputSchema: jsonSchema(parameters),
      strict: false,
    });
    providerTools.push({
      type: "function",
      function: { name: wireName, description, parameters: parameters as JSONValue, strict: false },
    });
  }
  return { tools, providerTools, order, publicToWire, wireToPublic };
}

/**
 * Provider schema types stay inside this transport adapter. The native model
 * contract deliberately carries provider-independent data, so validate the
 * object boundary before adapting it to the AI SDK's JSON Schema type.
 */
function providerJsonSchema(value: unknown, toolName: string): Parameters<typeof jsonSchema>[0] {
  if (!isRecord(value))
    throw new Error(`Forge tool ${toolName} must provide an object JSON Schema.`);
  assertProviderToolSchema(value, toolName);
  return value as Parameters<typeof jsonSchema>[0];
}

/** Enforce the portable schema subset supported by every registered model provider. */
function assertProviderToolSchema(root: Record<string, unknown>, toolName: string): void {
  const resolvePointer = (reference: string): unknown => {
    if (reference === "#") return root;
    if (!reference.startsWith("#/")) return undefined;
    return reference
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>(
        (value, segment) =>
          value !== null && typeof value === "object"
            ? (value as Record<string, unknown>)[segment]
            : undefined,
        root,
      );
  };
  const visit = (value: unknown, ancestors: ReadonlySet<unknown>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, ancestors);
      return;
    }
    if (!isRecord(value)) return;
    if (Array.isArray(value.prefixItems) && value.prefixItems.length === 0)
      throw new Error(`Forge tool ${toolName} contains an empty prefixItems schema.`);
    if (typeof value.$ref === "string" && value.$ref.startsWith("#")) {
      const target = resolvePointer(value.$ref);
      if (target === undefined)
        throw new Error(`Forge tool ${toolName} contains an unresolved local schema reference.`);
      if (ancestors.has(target))
        throw new Error(`Forge tool ${toolName} contains a recursive JSON Schema.`);
      visit(target, new Set([...ancestors, target]));
    }
    for (const [key, item] of Object.entries(value)) if (key !== "$ref") visit(item, ancestors);
  };
  visit(root, new Set([root]));
}

function toAiMessages(
  messages: ModelMessage[],
  publicToWire: ReadonlyMap<string, string>,
): AiModelMessage[] {
  const result: AiModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      result.push({
        role: "user",
        content: message.images?.length
          ? [
              ...message.images.flatMap((image, index) => [
                {
                  type: "text" as const,
                  text: `Image ${index + 1} (${image.width} × ${image.height} pixels):`,
                },
                {
                  type: "image" as const,
                  image: image.base64,
                  mediaType: image.mimeType,
                },
              ]),
              { type: "text", text: message.content },
            ]
          : message.content,
      });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: publicToWire.get(message.name) ?? message.name,
            output: { type: "text", value: message.content },
          },
        ],
      });
      continue;
    }
    if (message.continuation) {
      result.push(...validatedContinuation(message.continuation));
      continue;
    }
    result.push({
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: publicToWire.get(call.name) ?? call.name,
          input: call.arguments,
        })),
      ],
    });
  }
  return result;
}

function validatedContinuation(continuation: ModelContinuation): AiModelMessage[] {
  if (continuation.transport !== TRANSPORT || !Array.isArray(continuation.payload))
    throw new Error("Continuation transport or payload did not match");
  const serialized = stableJson(continuation.payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (
    bytes !== continuation.bytes ||
    bytes > MODEL_CONTINUATION_MAX_BYTES ||
    contentHash(serialized) !== continuation.hash
  )
    throw new Error("Continuation identity did not match");
  const messages: AiModelMessage[] = [];
  for (const value of continuation.payload) {
    const parsed = modelMessageSchema.safeParse(value);
    if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
      throw new Error("Continuation contained an invalid response message");
    messages.push(value as AiModelMessage);
  }
  return messages;
}

function createContinuation(
  payload: unknown,
):
  | { ok: true; value: ModelContinuation }
  | { ok: false; message: string; identity?: { hash: string; bytes: number } } {
  if (!Array.isArray(payload))
    return { ok: false, message: "AI SDK response continuation was malformed." };
  const serialized = stableJson(payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MODEL_CONTINUATION_MAX_BYTES)
    return {
      ok: false,
      message: `AI SDK response continuation exceeded ${MODEL_CONTINUATION_MAX_BYTES} bytes.`,
      identity: { hash: contentHash(serialized), bytes },
    };
  for (const value of payload) {
    const parsed = modelMessageSchema.safeParse(value);
    if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
      return { ok: false, message: "AI SDK response continuation was malformed." };
  }
  return {
    ok: true,
    value: { transport: TRANSPORT, payload, hash: contentHash(serialized), bytes },
  };
}

function responseFacts(
  requestedModel: string,
  resolvedModel: string | null,
  servingProvider: string | null,
  responseId: string | null,
  latencyMs: number,
  finishReason: string | null,
  continuation?: Pick<ModelContinuation, "hash" | "bytes">,
  toolCallWireEvidence?: ModelToolCallWireEvidence,
): ModelResponseFacts {
  return {
    requestedModel,
    resolvedModel,
    servingProvider,
    responseId,
    latencyMs,
    retryCount: 0,
    finishReason,
    continuationHash: continuation?.hash ?? null,
    continuationBytes: continuation?.bytes ?? null,
    ...(toolCallWireEvidence ? { toolCallWireEvidence } : {}),
  };
}

function wireEvidenceFromResponse(
  body: unknown,
  adaptedInputs?: readonly unknown[],
): ModelToolCallWireEvidence | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || !Array.isArray(first.message.tool_calls))
    return undefined;
  return captureToolCallWireEvidence(
    first.message.tool_calls.map((call: unknown) => {
      const entry = isRecord(call) ? call : {};
      const fn = isRecord(entry.function) ? entry.function : {};
      return { id: entry.id, name: fn.name, arguments: fn.arguments };
    }),
    adaptedInputs,
  );
}

function responseIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
}

function usageFrom(
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    };
    outputTokenDetails?: { reasoningTokens?: number | undefined };
  },
  metadata: unknown,
): ModelUsage {
  const openrouter = openRouterMetadata(metadata);
  const accounting = isRecord(openrouter?.usage) ? openrouter.usage : undefined;
  return {
    inputTokens: finiteOrNull(usage.inputTokens),
    outputTokens: finiteOrNull(usage.outputTokens),
    reasoningTokens: finiteOrNull(usage.outputTokenDetails?.reasoningTokens),
    cacheReadTokens: finiteOrNull(usage.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: finiteOrNull(usage.inputTokenDetails?.cacheWriteTokens),
    costUsd: finiteOrNull(accounting?.cost),
  };
}

function providerName(metadata: unknown): string | null {
  const value = openRouterMetadata(metadata)?.provider;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function openRouterMetadata(metadata: unknown): Record<string, unknown> | undefined {
  return isRecord(metadata) && isRecord(metadata.openrouter) ? metadata.openrouter : undefined;
}

function metadataHash(
  facts: ModelResponseFacts,
  usage: ModelUsage,
): { providerMetadataHash: string } {
  return { providerMetadataHash: contentHash(stableJson({ facts, usage })) };
}

function providerFailure(
  errorClass: string,
  message: string,
  retryable: boolean,
  requestHash: string,
  usage: ModelUsage,
  facts: ModelResponseFacts,
): Extract<ModelTurnResult, { kind: "provider_error" }> {
  return {
    kind: "provider_error",
    errorClass,
    message: message.slice(0, 500),
    retryable,
    usage,
    requestHash,
    responseFacts: facts,
    ...metadataHash(facts, usage),
  };
}

function normalizeStop(
  value: string,
  calls: number,
): Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"] {
  if (value === "length") return "max_tokens";
  if (value === "content-filter") return "refusal";
  if (calls > 0 || value === "tool-calls") return "tool_calls";
  if (value === "stop") return "end_turn";
  return "other";
}

function boundedTransportMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    ["invalid_continuation", "continuation_too_large"].includes(error.name)
  )
    return error.message.slice(0, 500);
  return fallback;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /timeout|timed out/i.test(error.message))
  );
}

function emptyUsage(): ModelUsage {
  return {
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
