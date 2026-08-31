import {
	APICallError,
	InvalidToolInputError,
	NoSuchToolError,
	generateText,
	jsonSchema,
	modelMessageSchema,
	stepCountIs,
	tool,
	type ModelMessage as AiModelMessage,
	type ToolSet,
} from "ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { contentHash, stableJson } from "../../contracts/src/index.js"
import {
	MODEL_CONTINUATION_MAX_BYTES,
	type ModelClient,
	type ModelContinuation,
	type ModelMessage,
	type ModelResponseFacts,
	type ModelToolDefinition,
	type ModelTurnRequest,
	type ModelTurnResult,
	type ModelUsage,
} from "./contracts.js"

export const CANONICAL_OPENROUTER_MODEL = "openai/gpt-5.6-luna"
const TRANSPORT = "openrouter-ai-sdk-core"

/** Public, secret-free transport identity used to preregister a treatment. */
export const OPENROUTER_MODEL_CLIENT_DESCRIPTOR = {
	transport: TRANSPORT,
	version: "1.0.0",
	configuration: {
		aiSdk: { package: "ai", version: "7.0.85" },
		providerAdapter: { package: "@openrouter/ai-sdk-provider", version: "3.0.0" },
		routing: { only: ["openai"], allowFallbacks: false as const, requireParameters: true as const },
		reasoning: { effort: "medium" as const, exclude: false as const },
		request: {
			steps: 1 as const,
			toolChoice: "auto" as const,
			providerParallelToolCalls: "not_requested" as const,
			toolBatchExecution: "atomic_validate_then_sequential" as const,
			toolNameEncoding: "openai_function_slug_v1" as const,
			maxRetries: 0 as const,
			telemetry: false as const,
			timeoutPolicy: "remaining_runtime_budget" as const,
			maxOutputTokensPerTurn: 4096,
		},
		continuation: { maxBytes: MODEL_CONTINUATION_MAX_BYTES },
	},
}

export interface OpenRouterAiSdkClientOptions {
	apiKey: string
	fetchImpl?: typeof fetch
	baseURL?: string
	model?: string
}

export class OpenRouterModelClient implements ModelClient {
	readonly descriptor = OPENROUTER_MODEL_CLIENT_DESCRIPTOR

	private readonly provider: ReturnType<typeof createOpenRouter>
	private readonly model: string

	constructor(options: OpenRouterAiSdkClientOptions) {
		if (!options.apiKey) throw new Error("OPENROUTER_API_KEY is required")
		this.model = options.model ?? CANONICAL_OPENROUTER_MODEL
		this.provider = createOpenRouter({
			apiKey: options.apiKey,
			...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
			...(options.baseURL ? { baseURL: options.baseURL } : {}),
			compatibility: "strict",
		})
	}

