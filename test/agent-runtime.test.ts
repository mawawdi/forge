import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BoundedToolHost,
  AgentExecutionJournalStore,
  CandidateWorkspace,
  ForgeNativeAgentRuntime,
  DEFAULT_AGENT_BUDGETS,
  assertHarnessConfiguration,
  agentExecutionJournalIdForAgentRun,
  createHarnessConfiguration,
  loadWorkspaceCandidateArtifact,
  persistCreatorPhaseAgentRun,
  runBoundedAgent,
  verifyAgentRunExecutionJournal,
  type AgentToolHost,
  type ToolBatchDecision,
  type ToolResult,
} from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import {
  createRequirementSet,
  resolveRequirementView,
  type RequirementSet,
} from "../packages/semantic-authority/src/index.js";
import { compileAgentOrientation } from "../packages/context-compiler/src/index.js";
import { createProjectSnapshot } from "../packages/semantic-map/src/index.js";
import type { FlightRecorderClock } from "../packages/flight-recorder/src/index.js";

const VULNERABLE = resolve("test/fixtures/client-controlled-authoritative-state");
const SAFE = resolve("test/fixtures/authoritative-state-safe");
const GENERIC_SEED = resolve("test/fixtures/empty-declared-source-root");
const EMPTY_ROOT = resolve("test/fixtures/empty-declared-source-root");
const CREATOR_PROMPT =
  "Keep authoritative state server-owned while preserving the existing request interface.";
const EMPTY_ROOT_PROMPT = "Create a minimal server bootstrap script in the declared source root.";
const CREATOR_SESSION = {
  id: "creator_session_test",
  hash: contentHash("creator_session_test"),
} as const;

test("a rejected well-formed batch preserves the complete assistant continuation and matching tool errors", async () => {
  const host = completionRequiredToolHost();
  let executions = 0;
  const execute = host.execute;
  host.execute = async (name, input) => {
    executions++;
    return execute(name, input);
  };
  const validate = host.validateBatch;
  host.validateBatch = (calls, seen) =>
    calls.some((call) => Object.hasOwn(call.arguments as object, "invalid"))
      ? {
          valid: false,
          budgetExhausted: false,
          feedback: calls.map((call) => ({
            id: call.id,
            name: call.name,
            result: rejectedToolResult(
              "TOOL_ARGUMENTS_INVALID",
              "changes.0.name: expected a non-empty string",
            ),
          })),
        }
      : validate(calls, seen);
  const payload = { reasoning: "opaque continuation retained for provider" };
  const continuation = {
    transport: "test",
    payload,
    hash: contentHash(stableJson(payload)),
    bytes: Buffer.byteLength(stableJson(payload)),
  };
  const client = new ScriptedModelClient([
    (request) => {
      const result = assistant(
        1,
        [
          { id: "invalid", name: "phase.seal", arguments: { invalid: true } },
          { id: "valid-but-rejected", name: "phase.seal", arguments: {} },
        ],
        "I will publish the plan.",
      )(request);
      if (result.kind !== "assistant") throw new Error("Expected assistant");
      result.message.continuation = continuation;
      result.responseFacts.continuationHash = continuation.hash;
      result.responseFacts.continuationBytes = continuation.bytes;
      return result;
    },
    (request) => {
      assert.equal(executions, 0, "Atomic rejection cannot execute the otherwise valid call");
      const attempted = request.messages[1];
      assert.equal(attempted?.role, "assistant");
      if (attempted?.role !== "assistant") throw new Error("Missing attempted assistant call");
      assert.deepEqual(attempted.continuation, continuation);
      assert.equal(attempted.content, "I will publish the plan.");
      assert.deepEqual(
        request.messages
          .slice(2)
          .map((message) => (message.role === "tool" ? message.toolCallId : message.role)),
        ["invalid", "valid-but-rejected"],
      );
      return assistant(2, [{ id: "fixed", name: "phase.seal", arguments: {} }])(request);
    },
  ]);
  const root = await directory();
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "Publish the result.",
    prompt: "Exact request.",
    orientation: await genericOrientation(),
    tools: host,
    budgets: DEFAULT_AGENT_BUDGETS,
    model: "fake/model",
    executionJournal: new AgentExecutionJournalStore(
      new (await import("../packages/artifact-store/src/index.js")).ImmutableJsonArtifactStore(
        root,
      ),
    ).sink("agent_execution_journal_rejected_continuation"),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 2);
  assert.equal(executions, 1);
  assert.ok(result.turns[1]!.requestSizes.toolResults > result.turns[0]!.requestSizes.toolResults);
  assert.equal(
    result.turns[0]!.requestSizes.systemInstructions,
    Buffer.byteLength("Publish the result."),
  );
});

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-agent-runtime-"));
}
async function genericOrientation() {
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  return compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
}
function requirements(): RequirementSet {
  return createRequirementSet([
    {
      kind: "Requirement",
      id: "creator-authority-outcome",
      statement: CREATOR_PROMPT,
      source: "creator",
      authority: "policy",
      visibility: "builder_visible",
      enforcement: "blocking",
      verificationModes: ["static"],
      evidence: [
        {
          kind: "creator_request",
          id: "creator-evidence",
          intentId: "creator-intent",
          requestHash: contentHash(CREATOR_PROMPT),
        },
      ],
    },
    {
      kind: "Requirement",
      id: "hidden-evaluator-sentinel",
      statement: "HIDDEN_EXPECTED_VALUE_999",
      source: "benchmark_oracle",
      authority: "evaluation_only",
      visibility: "evaluator_only",
      enforcement: "blocking",
      verificationModes: ["evaluator"],
      evidence: [
        {
          kind: "benchmark_fixture",
          id: "hidden-evidence",
          benchmarkId: "authority",
          oracleId: "oracle",
          fixtureHash: contentHash("hidden"),
        },
      ],
    },
  ]);
}

function emptyRootRequirements(): RequirementSet {
  return createRequirementSet([
    {
      kind: "Requirement",
      id: "creator-empty-root",
      statement: EMPTY_ROOT_PROMPT,
      source: "creator",
      authority: "policy",
      visibility: "builder_visible",
      enforcement: "blocking",
      verificationModes: ["static"],
      evidence: [
        {
          kind: "creator_request",
          id: "creator-empty-root-evidence",
          intentId: "creator-empty-root-intent",
          requestHash: contentHash(EMPTY_ROOT_PROMPT),
        },
      ],
    },
    {
      kind: "Requirement",
      id: "hidden-empty-root-sentinel",
      statement: "HIDDEN_EMPTY_ROOT_EVALUATOR_999",
      source: "benchmark_oracle",
      authority: "evaluation_only",
      visibility: "evaluator_only",
      enforcement: "blocking",
      verificationModes: ["evaluator"],
      evidence: [
        {
          kind: "benchmark_fixture",
          id: "hidden-empty-root-evidence",
          benchmarkId: "empty-root",
          oracleId: "oracle",
          fixtureHash: contentHash("hidden-empty-root"),
        },
      ],
    },
  ]);
}

class ScriptedModelClient implements ModelClient {
  readonly descriptor: ModelClient["descriptor"] = {
    transport: "fake-model",
    configuration: {
      aiSdk: { package: "fake-ai" },
      providerAdapter: { package: "fake-provider" },
      routing: {
        modelRegistryHash: "f".repeat(64),
        allowlistedModels: ["fake/model"],
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
        timeoutPolicy: "bounded_turn_and_remaining_runtime_budget",
        maxDurationMsPerTurn: 1_200_000,
        maxOutputTokensPerTurn: 4096,
      },
      continuation: { maxBytes: 256 * 1024 },
    },
  };
  private index = 0;
  constructor(private readonly results: Array<(request: ModelTurnRequest) => ModelTurnResult>) {}
  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const factory = this.results[this.index++];
    if (!factory) throw new Error("Unexpected model turn");
    return factory(request);
  }
}

