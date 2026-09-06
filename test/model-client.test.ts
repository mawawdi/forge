import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CREATOR_MODEL_IDS,
  CREATOR_MODEL_REGISTRY,
  DEFAULT_CREATOR_MODEL_ID,
  MODEL_CONTINUATION_MAX_BYTES,
  OpenRouterModelClient,
  modelOutputTokenLimit,
  parseOpenRouterModelCatalog,
  diagnoseToolArgumentJson,
  toolArgumentSyntaxMessage,
  assertModelToolCallWireEvidence,
  captureToolCallWireEvidence,
  type ModelTurnRequest,
} from "../packages/model-client/src/index.js";

const REQUEST: ModelTurnRequest = {
  model: DEFAULT_CREATOR_MODEL_ID,
  system: "Use only bounded tools.",
  messages: [{ role: "user", content: "Inspect the project." }],
  tools: [
    {
      name: "project.read",
      description: "Read one source file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "project.list",
      description: "List bounded source files only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
  maxOutputTokens: 512,
  timeoutMs: 1_000,
};

const REASONING_DETAIL = {
  type: "reasoning.encrypted",
  data: "opaque-reasoning-block",
  id: "reasoning-1",
  format: "openai-responses-v1",
};

function response(message: Record<string, unknown>, finishReason: string, id: string): Response {
  return new Response(
    JSON.stringify({
      id,
      model: DEFAULT_CREATOR_MODEL_ID,
      provider: "OpenAI",
      choices: [
        { index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        cost: 0.002,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("tool calls cannot conceal provider truncation or refusal", async () => {
  for (const [finishReason, expected] of [
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
  ]) {
    const client = new OpenRouterModelClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        response(
          {
            content: null,
            tool_calls: [
              {
                id: "partial",
                type: "function",
                function: { name: "project_list", arguments: "{}" },
              },
            ],
          },
          finishReason!,
          "response-truncated",
        ),
    });
    const result = await client.complete(REQUEST);
    assert.equal(result.kind, "assistant");
    if (result.kind !== "assistant") throw new Error("Expected provider response evidence");
    assert.equal(result.stopReason, expected);
  }
});

test("AI SDK Core sends one locked-down OpenRouter step and replays opaque reasoning continuation", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const authorizations: string[] = [];
  let attempt = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    attempt += 1;
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (attempt === 1)
      return response(
        {
          content: null,
          reasoning_details: [REASONING_DETAIL],
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "project_list", arguments: "{}" } },
          ],
        },
        "tool_calls",
        "response-1",
      );
    return response(
      { content: "Inspection complete.", reasoning_details: [] },
      "stop",
      "response-2",
    );
  };
  const client = new OpenRouterModelClient({ apiKey: "secret-one", fetchImpl });
  const first = await client.complete(REQUEST);
  assert.equal(first.kind, "assistant");
  if (first.kind !== "assistant") return;
  assert.deepEqual(first.message.toolCalls, [
    { id: "call-1", name: "project.list", arguments: {} },
  ]);
  assert.equal(first.stopReason, "tool_calls");
  assert.deepEqual(first.usage, {
    reasoningTokens: 2,
    cacheReadTokens: 8,
    cacheWriteTokens: null,
    inputTokens: 12,
    outputTokens: 4,
    costUsd: 0.002,
  });
  assert.equal(first.responseFacts.requestedModel, DEFAULT_CREATOR_MODEL_ID);
  assert.equal(first.responseFacts.resolvedModel, DEFAULT_CREATOR_MODEL_ID);
  assert.equal(first.responseFacts.servingProvider, "OpenAI");
  assert.equal(first.responseFacts.responseId, "response-1");
  assert.equal(first.responseFacts.retryCount, 0);
  assert.equal(first.responseFacts.continuationHash, first.message.continuation?.hash);
  assert.ok(first.message.continuation);
  assert.ok(first.message.continuation!.bytes <= MODEL_CONTINUATION_MAX_BYTES);

  const second = await client.complete({
    ...REQUEST,
    messages: [
      ...REQUEST.messages,
      first.message,
      { role: "tool", toolCallId: "call-1", name: "project.list", content: '{"ok":true}' },
    ],
  });
  assert.equal(second.kind, "assistant");
  assert.equal(attempt, 2);
  assert.deepEqual(authorizations, ["Bearer secret-one", "Bearer secret-one"]);
  assert.equal(JSON.stringify(bodies).includes("secret-one"), false);

  const firstBody = bodies[0]!;
  assert.equal(firstBody.model, DEFAULT_CREATOR_MODEL_ID);
  assert.equal("parallel_tool_calls" in firstBody, false);
  assert.equal(firstBody.tool_choice, "auto");
  assert.equal(firstBody.max_tokens, 512);
  assert.deepEqual(firstBody.usage, { include: true });
  assert.deepEqual(firstBody.provider, {
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.deepEqual(firstBody.reasoning, { effort: "medium", exclude: false });
  const sentTools = firstBody.tools as Array<{
    function: { name: string; parameters: unknown; strict: boolean };
  }>;
  assert.deepEqual(
    sentTools.map((entry) => entry.function.name),
    ["project_read", "project_list"],
  );
  assert.deepEqual(sentTools[0]?.function.parameters, REQUEST.tools[0]?.parameters);
  assert.ok(sentTools.every((entry) => entry.function.strict === false));
  assert.equal(JSON.stringify(bodies[1]).includes("opaque-reasoning-block"), true);
  const replayed = (bodies[1]!.messages as Array<Record<string, unknown>>).find(
    (message) => message.role === "assistant",
  );
  assert.deepEqual(replayed?.reasoning_details, [REASONING_DETAIL]);
  assert.equal(JSON.stringify(replayed).includes("project_list"), true);

  const otherKey = await new OpenRouterModelClient({
    apiKey: "different-secret",
    fetchImpl: async () =>
      response(
        {
          content: null,
          reasoning_details: [REASONING_DETAIL],
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "project_list", arguments: "{}" } },
          ],
        },
        "tool_calls",
        "response-other-key",
      ),
  }).complete(REQUEST);
  assert.equal(otherKey.requestHash, first.requestHash);
  assert.equal(
    first.requestHash,
    contentHash(
      stableJson({
        model: REQUEST.model,
        system: REQUEST.system,
        messages: REQUEST.messages,
        tools: REQUEST.tools,
        maxOutputTokens: REQUEST.maxOutputTokens,
        timeoutMs: REQUEST.timeoutMs,
        transport: client.descriptor,
      }),
    ),
  );
  assert.equal(client.descriptor.configuration.aiSdk.package, "ai");
  assert.equal(client.descriptor.configuration.request.providerParallelToolCalls, "not_requested");
  assert.equal(
    client.descriptor.configuration.request.toolBatchExecution,
    "host_validated_then_sequential",
  );
  assert.equal(client.descriptor.configuration.request.toolNameEncoding, "openai_function_slug");
  assert.equal(client.descriptor.configuration.request.toolSchemaMode, "explicit_non_strict");
  assert.equal(
    client.descriptor.configuration.providerAdapter.package,
    "@openrouter/ai-sdk-provider",
  );
  assert.deepEqual(client.descriptor.configuration.routing, {
    modelRegistryHash: CREATOR_MODEL_REGISTRY.hash,
    allowlistedModels: [...CREATOR_MODEL_IDS],
    providerAllowlist: "none",
    modelFallbacks: false,
    providerFallbacks: false,
    requireParameters: true,
    requireTools: true,
  });
});

