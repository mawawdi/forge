import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentExecutionJournalStore,
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  assessAgentExecutionJournalRecovery,
  createAgentExecutionJournalResume,
  createRequestIntentCheckpoint,
  createResponseReceivedCheckpoint,
  type AgentToolHost,
  type AgentExecutionBoundaryState,
  type ToolResult,
} from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import type { AgentOrientation } from "../packages/context-compiler/src/index.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
} from "../packages/model-client/src/contracts.js";

const MODEL = "openai/test-model";

function emptyBoundaryState(): AgentExecutionBoundaryState {
  return {
    runtimeStartedAt: "2026-09-03T00:00:00.000Z",
    usage: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    trialStarted: false,
    remaining: {
      turns: 32,
      toolCalls: 256,
      toolResultBytes: 4 * 1_024 * 1_024,
      durationMs: 30 * 60_000,
      inputTokens: 1_000_000,
      outputTokens: 128_000,
      budgetUsd: 10,
    },
    seenToolCallIds: [],
    rejectedBatchRepeats: [],
    noProgressBatchRepeats: [],
    prematureCompletionRepairs: 0,
    toolHostProgressTokenHash: null,
    materializedToolCalls: 0,
    materializedToolResultBytes: 0,
  };
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-agent-journal-"));
}

function descriptor(): ModelClient["descriptor"] {
  return {
    transport: "test-transport",
    configuration: {
      aiSdk: { package: "test-ai" },
      providerAdapter: { package: "test-provider" },
      routing: {
        modelRegistryHash: "f".repeat(64),
        allowlistedModels: [MODEL],
        providerAllowlist: "none",
        modelFallbacks: false,
        providerFallbacks: false,
        requireParameters: true,
        requireTools: true,
      },
      reasoning: { effort: "medium", exclude: false },
      request: {
        steps: 1,
        toolChoice: "auto",
        providerParallelToolCalls: "not_requested",
        toolBatchExecution: "atomic_validate_then_sequential",
        toolNameEncoding: "openai_function_slug",
        maxRetries: 0,
        telemetry: false,
        timeoutPolicy: "remaining_runtime_budget",
        maxOutputTokensPerTurn: 4_096,
      },
      continuation: { maxBytes: 256 * 1_024 },
    },
  };
}

function responseFacts(request: ModelTurnRequest, sequence: number) {
  return {
    requestedModel: request.model,
    resolvedModel: request.model,
    servingProvider: "test-provider",
    responseId: `response-${sequence}`,
    latencyMs: 1,
    retryCount: 0 as const,
    finishReason: sequence === 1 ? "tool_calls" : "stop",
    continuationHash: sequence === 1 ? contentHash("opaque-secret") : null,
    continuationBytes: sequence === 1 ? 15 : null,
  };
}

test("execution journal publishes a private hash-chained head atomically", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root);
  const request: ModelTurnRequest = {
    model: MODEL,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxOutputTokens: 100,
    timeoutMs: 1_000,
  };
  await store.append(
    "journal-private",
    createRequestIntentCheckpoint(1, "2026-09-03T00:00:00.000Z", request, emptyBoundaryState()),
  );
  const loaded = await store.load("journal-private");
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0]?.checkpoint.checkpointType, "request_intent");
  const headPath = join(root, "agent-execution-journals", "journal-private.head.json");
  assert.equal((await stat(headPath)).mode & 0o777, 0o600);
});