function assistant(
  sequence: number,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
  content = "",
): (request: ModelTurnRequest) => ModelTurnResult {
  return (request) => ({
    kind: "assistant",
    message: { role: "assistant", content, toolCalls },
    stopReason: toolCalls.length > 0 ? "tool_calls" : "end_turn",
    usage: {
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    },
    requestHash: contentHash(stableJson({ sequence, messages: request.messages })),
    responseHash: contentHash(stableJson({ content, toolCalls })),
    responseFacts: {
      requestedModel: request.model,
      resolvedModel: request.model,
      servingProvider: "fake",
      responseId: `response-${sequence}`,
      latencyMs: 1,
      retryCount: 0,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
      continuationHash: null,
      continuationBytes: null,
    },
  });
}

function rejectedToolResult(code: string, message: string): ToolResult {
  const error = { code, message };
  const serialized = stableJson(error);
  return {
    ok: false,
    error,
    truncated: false,
    resultHash: contentHash(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

class ManualTimingClock implements FlightRecorderClock {
  private milliseconds = 0;
  now(): Date {
    return new Date(`2026-08-30T00:00:00.${String(this.milliseconds).padStart(3, "0")}Z`);
  }
  monotonicNow(): number {
    return this.milliseconds;
  }
  advance(durationMs: number): void {
    this.milliseconds += durationMs;
  }
}

function recordlessRejectingToolHost(): AgentToolHost {
  return {
    definitions: () => [
      {
        name: "forge.accepted",
        description: "A test-only tool.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch(calls): ToolBatchDecision {
      return {
        valid: false,
        budgetExhausted: false,
        feedback: calls.map((call) => ({
          id: call.id,
          name: call.name,
          result: rejectedToolResult("TOOL_UNKNOWN", `Unknown tool ${call.name}`),
        })),
      };
    },
    async execute(): Promise<ToolResult> {
      throw new Error("Rejected batches must not execute tools");
    },
  };
}

function repairableExecutionToolHost(): AgentToolHost {
  let sealed = false;
  return {
    definitions: () => [
      {
        name: "project.read",
        description: "A test-only readable tool.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch: () => ({
      valid: true,
      budgetExhausted: false,
      feedback: [],
    }),
    async execute(_name, input): Promise<ToolResult> {
      if ((input as { target?: string }).target === "accepted") {
        sealed = true;
        const value = { sealed: true };
        const serialized = stableJson(value);
        return {
          ok: true,
          value,
          truncated: false,
          resultHash: contentHash(serialized),
          bytes: Buffer.byteLength(serialized, "utf8"),
        };
      }
      return rejectedToolResult(
        "TOOL_FAILURE",
        `The test host rejected target ${(input as { target?: string }).target ?? "missing"}.`,
      );
    },
    completionStatus: () =>
      sealed
        ? { ready: true }
        : {
            ready: false,
            code: "PHASE_ARTIFACT_NOT_SEALED",
            message: "The repairable phase artifact has not been sealed",
          },
    progressToken: () => (sealed ? "sealed" : "unsealed"),
  };
}

function noProgressToolHost(): AgentToolHost {
  const value = { inspected: true };
  const serialized = stableJson(value);
  return {
    definitions: () => [
      {
        name: "studio.inspect",
        description: "Read one unchanged fact.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch: () => ({
      valid: true,
      budgetExhausted: false,
      feedback: [],
    }),
    async execute(): Promise<ToolResult> {
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(serialized),
        bytes: Buffer.byteLength(serialized, "utf8"),
      };
    },
    progressToken: () => contentHash("unchanged-host-state"),
  };
}

function completionRequiredToolHost(): AgentToolHost {
  let sealed = false;
  const value = { sealed: true };
  const serialized = stableJson(value);
  return {
    definitions: () => [
      {
        name: "phase.seal",
        description: "Seal the required test phase artifact.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch(calls): ToolBatchDecision {
      return calls.every((call) => call.name === "phase.seal")
        ? { valid: true, budgetExhausted: false, feedback: [] }
        : {
            valid: false,
            budgetExhausted: false,
            feedback: calls.map((call) => ({
              id: call.id,
              name: call.name,
              result: rejectedToolResult("TOOL_UNKNOWN", `Unknown tool ${call.name}`),
            })),
          };
    },
    async execute(): Promise<ToolResult> {
      sealed = true;
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(serialized),
        bytes: Buffer.byteLength(serialized, "utf8"),
      };
    },
    completionStatus: () =>
      sealed
        ? { ready: true as const }
        : {
            ready: false as const,
            code: "PHASE_ARTIFACT_NOT_SEALED",
            message: "The required phase artifact has not been sealed",
          },
    progressToken: () => (sealed ? "sealed" : "unsealed"),
  };
}

async function repairingClient(withFeedback: boolean): Promise<ModelClient> {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  return new ScriptedModelClient([
    assistant(1, [
      {
        id: "plan",
        name: "plan.update",
        arguments: {
          goal: "Restore server authority",
          steps: [
            {
              id: "inspect",
              statement: "Inspect and repair the server handler",
              status: "in_progress",
            },
          ],
          verificationIntentions: ["Run the local authority gate"],
          status: "active",
        },
      },
      {
        id: "read",
        name: "project.read",
        arguments: { path: "src/server/ApplyAction.server.luau" },
      },
      ...(withFeedback ? [{ id: "verify-before", name: "forge.verify", arguments: {} }] : []),
    ]),
    assistant(2, [
      {
        id: "write",
        name: "workspace.write",
        arguments: {
          path: "src/server/ApplyAction.server.luau",
          precondition: { kind: "sha256", hash: contentHash(source) },
          content: repaired,
        },
      },
    ]),
    ...(withFeedback
      ? [assistant(3, [{ id: "verify-after", name: "forge.verify", arguments: {} }])]
      : []),
    assistant(withFeedback ? 4 : 3, [], "Server-owned update completed."),
  ]);
}

test("one default agent budget supports every bounded agent purpose", () => {
  assert.deepEqual(DEFAULT_AGENT_BUDGETS, {
    maxTurns: 10_000,
    maxToolCalls: 100_000,
    maxWrites: 100_000,
    maxVerifierCalls: 10_000,
    maxChangedFiles: 100_000,
    maxAddedLines: 10_000_000,
    maxRemovedLines: 10_000_000,
    maxBytesPerFile: 16_777_216,
    maxChangedSourceBytes: 536_870_912,
    maxToolResultBytes: 536_870_912,
    maxDurationMs: 604_800_000,
    maxBudgetUsd: 1_000,
    maxInputTokens: 1_000_000_000_000,
    maxOutputTokens: 100_000_000_000,
  });
});

test("native runtime requires an in-session repair when a model ends before sealing the phase artifact", async () => {
  let repairInstructionObserved = false;
  const client = new ScriptedModelClient([
    assistant(1, [], "Finished."),
    (request) => {
      const repair = request.messages.at(-1);
      assert.equal(repair?.role, "user");
      const payload = JSON.parse(String(repair?.content)) as {
        forgeCompletionRequired?: boolean;
        code?: string;
      };
      repairInstructionObserved = payload.forgeCompletionRequired === true;
      assert.equal(payload.code, "PHASE_ARTIFACT_NOT_SEALED");
      return assistant(2, [{ id: "seal", name: "phase.seal", arguments: {} }])(request);
    },
    assistant(3, [], "The phase artifact is sealed."),
  ]);
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "Test required completion",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: completionRequiredToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 2);
  assert.equal(repairInstructionObserved, true);
  assert.equal(result.toolCalls[0]?.name, "phase.seal");
});

test("native runtime bounds repeated premature completion without a sealed artifact", async () => {
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [], "Finished."),
      assistant(2, [], "Still finished."),
      assistant(3, [], "No artifact."),
    ]),
  ).run({
    systemPrompt: "Test bounded required completion",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: completionRequiredToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "model");
  assert.equal(result.failureCode, "PHASE_ARTIFACT_NOT_SEALED");
  assert.match(result.error ?? "", /exhausted 2 mandatory completion-repair attempts/);
  assert.equal(result.turns.length, 3);
});

