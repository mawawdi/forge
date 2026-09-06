import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentExecutionJournalStore,
  ForgeNativeAgentRuntime,
  DEFAULT_AGENT_BUDGETS,
  agentExecutionJournalIdForAgentRun,
  persistCreatorPhaseAgentRun,
  type AgentToolHost,
  type ToolResult,
} from "../../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../../packages/contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../../packages/artifact-store/src/index.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
} from "../../packages/model-client/src/contracts.js";
import {
  createCreatorApproval,
  createCreatorPlan,
  createCreatorSession,
  createCreatorBuildContract,
  createStudioOwnershipMap,
  creatorOrientation,
  type CreatorProjectIndexView,
} from "../../packages/creator-session/src/index.js";
import { creatorBuildRecoveryBinding } from "../../packages/creator-session/src/build-recovery.js";
import { compileGamePlan } from "../../packages/game-compiler/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  SourceConsultationRecorder,
} from "../../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./source-fixtures.js";

export function creatorBuildRecoveryFixture(options: { sourceSlots?: number } = {}) {
  const prompt = "Retain consulted API evidence during a bounded build.";
  const revisionHash = contentHash("builder-cache-revision");
  const captureHash = contentHash("builder-cache-capture");
  const projectIndex: CreatorProjectIndexView = {
    project: { name: "Builder memory", placeId: 0, universeId: 0 },
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "builder-cache",
    revisionHash,
    projectIndex,
  });
  const session = createCreatorSession({
    projectId: ownership.projectId,
    prompt,
    revisionHash,
    projectCaptureHash: captureHash,
    ownership,
  });
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: captureHash, documents: [] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("config"),
      pinnedToolchainProof: {
        hash: contentHash("proof"),
        lockHash: contentHash("lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("map"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const sourceResolver = createTestFixtureSourceResolver([]);
  const sourceConsultation = new SourceConsultationRecorder(sourceIndex, sourceResolver).seal();
  const change = {
    id: "folder",
    kind: "create" as const,
    path: "Workspace/Folder",
    className: "Folder" as const,
    initialization: "initial_properties" as const,
    parent: { kind: "engine_container" as const, path: "Workspace", className: "Workspace" },
  };
  const compiled = compileGamePlan({
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "cache",
      intent: prompt,
      components: [
        {
          kind: "native_graph",
          id: "container",
          graph: {
            kind: "studio_objects",
            operations: [
              {
                id: "folder",
                kind: "create",
                className: "Folder",
                parent: { kind: "engine", id: "Workspace" },
                name: "Folder",
                properties: [],
                valueSlots: [],
                attributes: [],
                removedAttributes: [],
                dependencies: [],
              },
            ],
          },
          ports: [],
          obligations: [],
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
    projectId: ownership.projectId,
    project: projectIndex.project,
    sessionId: session.id,
    observedRevisionHash: revisionHash,
    initialTopology: projectIndex.instances,
    inventory: [
      {
        id: change.id,
        componentId: "container",
        change,
        lockedProperties: {},
        valueSlots: [],
        attributes: {},
        removedAttributes: [],
        dependencies: [],
      },
      ...Array.from({ length: options.sourceSlots ?? 0 }, (_, index) => ({
        id: "source-" + index,
        componentId: "container",
        lockedProperties: {},
        valueSlots: [],
        attributes: {},
        removedAttributes: [],
        dependencies: [],
        change: {
          id: "source-" + index,
          kind: "create" as const,
          path: "Workspace/Module" + index,
          parent: { kind: "engine_container" as const, path: "Workspace", className: "Workspace" },
          className: "ModuleScript" as const,
          initialization: "inline_source_required" as const,
        },
        source: {
          fileId: "source-" + index,
          content: { kind: "slot" as const, maximumUtf8Bytes: 4096 },
        },
      })),
    ],
  });
  const plan = createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorPrompt: prompt,
      projectRevisionHash: revisionHash,
      projectCaptureHash: captureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      sourceIndex,
      sourceConsultation,
      compiled,
      changes: compiled.inventory.map((item) => item.change),
      inspectionPaths: [],
      steps: [
        {
          id: "container",
          statement: "Create the container and declared sources.",
          changeIds: compiled.inventory.map((item) => item.id),
        },
      ],
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/Folder",
            expectedClass: "Folder",
          },
          ...Array.from({ length: options.sourceSlots ?? 0 }, (_, index) => ({
            id: "source-exists-" + index,
            kind: "studio_check" as const,
            check: "instance_exists" as const,
            path: "Workspace/Module" + index,
            expectedClass: "ModuleScript" as const,
          })),
        ],
      },
    },
    projectIndex,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-05T12:00:00.000Z",
  });
  const contract = createCreatorBuildContract({
    session,
    plan,
    planApproval: approval,
    ownership,
    projectIndex,
  });
  return {
    session,
    plan,
    approval,
    contract,
    ownership,
    projectIndex,
    sourceIndex,
    sourceResolver,
    sourceConsultation,
    prompt,
    expected: creatorBuildRecoveryBinding({ session, plan, approval, contract }),
  };
}