test("one client admits each registry model per request and rejects all other models before transport", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(
        JSON.stringify({
          id: `response-${bodies.length}`,
          model: body.model,
          provider: "Exact Provider",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const hashes = new Set<string>();
  for (const model of CREATOR_MODEL_IDS) {
    const result = await client.complete({ ...REQUEST, model });
    assert.equal(result.kind, "assistant");
    hashes.add(result.requestHash);
    assert.equal(result.responseFacts.requestedModel, model);
    assert.equal(result.responseFacts.resolvedModel, model);
    assert.equal(result.responseFacts.servingProvider, "Exact Provider");
  }
  assert.deepEqual(
    bodies.map((body) => body.model),
    [...CREATOR_MODEL_IDS],
  );
  assert.equal(hashes.size, CREATOR_MODEL_IDS.length);

  const rejected = await client.complete({ ...REQUEST, model: "openai/not-allowlisted" });
  assert.equal(rejected.kind, "provider_error");
  if (rejected.kind !== "provider_error") return;
  assert.equal(rejected.errorClass, "model_not_allowlisted");
  assert.equal(rejected.responseFacts.requestedModel, "openai/not-allowlisted");
  assert.equal(rejected.responseFacts.resolvedModel, null);
  assert.equal(rejected.responseFacts.servingProvider, null);
  assert.equal(bodies.length, CREATOR_MODEL_IDS.length);
});

test("response attribution cannot silently substitute a model or omit its provider", async () => {
  const mismatched = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "response-mismatch",
          model: CREATOR_MODEL_IDS[1],
          provider: "Unexpected Provider",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  }).complete(REQUEST);
  assert.equal(mismatched.kind, "provider_error");
  if (mismatched.kind !== "provider_error") return;
  assert.equal(mismatched.errorClass, "response_identity_mismatch");
  assert.equal(mismatched.responseFacts.requestedModel, DEFAULT_CREATOR_MODEL_ID);
  assert.equal(mismatched.responseFacts.resolvedModel, CREATOR_MODEL_IDS[1]);
  assert.equal(mismatched.responseFacts.servingProvider, "Unexpected Provider");

  const unattributed = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "response-unattributed",
          model: DEFAULT_CREATOR_MODEL_ID,
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  }).complete(REQUEST);
  assert.equal(unattributed.kind, "provider_error");
  if (unattributed.kind === "provider_error") {
    assert.equal(unattributed.errorClass, "response_identity_mismatch");
    assert.equal(unattributed.responseFacts.resolvedModel, DEFAULT_CREATOR_MODEL_ID);
    assert.equal(unattributed.responseFacts.servingProvider, null);
  }
});

