import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_OPENROUTER_MODEL,
  MODEL_CONTINUATION_MAX_BYTES,
  OpenRouterModelClient,
  type ModelTurnRequest,
} from "../packages/model-client/src/index.js";

const REQUEST: ModelTurnRequest = {
  model: CANONICAL_OPENROUTER_MODEL,
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
      model: CANONICAL_OPENROUTER_MODEL,
      provider: "OpenAI",
      choices: [
        { index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.002 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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
  assert.deepEqual(first.usage, { inputTokens: 12, outputTokens: 4, costUsd: 0.002 });
  assert.equal(first.responseFacts.requestedModel, CANONICAL_OPENROUTER_MODEL);
  assert.equal(first.responseFacts.resolvedModel, CANONICAL_OPENROUTER_MODEL);
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
  assert.equal(firstBody.model, CANONICAL_OPENROUTER_MODEL);
  assert.equal("parallel_tool_calls" in firstBody, false);
  assert.equal(firstBody.tool_choice, "auto");
  assert.equal(firstBody.max_tokens, 512);
  assert.deepEqual(firstBody.usage, { include: true });
  assert.deepEqual(firstBody.provider, {
    only: ["openai"],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.deepEqual(firstBody.reasoning, { effort: "medium", exclude: false });
  const sentTools = firstBody.tools as Array<{ function: { name: string; parameters: unknown } }>;
  assert.deepEqual(
    sentTools.map((entry) => entry.function.name),
    ["project_read", "project_list"],
  );
  assert.deepEqual(sentTools[0]?.function.parameters, REQUEST.tools[0]?.parameters);
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
  assert.equal(client.descriptor.configuration.aiSdk.package, "ai");
  assert.equal(client.descriptor.configuration.request.providerParallelToolCalls, "not_requested");
  assert.equal(
    client.descriptor.configuration.request.toolBatchExecution,
    "atomic_validate_then_sequential",
  );
  assert.equal(client.descriptor.configuration.request.toolNameEncoding, "openai_function_slug");
  assert.equal(
    client.descriptor.configuration.providerAdapter.package,
    "@openrouter/ai-sdk-provider",
  );
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

test("provider adapter rejects non-object tool schemas before transport", async () => {
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("must not execute");
    },
  });
  const result = await client.complete({
    ...REQUEST,
    tools: [
      { name: "invalid.schema", description: "Invalid fixture.", parameters: "not-a-schema" },
    ],
  });

  assert.equal(result.kind, "provider_error");
  if (result.kind === "provider_error") {
    assert.equal(result.errorClass, "request_configuration");
    assert.equal(result.retryable, false);
  }
  assert.equal(attempts, 0);
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
  if (malformed.kind === "provider_error") assert.equal(malformed.responseFacts.responseId, null);
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
});