export function recoveryToolResult(value: unknown, ok = true): ToolResult {
  const serialized = stableJson(value);
  return {
    ok,
    ...(ok ? { value } : { error: value as { code: string; message: string } }),
    truncated: false,
    resultHash: contentHash(serialized),
    bytes: Buffer.byteLength(serialized),
  };
}
export interface RecoveryTestStep {
  name: string;
  input: unknown;
  result: ToolResult;
  rejected?: boolean;
  changesState?: boolean;
}
export const RECOVERY_MODEL_DESCRIPTOR: ModelClient["descriptor"] = {
  transport: "offline-recovery-fixture",
  configuration: {
    aiSdk: { package: "none" },
    providerAdapter: { package: "none" },
    routing: {
      modelRegistryHash: contentHash("fixture-model"),
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
      toolBatchExecution: "host_validated_then_sequential",
      toolNameEncoding: "openai_function_slug",
      maxRetries: 0,
      telemetry: false,
      timeoutPolicy: "bounded_turn_and_remaining_runtime_budget",
      maxDurationMsPerTurn: 1_200_000,
      maxOutputTokensPerTurn: 4096,
      maxOutputTokensByModel: {},
      outputTokenLimitCatalogHash: null,
      inputModalitiesByModel: {},
      inputModalityCatalogHash: null,
    },
    continuation: { maxBytes: 256 * 1024 },
  },
};
/** All responses are fixed test data. There are no external provider or Studio calls. */
export async function writeRecoveryTestRun(
  directory: string,
  authority: ReturnType<typeof creatorBuildRecoveryFixture>,
  steps: RecoveryTestStep[],
  options: { initialState?: number; rejectedRun?: boolean } = {},
) {
  const store = new ImmutableJsonArtifactStore(directory);
  const journals = new AgentExecutionJournalStore(store);
  const agentRunId = "agent_run_" + randomUUID();
  const journalId = agentExecutionJournalIdForAgentRun(agentRunId);
  let turn = 0;
  let state = options.initialState ?? 0;
  const host: AgentToolHost = {
    definitions: () =>
      [...new Set(steps.map((step) => step.name))].map((name) => ({
        name,
        description: "Offline staged outcome",
        inputShape: {},
        schema: { type: "object", additionalProperties: true },
      })),
    validateBatch: (calls) => ({
      valid: !steps[turn - 1]!.rejected,
      budgetExhausted: false,
      feedback: steps[turn - 1]!.rejected
        ? calls.map((call) => ({ id: call.id, name: call.name, result: steps[turn - 1]!.result }))
        : [],
    }),
    execute: async () => {
      const step = steps[turn - 1]!;
      if (step.changesState) state++;
      return step.result;
    },
    progressToken: () => contentHash(String(state)),
    completionStatus: () => ({
      ready: false,
      code: "STILL_BUILDING",
      message: "Fixture stops with a provider error.",
    }),
  };
  const client: ModelClient = {
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
      const step = steps[turn++];
      if (!step) throw new Error("Offline simulated provider outage");
      const toolCalls = [{ id: "call-" + turn, name: step.name, arguments: step.input }];
      return {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls },
        stopReason: "tool_calls",
        usage: {
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
        },
        requestHash: contentHash(stableJson({ turn, messages: request.messages })),
        responseHash: contentHash(stableJson(toolCalls)),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "offline",
          responseId: "fixture-" + turn,
          latencyMs: 1,
          retryCount: 0,
          finishReason: "tool-calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const runtime = new ForgeNativeAgentRuntime(client);
  const orientation = creatorOrientation(authority);
  const budgets = { ...DEFAULT_AGENT_BUDGETS, maxTurns: Math.max(steps.length + 2, 4) };
  const runtimeResult = await runtime.run({
    systemPrompt: "Offline recovery fixture",
    prompt: authority.prompt,
    model: "fake/model",
    orientation,
    tools: host,
    budgets,
    executionJournal: journals.sink(journalId),
  });
  const phase = await persistCreatorPhaseAgentRun({
    agentRunId,
    phase: "creator_builder",
    creatorSession: authority.session,
    promptHash: authority.expected.promptHash,
    projectId: authority.expected.projectId,
    revisionHash: authority.expected.revisionHash,
    orientation,
    systemPrompt: "Offline recovery fixture",
    runtime,
    runtimeResult,
    model: "fake/model",
    toolHost: host,
    budgets,
    directory,
    traceDirectory: join(directory, "traces"),
    finalization: {
      status: "unsealed",
      intendedArtifactKind: "game_build_graph",
      failureStage: "runtime",
      failureKind: "model",
      failureCode: "OFFLINE_FAILURE",
      detail: "Offline simulated provider outage",
    },
    executionWorker: {
      kind: "CreatorAgentWorkerDescriptor",
      name: "forge-local-creator-agent-worker",
      environment: "local_process",
      isolation: "none",
    },
    executionJournal: await journals.load(journalId),
    creatorBuildContract: authority.expected.buildContract,
  });
  const run = options.rejectedRun ? { ...phase.run, status: "rejected" as const } : phase.run;
  const priorRun = await store.write(run);
  return { store, priorRun, run, runtimeResult, journals };
}