test("AI SDK Core performs one HTTP attempt and normalizes bounded provider errors", async () => {
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({ error: { message: "sensitive provider pipeline details" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  };
  const result = await new OpenRouterModelClient({ apiKey: "secret", fetchImpl }).complete(REQUEST);
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(attempts, 1);
  assert.equal(result.errorClass, "http_429");
  assert.equal(result.retryable, true);
  assert.equal(result.message, "OpenRouter request failed with HTTP 429.");
  assert.equal(result.message.includes("sensitive"), false);
  assert.equal(result.usage.inputTokens, null);
});

test("provider adapter rejects malformed tool schemas before transport", async () => {
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("must not execute");
    },
  });
  for (const parameters of [
    "not-a-schema",
    {
      type: "object",
      properties: { empty: { type: "array", prefixItems: [], items: false, maxItems: 0 } },
    },
    {
      type: "object",
      properties: { node: { $ref: "#/$defs/node" } },
      $defs: {
        node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/node" } },
        },
      },
    },
  ]) {
    const result = await client.complete({
      ...REQUEST,
      tools: [{ name: "invalid.schema", description: "Invalid fixture.", parameters }],
    });

    assert.equal(result.kind, "provider_error");
    if (result.kind === "provider_error") {
      assert.equal(result.errorClass, "request_configuration");
      assert.equal(result.retryable, false);
    }
  }
  assert.equal(attempts, 0);
});