	async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
		const startedAt = Date.now()
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
		)
		if (request.model !== this.model) {
			return providerFailure(
				"model_configuration",
				`Configured OpenRouter model is ${this.model}; received ${request.model}.`,
				false,
				requestHash,
				emptyUsage(),
				responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
			)
		}
		let wireTools: WireTools
		try {
			wireTools = toWireTools(request.tools)
		} catch (error) {
			return providerFailure(
				"request_configuration",
				boundedTransportMessage(error, "Forge tool names could not be encoded for the provider."),
				false,
				requestHash,
				emptyUsage(),
				responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
			)
		}

		let messages: AiModelMessage[]
		try {
			messages = toAiMessages(request.messages, wireTools.publicToWire)
		} catch (error) {
			return providerFailure(
				"invalid_continuation",
				boundedTransportMessage(error, "Model continuation was malformed."),
				false,
				requestHash,
				emptyUsage(),
				responseFacts(request.model, null, null, null, Date.now() - startedAt, null),
			)
		}

		try {
			const result = await generateText({
				model: this.provider.chat(request.model, {
					provider: { only: ["openai"], allow_fallbacks: false, require_parameters: true },
					reasoning: { effort: "medium", exclude: false },
					usage: { include: true },
				}),
				system: request.system,
				messages,
				tools: wireTools.tools,
				toolOrder: wireTools.order,
				toolChoice: "auto",
				stopWhen: stepCountIs(1),
				maxRetries: 0,
				maxOutputTokens: request.maxOutputTokens,
				timeout: request.timeoutMs,
				telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
			})

			const latencyMs = Date.now() - startedAt
			const continuation = createContinuation(result.responseMessages)
			if (!continuation.ok) {
				return providerFailure(
					"continuation_too_large",
					continuation.message,
					false,
					requestHash,
					usageFrom(result.usage, result.providerMetadata),
					responseFacts(
						request.model,
						result.response.modelId,
						providerName(result.providerMetadata),
						result.response.id,
						latencyMs,
						result.finishReason,
						continuation.identity,
					),
				)
			}
			const calls = result.toolCalls.map((call) => ({
				id: call.toolCallId,
				name: wireTools.wireToPublic.get(call.toolName) ?? call.toolName,
				arguments: call.input,
			}))
			const message: Extract<ModelMessage, { role: "assistant" }> = {
				role: "assistant",
				content: result.text,
				toolCalls: calls,
				continuation: continuation.value,
			}
			const usage = usageFrom(result.usage, result.providerMetadata)
			const facts = responseFacts(
				request.model,
				result.response.modelId,
				providerName(result.providerMetadata),
				result.response.id,
				latencyMs,
				result.finishReason,
				continuation.value,
			)
			return {
				kind: "assistant",
				message,
				stopReason: normalizeStop(result.finishReason, calls.length),
				usage,
				requestHash,
				responseHash: contentHash(stableJson(message)),
				responseFacts: facts,
				...metadataHash(facts, usage),
			}
		} catch (error) {
			const latencyMs = Date.now() - startedAt
			if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
				const facts = responseFacts(request.model, null, null, null, latencyMs, "invalid-tool-call")
				const usage = emptyUsage()
				return {
					kind: "invalid_model_response",
					errorClass: InvalidToolInputError.isInstance(error) ? "invalid_tool_input" : "unknown_tool",
					message: "The provider returned an invalid Forge tool request.",
					usage,
					requestHash,
					responseFacts: facts,
					...metadataHash(facts, usage),
				}
			}
			if (isAbort(error) || (APICallError.isInstance(error) && isAbort(error.cause)))
				return providerFailure(
					"timeout",
					"OpenRouter request timed out before a valid assistant envelope was received.",
					true,
					requestHash,
					emptyUsage(),
					responseFacts(request.model, null, null, null, latencyMs, null),
				)
			if (APICallError.isInstance(error)) {
				const status = error.statusCode ?? null
				return providerFailure(
					status === null ? "provider_api" : `http_${status}`,
					status === null ? "OpenRouter request failed." : `OpenRouter request failed with HTTP ${status}.`,
					error.isRetryable,
					requestHash,
					emptyUsage(),
					responseFacts(request.model, null, null, null, latencyMs, null),
				)
			}
			return providerFailure(
				"transport",
				boundedTransportMessage(error, "OpenRouter transport failed before a valid assistant envelope was received."),
				false,
				requestHash,
				emptyUsage(),
				responseFacts(request.model, null, null, null, latencyMs, null),
			)
		}
	}
}

interface WireTools {
	tools: ToolSet
	order: string[]
	publicToWire: ReadonlyMap<string, string>
	wireToPublic: ReadonlyMap<string, string>
}

function toWireTools(definitions: ModelToolDefinition[]): WireTools {
	const tools: ToolSet = {}
	const order: string[] = []
	const publicToWire = new Map<string, string>()
	const wireToPublic = new Map<string, string>()
	for (const definition of definitions) {
		const wireName = definition.name.replace(/[^A-Za-z0-9_-]/g, "_")
		if (wireName.length === 0 || wireName.length > 64 || !/^[A-Za-z0-9_-]+$/.test(wireName))
			throw new Error(`Forge tool ${definition.name} has no valid provider wire name.`)
		if (wireToPublic.has(wireName))
			throw new Error(
				`Forge tools ${wireToPublic.get(wireName)} and ${definition.name} collide on provider wire name ${wireName}.`,
			)
		publicToWire.set(definition.name, wireName)
		wireToPublic.set(wireName, definition.name)
		order.push(wireName)
		tools[wireName] = tool({
			description: `Forge tool ${definition.name}. ${definition.description}`,
			inputSchema: jsonSchema(definition.parameters),
		})
	}
	return { tools, order, publicToWire, wireToPublic }
}