test("native runtime performs same-session verifier feedback repair and seals only a locally eligible candidate", async () => {
  const runDirectory = await directory();
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: VULNERABLE,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(await repairingClient(true)),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.classification, "none");
  assert.equal(result.run.trialStarted, true);
  assert.equal(result.run.finalVerification.gate, "eligible");
  assert.equal(result.run.studio, "not_run");
  assert.deepEqual(
    result.run.toolCalls
      .filter((call) => call.name === "forge.verify")
      .map((call) => (call.result.value as { gate: string }).gate),
    ["rejected", "locally_eligible"],
  );
  const firstVerifierResult = result.run.toolCalls.find((call) => call.name === "forge.verify")
    ?.result.value as { issues?: Array<{ message?: string; location?: unknown }> } | undefined;
  assert.ok(
    firstVerifierResult?.issues?.every(
      (issue) => typeof issue.message === "string" && issue.message.length > 0,
    ),
  );
  assert.equal(result.run.workspaceDelta?.operations.length, 1);
  assert.equal(result.run.modelTurns.length, 4);
  assert.equal((await stat(resolve(result.persistence.path))).mode & 0o777, 0o600);
  assert.ok(result.candidateArtifact);
  const loaded = await loadWorkspaceCandidateArtifact(
    resolve(result.candidateArtifact!.persistence.path),
    join(runDirectory, "traces"),
  );
  assert.equal(loaded.verification.report.gate.status, "eligible");
});

test("the independent final gate succeeds when the model never invokes forge.verify", async () => {
  const runDirectory = await directory();
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: VULNERABLE,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(await repairingClient(false)),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.equal(result.status, "locally_eligible");
  assert.equal(
    result.run.toolCalls.some((call) => call.name === "forge.verify"),
    false,
  );
  assert.equal(result.finalVerification.report.gate.status, "eligible");
});

test("an empty declared source root is visible before planning, supports creation, and seals a locally eligible candidate", async () => {
  const runDirectory = await directory();
  let orientationContentHash = "";
  let toolDescriptionHash = "";
  const client = new ScriptedModelClient([
    (request) => {
      const firstMessage = request.messages[0];
      assert.equal(firstMessage?.role, "user");
      const initial = {
        orientation: JSON.parse(
          firstMessage!.content
            .split("<forge_project_orientation>\n")[1]!
            .split("\n</forge_project_orientation>")[0]!,
        ) as { content: { files: unknown[]; sourceRoots: string[] } },
      };
      assert.deepEqual(initial.orientation.content.files, []);
      assert.deepEqual(initial.orientation.content.sourceRoots, ["src/server"]);
      assert.equal(
        firstMessage!.role === "user" && firstMessage.content.includes(runDirectory),
        false,
      );
      assert.doesNotMatch(
        firstMessage!.role === "user" ? firstMessage.content : "",
        /HIDDEN_EMPTY_ROOT_EVALUATOR_999/,
      );
      const write = request.tools.find((definition) => definition.name === "workspace.write");
      assert.match(write?.description ?? "", /candidate-relative/);
      assert.match(write?.description ?? "", /orientation\.content\.sourceRoots/);
      orientationContentHash = contentHash(stableJson(initial.orientation.content));
      toolDescriptionHash = contentHash(
        stableJson(request.tools.map(({ name, description }) => ({ name, description }))),
      );
      return assistant(1, [
        {
          id: "plan",
          name: "plan.update",
          arguments: {
            goal: "Create the bootstrap script",
            steps: [
              {
                id: "create",
                statement: "Create the server bootstrap script",
                status: "in_progress",
              },
            ],
            expectedTouchedAreas: ["src/server/Bootstrap.server.luau"],
            verificationIntentions: ["Run the local verifier"],
            status: "active",
          },
        },
        {
          id: "write",
          name: "workspace.write",
          arguments: {
            path: "src/server/Bootstrap.server.luau",
            precondition: { kind: "absent" },
            content: "local initialized = true\n",
          },
        },
      ])(request);
    },
    assistant(2, [{ id: "verify", name: "forge.verify", arguments: {} }]),
    (request) => {
      const verifierFeedback = request.messages.at(-1);
      assert.equal(verifierFeedback?.role, "tool");
      assert.match(
        verifierFeedback?.role === "tool" ? verifierFeedback.content : "",
        /locally_eligible/,
      );
      return assistant(3, [], "Bootstrap script created and locally verified.")(request);
    },
  ]);
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: EMPTY_ROOT,
    creatorPrompt: EMPTY_ROOT_PROMPT,
    requirementSet: emptyRootRequirements(),
    runtime: new ForgeNativeAgentRuntime(client),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.classification, "none");
  assert.deepEqual(
    result.run.toolCalls.map((call) => call.name),
    ["plan.update", "workspace.write", "forge.verify"],
  );
  assert.ok(result.candidateArtifact);
  assert.deepEqual(
    result.run.workspaceDelta?.operations.map((operation) => operation.path),
    ["src/server/Bootstrap.server.luau"],
  );
  assert.equal(
    await readFile(join(result.candidateRoot, "src/server/Bootstrap.server.luau"), "utf8"),
    "local initialized = true\n",
  );
  assert.equal(
    orientationContentHash,
    "3b178050f5d9ce0c35d77fcf86c7e1a11df404963c8e03470d16a77c82297270",
  );
  assert.equal(
    toolDescriptionHash,
    "b84ebc2580666fb7c8711d9d81ad08525b72b9b1ad2b29641d92ef9df0a72d8b",
  );
  assert.match(result.run.harnessConfigurationHash, /^[0-9a-f]{64}$/);
  assert.equal(
    result.run.harnessConfigurationId,
    `harness_configuration_${result.run.harnessConfigurationHash.slice(0, 24)}`,
  );
});