test("selected catalog completion cap reaches the provider unchanged and unreported limits stay explicit", async () => {
  const modelCatalog = parseOpenRouterModelCatalog(
    {
      data: CREATOR_MODEL_IDS.map((id) => ({
        id,
        supported_parameters: ["tools"],
        top_provider: { max_completion_tokens: id === DEFAULT_CREATOR_MODEL_ID ? 131072 : null },
      })),
    },
    "2026-09-05T12:00:00.000Z",
  );
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "offline-key",
    modelCatalog,
    fetchImpl: async (_input, init) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 131072);
      return response({ content: "Complete." }, "stop", "cap-response");
    },
  });
  assert.equal(modelOutputTokenLimit(client.descriptor, DEFAULT_CREATOR_MODEL_ID), 131072);
  const unreportedModel = CREATOR_MODEL_IDS.find((id) => id !== DEFAULT_CREATOR_MODEL_ID)!;
  assert.equal(modelOutputTokenLimit(client.descriptor, unreportedModel), 32768);
  assert.equal(
    client.descriptor.configuration.request.outputTokenLimitCatalogHash,
    modelCatalog.hash,
  );
  modelCatalog.models.find(
    (entry) => entry.modelId === DEFAULT_CREATOR_MODEL_ID,
  )!.maxCompletionTokens = 7;
  assert.equal(modelOutputTokenLimit(client.descriptor, DEFAULT_CREATOR_MODEL_ID), 131072);
  const result = await client.complete({ ...REQUEST, maxOutputTokens: 131072 });
  assert.equal(result.kind, "assistant");
  assert.equal(attempts, 1);
  const excessive = await client.complete({ ...REQUEST, maxOutputTokens: 131073 });
  assert.equal(excessive.kind, "provider_error");
  if (excessive.kind === "provider_error")
    assert.equal(excessive.errorClass, "request_configuration");
  assert.equal(attempts, 1);
});

test("provider wire preserves nested input schema unions, bounds, references, and omitted optional fields", async () => {
  const file = z
    .object({
      path: z.string().regex(/^[a-z][a-z-]*\.luau$/),
      role: z.enum(["module", "entrypoint"]),
      maximumUtf8Bytes: z.number().int().positive().max(262144),
    })
    .strict();
  const shape = z
    .object({
      design: z
        .object({
          kind: z.literal("Composition"),
          components: z
            .array(
              z.discriminatedUnion("kind", [
                z
                  .object({ kind: z.literal("source"), files: z.array(file).min(1).max(8) })
                  .strict(),
                z
                  .object({
                    kind: z.literal("copy"),
                    source: file,
                    config: z
                      .object({ label: z.string().min(1), enabled: z.boolean().optional() })
                      .strict(),
                  })
                  .strict(),
              ]),
            )
            .min(1),
        })
        .strict(),
      activity: z.string().max(120).optional(),
    })
    .strict();
  const parameters = z.toJSONSchema(shape, { target: "draft-7", io: "input", reused: "ref" });
  const args = {
    design: {
      kind: "Composition",
      components: [
        {
          kind: "source",
          files: [{ path: "main.luau", role: "entrypoint", maximumUtf8Bytes: 1024 }],
        },
      ],
    },
  };
  let attempts = 0;
  const result = await new OpenRouterModelClient({
    apiKey: "offline-key",
    fetchImpl: async (_input, init) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].function.strict, false);
      assert.deepEqual(body.tools[0].function.parameters, parameters);
      assert.deepEqual(body.tools[0].function.parameters.required, ["design"]);
      assert.ok(JSON.stringify(parameters).includes('"$ref"'));
      assert.ok(JSON.stringify(parameters).includes('"oneOf"'));
      return response(
        {
          content: null,
          tool_calls: [
            {
              id: "nested-call",
              type: "function",
              function: { name: "composition_propose", arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
        "nested-schema-response",
      );
    },
  }).complete({
    ...REQUEST,
    tools: [
      { name: "composition.propose", description: "Propose a declared composition.", parameters },
    ],
  });
  assert.equal(attempts, 1);
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") return;
  assert.deepEqual(result.message.toolCalls[0]?.arguments, args);
  assert.equal(Object.hasOwn(result.message.toolCalls[0]!.arguments as object, "activity"), false);
});

test("HTTP schema failures retain safe provider diagnostic categories without echoing secrets or request data", async () => {
  const secret = "never-echo-api-key-or-source";
  let attempts = 0;
  const result = await new OpenRouterModelClient({
    apiKey: secret,
    fetchImpl: async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Provider returned error",
            metadata: {
              provider_name: secret,
              raw: JSON.stringify({
                error: {
                  code: "invalid_function_parameters",
                  param: `tools[2].function.parameters.${secret}`,
                  message: `Invalid schema for function '${secret}': additionalProperties is required for timeout. Authorization: Bearer ${secret}. Raw request: ${secret}`,
                },
              }),
            },
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json", "x-provider-private": secret },
        },
      );
    },
  }).complete({ ...REQUEST, system: secret });
  assert.equal(attempts, 1);
  assert.equal(result.kind, "provider_error");
  if (result.kind !== "provider_error") return;
  assert.equal(result.errorClass, "http_400");
  assert.match(result.message, /code=400/);
  assert.match(result.message, /code=invalid_function_parameters/);
  assert.match(result.message, /parameter=tools/);
  assert.match(result.message, /mentions invalid or unsupported schema/);
  assert.match(result.message, /keyword=additionalProperties/);
  assert.ok(Buffer.byteLength(result.message, "utf8") <= 500);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.responseFacts.servingProvider, null);
});