function toAiMessages(messages: ModelMessage[], publicToWire: ReadonlyMap<string, string>): AiModelMessage[] {
	const result: AiModelMessage[] = []
	for (const message of messages) {
		if (message.role === "user") {
			result.push({ role: "user", content: message.content })
			continue
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
			})
			continue
		}
		if (message.continuation) {
			result.push(...validatedContinuation(message.continuation))
			continue
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
		})
	}
	return result
}

function validatedContinuation(continuation: ModelContinuation): AiModelMessage[] {
	if (continuation.transport !== TRANSPORT || !Array.isArray(continuation.payload))
		throw new Error("Continuation transport or payload did not match")
	const serialized = stableJson(continuation.payload)
	const bytes = Buffer.byteLength(serialized, "utf8")
	if (
		bytes !== continuation.bytes ||
		bytes > MODEL_CONTINUATION_MAX_BYTES ||
		contentHash(serialized) !== continuation.hash
	)
		throw new Error("Continuation identity did not match")
	const messages: AiModelMessage[] = []
	for (const value of continuation.payload) {
		const parsed = modelMessageSchema.safeParse(value)
		if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
			throw new Error("Continuation contained an invalid response message")
		messages.push(value as AiModelMessage)
	}
	return messages
}

function createContinuation(
	payload: unknown,
): { ok: true; value: ModelContinuation } | { ok: false; message: string; identity?: { hash: string; bytes: number } } {
	if (!Array.isArray(payload)) return { ok: false, message: "AI SDK response continuation was malformed." }
	const serialized = stableJson(payload)
	const bytes = Buffer.byteLength(serialized, "utf8")
	if (bytes > MODEL_CONTINUATION_MAX_BYTES)
		return {
			ok: false,
			message: `AI SDK response continuation exceeded ${MODEL_CONTINUATION_MAX_BYTES} bytes.`,
			identity: { hash: contentHash(serialized), bytes },
		}
	for (const value of payload) {
		const parsed = modelMessageSchema.safeParse(value)
		if (!parsed.success || (parsed.data.role !== "assistant" && parsed.data.role !== "tool"))
			return { ok: false, message: "AI SDK response continuation was malformed." }
	}
	return { ok: true, value: { transport: TRANSPORT, payload, hash: contentHash(serialized), bytes } }
}

function responseFacts(
	requestedModel: string,
	resolvedModel: string | null,
	servingProvider: string | null,
	responseId: string | null,
	latencyMs: number,
	finishReason: string | null,
	continuation?: Pick<ModelContinuation, "hash" | "bytes">,
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
	}
}

function usageFrom(
	usage: { inputTokens: number | undefined; outputTokens: number | undefined },
	metadata: unknown,
): ModelUsage {
	const openrouter = openRouterMetadata(metadata)
	const accounting = isRecord(openrouter?.usage) ? openrouter.usage : undefined
	return {
		inputTokens: finiteOrNull(usage.inputTokens),
		outputTokens: finiteOrNull(usage.outputTokens),
		costUsd: finiteOrNull(accounting?.cost),
	}
}

function providerName(metadata: unknown): string | null {
	const value = openRouterMetadata(metadata)?.provider
	return typeof value === "string" && value.length > 0 ? value : null
}

function openRouterMetadata(metadata: unknown): Record<string, unknown> | undefined {
	return isRecord(metadata) && isRecord(metadata.openrouter) ? metadata.openrouter : undefined
}

function metadataHash(facts: ModelResponseFacts, usage: ModelUsage): { providerMetadataHash: string } {
	return { providerMetadataHash: contentHash(stableJson({ facts, usage })) }
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
	}
}

function normalizeStop(value: string, calls: number): Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"] {
	if (calls > 0 || value === "tool-calls") return "tool_calls"
	if (value === "stop") return "end_turn"
	if (value === "length") return "max_tokens"
	if (value === "content-filter") return "refusal"
	return "other"
}

function boundedTransportMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && ["invalid_continuation", "continuation_too_large"].includes(error.name))
		return error.message.slice(0, 500)
	return fallback
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message))
}

function emptyUsage(): ModelUsage {
	return { inputTokens: null, outputTokens: null, costUsd: null }
}
function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