test("runtime journals every provider and tool boundary without opaque continuation payloads", async () => {
  const root = await directory();
  const journal = new AgentExecutionJournalStore(root);
  let turn = 0;
  const client: ModelClient = {
    descriptor: descriptor(),
    async complete(request): Promise<ModelTurnResult> {
      turn += 1;
      if (turn === 1) {
        const continuation = {
          transport: "test-transport",
          payload: { private: "opaque-secret" },
          hash: contentHash("opaque-secret"),
          bytes: 15,
        };
        return {
          kind: "assistant",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "project.inspect", arguments: { id: "door" } }],
            continuation,
          },
          stopReason: "tool_calls",
          requestHash: contentHash(stableJson(request)),
          responseHash: contentHash("response-1"),
          responseFacts: responseFacts(request, 1),
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        };
      }
      return {
        kind: "assistant",
        message: { role: "assistant", content: "Done", toolCalls: [] },
        stopReason: "end_turn",
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash("response-2"),
        responseFacts: responseFacts(request, 2),
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      };
    },
  };
  const toolResult: ToolResult = {
    ok: true,
    value: { className: "Part" },
    truncated: false,
    resultHash: contentHash(stableJson({ className: "Part" })),
    bytes: 20,
  };
  const tools: AgentToolHost = {
    definitions: () => [
      {
        name: "project.inspect",
        description: "Inspect one project object.",
        inputShape: {},
        schema: { type: "object" },
      },
    ],
    validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
    async execute() {
      return toolResult;
    },
  };
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "system",
    prompt: "inspect",
    orientation: {} as AgentOrientation,
    tools,
    budgets: DEFAULT_AGENT_BUDGETS,
    model: MODEL,
    executionJournal: journal.sink("journal-runtime"),
  });
  assert.equal(result.status, "completed");
  const loaded = await journal.load("journal-runtime");
  assert.deepEqual(assessAgentExecutionJournalRecovery(loaded), {
    kind: "terminal",
    automaticProviderDispatchAllowed: false,
  });
  assert.deepEqual(
    loaded.entries.map((entry) => entry.checkpoint.checkpointType),
    [
      "request_intent",
      "response_received",
      "batch_validated",
      "tool_execution_intent",
      "tool_completed",
      "request_intent",
      "response_received",
      "terminal",
    ],
  );
  const firstResponse = loaded.entries[1]?.checkpoint;
  assert.equal(firstResponse?.checkpointType, "response_received");
  if (firstResponse?.checkpointType !== "response_received") assert.fail("missing response");
  assert.equal(firstResponse.result.kind, "assistant");
  if (firstResponse.result.kind !== "assistant") assert.fail("missing assistant response");
  assert.deepEqual(firstResponse.result.message.continuation, {
    present: true,
    transport: "test-transport",
    hash: contentHash("opaque-secret"),
    bytes: 15,
  });
  const terminal = loaded.entries.at(-1)?.checkpoint;
  assert.equal(terminal?.checkpointType, "terminal");
  if (terminal?.checkpointType !== "terminal") assert.fail("missing terminal checkpoint");
  assert.deepEqual(terminal.continuationBoundary, {
    kind: "opaque_continuation_not_persisted",
    hashes: [contentHash("opaque-secret")],
    rule: "explicit_new_agent_run_required_for_any_further_provider_turn",
  });
  await assert.rejects(() => journal.append("journal-runtime", terminal), /already terminal/);

  const artifactDirectory = join(root, "artifacts");
  for (const file of await readdir(artifactDirectory)) {
    const serialized = await readFile(join(artifactDirectory, file), "utf8");
    assert.equal(serialized.includes("opaque-secret"), false);
    assert.equal(serialized.includes('"payload"'), false);
  }
});

test("an interrupted provider intent remains durable and is never an implicit resend", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root, {
    beforePublishHead(_head, entry) {
      if (entry.checkpoint.checkpointType === "terminal")
        throw new Error("simulate crash before terminal publication");
    },
  });
  let calls = 0;
  await assert.rejects(
    () =>
      new ForgeNativeAgentRuntime({
        descriptor: descriptor(),
        async complete() {
          calls += 1;
          throw new Error("transport outcome unknown");
        },
      }).run({
        systemPrompt: "system",
        prompt: "request",
        orientation: {} as AgentOrientation,
        tools: {
          definitions: () => [],
          validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
          async execute() {
            assert.fail("no tool may run");
          },
        },
        budgets: DEFAULT_AGENT_BUDGETS,
        model: MODEL,
        executionJournal: store.sink("journal-provider-unknown"),
      }),
    /simulate crash/,
  );
  const loaded = await store.load("journal-provider-unknown");
  assert.deepEqual(
    loaded.entries.map((entry) => entry.checkpoint.checkpointType),
    ["request_intent"],
  );
  assert.equal(calls, 1);
  assert.deepEqual(assessAgentExecutionJournalRecovery(loaded), {
    kind: "provider_outcome_unknown",
    turnSequence: 1,
    intentHash:
      loaded.entries[0]!.checkpoint.checkpointType === "request_intent"
        ? loaded.entries[0]!.checkpoint.intentHash
        : "unreachable",
    exactSafeCreatorAction: "retry_work",
    rule: "explicit_creator_authorized_retry_work_required",
    automaticProviderDispatchAllowed: false,
  });
  assert.equal(
    loaded.entries.some((entry) => entry.checkpoint.checkpointType === "response_received"),
    false,
  );
});