test("provider diagnostic output is bounded, distinguishes context limits, and omits unknown prose", async () => {
  for (const [code, message, expected] of [
    [
      "context_length_exceeded",
      "Maximum context length exceeded: private-request-content",
      /code=context_length_exceeded/,
    ],
    [
      "private-code",
      "private-request-content".repeat(10000),
      /^OpenRouter request failed with HTTP 400\.$/,
    ],
  ] as const) {
    const result = await new OpenRouterModelClient({
      apiKey: "offline-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code, message, metadata: { raw: "private-request-content".repeat(10000) } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    }).complete(REQUEST);
    assert.equal(result.kind, "provider_error");
    if (result.kind !== "provider_error") continue;
    assert.match(result.message, expected);
    assert.ok(Buffer.byteLength(result.message, "utf8") <= 500);
    assert.equal(JSON.stringify(result).includes("private-request-content"), false);
    assert.equal(JSON.stringify(result).includes("private-code"), false);
  }
});

test("malformed or oversized continuation fails before transport and remains bounded", async () => {
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("must not execute");
    },
  });
  const payload = [{ role: "assistant", content: "x".repeat(MODEL_CONTINUATION_MAX_BYTES) }];
  const result = await client.complete({
    ...REQUEST,
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [],
        continuation: {
          transport: "openrouter-ai-sdk-core",
          payload,
          hash: "0".repeat(64),
          bytes: MODEL_CONTINUATION_MAX_BYTES + 1,
        },
      },
    ],
  });
  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") assert.equal(result.errorClass, "invalid_continuation");
  assert.equal(attempts, 0);
});

test("responses above the former continuation bound replay once without duplicating assistant content", async () => {
  const content = "source-or-plan-content ".repeat(16000);
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "offline-key",
    fetchImpl: async (_input, init) => {
      attempts++;
      if (attempts === 1) return response({ content }, "stop", "large-response");
      const body = JSON.parse(String(init?.body));
      const assistantMessages = body.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      );
      assert.equal(assistantMessages.length, 1);
      assert.equal(assistantMessages[0].content, content);
      return response({ content: "Continued." }, "stop", "after-large-response");
    },
  });
  const first = await client.complete(REQUEST);
  assert.equal(first.kind, "assistant");
  if (first.kind !== "assistant") return;
  assert.ok(first.message.continuation!.bytes > 256 * 1024);
  assert.ok(first.message.continuation!.bytes <= MODEL_CONTINUATION_MAX_BYTES);
  const second = await client.complete({
    ...REQUEST,
    messages: [...REQUEST.messages, first.message, { role: "user", content: "Continue." }],
  });
  assert.equal(second.kind, "assistant");
  assert.equal(attempts, 2);
});