test("mixed invalid tool batches execute nothing, return feedback for every call, and recover in-session", async () => {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  const client = new ScriptedModelClient([
    assistant(1, [
      {
        id: "rejected-plan",
        name: "plan.update",
        arguments: {
          goal: "Repair",
          steps: [
            {
              id: "repair",
              statement: "Repair authority",
              status: "in_progress",
            },
          ],
          status: "active",
        },
      },
      {
        id: "",
        name: "project.read",
        arguments: { path: "src/server/ApplyAction.server.luau" },
      },
      { id: "bad-arguments", name: "project.read", arguments: {} },
      { id: "unknown-tool", name: "project.shell", arguments: {} },
    ]),
    (request) => {
      const feedback = request.messages.at(-1);
      assert.equal(feedback?.role, "user");
      assert.match(
        feedback?.role === "user" ? feedback.content : "",
        /forgeToolBatchRejected|TOOL_CALL_ID_EMPTY|TOOL_ARGUMENTS_INVALID|TOOL_UNKNOWN/,
      );
      return assistant(2, [
        {
          id: "accepted-plan",
          name: "plan.update",
          arguments: {
            goal: "Repair",
            steps: [
              {
                id: "repair",
                statement: "Repair authority",
                status: "in_progress",
              },
            ],
            status: "active",
          },
        },
      ])(request);
    },
    assistant(3, [
      {
        id: "accepted-write",
        name: "workspace.write",
        arguments: {
          path: "src/server/ApplyAction.server.luau",
          precondition: { kind: "sha256", hash: contentHash(source) },
          content: repaired,
        },
      },
    ]),
    assistant(4, [], "Repair complete."),
  ]);
  const runDirectory = await directory();
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: VULNERABLE,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(client),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.run.plans.length, 1);
  assert.deepEqual(
    result.run.toolCalls.slice(0, 4).map((call) => call.result.error?.code),
    ["TOOL_BATCH_REJECTED", "TOOL_CALL_ID_EMPTY", "TOOL_ARGUMENTS_INVALID", "TOOL_UNKNOWN"],
  );
  assert.equal(result.run.toolCalls[0]?.name, "plan.update");
  assert.equal(result.run.toolCalls[0]?.result.ok, false);
  const persisted = JSON.parse(
    await readFile(result.persistence.path, "utf8"),
  ) as typeof result.run;
  assert.deepEqual(
    persisted.toolCalls.slice(0, 4).map((call) => ({
      inputHash: call.inputHash,
      resultHash: call.resultHash,
      code: call.result.error?.code,
    })),
    result.run.toolCalls.slice(0, 4).map((call) => ({
      inputHash: call.inputHash,
      resultHash: call.resultHash,
      code: call.result.error?.code,
    })),
  );
  const rejectedSpans = result.trace.spans.filter(
    (span) => span.name === "forge.tool.call" && span.status === "error",
  );
  assert.equal(rejectedSpans.length, 4);
  assert.deepEqual(
    rejectedSpans.map((span) => span.attributes["forge.tool.error_code"]),
    ["TOOL_BATCH_REJECTED", "TOOL_CALL_ID_EMPTY", "TOOL_ARGUMENTS_INVALID", "TOOL_UNKNOWN"],
  );
  assert.ok(
    rejectedSpans.every(
      (span) =>
        typeof span.attributes["forge.tool.input_hash"] === "string" &&
        typeof span.attributes["forge.tool.result_hash"] === "string",
    ),
  );
});

test("runtime persists rejected atomic-batch evidence when a tool host only returns validation feedback", async () => {
  const runDirectory = await directory();
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    runDirectory,
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const toolHost = recordlessRejectingToolHost();
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "unknown", name: "forge.missing", arguments: { target: "x" } }]),
      assistant(2, [], "Stopped after receiving the validation result."),
    ]),
  );
  const agentRunId = "agent_run_runtime_evidence";
  const executionJournalStore = new AgentExecutionJournalStore(runDirectory);
  const executionJournalId = agentExecutionJournalIdForAgentRun(agentRunId);
  const runtimeResult = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: toolHost,
    budgets: DEFAULT_AGENT_BUDGETS,
    model: "fake/model",
    executionJournal: executionJournalStore.sink(executionJournalId),
  });
  const executionJournal = await executionJournalStore.load(executionJournalId);
  assert.equal(runtimeResult.status, "completed");
  assert.deepEqual(
    runtimeResult.toolCalls.map((call) => call.result.error?.code),
    ["TOOL_UNKNOWN"],
  );
  const phase = await persistCreatorPhaseAgentRun({
    agentRunId,
    phase: "creator_planner",
    creatorSession: CREATOR_SESSION,
    promptHash: contentHash(CREATOR_PROMPT),
    projectId: "project_runtime_evidence",
    revisionHash: contentHash("runtime-evidence-revision"),
    orientation,
    systemPrompt: "Test runtime",
    finalization: {
      status: "sealed",
      artifact: {
        kind: "creator_outcome",
        id: "creator_plan_runtime_evidence",
        hash: contentHash("creator-plan-runtime-evidence"),
      },
    },
    runtime,
    runtimeResult,
    model: "fake/model",
    toolHost,
    budgets: DEFAULT_AGENT_BUDGETS,
    directory: runDirectory,
    traceDirectory: join(runDirectory, "traces"),
    executionWorker: {
      kind: "CreatorAgentWorkerDescriptor",
      name: "forge-local-creator-agent-worker",
      environment: "local_process",
      isolation: "none",
    },
    executionJournal,
  });
  assert.deepEqual(
    phase.run.toolCalls.map((call) => call.result.error?.code),
    ["TOOL_UNKNOWN"],
  );
  assert.equal(phase.run.toolCalls[0]?.inputHash, runtimeResult.toolCalls[0]?.inputHash);
  assert.equal(phase.run.toolCalls[0]?.resultHash, runtimeResult.toolCalls[0]?.resultHash);
  assert.equal(phase.run.budgets.consumed.toolCalls, 1);
  assert.equal(phase.run.model.name, "fake/model");
  assert.equal(phase.run.executionJournal?.journalId, executionJournal.head.journalId);
  assert.equal(phase.run.executionJournal?.sequence, executionJournal.head.sequence);
  assert.equal(phase.run.executionJournal?.entryHash, executionJournal.head.entryHash);
  assert.deepEqual(phase.run.executionJournal?.entry, executionJournal.head.entry);
  assert.equal(
    phase.run.executionJournal?.terminalResultHash,
    contentHash(stableJson(runtimeResult)),
  );
  await verifyAgentRunExecutionJournal(phase.run, executionJournalStore.artifactStore);
  assert.equal(phase.trace.components.model?.name, "fake/model");
  assert.equal(phase.run.budgets.consumed.toolResultBytes, phase.run.toolCalls[0]?.bytes);
  const persisted = JSON.parse(await readFile(phase.persistence.path, "utf8")) as typeof phase.run;
  assert.equal(persisted.toolCalls[0]?.result.error?.code, "TOOL_UNKNOWN");
  const span = phase.trace.spans.find((candidate) => candidate.name === "forge.tool.call");
  assert.equal(span?.attributes["forge.tool.error_code"], "TOOL_UNKNOWN");
  assert.equal(span?.attributes["forge.tool.input_hash"], phase.run.toolCalls[0]?.inputHash);
  assert.equal(span?.attributes["forge.tool.result_hash"], phase.run.toolCalls[0]?.resultHash);
});

