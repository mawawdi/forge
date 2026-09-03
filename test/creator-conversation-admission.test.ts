import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import {
  CreatorConversationStore,
  sealCreatorConversationEvent,
  sealCreatorConversationTurn,
  sealCreatorPlanRevision,
  sealCreatorProjectConversation,
  sealCreatorWorkEpisode,
  type CreatorActionRequest,
  type CreatorConversationEvent,
  type CreatorConversationAttachment,
  type CreatorControlView,
  type CreatorWorkJob,
  type LoadedCreatorConversation,
} from "../packages/creator-conversation/src/index.js";
import {
  CREATOR_MODEL_IDS,
  parseOpenRouterModelCatalog,
} from "../packages/model-client/src/model-registry.js";
import type { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import type {
  CreatorTransactionControlView as TransactionControlView,
  CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import type {
  StudioBridgeConnection,
  StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import { createStudioProjectIdentityState } from "../packages/studio-protocol/src/index.js";
import {
  AgentExecutionJournalStore,
  type LoadedAgentExecutionJournal,
} from "../packages/agent-runtime/src/index.js";
import {
  assertCreatorDashboardState,
  type CreatorDashboardState,
} from "../packages/creator-conversation/src/contracts.js";

const NOW = "2026-09-03T16:00:00.000Z";
const MODEL = "openai/gpt-5.6-luna";
const CONVERSATION_ID = "creator_conversation_admission";
const PROJECT_ID = "forge_project_0123456789abcdef0123456789abcdef";
const SESSION_ID = "creator_session_admission";
const REVISION_HASH = "a".repeat(64);

test("turn admission publishes intent and queued idempotency record at one conversation head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-admission-"));
  try {
    await seedPlanEpisode(directory);
    let failBeforeHead = true;
    const faulting = coordinator(directory, undefined, {
      beforePublishHead(head) {
        if (failBeforeHead && head.sequence === 2)
          throw new Error("injected admission head interruption");
      },
    });
    await faulting.initialize();
    const failedState = await faulting.dashboardState(CONVERSATION_ID);
    const failedContract = failedState.controlView!.turnContract!;
    await assert.rejects(
      faulting.submitTurn({
        kind: "CreatorTurnRequest",
        conversationId: CONVERSATION_ID,
        turnContractId: failedContract.id,
        turnContractHash: failedContract.hash,
        turnKind: "plan_refinement",
        text: "Make the plan more deliberate.",
        selectedModelId: MODEL,
        idempotencyKey: "atomic-turn-fault-0001",
      }),
      /injected admission head interruption/i,
    );
    await faulting.close();

    const afterFailure = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    assert.equal(afterFailure.head.sequence, 1);
    assert.equal(afterFailure.jobs.length, 0);
    assert.equal(afterFailure.turns.length, 1);

    failBeforeHead = false;
    const restarted = coordinator(directory);
    await restarted.initialize();
    const state = await restarted.dashboardState(CONVERSATION_ID);
    const contract = state.controlView!.turnContract!;
    const admission = await restarted.submitTurn({
      kind: "CreatorTurnRequest",
      conversationId: CONVERSATION_ID,
      turnContractId: contract.id,
      turnContractHash: contract.hash,
      turnKind: "plan_refinement",
      text: "Make the plan more deliberate.",
      selectedModelId: MODEL,
      idempotencyKey: "atomic-turn-success-0001",
    });
    const admitted = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const commit = admissionCommit(admitted.events, admitted.commits, admission.jobId);
    assert.equal(commit.event.eventType, "creator_turn");
    if (commit.event.eventType !== "creator_turn") throw new Error("Expected atomic creator turn");
    assert.equal(commit.event.data.job?.id, admission.jobId);
    assert.equal(commit.commit.jobId, admission.jobId);
    assert.equal(
      admitted.jobs.some((job) => job.id === admission.jobId),
      true,
    );
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Build this admits a real plan-bearing control view without fabricating technical identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-plan-admission-"));
  try {
    const store = new CreatorConversationStore(directory);
    const plan = identifiedBody("CreatorPlan", "creator_plan_admission");
    const revision = identifiedBody("StudioProjectRevision", "studio_revision_admission");
    const planArtifact = await store.artifactStore.write(plan);
    const revisionArtifact = await store.artifactStore.write(revision);
    await seedPlanEpisode(directory, { plan, artifact: planArtifact });
    const transactionView = planBearingView(plan, planArtifact, revisionArtifact);
    const faulting = coordinator(directory, transactionView, {
      beforePublishHead(head) {
        if (head.sequence === 3) throw new Error("injected build admission interruption");
      },
    });
    await faulting.initialize();
    const failedState = await faulting.dashboardState(CONVERSATION_ID);
    const failedBuild = failedState.controlView!.actions.find(
      (action) => action.actionId === "build_plan",
    )!;
    await assert.rejects(
      faulting.submitAction({
        kind: "CreatorActionRequest",
        conversationId: CONVERSATION_ID,
        viewId: failedState.controlView!.id,
        viewHash: failedState.controlView!.hash,
        actionInstanceId: failedBuild.actionInstanceId,
        idempotencyKey: "plan-bearing-build-fault-0001",
      }),
      /injected build admission interruption/i,
    );
    await faulting.close();
    const afterFault = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    assert.equal(afterFault.head.sequence, 2);
    assert.equal(afterFault.jobs.length, 0);
    assert.equal(
      afterFault.events.some((event) => event.eventType === "decision"),
      false,
    );

    const control = coordinator(directory, transactionView);
    await control.initialize();
    const state = await control.dashboardState(CONVERSATION_ID);
    const build = state.controlView!.actions.find((action) => action.actionId === "build_plan")!;
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: CONVERSATION_ID,
      viewId: state.controlView!.id,
      viewHash: state.controlView!.hash,
      actionInstanceId: build.actionInstanceId,
      idempotencyKey: "plan-bearing-build-0001",
    };
    const admission = await control.submitAction(request);
    const admitted = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const commit = admissionCommit(admitted.events, admitted.commits, admission.jobId);
    assert.equal(commit.event.eventType, "decision");
    if (commit.event.eventType !== "decision") throw new Error("Expected atomic build decision");
    assert.equal(commit.event.data.decision, "build");
    assert.equal(commit.event.data.job?.id, admission.jobId);
    assert.equal(commit.commit.jobId, admission.jobId);

    const view = await new CreatorConversationStore(directory).artifactStore.read(
      admitted.jobs.find((job) => job.id === admission.jobId)!.admissionAuthority,
    );
    const attachments = (
      view as {
        technicalAttachments: Array<{ label: string; binding: { id: string; hash: string } }>;
      }
    ).technicalAttachments;
    assert.deepEqual(
      attachments
        .filter((attachment) => ["Plan", "Studio Execution Plan"].includes(attachment.label))
        .map((attachment) => ({
          label: attachment.label,
          id: attachment.binding.id,
          hash: attachment.binding.hash,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      [
        { label: "Plan", id: plan.id, hash: plan.hash },
        { label: "Studio Execution Plan", id: revision.id, hash: revision.hash },
      ],
    );
    await control.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source evidence resolves a historical cited index through its event episode, never the latest episode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-source-evidence-anchor-"));
  const historicalEventHash = "b".repeat(64);
  const historicalIndexHash = "c".repeat(64);
  const calls: unknown[] = [];
  const transaction = {
    subscribe: () => () => undefined,
    async sourceDocuments(sessionId: string, sourceIndexHash: string, input: unknown) {
      calls.push({ sessionId, sourceIndexHash, input });
      return { documents: [] };
    },
  } as unknown as CreatorSessionCoordinator;
  const control = new CreatorConversationCoordinator({
    transaction,
    connection: {} as StudioBridgeConnection,
    directory,
    defaultModelId: MODEL,
    modelCatalog: availableCatalog(),
    now: () => new Date(NOW),
  });
  const historicalEvent = {
    kind: "CreatorConversationEvent",
    id: "creator_event_historical_source",
    hash: historicalEventHash,
    conversationId: CONVERSATION_ID,
    sequence: 1,
    occurredAt: NOW,
    authority: "agent",
    episodeId: "creator_episode_historical",
    attachments: [],
    eventType: "agent_turn",
    data: {
      citations: [
        {
          target: { kind: "source_range", sourceIndexHash: historicalIndexHash },
        },
      ],
    },
  } as unknown as CreatorConversationEvent;
  const currentEvent = {
    ...historicalEvent,
    id: "creator_event_current_source",
    hash: "d".repeat(64),
    sequence: 2,
    episodeId: "creator_episode_current",
    data: {
      citations: [
        {
          target: { kind: "source_range", sourceIndexHash: "e".repeat(64) },
        },
      ],
    },
  } as unknown as CreatorConversationEvent;
  const loaded = {
    events: [historicalEvent, currentEvent],
    episodes: [
      { id: "creator_episode_historical", sessionBundle: { id: "creator_session_historical" } },
      { id: "creator_episode_current", sessionBundle: { id: "creator_session_current" } },
    ],
  } as unknown as LoadedCreatorConversation;
  (control as unknown as { loaded: Map<string, LoadedCreatorConversation> }).loaded.set(
    CONVERSATION_ID,
    loaded,
  );
  try {
    await control.sourceDocuments(
      {
        conversationId: CONVERSATION_ID,
        eventId: historicalEvent.id,
        eventHash: historicalEvent.hash,
        sourceIndexHash: historicalIndexHash,
      },
      { limit: 20 },
    );
    assert.deepEqual(calls, [
      {
        sessionId: "creator_session_historical",
        sourceIndexHash: historicalIndexHash,
        input: { limit: 20 },
      },
    ]);
    await assert.rejects(
      control.sourceDocuments(
        {
          conversationId: CONVERSATION_ID,
          eventId: historicalEvent.id,
          eventHash: historicalEvent.hash,
          sourceIndexHash: "e".repeat(64),
        },
        { limit: 20 },
      ),
      /not issued by the selected immutable event/i,
    );
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("new conversations retain project identity, isolate history, and are idempotent without provider or Studio dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-separate-conversations-"));
  const control = coordinator(directory);
  try {
    await control.initialize();
    const first = await control.dashboardState();
    const view = first.controlView!;
    const action = view.actions.find((item) => item.actionId === "new_conversation")!;
    assert.ok(action);
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: view.conversationId,
      viewId: view.id,
      viewHash: view.hash,
      actionInstanceId: action.actionInstanceId,
      idempotencyKey: "separate-conversation-0001",
    };
    const result = await control.submitAction(request);
    assert.notEqual(result.conversationId, view.conversationId);
    assert.equal((await control.submitAction(request)).conversationId, result.conversationId);
    const state = await control.dashboardState(result.conversationId);
    assert.equal(state.conversations.length, 2);
    assert.deepEqual(state.selectedConversation!.project, first.selectedConversation!.project);
    assert.equal(state.episodes.length, 0);
    const store = new CreatorConversationStore(directory);
    const created = await store.load(result.conversationId);
    assert.equal(created.turns.length, 0);
    assert.equal(created.jobs.length, 0);
    assert.equal(created.events.length, 1);
    assert.equal(state.projectSettings!.controlView.conversationId, view.conversationId);

    const settings = state.projectSettings!.controlView;
    const remember = settings.actions.find((item) => item.actionId === "remember")!;
    await control.submitAction({
      kind: "CreatorActionRequest",
      conversationId: settings.conversationId,
      viewId: settings.id,
      viewHash: settings.hash,
      actionInstanceId: remember.actionInstanceId,
      idempotencyKey: "shared-preference-0001",
      input: { text: "Keep scripts server-owned.", memoryCategory: "preference" },
    });
    await control.close();
    const reopened = coordinator(directory);
    try {
      await reopened.initialize();
      const fresh = await reopened.dashboardState(result.conversationId);
      assert.equal(fresh.projectSettings!.memories[0]?.text, "Keep scripts server-owned.");
      assert.equal((await store.load(result.conversationId)).turns.length, 0);
      assert.equal(fresh.conversations.length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed recovery releases sibling conversations while retaining the full job chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-recovered-project-"));
  const control = coordinator(directory);
  try {
    await control.initialize();
    const first = await control.dashboardState();
    const view = first.controlView!;
    const action = view.actions.find((item) => item.actionId === "new_conversation")!;
    const second = await control.submitAction({
      kind: "CreatorActionRequest",
      conversationId: view.conversationId,
      viewId: view.id,
      viewHash: view.hash,
      actionInstanceId: action.actionInstanceId,
      idempotencyKey: "recovery-sibling-0001",
    });
    const internals = control as unknown as {
      loaded: Map<string, LoadedCreatorConversation>;
      controlViews: Map<string, CreatorControlView>;
    };
    const original = internals.loaded.get(view.conversationId)!;
    // Inject observed job summaries at the presentation boundary; the durable
    // store's separate topology tests cover creation and exact resume bindings.
    const failed: CreatorWorkJob = {
      ...original.jobs.at(-1)!,
      id: "job_original",
      hash: "a".repeat(64),
      jobType: "agent_turn",
      status: "outcome_unknown",
      providerOutcome: "outcome_unknown",
      agentExecutions: [
        {
          journalId: "journal_original",
          agentRunId: "run_original",
          purpose: "planner",
          ordinal: 1,
        },
      ],
    };
    const retry: CreatorWorkJob = {
      ...failed,
      id: "job_retry",
      hash: "b".repeat(64),
      resumesJob: { id: failed.id, hash: failed.hash },
      agentExecutions: [
        { journalId: "journal_retry", agentRunId: "run_retry", purpose: "planner", ordinal: 1 },
      ],
    };
    const last: CreatorWorkJob = {
      ...retry,
      id: "job_last",
      hash: "c".repeat(64),
      status: "succeeded",
      resumesJob: { id: retry.id, hash: retry.hash },
      agentExecutions: [
        { journalId: "journal_last", agentRunId: "run_last", purpose: "planner", ordinal: 1 },
      ],
    };
    for (const [jobs, blocked] of [
      [[failed], true],
      [[failed, { ...retry, status: "queued" }], true],
      [[failed, { ...retry, status: "running" }], true],
      [[failed, retry], true],
      [[failed, { ...retry, status: "succeeded" }], false],
      [[failed, retry, last], false],
    ] as const) {
      internals.loaded.set(view.conversationId, { ...original, jobs });
      internals.controlViews.clear();
      const state = await control.dashboardState(second.conversationId);
      assert.equal(state.controlView?.status, blocked ? "blocked" : "ready");
      assert.equal(Boolean(state.controlView?.turnContract), !blocked);
      assert.equal(internals.loaded.get(view.conversationId)!.jobs[0], failed);
      assert.equal(failed.status, "outcome_unknown", "historical evidence must not be rewritten");
    }
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("published outcome attachments retain semantic identity across real artifact-store append and reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-outcome-attachment-"));
  const control = coordinator(directory);
  try {
    await seedPlanEpisode(directory);
    const store = new CreatorConversationStore(directory);
    const loaded = await store.load(CONVERSATION_ID);
    const payload = {
      kind: "answer" as const,
      text: "The scene contains an airlock.",
      citations: [],
    };
    const hash = contentHash(stableJson(payload));
    const outcome = { ...payload, id: `creator_agent_outcome_${hash.slice(0, 24)}`, hash };
    const artifact = await store.artifactStore.write(outcome);
    const boundary = control as unknown as {
      technicalAttachments(bundle: CreatorSessionBundle): Promise<CreatorConversationAttachment[]>;
    };
    const attachments = await boundary.technicalAttachments({
      projectIndices: [],
      sourceConsultations: [],
      agentRuns: [],
      changeSets: [],
      mutationAttempts: [],
      verifications: [],
      projectRefreshes: [],
      agentOutcome: { outcome, artifact },
    } as unknown as CreatorSessionBundle);
    const sequence = loaded.head.sequence + 1;
    const conversation = sealCreatorProjectConversation({
      ...withoutRecordIdentity(loaded.conversation),
      latestEventSequence: sequence,
    });
    await store.append({
      conversation,
      event: sealCreatorConversationEvent({
        id: "event_outcome_attachment",
        conversationId: CONVERSATION_ID,
        sequence,
        occurredAt: NOW,
        authority: "forge",
        attachments,
        eventType: "terminal_output",
        data: {
          outcome: "incomplete",
          message: "Saved agent response is available for review.",
          studioHasAcceptedResult: false,
        },
      }),
      expectedHead: { sequence: loaded.head.sequence, commitHash: loaded.head.commitHash },
    });
    const reloaded = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    assert.deepEqual(reloaded.events.at(-1)!.attachments[0]!.binding, {
      id: outcome.id,
      hash: outcome.hash,
      artifact,
    });
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal activity fits the browser contract after long errors and multilingual project queries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-activity-contract-"));
  const control = coordinator(directory);
  try {
    await seedPlanEpisode(directory);
    await control.initialize();
    const state = await control.dashboardState(CONVERSATION_ID);
    const conversation = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
    const structuredError = JSON.stringify({
      details: { paths: Array(40).fill("Workspace/Airlock/Part") },
      message: "Inspect the missing scene objects before proposing the plan.",
    });
    // Persistence/hash validation has its own journal suite. Here the real
    // coordinator projection must satisfy the exact browser consumer contract.
    t.mock.method(
      AgentExecutionJournalStore.prototype,
      "loadIfPresent",
      async () =>
        ({
          entries: [structuredError, "界😀".repeat(200), undefined].map((message, index) => ({
            checkpoint: {
              checkpointType: "tool_completed",
              occurredAt: NOW,
              toolCall: {
                name: index === 2 ? "project.search" : "creator.propose_plan",
                input: { query: "界😀".repeat(200) },
                result: {
                  ok: message === undefined,
                  ...(message ? { error: { code: "PLAN_INVALID", message } } : {}),
                },
              },
            },
          })),
        }) as unknown as LoadedAgentExecutionJournal,
    );
    const projection = control as unknown as {
      readAgentActivity(
        conversation: LoadedCreatorConversation,
      ): Promise<CreatorDashboardState["agentActivity"]>;
    };
    const activity = await projection.readAgentActivity({
      ...conversation,
      jobs: [
        {
          id: "job_activity",
          status: "running",
          createdAt: NOW,
          updatedAt: NOW,
          agentExecutions: [
            {
              agentRunId: "agent_run_activity",
              journalId: "journal_activity",
              purpose: "planner",
              ordinal: 1,
            },
          ],
        } as unknown as CreatorWorkJob,
      ],
    });
    assert.ok(activity);
    assert.equal(activity.steps.length, 3);
    assert.equal(
      activity.steps[0]!.detail,
      "Inspect the missing scene objects before proposing the plan.",
    );
    assert.ok(activity.steps.every((step) => Buffer.byteLength(step.detail, "utf8") <= 240));
    assert.ok(
      activity.steps
        .slice(1)
        .every((step) => !step.detail.includes("�") && step.detail.endsWith("…")),
    );
    assert.doesNotThrow(() => assertCreatorDashboardState({ ...state, agentActivity: activity }));
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function coordinator(
  directory: string,
  controlView?: TransactionControlView,
  conversationStoreOptions?: ConstructorParameters<typeof CreatorConversationStore>[1],
): CreatorConversationCoordinator {
  const studio = pairedStudio();
  const transaction = {
    subscribe: () => () => undefined,
    pairedStudio: () => studio,
    dashboardState: async () => ({
      kind: "CreatorTransactionState",
      selectedSessionId: SESSION_ID,
      sessions: [],
      ...(controlView ? { controlView } : {}),
      stages: [],
      pairedStudio: {
        status: "paired",
        projectId: studio.projectId,
        projectName: studio.project.name,
        transactionInventoryStatus: "clear",
        message: "Studio is paired.",
      },
      serverTime: NOW,
    }),
    action: async () => {
      throw new Error("test stops before a lower transaction dispatch");
    },
  } as unknown as CreatorSessionCoordinator;
  return new CreatorConversationCoordinator({
    transaction,
    connection: {
      send: async () => undefined,
      sendAndWaitForSettlement: async () => undefined,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: MODEL,
    modelCatalog: availableCatalog(),
    now: () => new Date(NOW),
    ...(conversationStoreOptions ? { conversationStoreOptions } : {}),
  });
}

async function seedPlanEpisode(
  directory: string,
  existingPlan?: {
    readonly plan: ReturnType<typeof identifiedBody>;
    readonly artifact: ArtifactReference;
  },
): Promise<void> {
  const store = new CreatorConversationStore(new ImmutableJsonArtifactStore(directory));
  const sessionBody = { kind: "CreatorSessionEvidenceSnapshot", id: SESSION_ID };
  const sessionArtifact = await store.artifactStore.write(sessionBody);
  const turn = sealCreatorConversationTurn({
    id: "creator_turn_seed_admission",
    conversationId: CONVERSATION_ID,
    role: "creator",
    turnType: "new_work",
    text: "Propose a safe plan for this project.",
    selectedModelId: MODEL,
    createdAt: NOW,
  });
  const turnArtifact = await store.artifactStore.write(turn);
  if (turn.role !== "creator") throw new Error("Expected creator seed turn");
  const episode = sealCreatorWorkEpisode({
    id: "creator_episode_admission",
    conversationId: CONVERSATION_ID,
    ordinal: 1,
    status: "awaiting_plan_decision",
    selectedModelId: MODEL,
    initialProjectRevisionHash: REVISION_HASH,
    currentProjectRevisionHash: REVISION_HASH,
    sessionBundle: {
      id: SESSION_ID,
      hash: contentHash(stableJson(sessionBody)),
      artifact: sessionArtifact,
    },
    creatorTurnId: turn.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const conversation = sealCreatorProjectConversation({
    id: CONVERSATION_ID,
    project: { kind: "local_linked", forgeProjectId: PROJECT_ID },
    title: "Admission fixture",
    createdAt: NOW,
    updatedAt: NOW,
    latestEventSequence: 1,
    episodeIds: [episode.id],
    activeEpisodeId: episode.id,
    memoryHeads: [],
  });
  const event = sealCreatorConversationEvent({
    id: "creator_event_seed_admission",
    conversationId: CONVERSATION_ID,
    sequence: 1,
    occurredAt: NOW,
    authority: "creator",
    projectRevisionHash: REVISION_HASH,
    episodeId: episode.id,
    attachments: [],
    eventType: "creator_turn",
    data: {
      turn: { id: turn.id, hash: turn.hash, artifact: turnArtifact },
      turnType: turn.turnType,
      text: turn.text,
      selectedModelId: turn.selectedModelId,
    },
  });
  await store.append({ conversation, event, episode, turn, expectedHead: null });
  if (!existingPlan) return;
  const planRevision = sealCreatorPlanRevision({
    id: "creator_plan_revision_admission",
    conversationId: CONVERSATION_ID,
    episodeId: episode.id,
    revision: 1,
    projectRevisionHash: REVISION_HASH,
    modelId: MODEL,
    plan: {
      id: existingPlan.plan.id,
      hash: existingPlan.plan.hash,
      artifact: existingPlan.artifact,
    },
    publishedAt: NOW,
  });
  const updatedEpisode = sealCreatorWorkEpisode({
    ...withoutRecordIdentity(episode),
    planRevision: { id: planRevision.id, hash: planRevision.hash },
    updatedAt: NOW,
  });
  const updatedConversation = sealCreatorProjectConversation({
    ...withoutRecordIdentity(conversation),
    latestEventSequence: 2,
    updatedAt: NOW,
  });
  const planEvent = sealCreatorConversationEvent({
    id: "creator_event_seed_plan_admission",
    conversationId: CONVERSATION_ID,
    sequence: 2,
    occurredAt: NOW,
    authority: "agent",
    projectRevisionHash: REVISION_HASH,
    episodeId: episode.id,
    attachments: [],
    eventType: "plan_revision",
    data: {
      planRevision: {
        id: planRevision.id,
        hash: planRevision.hash,
        artifact: await store.artifactStore.write(planRevision),
      },
      revision: planRevision.revision,
      summary: "A plan is ready for the creator's Build this decision.",
    },
  });
  await store.append({
    conversation: updatedConversation,
    event: planEvent,
    episode: updatedEpisode,
    planRevision,
  });
}

function planBearingView(
  plan: ReturnType<typeof identifiedBody>,
  planArtifact: ArtifactReference,
  revisionArtifact: ArtifactReference,
): TransactionControlView {
  return {
    kind: "CreatorTransactionControlView",
    id: "creator_transaction_view_admission",
    hash: "b".repeat(64),
    creatorSessionId: SESSION_ID,
    creatorSessionHash: "c".repeat(64),
    status: "awaiting_plan_approval",
    title: "Ready to build",
    detail: "The exact plan is ready for a creator decision.",
    artifact: {
      kind: "plan",
      id: plan.id,
      hash: plan.hash,
      presentation: { title: "Admission plan" },
      presentationHash: "d".repeat(64),
    },
    actions: [
      { id: "transaction_approve_plan", label: "Approve", intent: "primary" },
      { id: "transaction_reject_plan", label: "Reject", intent: "secondary" },
    ],
    artifacts: { plan: planArtifact, studioExecutionPlan: revisionArtifact },
  };
}

function identifiedBody(kind: string, id: string) {
  const payload = { kind, id };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

function withoutRecordIdentity<T extends { readonly kind: string; readonly hash: string }>(
  value: T,
): Omit<T, "kind" | "hash"> {
  const { kind: _kind, hash: _hash, ...draft } = value;
  return draft;
}

function admissionCommit(
  events: readonly CreatorConversationEvent[],
  commits: readonly { readonly eventId: string; readonly jobId?: string }[],
  jobId: string,
) {
  const commit = commits.find((candidate) => candidate.jobId === jobId)!;
  const event = events.find((candidate) => candidate.id === commit.eventId)!;
  assert.ok(commit);
  assert.ok(event);
  return { commit, event };
}

function pairedStudio(): StudioBridgeSession {
  const project = { name: "Admission fixture", placeId: 0, universeId: 0 };
  return {
    sessionId: "studio_admission",
    projectId: "studio_project_admission",
    conversationProjectId: PROJECT_ID,
    project,
    projectIdentity: createStudioProjectIdentityState({
      project,
      reservedAttribute: { status: "observed", forgeProjectId: PROJECT_ID },
    }),
    projectIdentityTransaction: { status: "none" },
    capabilities: [],
    manifestHash: "e".repeat(64),
    connectorBuildHash: "f".repeat(64),
    capabilityAttestationProjectionHash: "1".repeat(64),
    sessionToken: "admission-session-token",
    connectedAt: NOW,
  };
}

function availableCatalog() {
  return parseOpenRouterModelCatalog(
    { data: CREATOR_MODEL_IDS.map((id) => ({ id, supported_parameters: ["tools"] })) },
    NOW,
  );
}