test("a durable opaque response has a provider-neutral resume plan", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root);
  const request: ModelTurnRequest = {
    model: MODEL,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxOutputTokens: 100,
    timeoutMs: 1_000,
  };
  const intent = createRequestIntentCheckpoint(
    1,
    "2026-09-03T00:00:00.000Z",
    request,
    emptyBoundaryState(),
  );
  await store.append("journal-opaque-interrupted", intent);
  const continuationHash = contentHash("opaque-interrupted");
  await store.append(
    "journal-opaque-interrupted",
    createResponseReceivedCheckpoint({
      turnSequence: 1,
      occurredAt: "2026-09-03T00:00:01.000Z",
      intentHash: intent.intentHash,
      result: {
        kind: "assistant",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [],
          continuation: {
            transport: "test-transport",
            payload: { not: "durable" },
            hash: continuationHash,
            bytes: 18,
          },
        },
        stopReason: "end_turn",
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash("opaque-response"),
        responseFacts: {
          ...responseFacts(request, 1),
          continuationHash,
          continuationBytes: 18,
        },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
      state: {
        ...emptyBoundaryState(),
        usage: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        trialStarted: true,
      },
      turn: {
        sequence: 1,
        startedAt: "2026-09-03T00:00:00.000Z",
        endedAt: "2026-09-03T00:00:01.000Z",
        durationMs: 1_000,
        requestHash: contentHash(stableJson(request)),
        resultKind: "assistant",
        responseHash: contentHash("opaque-response"),
        stopReason: "end_turn",
        responseFacts: {
          ...responseFacts(request, 1),
          continuationHash,
          continuationBytes: 18,
        },
        toolCallIds: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
    }),
  );
  const loaded = await store.load("journal-opaque-interrupted");
  assert.deepEqual(assessAgentExecutionJournalRecovery(loaded), {
    kind: "response_ready",
    turnSequence: 1,
    responseHash: contentHash("opaque-response"),
    exactSafeCreatorAction: "resume_work",
    rule: "persisted_response_must_be_consumed_before_any_new_provider_turn",
    automaticProviderDispatchAllowed: false,
  });
  assert.deepEqual(createAgentExecutionJournalResume(loaded).opaqueContinuationHashes, [
    continuationHash,
  ]);
  for (const file of await readdir(join(root, "artifacts"))) {
    const serialized = await readFile(join(root, "artifacts", file), "utf8");
    assert.equal(serialized.includes('"not":"durable"'), false);
  }
});