test("creator builder repair AgentRuns bind distinct terminal execution journals", async () => {
  const runDirectory = await directory();
  const orientation = await genericOrientation();
  const toolHost = recordlessRejectingToolHost();
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [], "repair one sealed"),
      assistant(2, [], "repair two sealed"),
    ]),
  );
  const journalStore = new AgentExecutionJournalStore(runDirectory);
  const phases: Array<Awaited<ReturnType<typeof persistCreatorPhaseAgentRun>>> = [];
  for (const repair of [1, 2]) {
    const agentRunId = `agent_run_builder_repair_${repair}`;
    const journalId = agentExecutionJournalIdForAgentRun(agentRunId);
    const runtimeResult = await runtime.run({
      systemPrompt: "Builder repair",
      prompt: CREATOR_PROMPT,
      orientation,
      tools: toolHost,
      budgets: DEFAULT_AGENT_BUDGETS,
      model: "fake/model",
      executionJournal: journalStore.sink(journalId),
    });
    const executionJournal = await journalStore.load(journalId);
    phases.push(
      await persistCreatorPhaseAgentRun({
        agentRunId,
        phase: "creator_builder",
        creatorSession: CREATOR_SESSION,
        promptHash: contentHash(CREATOR_PROMPT),
        projectId: "project_builder_repairs",
        revisionHash: contentHash("builder-repair-revision"),
        orientation,
        systemPrompt: "Builder repair",
        finalization: {
          status: "sealed",
          artifact: {
            kind: "change_set",
            id: `creator_change_set_repair_${repair}`,
            hash: contentHash(`creator-change-set-repair-${repair}`),
          },
        },
        runtime,
        runtimeResult,
        model: "fake/model",
        toolHost,
        budgets: DEFAULT_AGENT_BUDGETS,
        directory: runDirectory,
        traceDirectory: join(runDirectory, "traces"),
        executionWorker: {
          kind: "CreatorAgentWorkerDescriptor",
          name: "forge-local-creator-agent-worker",
          environment: "local_process",
          isolation: "none",
        },
        executionJournal,
        creatorBuildContract: {
          id: "creator_build_contract_repairs",
          hash: contentHash("creator-build-contract-repairs"),
        },
      }),
    );
  }
  assert.notEqual(
    phases[0]?.run.executionJournal?.journalId,
    phases[1]?.run.executionJournal?.journalId,
  );
  for (const phase of phases) {
    assert.equal(
      phase.run.executionJournal?.journalId,
      agentExecutionJournalIdForAgentRun(phase.run.id),
    );
    const loaded = await journalStore.load(phase.run.executionJournal!.journalId);
    assert.equal(loaded.entries.at(-1)?.checkpoint.checkpointType, "terminal");
    assert.equal(phase.run.executionJournal?.entryHash, loaded.head.entryHash);
  }
});

test("runtime owns exact monotonic timing for provider turns and executed tool calls", async () => {
  const clock = new ManualTimingClock();
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const readValue = { observed: true };
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      (request) => {
        clock.advance(5);
        return assistant(1, [{ id: "read_1", name: "project.read", arguments: {} }])(request);
      },
      (request) => {
        clock.advance(2);
        return assistant(2, [], "The bounded read completed.")(request);
      },
    ]),
    { clock },
  );
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: {
      definitions: () => [
        {
          name: "project.read",
          description: "Read one fact.",
          inputShape: {},
          schema: { type: "object", additionalProperties: false },
        },
      ],
      validateBatch: () => ({
        valid: true,
        feedback: [],
        budgetExhausted: false,
      }),
      async execute() {
        clock.advance(3);
        const serialized = stableJson(readValue);
        return {
          ok: true,
          value: readValue,
          truncated: false,
          resultHash: contentHash(serialized),
          bytes: Buffer.byteLength(serialized, "utf8"),
        };
      },
    },
    budgets: DEFAULT_AGENT_BUDGETS,
    model: "fake/model",
  });
  assert.deepEqual(result.timing, {
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:00.010Z",
    durationMs: 10,
  });
  assert.deepEqual(
    result.turns.map((turn) => turn.durationMs),
    [5, 2],
  );
  assert.deepEqual(
    result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      disposition: call.disposition,
      durationMs: call.durationMs,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
    })),
    [
      {
        toolCallId: "read_1",
        disposition: "executed",
        durationMs: 3,
        startedAt: "2026-08-30T00:00:00.005Z",
        endedAt: "2026-08-30T00:00:00.008Z",
      },
    ],
  );

  const zeroClock = new ManualTimingClock();
  const zeroResult = await new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "read_zero", name: "project.read", arguments: {} }]),
      assistant(2, [], "The zero-tick read completed."),
    ]),
    { clock: zeroClock },
  ).run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: {
      definitions: () => [
        {
          name: "project.read",
          description: "Read one fact.",
          inputShape: {},
          schema: { type: "object", additionalProperties: false },
        },
      ],
      validateBatch: () => ({
        valid: true,
        feedback: [],
        budgetExhausted: false,
      }),
      async execute() {
        const serialized = stableJson(readValue);
        return {
          ok: true,
          value: readValue,
          truncated: false,
          resultHash: contentHash(serialized),
          bytes: Buffer.byteLength(serialized, "utf8"),
        };
      },
    },
    budgets: DEFAULT_AGENT_BUDGETS,
    model: "fake/model",
  });
  assert.equal(zeroResult.toolCalls[0]?.durationMs, 0);
  assert.equal(zeroResult.toolCalls[0]?.startedAt, zeroResult.toolCalls[0]?.endedAt);
});

test("repeating a semantically identical rejected batch terminates before the turn budget", async () => {
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "first", name: "forge.missing", arguments: { target: "x" } }]),
      assistant(2, [{ id: "second", name: "forge.missing", arguments: { target: "x" } }]),
      assistant(3, [{ id: "third", name: "forge.missing", arguments: { target: "x" } }]),
    ]),
  );
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: recordlessRejectingToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "model");
  assert.equal(result.failureCode, "REPEATED_REJECTED_TOOL_BATCH");
  assert.equal(result.turns.length, 3);
  assert.deepEqual(
    result.toolCalls.map((call) => call.result.error?.code),
    ["TOOL_UNKNOWN", "TOOL_UNKNOWN", "TOOL_UNKNOWN"],
  );
});

test("rejected-batch repetition is scoped to one chronological host-state epoch", async () => {
  let state: "a" | "b" = "a";
  const host: AgentToolHost = {
    definitions: () => [
      {
        name: "phase.reject",
        description: "Reject one test proposal.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
      {
        name: "phase.advance",
        description: "Advance accepted test state.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch(calls): ToolBatchDecision {
      if (calls.every((call) => call.name === "phase.advance"))
        return { valid: true, budgetExhausted: false, feedback: [] };
      return {
        valid: false,
        budgetExhausted: false,
        feedback: calls.map((call) => ({
          id: call.id,
          name: call.name,
          result: rejectedToolResult(
            "PROPOSAL_INVALID",
            "The proposal is invalid in the current epoch.",
          ),
        })),
      };
    },
    async execute(): Promise<ToolResult> {
      state = state === "a" ? "b" : "a";
      const value = { state };
      const serialized = stableJson(value);
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(serialized),
        bytes: Buffer.byteLength(serialized, "utf8"),
      };
    },
    progressToken: () => contentHash(`state-${state}`),
  };
  const result = await new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "reject-a-1", name: "phase.reject", arguments: { value: "x" } }]),
      assistant(2, [{ id: "advance-b", name: "phase.advance", arguments: {} }]),
      assistant(3, [{ id: "reject-b", name: "phase.reject", arguments: { value: "x" } }]),
      assistant(4, [{ id: "advance-a", name: "phase.advance", arguments: {} }]),
      assistant(5, [{ id: "reject-a-2", name: "phase.reject", arguments: { value: "x" } }]),
      assistant(6, [], "Each chronological epoch retained independent rejection evidence."),
    ]),
  ).run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation: await genericOrientation(),
    tools: host,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 8 },
    model: "fake/model",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 6);
  assert.deepEqual(
    result.toolCalls.map((call) => call.disposition),
    ["rejected", "executed", "rejected", "executed", "rejected"],
  );
});

