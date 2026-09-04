import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentExecutionJournalStore,
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  assertAgentRun,
  createAgentExecutionSlot,
  createRequestIntentCheckpoint,
  verifyAgentRunExecutionJournal,
  type AgentExecutionBoundaryState,
  type AgentRuntime,
} from "../packages/agent-runtime/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import { LocalCreatorAgentWorker } from "../packages/creator-session/src/worker.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import { createPinnedLuauLspSourceIndex } from "../packages/source-intelligence/src/index.js";

const MODEL = "fake/model";
const PROMPT = "Explain the current project.";
const REVISION_HASH = contentHash("creator-worker-test-revision");
const PROJECT_CAPTURE_HASH = contentHash("creator-worker-test-project-capture");
const PROJECT_INDEX: CreatorProjectIndexView = {
  project: { name: "WorkerSeam", placeId: 0, universeId: 0 },
  revision: { hash: REVISION_HASH } as CreatorProjectIndexView["revision"],
  instances: [
    {
      objectId: "forge_attribute:workspace",
      identity: { kind: "forge_attribute", stableId: "workspace" },
      path: "Workspace",
      name: "Workspace",
      engineContainer: { path: "Workspace", className: "Workspace" },
      className: "Workspace",
      properties: {},
      attributes: {},
      tags: [],
    },
  ],
  scripts: [],
};
const OWNERSHIP = createStudioOwnershipMap({
  projectId: "project_creator_worker",
  revisionHash: REVISION_HASH,
  projectIndex: PROJECT_INDEX,
});
const SESSION = createCreatorSession({
  id: "creator_session_worker_seam",
  prompt: PROMPT,
  projectId: OWNERSHIP.projectId,
  revisionHash: REVISION_HASH,
  projectCaptureHash: PROJECT_CAPTURE_HASH,
  ownership: OWNERSHIP,
  model: MODEL,
  now: new Date("2026-09-03T00:00:00.000Z"),
});
const SOURCE_INDEX = createPinnedLuauLspSourceIndex(
  { snapshotHash: PROJECT_CAPTURE_HASH, documents: [] },
  { symbols: [], references: [] },
  {
    analysisConfigHash: contentHash("creator-worker-test-analysis-config"),
    pinnedToolchainProof: {
      hash: contentHash("creator-worker-test-toolchain-proof"),
      lockHash: contentHash("creator-worker-test-toolchain-lock"),
      platform: "test",
    },
    sourcemapHash: contentHash("creator-worker-test-sourcemap"),
  },
  { maximumStaticDependencyRows: 1_024 },
);
const SOURCE_RESOLVER = createTestFixtureSourceResolver([]);

function descriptor(): ModelClient["descriptor"] {
  return {
    transport: "creator-worker-test",
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
        timeoutPolicy: "bounded_turn_and_remaining_runtime_budget",
        maxDurationMsPerTurn: 1_200_000,
        maxOutputTokensPerTurn: 4_096,
      },
      continuation: { maxBytes: 256 * 1_024 },
    },
  };
}

class ForbiddenRuntime implements AgentRuntime {
  readonly identity = { name: "forbidden-creator-worker-test-runtime" };
  readonly modelClientDescriptor = descriptor();
  calls = 0;

  async run(): Promise<never> {
    this.calls += 1;
    throw new Error("Worker crossed a rejected dispatch seam");
  }
}

class AnsweringModelClient implements ModelClient {
  readonly descriptor = descriptor();
  calls = 0;
  readonly requests: ModelTurnRequest[] = [];

  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    const toolCalls =
      this.calls === 1
        ? [
            {
              id: "answer-current-project",
              name: "creator.answer",
              arguments: { text: "The current project contains Workspace.", citationHandles: [] },
            },
          ]
        : [];
    if (this.calls > 2) throw new Error("Unexpected model turn");
    return {
      kind: "assistant",
      message: {
        role: "assistant",
        content: this.calls === 2 ? "Done." : "",
        toolCalls,
      },
      stopReason: toolCalls.length > 0 ? "tool_calls" : "end_turn",
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      },
      requestHash: contentHash(stableJson(request)),
      responseHash: contentHash(stableJson({ sequence: this.calls, toolCalls })),
      responseFacts: {
        requestedModel: request.model,
        resolvedModel: request.model,
        servingProvider: "test-provider",
        responseId: `response-${this.calls}`,
        latencyMs: 1,
        retryCount: 0,
        finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
        continuationHash: null,
        continuationBytes: null,
      },
    };
  }
}

function plannerInput(execution: ReturnType<typeof createAgentExecutionSlot>) {
  return {
    session: SESSION,
    ownership: OWNERSHIP,
    projectIndex: PROJECT_INDEX,
    sourceIndex: SOURCE_INDEX,
    sourceResolver: SOURCE_RESOLVER,
    creatorPrompt: PROMPT,
    agentPrompt: `Host-authored conversation context.\n\nExact creator request: ${PROMPT}`,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution,
  };
}