for (const crashAfter of [
  "response_received",
  "tool_completed:call-1",
  "tool_completed:call-2",
] as const) {
  test(`restart consumes persisted response/tool state after ${crashAfter} without redispatch`, async () => {
    const root = await directory();
    const store = new AgentExecutionJournalStore(root);
    const journalId = `journal-resume-${crashAfter.replace(":", "-")}`;
    const durableSink = store.sink(journalId);
    let crashed = false;
    const crashSink = {
      journalId,
      async checkpoint(checkpoint: Parameters<typeof durableSink.checkpoint>[0]): Promise<void> {
        await durableSink.checkpoint(checkpoint);
        const label =
          checkpoint.checkpointType === "tool_completed"
            ? `tool_completed:${checkpoint.toolCall.toolCallId}`
            : checkpoint.checkpointType;
        if (!crashed && label === crashAfter) {
          crashed = true;
          throw new Error(`simulate crash after ${label}`);
        }
      },
    };
    let providerCalls = 0;
    const client: ModelClient = {
      descriptor: descriptor(),
      async complete(request): Promise<ModelTurnResult> {
        providerCalls += 1;
        if (providerCalls === 1) {
          const continuation = {
            transport: "test-transport",
            payload: { never: "persisted" },
            hash: contentHash("resume-opaque"),
            bytes: 13,
          };
          return {
            kind: "assistant",
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "call-1", name: "project.inspect", arguments: { target: 1 } },
                { id: "call-2", name: "project.inspect", arguments: { target: 2 } },
              ],
              continuation,
            },
            stopReason: "tool_calls",
            requestHash: contentHash(stableJson(request)),
            responseHash: contentHash("resume-response-1"),
            responseFacts: {
              ...responseFacts(request, 1),
              continuationHash: continuation.hash,
              continuationBytes: continuation.bytes,
            },
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          };
        }
        return {
          kind: "assistant",
          message: { role: "assistant", content: "done", toolCalls: [] },
          stopReason: "end_turn",
          requestHash: contentHash(stableJson(request)),
          responseHash: contentHash("resume-response-2"),
          responseFacts: responseFacts(request, 2),
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        };
      },
    };
    const toolExecutions: string[] = [];
    const tools: AgentToolHost = {
      definitions: () => [
        {
          name: "project.inspect",
          description: "Inspect one project object.",
          inputShape: {},
          schema: { type: "object" },
        },
      ],
      validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
      async execute(_name, input) {
        const target = (input as { target: number }).target;
        toolExecutions.push(`call-${target}`);
        const value = { target };
        return {
          ok: true,
          value,
          truncated: false,
          resultHash: contentHash(stableJson(value)),
          bytes: Buffer.byteLength(stableJson(value), "utf8"),
        };
      },
    };
    const runtime = new ForgeNativeAgentRuntime(client);
    const common = {
      systemPrompt: "system",
      prompt: "inspect both",
      orientation: {} as AgentOrientation,
      tools,
      budgets: DEFAULT_AGENT_BUDGETS,
      model: MODEL,
    };
    await assert.rejects(
      () => runtime.run({ ...common, executionJournal: crashSink }),
      /simulate crash after/,
    );
    const interrupted = await store.load(journalId);
    assert.deepEqual(assessAgentExecutionJournalRecovery(interrupted), {
      kind: "response_ready",
      turnSequence: 1,
      responseHash: contentHash("resume-response-1"),
      exactSafeCreatorAction: "resume_work",
      rule: "persisted_response_must_be_consumed_before_any_new_provider_turn",
      automaticProviderDispatchAllowed: false,
    });
    const result = await runtime.run({
      ...common,
      executionJournal: durableSink,
      resumeFromJournal: createAgentExecutionJournalResume(interrupted),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "OPAQUE_CONTINUATION_NEW_RUN_REQUIRED");
    assert.equal(
      providerCalls,
      1,
      "an opaque persisted continuation must never trigger a new provider turn",
    );
    assert.deepEqual(toolExecutions, ["call-1", "call-2"]);
    const completed = await store.load(journalId);
    assert.equal(completed.entries.at(-1)?.checkpoint.checkpointType, "terminal");
  });
}

test("explicit response resume preserves active duration budget across service downtime", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root);
  const journalId = "journal-resume-after-downtime";
  const durableSink = store.sink(journalId);
  const crashSink = {
    journalId,
    async checkpoint(checkpoint: Parameters<typeof durableSink.checkpoint>[0]): Promise<void> {
      await durableSink.checkpoint(checkpoint);
      if (checkpoint.checkpointType === "response_received")
        throw new Error("simulate service exit after durable response");
    },
  };
  let providerCalls = 0;
  const client: ModelClient = {
    descriptor: descriptor(),
    async complete(request): Promise<ModelTurnResult> {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          kind: "assistant",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-after-downtime", name: "project.inspect", arguments: {} }],
          },
          stopReason: "tool_calls",
          requestHash: contentHash(stableJson(request)),
          responseHash: contentHash("response-before-downtime"),
          responseFacts: {
            ...responseFacts(request, 1),
            continuationHash: null,
            continuationBytes: null,
          },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        };
      }
      return {
        kind: "assistant",
        message: { role: "assistant", content: "done", toolCalls: [] },
        stopReason: "end_turn",
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash("response-after-downtime"),
        responseFacts: responseFacts(request, 2),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      };
    },
  };
  let toolExecutions = 0;
  const tools: AgentToolHost = {
    definitions: () => [
      {
        name: "project.inspect",
        description: "Inspect one project object.",
        inputShape: {},
        schema: { type: "object" },
      },
    ],
    validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
    async execute() {
      toolExecutions += 1;
      const value = { inspected: true };
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(stableJson(value)),
        bytes: Buffer.byteLength(stableJson(value), "utf8"),
      };
    },
  };
  const budgets = { ...DEFAULT_AGENT_BUDGETS, maxDurationMs: 1_000 };
  const common = {
    systemPrompt: "system",
    prompt: "inspect",
    orientation: {} as AgentOrientation,
    tools,
    budgets,
    model: MODEL,
  };
  const firstClock = {
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    monotonicNow: () => 0,
  };
  await assert.rejects(
    () =>
      new ForgeNativeAgentRuntime(client, { clock: firstClock }).run({
        ...common,
        executionJournal: crashSink,
      }),
    /simulate service exit/,
  );
  const interrupted = await store.load(journalId);
  const nextDayClock = {
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    monotonicNow: () => 0,
  };
  const result = await new ForgeNativeAgentRuntime(client, { clock: nextDayClock }).run({
    ...common,
    executionJournal: durableSink,
    resumeFromJournal: createAgentExecutionJournalResume(interrupted),
  });

  assert.equal(result.status, "completed");
  assert.equal(providerCalls, 2);
  assert.equal(toolExecutions, 1);
  assert.equal(result.timing.durationMs, 24 * 60 * 60 * 1_000);
});