test("timeouts and malformed HTTP envelopes remain pre-trial provider failures", async () => {
  const timeoutFetch: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const fallback = setTimeout(
        () => reject(new Error("AI SDK did not abort the bounded request")),
        250,
      );
      const abort = () => {
        clearTimeout(fallback);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  const timeout = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: timeoutFetch,
  }).complete({ ...REQUEST, timeoutMs: 10 });
  assert.equal(timeout.kind, "provider_error");
  if (timeout.kind === "provider_error") {
    assert.equal(timeout.errorClass, "timeout");
    assert.equal(timeout.responseFacts.responseId, null);
  }

  const malformed = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      new Response('{"unexpected":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  }).complete(REQUEST);
  assert.equal(malformed.kind, "provider_error");
  if (malformed.kind === "provider_error") {
    assert.equal(malformed.responseFacts.responseId, null);
    assert.equal(malformed.errorClass, "invalid_response_schema");
    assert.doesNotMatch(malformed.message, /HTTP 200/);
  }
  const errorEnvelope = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { code: 502, message: "sensitive provider details" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  }).complete(REQUEST);
  assert.equal(errorEnvelope.kind, "provider_error");
  if (errorEnvelope.kind === "provider_error") {
    assert.equal(errorEnvelope.errorClass, "provider_response_error_502");
    assert.equal(
      errorEnvelope.message,
      "OpenRouter returned an error response (code 502). Provider diagnostic: code=502.",
    );
    assert.doesNotMatch(errorEnvelope.message, /sensitive/);
  }
});

test("AI SDK parses envelopes while Forge retains semantic tool-argument authority", async () => {
  const semanticallyInvalid = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      response(
        {
          content: null,
          tool_calls: [
            {
              id: "bad-semantic-input",
              type: "function",
              function: { name: "project_read", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
        "response-semantic",
      ),
  }).complete(REQUEST);
  assert.equal(semanticallyInvalid.kind, "assistant");
  if (semanticallyInvalid.kind === "assistant")
    assert.deepEqual(semanticallyInvalid.message.toolCalls[0]?.arguments, {});

  const malformedArguments = await new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () =>
      response(
        {
          content: null,
          tool_calls: [
            {
              id: "bad-json",
              type: "function",
              function: { name: "project_read", arguments: "not-json" },
            },
          ],
        },
        "tool_calls",
        "response-invalid",
      ),
  }).complete(REQUEST);
  assert.equal(malformedArguments.kind, "assistant");
  if (malformedArguments.kind === "assistant")
    assert.equal(malformedArguments.message.toolCalls[0]?.arguments, "not-json");
  if (malformedArguments.kind === "assistant")
    assert.equal(
      malformedArguments.message.toolCalls[0]?.argumentSyntaxError?.kind,
      "invalid_json",
    );
});

test("valid JSON primitives and encoded strings retain shape errors, never syntax errors or unwrapping", async () => {
  for (const value of ["not-json", '{"path":"example.luau"}', 42, null, []]) {
    const result = await new OpenRouterModelClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        response(
          {
            content: null,
            tool_calls: [
              {
                id: "primitive",
                type: "function",
                function: { name: "project_read", arguments: JSON.stringify(value) },
              },
            ],
          },
          "tool_calls",
          "response-primitive",
        ),
    }).complete(REQUEST);
    assert.equal(result.kind, "assistant");
    if (result.kind !== "assistant") throw new Error("Expected assistant");
    assert.deepEqual(result.message.toolCalls[0]?.arguments, value);
    assert.equal(result.message.toolCalls[0]?.argumentSyntaxError, undefined);
  }
});