function emptyBoundaryState(): AgentExecutionBoundaryState {
  return {
    runtimeStartedAt: "2026-09-03T00:00:00.000Z",
    usage: {
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    trialStarted: false,
    remaining: {
      turns: DEFAULT_AGENT_BUDGETS.maxTurns,
      toolCalls: DEFAULT_AGENT_BUDGETS.maxToolCalls,
      toolResultBytes: DEFAULT_AGENT_BUDGETS.maxToolResultBytes,
      durationMs: DEFAULT_AGENT_BUDGETS.maxDurationMs,
      inputTokens: DEFAULT_AGENT_BUDGETS.maxInputTokens,
      outputTokens: DEFAULT_AGENT_BUDGETS.maxOutputTokens,
      budgetUsd: DEFAULT_AGENT_BUDGETS.maxBudgetUsd,
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

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-creator-worker-"));
}

test("creator worker rejects a purpose mismatch before provider dispatch", async () => {
  const root = await temporaryDirectory();
  const runtime = new ForbiddenRuntime();
  const worker = new LocalCreatorAgentWorker(runtime, root);
  try {
    await assert.rejects(
      worker.plan(
        plannerInput(
          createAgentExecutionSlot({
            purpose: "builder",
            ordinal: 1,
            agentRunId: "agent_run_wrong_planner_purpose",
          }),
        ),
      ),
      /expected a planner execution slot, received builder/,
    );
    await assert.rejects(
      worker.build({
        verificationFeedback: ["Retry the failed verification."],
        execution: createAgentExecutionSlot({
          purpose: "builder",
          ordinal: 2,
          agentRunId: "agent_run_wrong_repair_purpose",
        }),
      } as unknown as Parameters<LocalCreatorAgentWorker["build"]>[0]),
      /expected a repair execution slot, received builder/,
    );
    assert.equal(runtime.calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creator worker rejects a preexisting execution journal before provider dispatch", async () => {
  const root = await temporaryDirectory();
  const runtime = new ForbiddenRuntime();
  const worker = new LocalCreatorAgentWorker(runtime, root);
  const execution = createAgentExecutionSlot({
    purpose: "planner",
    ordinal: 1,
    agentRunId: "agent_run_preexisting_worker_journal",
  });
  const request: ModelTurnRequest = {
    model: MODEL,
    system: "test",
    messages: [{ role: "user", content: PROMPT }],
    tools: [],
    maxOutputTokens: 100,
    timeoutMs: 1_000,
  };
  try {
    await new AgentExecutionJournalStore(root).append(
      execution.journalId,
      createRequestIntentCheckpoint(1, "2026-09-03T00:00:00.000Z", request, emptyBoundaryState()),
    );
    await assert.rejects(
      worker.plan(plannerInput(execution)),
      /Preassigned creator execution journal was already dispatched/,
    );
    assert.equal(runtime.calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creator worker persists the supplied AgentRun identity and its exact journal binding", async () => {
  const root = await temporaryDirectory();
  const client = new AnsweringModelClient();
  const worker = new LocalCreatorAgentWorker(new ForgeNativeAgentRuntime(client), root);
  const execution = createAgentExecutionSlot({
    purpose: "planner",
    ordinal: 1,
    agentRunId: "agent_run_supplied_worker_identity",
  });
  try {
    const result = await worker.plan(plannerInput(execution));
    assert.equal(result.status, "sealed");
    assert.equal(result.evidence.agentRunId, execution.agentRunId);
    assert.equal(client.calls, 1, "Publishing an answer must not buy another response");
    const firstUserMessage = client.requests[0]?.messages[0]?.content;
    assert.match(client.requests[0]!.system, /creator-facing prose in GitHub-flavored Markdown/);
    assert.match(client.requests[0]!.system, /tool arguments remain exact schema-valid JSON/);
    assert.equal(typeof firstUserMessage, "string");
    assert.ok(
      firstUserMessage!.startsWith(
        `Host-authored conversation context.\n\nExact creator request: ${PROMPT}\n\n<forge_project_orientation>`,
      ),
    );
    assert.equal(firstUserMessage!.split(PROMPT).length - 1, 1);

    const artifactStore = new ImmutableJsonArtifactStore(root);
    const persistedRun = await artifactStore.read(result.evidence.agentRun);
    assertAgentRun(persistedRun);
    assert.equal(persistedRun.id, execution.agentRunId);
    assert.equal(persistedRun.executionJournal?.journalId, execution.journalId);

    const journal = await new AgentExecutionJournalStore(artifactStore).load(execution.journalId);
    assert.equal(persistedRun.executionJournal?.sequence, journal.head.sequence);
    assert.equal(persistedRun.executionJournal?.entryHash, journal.head.entryHash);
    assert.deepEqual(persistedRun.executionJournal?.entry, journal.head.entry);
    assert.equal(journal.entries.at(-1)?.checkpoint.checkpointType, "terminal");
    await verifyAgentRunExecutionJournal(persistedRun, artifactStore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