test("changing arguments cannot evade the semantic rejection limit", async () => {
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "first", name: "forge.missing", arguments: { target: "one" } }]),
      assistant(2, [{ id: "second", name: "forge.missing", arguments: { target: "two" } }]),
      assistant(3, [{ id: "third", name: "forge.missing", arguments: { target: "three" } }]),
      assistant(4, [], "The rejected attempts were distinct and are recorded."),
    ]),
  );
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: recordlessRejectingToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "REPEATED_REJECTED_TOOL_BATCH");
  assert.equal(result.turns.length, 3);
  assert.deepEqual(
    result.toolCalls.map((call) => call.inputHash),
    [
      contentHash(stableJson({ target: "one" })),
      contentHash(stableJson({ target: "two" })),
      contentHash(stableJson({ target: "three" })),
    ],
  );
});

test("varied executed failures remain repairable", async () => {
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "first", name: "project.read", arguments: { target: "one" } }]),
      assistant(2, [{ id: "second", name: "project.read", arguments: { target: "two" } }]),
      assistant(3, [{ id: "third", name: "project.read", arguments: { target: "three" } }]),
      assistant(4, [
        {
          id: "accepted",
          name: "project.read",
          arguments: { target: "accepted" },
        },
      ]),
      assistant(5, [], "The corrected phase artifact is sealed."),
    ]),
  );
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: repairableExecutionToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 4);
  assert.deepEqual(
    result.toolCalls.map((call) => call.result.error?.code),
    ["TOOL_FAILURE", "TOOL_FAILURE", "TOOL_FAILURE", undefined],
  );
});

test("truncated or refused responses never execute even a syntactically valid tool call", async () => {
  for (const stopReason of ["max_tokens", "refusal"] as const) {
    const runtime = new ForgeNativeAgentRuntime(
      new ScriptedModelClient([
        (request) =>
          ({
            ...assistant(1, [{ id: "partial", name: "project.read", arguments: {} }])(request),
            stopReason,
          }) as ModelTurnResult,
      ]),
    );
    const result = await runtime.run({
      systemPrompt: "Test runtime",
      prompt: CREATOR_PROMPT,
      orientation: await genericOrientation(),
      tools: recordlessRejectingToolHost(),
      budgets: DEFAULT_AGENT_BUDGETS,
      model: "fake/model",
    });
    assert.equal(result.status, "failed");
    assert.equal(
      result.failureCode,
      stopReason === "max_tokens" ? "MODEL_RESPONSE_TRUNCATED" : "MODEL_RESPONSE_REFUSED",
    );
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.turns.length, 1);
  }
});

test("model responses allow twenty minutes while respecting the remaining run budget", async () => {
  for (const maxDurationMs of [1_800_000, 90_000]) {
    let observedTimeout = 0;
    const runtime = new ForgeNativeAgentRuntime(
      new ScriptedModelClient([
        (request) => {
          observedTimeout = request.timeoutMs;
          return assistant(1, [], "Done.")(request);
        },
      ]),
    );
    const result = await runtime.run({
      systemPrompt: "Test runtime",
      prompt: CREATOR_PROMPT,
      orientation: await genericOrientation(),
      tools: recordlessRejectingToolHost(),
      budgets: { ...DEFAULT_AGENT_BUDGETS, maxDurationMs },
      model: "fake/model",
    });
    assert.equal(result.status, "completed");
    if (maxDurationMs > 1_200_000) assert.equal(observedTimeout, 1_200_000);
    else assert.ok(observedTimeout > 0 && observedTimeout <= maxDurationMs);
  }
});

test("varied rejected tool batches remain bounded by the ordinary turn budget", async () => {
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "first", name: "forge.missing", arguments: { target: "one" } }]),
      assistant(2, [{ id: "second", name: "forge.missing", arguments: { target: "two" } }]),
      assistant(3, [{ id: "read", name: "project.read", arguments: {} }]),
    ]),
  );
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: recordlessRejectingToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 3 },
    model: "fake/model",
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.error, "Turn budget exhausted");
  assert.equal(result.turns.length, 3);
});

test("repeating an executed tool batch without semantic host progress terminates early", async () => {
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "inspect-first", name: "studio.inspect", arguments: {} }]),
      assistant(2, [{ id: "inspect-second", name: "studio.inspect", arguments: {} }]),
      assistant(3, [{ id: "inspect-third", name: "studio.inspect", arguments: {} }]),
    ]),
  );
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const requirementView = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "production",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: noProgressToolHost(),
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "REPEATED_NO_PROGRESS_TOOL_BATCH");
  assert.equal(result.turns.length, 3);
});

test("no-progress repetition is scoped to one accepted host-state epoch", async () => {
  let state: "a" | "b" = "a";
  const host: AgentToolHost = {
    definitions: () => [
      {
        name: "studio.inspect",
        description: "Read one bounded Studio fact.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
      {
        name: "studio.stage",
        description: "Advance accepted host state.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch: () => ({
      valid: true,
      budgetExhausted: false,
      feedback: [],
    }),
    async execute(name): Promise<ToolResult> {
      if (name === "studio.stage") state = state === "a" ? "b" : "a";
      const value = { name, state };
      const serialized = stableJson(value);
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(serialized),
        bytes: Buffer.byteLength(serialized, "utf8"),
      };
    },
    progressToken: () => contentHash(`state-${state}`),
  };
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "inspect-before", name: "studio.inspect", arguments: {} }]),
      assistant(2, [{ id: "stage-to-b", name: "studio.stage", arguments: {} }]),
      assistant(3, [{ id: "inspect-b", name: "studio.inspect", arguments: {} }]),
      assistant(4, [{ id: "stage-back-to-a", name: "studio.stage", arguments: {} }]),
      assistant(5, [{ id: "inspect-new-a-epoch", name: "studio.inspect", arguments: {} }]),
      assistant(6, [], "Each accepted host-state epoch was inspected."),
    ]),
  );
  const orientation = await genericOrientation();
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: host,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 8 },
    model: "fake/model",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 6);
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["studio.inspect", "studio.stage", "studio.inspect", "studio.stage", "studio.inspect"],
  );
});