test("nonstream wire evidence preserves separate malformed arguments without retaining the response body", async () => {
  const argumentsByCall = [
    '{"nodes":[{"id":"one"}]} {\\"id\\":\\"foreign\\"}',
    '{"nodes":[{"id":"two"}]}] {\\"id\\":\\"other\\"}',
    JSON.stringify({ path: "third.luau" }),
  ];
  const wireCalls = argumentsByCall.map((raw, index) => ({
    id: `wire-${index}`,
    type: "function",
    function: { name: "project_read", arguments: raw },
  }));
  const result = await new OpenRouterModelClient({
    apiKey: "never-retain-key",
    fetchImpl: async (_input, init) => {
      assert.notEqual(JSON.parse(String(init?.body)).stream, true);
      return response(
        { content: "", reasoning: "never-retain-reasoning", tool_calls: wireCalls },
        "tool_calls",
        "wire-response",
      );
    },
  }).complete(REQUEST);
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") throw new Error("Expected assistant");
  const evidence = result.responseFacts.toolCallWireEvidence;
  assert.ok(evidence);
  assertModelToolCallWireEvidence(evidence);
  assert.equal(result.responseFacts.responseId, "wire-response");
  assert.equal(result.responseFacts.servingProvider, "OpenAI");
  assert.equal(evidence.totalCalls, 3);
  assert.equal(evidence.omittedCalls, 0);
  assert.equal(
    evidence.envelopeHash,
    captureToolCallWireEvidence(
      wireCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    ).envelopeHash,
  );
  assert.deepEqual(
    evidence.calls.map((call) => call.jsonValidity),
    ["invalid", "invalid", "valid"],
  );
  assert.deepEqual(
    evidence.calls.map((call) => call.invalidInputMatchesWire),
    [true, true, null],
  );
  for (const [index, raw] of argumentsByCall.entries()) {
    assert.equal(evidence.calls[index]?.argumentsHash, contentHash(raw));
    assert.equal(evidence.calls[index]?.argumentsBytes, Buffer.byteLength(raw, "utf8"));
    if (index < 2) assert.equal(result.message.toolCalls[index]?.arguments, raw);
  }
  assert.doesNotMatch(
    JSON.stringify(result.responseFacts),
    /never-retain|foreign|nodes|third\.luau/,
  );
});