test("a durable tool intent without completion exposes the exact safe creator action", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root);
  const journalId = "journal-tool-outcome-unknown";
  const durableSink = store.sink(journalId);
  const crashSink = {
    journalId,
    async checkpoint(checkpoint: Parameters<typeof durableSink.checkpoint>[0]): Promise<void> {
      await durableSink.checkpoint(checkpoint);
      if (checkpoint.checkpointType === "tool_execution_intent")
        throw new Error("simulate crash after tool intent");
    },
  };
  let providerCalls = 0;
  let toolCalls = 0;
  const runtime = new ForgeNativeAgentRuntime({
    descriptor: descriptor(),
    async complete(request) {
      providerCalls += 1;
      return {
        kind: "assistant",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-unknown", name: "project.inspect", arguments: {} }],
        },
        stopReason: "tool_calls",
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash("tool-intent-response"),
        responseFacts: {
          ...responseFacts(request, 1),
          continuationHash: null,
          continuationBytes: null,
        },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      };
    },
  });
  await assert.rejects(
    () =>
      runtime.run({
        systemPrompt: "system",
        prompt: "inspect",
        orientation: {} as AgentOrientation,
        tools: {
          definitions: () => [
            {
              name: "project.inspect",
              description: "Inspect one project object.",
              inputShape: {},
              schema: { type: "object" },
            },
          ],
          validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
          async execute() {
            toolCalls += 1;
            assert.fail("the crash occurs before tool dispatch");
          },
        },
        budgets: DEFAULT_AGENT_BUDGETS,
        model: MODEL,
        executionJournal: crashSink,
      }),
    /simulate crash after tool intent/,
  );
  assert.equal(providerCalls, 1);
  assert.equal(toolCalls, 0);
  assert.deepEqual(assessAgentExecutionJournalRecovery(await store.load(journalId)), {
    kind: "tool_outcome_unknown",
    turnSequence: 1,
    responseHash: contentHash("tool-intent-response"),
    toolCallId: "call-unknown",
    exactSafeCreatorAction: "retry_work",
    rule: "explicit_creator_authorized_retry_work_required",
    automaticProviderDispatchAllowed: false,
  });
});

test("provider exception terminal is valid directly after its durable intent", async () => {
  const root = await directory();
  const store = new AgentExecutionJournalStore(root);
  const result = await new ForgeNativeAgentRuntime({
    descriptor: descriptor(),
    async complete() {
      throw new Error("provider unavailable");
    },
  }).run({
    systemPrompt: "system",
    prompt: "request",
    orientation: {} as AgentOrientation,
    tools: {
      definitions: () => [],
      validateBatch: () => ({ valid: true, feedback: [], budgetExhausted: false }),
      async execute() {
        assert.fail("no tool may run");
      },
    },
    budgets: DEFAULT_AGENT_BUDGETS,
    model: MODEL,
    executionJournal: store.sink("journal-provider-exception"),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "provider");
  const loaded = await store.load("journal-provider-exception");
  assert.deepEqual(
    loaded.entries.map((entry) => entry.checkpoint.checkpointType),
    ["request_intent", "terminal"],
  );
  assert.deepEqual(assessAgentExecutionJournalRecovery(loaded), {
    kind: "terminal",
    automaticProviderDispatchAllowed: false,
  });
});