test("a seal-ready host completes immediately without another inference", async () => {
  let ready = false;
  const host: AgentToolHost = {
    definitions: () => [
      {
        name: "forge.verify",
        description: "Seal the local gate.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
      {
        name: "studio.diff",
        description: "Read the current sealed diff.",
        inputShape: {},
        schema: { type: "object", additionalProperties: false },
      },
    ],
    validateBatch: () => ({
      valid: true,
      budgetExhausted: false,
      feedback: [],
    }),
    async execute(name): Promise<ToolResult> {
      if (name === "forge.verify") ready = true;
      const value = { name, ready };
      const serialized = stableJson(value);
      return {
        ok: true,
        value,
        truncated: false,
        resultHash: contentHash(serialized),
        bytes: Buffer.byteLength(serialized, "utf8"),
      };
    },
    completionStatus: () =>
      ready
        ? { ready: true }
        : {
            ready: false,
            code: "LOCAL_GATE_NOT_READY",
            message: "The local gate is not ready.",
          },
    progressToken: () => contentHash(ready ? "eligible" : "not-run"),
  };
  const runtime = new ForgeNativeAgentRuntime(
    new ScriptedModelClient([
      assistant(1, [{ id: "verify", name: "forge.verify", arguments: {} }]),
      assistant(2, [{ id: "diff-first", name: "studio.diff", arguments: {} }]),
      assistant(3, [{ id: "diff-second", name: "studio.diff", arguments: {} }]),
    ]),
  );
  const orientation = await genericOrientation();
  const result = await runtime.run({
    systemPrompt: "Test runtime",
    prompt: CREATOR_PROMPT,
    orientation,
    tools: host,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
    model: "fake/model",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.turns.length, 1);
  assert.equal(result.failureCode, undefined);
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["forge.verify"],
  );
});

test("tool-call IDs are unique for the full run and valid batches execute sequentially", async () => {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  const client = new ScriptedModelClient([
    assistant(1, [
      {
        id: "shared-id",
        name: "plan.update",
        arguments: {
          goal: "Repair",
          steps: [
            {
              id: "repair",
              statement: "Repair authority",
              status: "in_progress",
            },
          ],
          status: "active",
        },
      },
    ]),
    assistant(2, [
      {
        id: "shared-id",
        name: "project.read",
        arguments: { path: "src/server/ApplyAction.server.luau" },
      },
    ]),
    (request) => {
      const feedback = request.messages.at(-1);
      assert.match(feedback?.role === "user" ? feedback.content : "", /TOOL_CALL_ID_DUPLICATE/);
      return assistant(3, [
        {
          id: "read-sequential",
          name: "project.read",
          arguments: { path: "src/server/ApplyAction.server.luau" },
        },
        {
          id: "write-sequential",
          name: "workspace.write",
          arguments: {
            path: "src/server/ApplyAction.server.luau",
            precondition: { kind: "sha256", hash: contentHash(source) },
            content: repaired,
          },
        },
      ])(request);
    },
    assistant(4, [], "Repair complete."),
  ]);
  const runDirectory = await directory();
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: VULNERABLE,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(client),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.equal(result.status, "locally_eligible");
  assert.deepEqual(
    result.run.toolCalls.map((call) => call.name),
    ["plan.update", "project.read", "project.read", "workspace.write"],
  );
  assert.equal(result.run.toolCalls[1]?.result.error?.code, "TOOL_CALL_ID_DUPLICATE");
  assert.equal(result.run.toolCalls[2]?.result.ok, true);
  assert.equal(result.run.toolCalls[3]?.result.ok, true);
});

test("provider failures and model budget exhaustion normalize to incomplete outcomes", async () => {
  const failedDirectory = await directory();
  const failureClock = new ManualTimingClock();
  const failureClient = new ScriptedModelClient([
    (request) => ({
      kind: "provider_error",
      errorClass: "http_503",
      message: "unavailable",
      retryable: true,
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
      requestHash: contentHash(stableJson(request)),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: null,
        servingProvider: null,
        responseId: null,
        latencyMs: 1,
        retryCount: 0,
        finishReason: null,
        continuationHash: null,
        continuationBytes: null,
      },
    }),
  ]);
  const failed = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: GENERIC_SEED,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(failureClient, {
      clock: failureClock,
    }),
    model: "fake/model",
    runDirectory: failedDirectory,
    traceDirectory: join(failedDirectory, "traces"),
  });
  assert.equal(failed.status, "incomplete");
  assert.equal(failed.classification, "provider_failure");
  assert.equal(failed.run.trialStarted, false);
  assert.equal(failed.run.modelTurns[0]?.durationMs, 0);
  assert.deepEqual(failed.run.timing, {
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 0,
  });
  const invalidDirectory = await directory();
  const invalidClient = new ScriptedModelClient([
    (request) => ({
      kind: "invalid_model_response",
      errorClass: "unknown_tool",
      message: "invalid tool envelope",
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.0001,
      },
      requestHash: contentHash(stableJson(request)),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: request.model,
        servingProvider: "fake",
        responseId: "response-invalid",
        latencyMs: 1,
        retryCount: 0,
        finishReason: "invalid-tool-call",
        continuationHash: null,
        continuationBytes: null,
      },
    }),
  ]);
  const invalid = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: GENERIC_SEED,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(invalidClient),
    model: "fake/model",
    runDirectory: invalidDirectory,
    traceDirectory: join(invalidDirectory, "traces"),
  });
  assert.equal(invalid.status, "incomplete");
  assert.equal(invalid.classification, "agent_failure");
  assert.equal(invalid.run.trialStarted, true);
  const postResponseDirectory = await directory();
  const postResponseFailure = new ScriptedModelClient([
    (request) => ({
      kind: "provider_error",
      errorClass: "continuation_too_large",
      message: "bounded continuation exceeded",
      retryable: false,
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.0001,
      },
      requestHash: contentHash(stableJson(request)),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: request.model,
        servingProvider: "fake",
        responseId: "response-valid-envelope",
        latencyMs: 1,
        retryCount: 0,
        finishReason: "tool-calls",
        continuationHash: null,
        continuationBytes: null,
      },
    }),
  ]);
  const postResponse = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: GENERIC_SEED,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(postResponseFailure),
    model: "fake/model",
    runDirectory: postResponseDirectory,
    traceDirectory: join(postResponseDirectory, "traces"),
  });
  assert.equal(postResponse.status, "incomplete");
  assert.equal(postResponse.run.trialStarted, true);
  const budgetDirectory = await directory();
  const budgetClient = new ScriptedModelClient([
    (request) => ({
      kind: "assistant",
      message: { role: "assistant", content: "", toolCalls: [] },
      stopReason: "max_tokens",
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 1,
        outputTokens: 10,
        costUsd: 0,
      },
      requestHash: contentHash(stableJson(request)),
      responseHash: contentHash("limit"),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: request.model,
        servingProvider: "fake",
        responseId: "limit",
        latencyMs: 1,
        retryCount: 0,
        finishReason: "length",
        continuationHash: null,
        continuationBytes: null,
      },
    }),
  ]);
  const exhausted = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: GENERIC_SEED,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(budgetClient),
    model: "fake/model",
    runDirectory: budgetDirectory,
    traceDirectory: join(budgetDirectory, "traces"),
  });
  assert.equal(exhausted.status, "incomplete");
  assert.equal(exhausted.classification, "agent_failure");
  assert.equal(exhausted.run.trialStarted, true);
});

test("opaque model continuation is never persisted in AgentRun or BuildTrace", async () => {
  const secretReasoning = "PRIVATE_REASONING_SENTINEL";
  const runDirectory = await directory();
  const client = new ScriptedModelClient([
    (request) => ({
      kind: "assistant",
      message: {
        role: "assistant",
        content: "No change required.",
        toolCalls: [],
        continuation: {
          transport: "fake-model",
          payload: [{ role: "assistant", content: secretReasoning }],
          hash: contentHash(secretReasoning),
          bytes: Buffer.byteLength(secretReasoning),
        },
      },
      stopReason: "end_turn",
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      },
      requestHash: contentHash(stableJson(request)),
      responseHash: contentHash(secretReasoning),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: request.model,
        servingProvider: "fake",
        responseId: "private-response",
        latencyMs: 1,
        retryCount: 0,
        finishReason: "stop",
        continuationHash: contentHash(secretReasoning),
        continuationBytes: Buffer.byteLength(secretReasoning),
      },
    }),
  ]);
  const result = await runBoundedAgent({
    creatorSession: CREATOR_SESSION,
    seedRoot: GENERIC_SEED,
    creatorPrompt: CREATOR_PROMPT,
    requirementSet: requirements(),
    runtime: new ForgeNativeAgentRuntime(client),
    model: "fake/model",
    runDirectory,
    traceDirectory: join(runDirectory, "traces"),
  });
  assert.doesNotMatch(stableJson(result.run), new RegExp(secretReasoning));
  assert.doesNotMatch(stableJson(result.trace), new RegExp(secretReasoning));
  assert.equal(
    result.run.modelTurns[0]?.responseFacts?.continuationHash,
    contentHash(secretReasoning),
  );
});