test("wire evidence survives truncated responses and rejected response identity", async () => {
  for (const mismatch of [false, true]) {
    const result = await new OpenRouterModelClient({
      apiKey: "test-key",
      fetchImpl: async () => {
        const body = (await response(
          {
            content: null,
            tool_calls: [
              {
                id: "partial",
                type: "function",
                function: { name: "project_read", arguments: '{"path":' },
              },
            ],
          },
          "length",
          "partial-response",
        ).json()) as Record<string, unknown>;
        if (mismatch) body.model = "different-model";
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    }).complete(REQUEST);
    assert.equal(result.responseFacts.responseId, "partial-response");
    const evidence = result.responseFacts.toolCallWireEvidence;
    assert.ok(evidence);
    assertModelToolCallWireEvidence(evidence);
    assert.equal(evidence.calls[0]?.argumentsHash, contentHash('{"path":'));
    assert.equal(evidence.calls[0]?.invalidInputMatchesWire, true);
    assert.equal(result.kind, mismatch ? "provider_error" : "assistant");
    if (result.kind === "assistant") assert.equal(result.stopReason, "max_tokens");
  }
});

test("wire evidence counts omitted details without limiting provider tool calls and validates every field", () => {
  const calls = Array.from({ length: 130 }, (_, index) => ({
    id: String(index),
    name: "tool",
    arguments: index === 0 ? "" : "{}",
  }));
  const evidence = captureToolCallWireEvidence(
    calls,
    calls.map(() => "changed"),
  );
  assertModelToolCallWireEvidence(evidence);
  assert.equal(evidence.totalCalls, 130);
  assert.equal(evidence.calls.length, 128);
  assert.equal(evidence.omittedCalls, 2);
  assert.equal(evidence.calls[0]?.argumentsBytes, 0);
  assert.equal(evidence.calls[0]?.invalidInputMatchesWire, false);
  assert.notEqual(
    evidence.envelopeHash,
    captureToolCallWireEvidence(calls.slice(0, 128)).envelopeHash,
  );
  for (const changed of [
    { totalCalls: -1 },
    { omittedCalls: 0 },
    { envelopeHash: "bad" },
    { extra: true },
  ])
    assert.throws(() => assertModelToolCallWireEvidence({ ...evidence, ...changed }));
  for (const changed of [
    { index: 1 },
    { argumentsHash: "bad" },
    { argumentsBytes: -1 },
    { argumentsBytes: 1.5 },
    { invalidInputMatchesWire: "true" },
    { jsonValidity: "unknown" },
    { extra: true },
  ])
    assert.throws(() =>
      assertModelToolCallWireEvidence({
        ...evidence,
        calls: [{ ...evidence.calls[0], ...changed }, ...evidence.calls.slice(1)],
      }),
    );
  const missing = captureToolCallWireEvidence([{ id: "x", arguments: null }]);
  assertModelToolCallWireEvidence(missing);
  assert.equal(missing.calls[0]?.jsonValidity, "unavailable");
  assert.equal(missing.calls[0]?.argumentsHash, null);
});

test("a rejected outer response retains only attributable tool digests and identity", async () => {
  const raw = '{"path":';
  const result = await new OpenRouterModelClient({
    apiKey: "never-retain-key",
    fetchImpl: async () =>
      response(
        {
          content: 42,
          hidden: "never-retain-hidden-field",
          tool_calls: [
            {
              id: "outer-invalid",
              type: "function",
              function: { name: "project_read", arguments: raw },
            },
          ],
        },
        "tool_calls",
        "invalid-envelope-response",
      ),
  }).complete(REQUEST);
  assert.equal(result.kind, "provider_error");
  assert.equal(result.responseFacts.responseId, "invalid-envelope-response");
  assert.equal(result.responseFacts.servingProvider, "OpenAI");
  assert.equal(
    result.responseFacts.toolCallWireEvidence?.calls[0]?.argumentsHash,
    contentHash(raw),
  );
  assert.equal(result.responseFacts.toolCallWireEvidence?.calls[0]?.invalidInputMatchesWire, null);
  assert.doesNotMatch(JSON.stringify(result), /never-retain/);
});

test("JSON diagnostics retain an interior UTF-16 position and bounded escaped vicinity without parser prose", () => {
  const raw = '{"prefix":"' + "🚀".repeat(50_000) + '",\n"broken":true false,"ending":"complete"}';
  const diagnostic = diagnoseToolArgumentJson(raw);
  assert.ok(diagnostic);
  assert.equal(diagnostic.positionUtf16, raw.indexOf("false"));
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column, 15);
  assert.ok(diagnostic.vicinity);
  assert.equal(
    diagnostic.vicinity.text,
    raw.slice(
      diagnostic.vicinity.startUtf16,
      diagnostic.vicinity.startUtf16 + diagnostic.vicinity.text.length,
    ),
  );
  assert.ok(diagnostic.vicinity.text.length <= 120);
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic.vicinity.text), "utf8") <= 722);
  const feedback = toolArgumentSyntaxMessage(diagnostic);
  assert.match(feedback, /Malformed JSON.*UTF-16 offset/);
  assert.match(feedback, /broken/);
  assert.doesNotMatch(feedback, /truncat|token|expected object/i);
  assert.ok(Buffer.byteLength(feedback, "utf8") < 1_200);
  assert.equal(diagnoseToolArgumentJson(JSON.stringify(raw)), null);
  const missingOffset = toolArgumentSyntaxMessage({
    kind: "invalid_json",
    positionUtf16: null,
    line: null,
    column: null,
    vicinity: null,
  });
  assert.match(missingOffset, /did not provide an offset/);
  assert.doesNotMatch(missingOffset, /truncat|token/i);
});
