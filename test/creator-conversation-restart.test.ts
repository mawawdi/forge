import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentExecutionJournalStore,
  createBatchValidatedCheckpoint,
  createRequestIntentCheckpoint,
  createResponseReceivedCheckpoint,
  createToolExecutionIntentCheckpoint,
  type AgentExecutionBoundaryState,
} from "../packages/agent-runtime/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import type { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  CreatorConversationStore,
  creatorWorkRequestHash,
  sealCreatorConversationEvent,
  sealCreatorConversationTurn,
  sealCreatorProjectConversation,
  sealCreatorTurnContract,
  sealCreatorWorkJob,
  type CreatorActionRequest,
} from "../packages/creator-conversation/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CREATOR_MODEL_IDS,
  parseOpenRouterModelCatalog,
  unconfirmedCreatorModelCatalog,
} from "../packages/model-client/src/model-registry.js";
import type {
  StudioBridgeConnection,
  StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import { createStudioProjectIdentityState } from "../packages/studio-protocol/src/index.js";

const NOW = "2026-09-03T15:00:00.000Z";
const MODEL = "openai/gpt-5.6-luna";
const CONVERSATION_ID = "creator_conversation_restart_resume";
const PROJECT_ID = "forge_project_0123456789abcdef0123456789abcdef";

test("restart never dispatches interrupted agent work and exposes one exact creator-authorized resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-restart-"));
  let starts = 0;
  const abandoned: string[] = [];
  try {
    await seedQueuedAgentJob(directory);
    const paired = pairedStudio();
    const transaction = {
      subscribe: () => () => undefined,
      pairedStudio: () => paired,
      dashboardState: async () => ({
        kind: "CreatorTransactionState",
        sessions: [],
        stages: [],
        pairedStudio: {
          status: "paired",
          projectId: paired.projectId,
          projectName: paired.project.name,
          transactionInventoryStatus: "clear",
          message: "Studio is paired.",
        },
        serverTime: NOW,
      }),
      abandonInterruptedConversationCandidate: async (sessionId: string) => {
        abandoned.push(sessionId);
      },
      action: async () => {
        starts += 1;
        throw new Error("injected provider boundary after explicit resume");
      },
    } as unknown as CreatorSessionCoordinator;
    const connection = {
      send: async () => undefined,
      sendAndWaitForSettlement: async () => undefined,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection;
    const coordinator = new CreatorConversationCoordinator({
      transaction,
      connection,
      directory,
      defaultModelId: MODEL,
      modelCatalog: availableCreatorModelCatalog(),
      now: () => new Date(NOW),
    });

    await coordinator.initialize();
    assert.equal(starts, 0, "restart must not dispatch provider work");
    const state = await coordinator.dashboardState(CONVERSATION_ID);
    const resume = state.controlView?.actions.find((action) => action.actionId === "resume_work");
    assert.ok(resume);
    assert.equal(state.controlView?.turnContract, undefined);
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: resume.actionInstanceId,
      idempotencyKey: "restart_resume_action_0001",
    };
    const admission = await coordinator.submitAction(request);
    assert.equal(starts, 0, "admission must return before foreground dispatch");
    await waitFor(() => starts === 1);
    await waitFor(async () => {
      const current = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
      const resumed = current.jobs.find((job) => job.id === admission.jobId);
      return resumed?.status === "failed" && resumed.providerOutcome === "never_dispatched";
    });
    assert.deepEqual(abandoned, ["creator_session_interrupted_before_dispatch"]);
    const replay = await coordinator.submitAction(request);
    assert.equal(replay.jobId, admission.jobId);
    assert.equal(starts, 1, "idempotent admission must not dispatch twice");
    await coordinator.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart preserves resumable work when its exact model is not confirmed available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-restart-model-"));
  let starts = 0;
  try {
    await seedQueuedAgentJob(directory);
    const paired = pairedStudio();
    const transaction = {
      subscribe: () => () => undefined,
      pairedStudio: () => paired,
      dashboardState: async () => ({
        kind: "CreatorTransactionState",
        sessions: [],
        stages: [],
        pairedStudio: {
          status: "paired",
          projectId: paired.projectId,
          projectName: paired.project.name,
          transactionInventoryStatus: "clear",
          message: "Studio is paired.",
        },
        serverTime: NOW,
      }),
      action: async () => {
        starts += 1;
        throw new Error("unavailable model must never dispatch");
      },
    } as unknown as CreatorSessionCoordinator;
    const connection = {
      send: async () => undefined,
      sendAndWaitForSettlement: async () => undefined,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection;
    const coordinator = new CreatorConversationCoordinator({
      transaction,
      connection,
      directory,
      defaultModelId: MODEL,
      modelCatalog: unconfirmedCreatorModelCatalog(NOW, "catalog_request_failed"),
      now: () => new Date(NOW),
    });

    await coordinator.initialize();
    const state = await coordinator.dashboardState(CONVERSATION_ID);
    const resume = state.controlView?.actions.find((action) => action.actionId === "resume_work");
    assert.ok(resume);
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: resume.actionInstanceId,
      idempotencyKey: "restart_unavailable_model_0001",
    };
    const store = new CreatorConversationStore(directory);
    const before = await store.load(CONVERSATION_ID);
    await assert.rejects(coordinator.submitAction(request), /unavailable.*catalog_request_failed/i);
    const after = await store.load(CONVERSATION_ID);
    assert.equal(after.head.commitHash, before.head.commitHash);
    assert.equal(starts, 0);
    assert.ok(after.jobs.some((job) => job.failure?.code === "control_process_interrupted"));
    await coordinator.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creator-authorized response resume retains the exact session and journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-response-resume-"));
  const actions: unknown[] = [];
  const abandoned: string[] = [];
  try {
    await seedResponseReadyAgentJob(directory);
    const paired = pairedStudio();
    const transaction = {
      subscribe: () => () => undefined,
      pairedStudio: () => paired,
      dashboardState: async () => transactionDashboardState(paired),
      abandonInterruptedConversationCandidate: async (sessionId: string) => {
        abandoned.push(sessionId);
      },
      action: async (input: unknown) => {
        actions.push(structuredClone(input));
        throw new Error("test stops after creator-authorized lower response resume");
      },
    } as unknown as CreatorSessionCoordinator;
    const coordinator = new CreatorConversationCoordinator({
      transaction,
      connection: testConnection(),
      directory,
      defaultModelId: MODEL,
      modelCatalog: availableCreatorModelCatalog(),
      now: () => new Date(NOW),
    });

    await coordinator.initialize();
    const before = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const interrupted = before.jobs.at(-1);
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.providerOutcome, "response_persisted");
    assert.equal(interrupted?.transactionSessionId, "creator_session_interrupted_before_dispatch");
    assert.equal(interrupted?.agentExecutions.length, 1);
    assert.ok(interrupted?.conversationContext);
    assert.equal(interrupted?.failure?.code, "agent_execution_response_ready");
    const state = await coordinator.dashboardState(CONVERSATION_ID);
    const resume = state.controlView?.actions.find((action) => action.actionId === "resume_work");
    assert.ok(resume);
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: resume.actionInstanceId,
      idempotencyKey: "restart_response_resume_action_0001",
    };
    await coordinator.submitAction(request);
    await waitFor(() => actions.length === 1);
    assert.deepEqual(actions[0], {
      action: "resume",
      creatorSessionId: "creator_session_interrupted_before_dispatch",
      agentExecutions: interrupted?.agentExecutions,
    });
    assert.deepEqual(abandoned, []);
    const after = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const resumed = after.jobs.at(-1);
    assert.equal(resumed?.providerOutcome, "response_persisted");
    assert.equal(resumed?.failure?.code, "agent_execution_response_ready");
    await coordinator.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tool execution intent without completion remains retry_work, never resume_work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-tool-intent-restart-"));
  let actions = 0;
  try {
    await seedToolIntentAgentJob(directory);
    const paired = pairedStudio();
    const transaction = {
      subscribe: () => () => undefined,
      pairedStudio: () => paired,
      dashboardState: async () => transactionDashboardState(paired),
      action: async () => {
        actions += 1;
        throw new Error("a tool outcome-unknown restart cannot dispatch");
      },
    } as unknown as CreatorSessionCoordinator;
    const coordinator = new CreatorConversationCoordinator({
      transaction,
      connection: testConnection(),
      directory,
      defaultModelId: MODEL,
      modelCatalog: availableCreatorModelCatalog(),
      now: () => new Date(NOW),
    });

    await coordinator.initialize();
    assert.equal(actions, 0);
    const persisted = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const interrupted = persisted.jobs.at(-1);
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.failure?.code, "agent_execution_boundary_not_resumable");
    const state = await coordinator.dashboardState(CONVERSATION_ID);
    assert.equal(
      state.controlView?.actions.some((action) => action.actionId === "resume_work"),
      false,
    );
    assert.ok(state.controlView?.actions.some((action) => action.actionId === "retry_work"));
    await coordinator.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation storage rejects a same-journal resume whose session binding is tampered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-response-tamper-"));
  try {
    await seedResponseReadyAgentJob(directory);
    const paired = pairedStudio();
    const transaction = {
      subscribe: () => () => undefined,
      pairedStudio: () => paired,
      dashboardState: async () => transactionDashboardState(paired),
      action: async () => {
        throw new Error("test stops after durable admission");
      },
    } as unknown as CreatorSessionCoordinator;
    const coordinator = new CreatorConversationCoordinator({
      transaction,
      connection: testConnection(),
      directory,
      defaultModelId: MODEL,
      modelCatalog: availableCreatorModelCatalog(),
      now: () => new Date(NOW),
    });
    await coordinator.initialize();
    const state = await coordinator.dashboardState(CONVERSATION_ID);
    const resume = state.controlView!.actions.find((action) => action.actionId === "resume_work")!;
    await coordinator.submitAction({
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: resume.actionInstanceId,
      idempotencyKey: "response-resume-tamper-admission-0001",
    });
    await waitFor(
      async () =>
        (await new CreatorConversationStore(directory).load(CONVERSATION_ID)).jobs.length === 2,
    );
    const store = new CreatorConversationStore(directory);
    const loaded = await store.load(CONVERSATION_ID);
    const [prior, validResume] = loaded.jobs;
    assert.ok(prior);
    assert.ok(validResume);
    const tamperedRequest: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: resume.actionInstanceId,
      idempotencyKey: "response-resume-tamper-chain-0001",
    };
    const admittedRequest = await store.artifactStore.write(tamperedRequest);
    const tampered = sealCreatorWorkJob({
      ...withoutHash(validResume),
      id: "creator_job_response_resume_tampered",
      idempotencyKey: tamperedRequest.idempotencyKey,
      requestHash: creatorWorkRequestHash(tamperedRequest),
      admittedRequest,
      transactionSessionId: "creator_session_tampered",
      resumesJob: { id: prior.id, hash: prior.hash },
      status: "queued",
      phase: "resume_work",
      providerOutcome: "response_persisted",
      createdAt: "2026-09-03T15:00:10.000Z",
      updatedAt: "2026-09-03T15:00:10.000Z",
    });
    const tamperedReference = await store.artifactStore.write(tampered);
    const conversation = sealCreatorProjectConversation({
      ...withoutHash(loaded.conversation),
      latestEventSequence: loaded.conversation.latestEventSequence + 1,
      updatedAt: "2026-09-03T15:00:10.000Z",
    });
    const event = sealCreatorConversationEvent({
      id: "creator_event_response_resume_tampered",
      conversationId: CONVERSATION_ID,
      sequence: conversation.latestEventSequence,
      occurredAt: "2026-09-03T15:00:10.000Z",
      authority: "creator",
      attachments: [],
      eventType: "decision",
      data: {
        actionInstanceId: resume.actionInstanceId,
        decision: "resume_work",
        job: { id: tampered.id, hash: tampered.hash, artifact: tamperedReference },
      },
    });
    await assert.rejects(
      store.append({ conversation, event, job: tampered }),
      /execution identity|response boundary/i,
    );
    assert.equal((await store.load(CONVERSATION_ID)).head.commitHash, loaded.head.commitHash);
    await coordinator.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function seedQueuedAgentJob(directory: string): Promise<void> {
  const store = new CreatorConversationStore(directory);
  const contract = sealCreatorTurnContract({
    id: "creator_turn_contract_restart_resume",
    conversationId: CONVERSATION_ID,
    allowedTurnTypes: ["new_work"],
    modelRegistryHash: "a".repeat(64),
    minimumBytes: 1,
    maximumBytes: 65_536,
    issuedAt: NOW,
  });
  const request = {
    kind: "CreatorTurnRequest",
    conversationId: CONVERSATION_ID,
    turnContractId: contract.id,
    turnContractHash: contract.hash,
    turnKind: "new_work",
    text: "Inspect this project and propose a safe change.",
    selectedModelId: MODEL,
    idempotencyKey: "restart_original_turn_0001",
  } as const;
  const turn = sealCreatorConversationTurn({
    id: "creator_turn_restart_resume",
    conversationId: CONVERSATION_ID,
    role: "creator",
    turnType: "new_work",
    text: request.text,
    selectedModelId: MODEL,
    createdAt: NOW,
  });
  const turnArtifact = await store.artifactStore.write(turn);
  const firstConversation = sealCreatorProjectConversation({
    id: CONVERSATION_ID,
    project: { kind: "local_linked", forgeProjectId: PROJECT_ID },
    title: "Restart Resume",
    createdAt: NOW,
    updatedAt: NOW,
    latestEventSequence: 1,
    episodeIds: [],
    memoryHeads: [],
  });
  const firstEvent = sealCreatorConversationEvent({
    id: "creator_event_restart_resume_turn",
    conversationId: CONVERSATION_ID,
    sequence: 1,
    occurredAt: NOW,
    authority: "creator",
    attachments: [],
    eventType: "creator_turn",
    data: {
      turn: { id: turn.id, hash: turn.hash, artifact: turnArtifact },
      turnType: "new_work",
      text: turn.text,
      selectedModelId: MODEL,
    },
  });
  await store.append({ conversation: firstConversation, event: firstEvent, turn });

  const admittedRequest = await store.artifactStore.write(request);
  const admissionAuthority = await store.artifactStore.write(contract);
  const conversationContext = await store.artifactStore.write({
    kind: "CreatorConversationContext",
    conversationId: CONVERSATION_ID,
    includedMemories: [],
    includedTurns: [],
    includedDecisions: [],
    budget: { maximumBytes: 131_072, materializedBytes: 2 },
  });
  const job = sealCreatorWorkJob({
    id: "creator_job_interrupted_before_dispatch",
    conversationId: CONVERSATION_ID,
    turnId: turn.id,
    idempotencyKey: request.idempotencyKey,
    requestHash: creatorWorkRequestHash(request),
    admittedRequest,
    admissionAuthority,
    conversationContext,
    transactionSessionId: "creator_session_interrupted_before_dispatch",
    agentExecutions: [
      {
        purpose: "planner",
        ordinal: 1,
        agentRunId: "agent_run_interrupted_before_dispatch",
        journalId: "agent_execution_journal:agent_run_interrupted_before_dispatch",
      },
    ],
    jobType: "agent_turn",
    status: "queued",
    phase: "admitted",
    providerOutcome: "never_dispatched",
    selectedModelId: MODEL,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const jobArtifact = await store.artifactStore.write(job);
  const secondConversation = sealCreatorProjectConversation({
    ...withoutHash(firstConversation),
    latestEventSequence: 2,
  });
  const secondEvent = sealCreatorConversationEvent({
    id: "creator_event_restart_resume_job",
    conversationId: CONVERSATION_ID,
    sequence: 2,
    occurredAt: NOW,
    authority: "forge",
    attachments: [],
    eventType: "job",
    data: {
      job: { id: job.id, hash: job.hash, artifact: jobArtifact },
      status: "queued",
      message: "Work was admitted before the creator service stopped.",
    },
  });
  await store.append({ conversation: secondConversation, event: secondEvent, job });
}

async function seedResponseReadyAgentJob(directory: string): Promise<void> {
  await seedQueuedAgentJob(directory);
  const store = new CreatorConversationStore(directory);
  const journalStore = new AgentExecutionJournalStore(store.artifactStore);
  const request = {
    model: MODEL,
    system: "durable planner system",
    messages: [{ role: "user" as const, content: "durable planner prompt" }],
    tools: [],
    maxOutputTokens: 100,
    timeoutMs: 1_000,
  };
  const initial = journalState({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const intent = createRequestIntentCheckpoint(1, NOW, request, initial);
  const journalId = "agent_execution_journal:agent_run_interrupted_before_dispatch";
  await journalStore.append(journalId, intent);
  const responseHash = contentHash("creator-response-ready");
  const facts = {
    requestedModel: MODEL,
    resolvedModel: MODEL,
    servingProvider: "test-provider",
    responseId: "response-ready-1",
    latencyMs: 1,
    retryCount: 0 as const,
    finishReason: "end_turn",
    continuationHash: null,
    continuationBytes: null,
  };
  await journalStore.append(
    journalId,
    createResponseReceivedCheckpoint({
      turnSequence: 1,
      occurredAt: "2026-09-03T15:00:01.000Z",
      intentHash: intent.intentHash,
      result: {
        kind: "assistant",
        message: { role: "assistant", content: "Durable response", toolCalls: [] },
        stopReason: "end_turn",
        requestHash: contentHash(stableJson(request)),
        responseHash,
        responseFacts: facts,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
      state: {
        ...journalState({ turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.001 }),
        trialStarted: true,
      },
      turn: {
        sequence: 1,
        startedAt: NOW,
        endedAt: "2026-09-03T15:00:01.000Z",
        durationMs: 1_000,
        requestHash: contentHash(stableJson(request)),
        resultKind: "assistant",
        responseHash,
        stopReason: "end_turn",
        responseFacts: facts,
        toolCallIds: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
    }),
  );
}

async function seedToolIntentAgentJob(directory: string): Promise<void> {
  await seedQueuedAgentJob(directory);
  const store = new CreatorConversationStore(directory);
  const journalStore = new AgentExecutionJournalStore(store.artifactStore);
  const request = {
    model: MODEL,
    system: "durable planner system",
    messages: [{ role: "user" as const, content: "durable planner prompt" }],
    tools: [
      {
        name: "forge.inspect",
        description: "Inspect the durable project state.",
        parameters: { type: "object" },
      },
    ],
    maxOutputTokens: 100,
    timeoutMs: 1_000,
  };
  const initial = journalState({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const intent = createRequestIntentCheckpoint(1, NOW, request, initial);
  const journalId = "agent_execution_journal:agent_run_interrupted_before_dispatch";
  const call = { id: "call_tool_intent", name: "forge.inspect", arguments: {} };
  const responseHash = contentHash("creator-tool-intent-response");
  const facts = {
    requestedModel: MODEL,
    resolvedModel: MODEL,
    servingProvider: "test-provider",
    responseId: "response-tool-intent-1",
    latencyMs: 1,
    retryCount: 0 as const,
    finishReason: "tool_calls",
    continuationHash: null,
    continuationBytes: null,
  };
  const responseState = {
    ...journalState({ turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.001 }),
    trialStarted: true,
  };
  await journalStore.append(journalId, intent);
  await journalStore.append(
    journalId,
    createResponseReceivedCheckpoint({
      turnSequence: 1,
      occurredAt: "2026-09-03T15:00:01.000Z",
      intentHash: intent.intentHash,
      result: {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls: [call] },
        stopReason: "tool_calls",
        requestHash: contentHash(stableJson(request)),
        responseHash,
        responseFacts: facts,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
      state: responseState,
      turn: {
        sequence: 1,
        startedAt: NOW,
        endedAt: "2026-09-03T15:00:01.000Z",
        durationMs: 1_000,
        requestHash: contentHash(stableJson(request)),
        resultKind: "assistant",
        responseHash,
        stopReason: "tool_calls",
        responseFacts: facts,
        toolCallIds: [call.id],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
    }),
  );
  const decision = { valid: true as const, feedback: [], budgetExhausted: false };
  await journalStore.append(
    journalId,
    createBatchValidatedCheckpoint({
      turnSequence: 1,
      occurredAt: "2026-09-03T15:00:02.000Z",
      intentHash: intent.intentHash,
      responseHash,
      calls: [call],
      decision,
      state: responseState,
    }),
  );
  await journalStore.append(
    journalId,
    createToolExecutionIntentCheckpoint({
      turnSequence: 1,
      occurredAt: "2026-09-03T15:00:03.000Z",
      intentHash: intent.intentHash,
      responseHash,
      toolCall: call,
      state: responseState,
    }),
  );
}

function journalState(usage: AgentExecutionBoundaryState["usage"]): AgentExecutionBoundaryState {
  return {
    runtimeStartedAt: NOW,
    usage,
    trialStarted: false,
    remaining: {
      turns: 31,
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

function pairedStudio(): StudioBridgeSession {
  const project = { name: "Restart Resume", placeId: 0, universeId: 0 };
  return {
    sessionId: "studio_restart_resume",
    projectId: "studio_project_restart_resume",
    conversationProjectId: PROJECT_ID,
    project,
    projectIdentity: createStudioProjectIdentityState({
      project,
      reservedAttribute: { status: "observed", forgeProjectId: PROJECT_ID },
    }),
    projectIdentityTransaction: { status: "none" },
    capabilities: [],
    manifestHash: "b".repeat(64),
    connectorBuildHash: "c".repeat(64),
    capabilityAttestationProjectionHash: "d".repeat(64),
    sessionToken: "restart-resume-session-token",
    connectedAt: NOW,
  };
}

function transactionDashboardState(paired: StudioBridgeSession) {
  return {
    kind: "CreatorTransactionState" as const,
    sessions: [],
    stages: [],
    pairedStudio: {
      status: "paired" as const,
      projectId: paired.projectId,
      projectName: paired.project.name,
      transactionInventoryStatus: "clear" as const,
      message: "Studio is paired.",
    },
    serverTime: NOW,
  };
}

function testConnection(): StudioBridgeConnection {
  return {
    send: async () => undefined,
    sendAndWaitForSettlement: async () => undefined,
    subscribeWithSession: () => () => undefined,
    close: async () => undefined,
  } as StudioBridgeConnection;
}

function availableCreatorModelCatalog() {
  return parseOpenRouterModelCatalog(
    {
      data: CREATOR_MODEL_IDS.map((id) => ({ id, supported_parameters: ["tools"] })),
    },
    NOW,
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for foreground work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function withoutHash<T extends { readonly hash: string }>(value: T): Omit<T, "hash"> {
  const { hash: _hash, ...rest } = value;
  return rest;
}