test("workspace requires a plan, safe relative source paths, fresh hashes, and explicit absent creation", async () => {
  const workspace = await CandidateWorkspace.create(SAFE, await directory(), DEFAULT_AGENT_BUDGETS);
  const tools = new BoundedToolHost(workspace, DEFAULT_AGENT_BUDGETS);
  const read = await tools.execute("project.read", {
    path: "src/server/ApplyAction.server.luau",
  });
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/ApplyAction.server.luau",
        precondition: {
          kind: "sha256",
          hash: (read.value as { sourceHash: string }).sourceHash,
        },
        content: "-- blocked",
      })
    ).error?.code,
    "PLAN_REQUIRED",
  );
  assert.equal(
    (await tools.execute("project.read", { path: "../forge.fixture.json" })).error?.code,
    "PATH_FORBIDDEN",
  );
  await tools.execute("plan.update", {
    goal: "Add source",
    steps: [{ id: "create", statement: "Create a file", status: "in_progress" }],
    status: "active",
  });
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/NewModule.luau",
        precondition: { kind: "absent" },
        content: "return true",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/NewModule.luau",
        precondition: { kind: "absent" },
        content: "return false",
      })
    ).error?.code,
    "PATH_ALREADY_EXISTS",
  );
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/missing/New.luau",
        precondition: { kind: "absent" },
        content: "return true",
      })
    ).error?.code,
    "PATH_NOT_REGULAR_DIRECTORY",
  );
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/ApplyAction.server.luau",
        precondition: { kind: "sha256", hash: contentHash("stale") },
        content: "-- stale",
      })
    ).error?.code,
    "STALE_WRITE",
  );
  const outside = await directory();
  await writeFile(join(outside, "Escape.luau"), "return 'outside'", "utf8");
  await symlink(outside, join(workspace.candidateRoot, "src/server/link"), "dir");
  assert.equal(
    (
      await tools.execute("project.read", {
        path: "src/server/link/Escape.luau",
      })
    ).error?.code,
    "PATH_FORBIDDEN",
  );
  assert.equal(
    (
      await tools.execute("workspace.write", {
        path: "src/server/link/New.luau",
        precondition: { kind: "absent" },
        content: "return true",
      })
    ).error?.code,
    "PATH_NOT_REGULAR_DIRECTORY",
  );
});

test("builder orientation withholds benchmark bodies and HarnessConfiguration hashes tool behavior", async () => {
  const workspace = await CandidateWorkspace.create(
    GENERIC_SEED,
    await directory(),
    DEFAULT_AGENT_BUDGETS,
  );
  const map = await workspace.semanticMap();
  const view = resolveRequirementView(requirements(), {
    phase: "build",
    environment: "benchmark",
    audience: "builder",
  });
  const orientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView: view,
    sourceRoots: workspace.sourceRoots,
  });
  assert.doesNotMatch(
    stableJson(orientation),
    /HIDDEN_EXPECTED_VALUE_999|hidden-evaluator-sentinel/,
  );
  assert.deepEqual(orientation.content.sourceRoots, ["src/server"]);
  const sortedOrientation = compileAgentOrientation({
    semanticMap: map,
    projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
    requirementView: view,
    sourceRoots: ["src/shared", "src/server"],
  });
  assert.deepEqual(sortedOrientation.content.sourceRoots, ["src/server", "src/shared"]);
  for (const invalidRoots of [
    ["src/server", "src/server"],
    ["./src/server"],
    ["src//server"],
    ["src/server/"],
    ["src\\server"],
    ["/src/server"],
    ["C:/src/server"],
    ["src/../server"],
  ]) {
    assert.throws(() =>
      compileAgentOrientation({
        semanticMap: map,
        projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash,
        requirementView: view,
        sourceRoots: invalidRoots,
      }),
    );
  }
  const input = {
    systemPrompt: "one",
    tools: [
      { name: "project.read", description: "read", schema: { type: "object" } },
      { name: "project.list", description: "list", schema: { type: "object" } },
    ],
    capabilityPolicy: {
      sourceRoots: ["src"],
      blockedPathPrefixes: [".forge"],
      allowedExtensions: [".lua", ".luau"],
    },
    orientation: {
      policy: orientation.policy,
      contentHash: orientation.contentHash,
    },
    requirementViewHash: contentHash("view"),
    budgets: DEFAULT_AGENT_BUDGETS,
    runtime: { name: "forge-native" },
    model: {
      transport: "fake",
      name: "fake/model",
      transportConfiguration: new ScriptedModelClient([]).descriptor.configuration,
    },
  };
  const first = createHarnessConfiguration(input);
  const second = createHarnessConfiguration(input);
  const changed = createHarnessConfiguration({
    ...input,
    tools: input.tools.map((item, index) =>
      index === 0 ? { ...item, description: "different" } : item,
    ),
  });
  const reordered = createHarnessConfiguration({
    ...input,
    tools: [...input.tools].reverse(),
  });
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, changed.hash);
  assert.notEqual(first.hash, reordered.hash);
  assert.throws(() => assertHarnessConfiguration({ ...first, hash: contentHash("tampered") }));
  assert.throws(() =>
    assertHarnessConfiguration({
      ...first,
      orientation: {
        ...first.orientation,
        policy: "wrong_policy",
      },
    }),
  );
  assert.doesNotThrow(() =>
    createHarnessConfiguration({
      ...input,
      systemPrompt: "A reward, sell action, door, and fruit are ordinary domain words.",
    }),
  );
});

test("generic packages do not import deleted mechanics, adapters, fixtures, or Studio harness registries", async () => {
  const paths = [
    "packages/agent-runtime/src/index.ts",
    "packages/cli/src/index.ts",
    "packages/context-compiler/src/agent-orientation.ts",
    "packages/context-compiler/src/index.ts",
    "packages/experiments/src/index.ts",
    "packages/contracts/src/index.ts",
    "packages/flight-recorder/src/index.ts",
    "packages/luau-toolchain/src/index.ts",
    "packages/model-client/src/contracts.ts",
    "packages/model-client/src/index.ts",
    "packages/proofs/src/index.ts",
    "packages/proofs/src/runtime.ts",
    "packages/semantic-authority/src/index.ts",
    "packages/semantic-map/src/index.ts",
    "packages/studio-bridge/src/index.ts",
    "packages/studio-capabilities/src/index.ts",
    "packages/studio-protocol/src/index.ts",
    "packages/studio-runtime/src/index.ts",
    "packages/verifier/src/index.ts",
  ];
  for (const path of paths) {
    const source = await readFile(resolve(path), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(agent-claude|generation|repair|studio-proof|patch-model|examples|fixtures|HarnessRegistry)[^"']*["']/,
    );
    assert.doesNotMatch(source, /from\s+["'](?:ai|@openrouter\/ai-sdk-provider)["']/);
  }
  const adapter = await readFile(resolve("packages/model-client/src/openrouter-ai-sdk.ts"), "utf8");
  assert.match(adapter, /from "ai"/);
  assert.match(adapter, /from "@openrouter\/ai-sdk-provider"/);
});
