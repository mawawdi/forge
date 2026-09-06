import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import {
  sealCreatorConversationEvent,
  sealCreatorControlView,
  sealCreatorWorkEpisode,
  type CreatorWorkEpisode,
} from "../packages/creator-conversation/src/index.js";

const NOW = "2026-09-06T05:00:00.000Z";
const MODEL = "deepseek/deepseek-v4-flash-0731";
const HASH = contentHash("host-plan-restart-fixture");
const ARTIFACT = { artifactHash: HASH, bytes: 1, locator: `artifacts/${HASH}.json` };
const binding = (id: string) => ({ id, hash: HASH, artifact: ARTIFACT });

test("the control view offers explicit retry for an unknown refresh planner but excludes unknown mutation work", async () => {
  const conversationId = "creator_conversation_unknown_refresh";
  const job = {
    id: "creator_job_unknown_refresh",
    jobType: "agent_action",
    status: "outcome_unknown",
    providerOutcome: "outcome_unknown",
    failure: { code: "provider_outcome_unknown" },
    agentExecutions: [{ purpose: "planner" }],
  };
  const conversation = {
    conversation: {
      id: conversationId,
      hash: HASH,
      latestEventSequence: 1,
      project: { kind: "published", placeId: "1", universeId: "2" },
      memoryHeads: [],
    },
    episodes: [],
    events: [{ id: "creator_event_unknown_refresh", hash: HASH }],
    jobs: [job],
  };
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    options: { transaction: { pairedStudio: () => ({ project: { placeId: 1, universeId: 2 } }) } },
    publishedContinuityControlView: () => undefined,
    controlViews: new Map(),
    controlProjectScopes: new Map(),
    loaded: new Map([[conversationId, conversation]]),
    modelRegistry: { hash: HASH },
    now: () => NOW,
  }) as {
    materializeControlView(
      input: unknown,
    ): Promise<{ actions: { actionId: string; label: string }[] }>;
  };
  const recoveryActions = async () =>
    (await harness.materializeControlView(conversation)).actions.filter(
      (action) => action.actionId === "retry_work" || action.actionId === "resume_work",
    );
  assert.deepEqual(
    (await recoveryActions()).map(({ actionId, label }) => ({ actionId, label })),
    [{ actionId: "retry_work", label: "Try again" }],
  );
  for (const purpose of ["builder", "repair"]) {
    job.agentExecutions = [{ purpose }];
    assert.deepEqual(await recoveryActions(), []);
  }
  job.agentExecutions = [{ purpose: "planner" }, { purpose: "planner" }];
  assert.deepEqual(await recoveryActions(), []);
});

test("unknown agent actions cannot retry a mutation using refresh recovery authority", async () => {
  const conversationId = "creator_conversation_unknown_mutation";
  const view = sealCreatorControlView({
    id: "creator_control_unknown_mutation",
    conversationId,
    conversationHash: HASH,
    eventSequence: 1,
    status: "awaiting_creator",
    title: "Apply changes",
    detail: "",
    actions: [
      {
        actionInstanceId: "creator_action_unknown_mutation",
        actionId: "apply_changes",
        label: "Apply",
        intent: "primary",
        controlViewId: "creator_control_unknown_mutation",
        authorizingEventId: "creator_event_unknown_mutation",
        authorizingEventHash: HASH,
        target: "none",
        input: { kind: "none" },
      },
    ],
    technicalAttachments: [],
  });
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    store: { artifactStore: { read: async () => view } },
    load: async () => {
      throw new Error("Mutation retry must reject before loading or dispatching work");
    },
  }) as {
    executeResumedAgentAction(
      execution: unknown,
      running: unknown,
      prior: unknown,
      admitted: unknown,
    ): Promise<void>;
  };
  await assert.rejects(
    harness.executeResumedAgentAction(
      {},
      {},
      {
        admissionAuthority: ARTIFACT,
        providerOutcome: "outcome_unknown",
      },
      {
        kind: "CreatorActionRequest",
        conversationId,
        viewId: view.id,
        viewHash: view.hash,
        actionInstanceId: "creator_action_unknown_mutation",
        idempotencyKey: "unknown-mutation-retry-001",
      },
    ),
    /only restart a read-only project refresh/,
  );
});

test("restart publishes the final retained host plan across an interrupted refresh without redispatch", async () => {
  const conversationId = "creator_conversation_multihop_restart";
  const episodeId = "creator_episode_multihop_before";
  const view = sealCreatorControlView({
    id: "creator_control_multihop_original",
    conversationId,
    conversationHash: HASH,
    eventSequence: 1,
    episodeId,
    status: "awaiting_creator",
    title: "Refresh project",
    detail: "Review complete fresh observations.",
    actions: [
      {
        actionInstanceId: "creator_action_multihop_refresh",
        actionId: "refresh_project",
        label: "Refresh",
        intent: "primary",
        controlViewId: "creator_control_multihop_original",
        authorizingEventId: "creator_event_multihop_refresh",
        authorizingEventHash: HASH,
        target: "none",
        input: { kind: "none" },
      },
    ],
    technicalAttachments: [],
  });
  const before = {
    session: {
      id: "before",
      model: MODEL,
      promptHash: HASH,
      projectId: "project",
      status: "superseded",
    },
    successorSessionId: "interrupted",
  };
  const interrupted = {
    session: {
      id: "interrupted",
      model: MODEL,
      promptHash: HASH,
      projectId: "project",
      status: "superseded",
    },
    predecessorSessionId: "before",
    successorSessionId: "host-plan",
  };
  const final = {
    session: {
      id: "host-plan",
      model: MODEL,
      promptHash: HASH,
      projectId: "project",
      status: "awaiting_plan_approval",
    },
    predecessorSessionId: "interrupted",
    planRecompilation: { artifact: ARTIFACT },
  };
  const bundles = new Map<string, unknown>([
    ["before", before],
    ["interrupted", interrupted],
    ["host-plan", final],
  ]);
  const publications: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    store: { artifactStore: { read: async () => view } },
    options: {
      transaction: {
        conversationSnapshot: async (id: string) => ({ bundle: bundles.get(id) }),
        action: async () => {
          throw new Error("Recovery must not dispatch a transaction or model action");
        },
      },
    },
    settleBuildRefreshBeforeDispatch: async () => false,
    assertRefreshPlanningBoundary: async (
      _job: unknown,
      snapshot: unknown,
      assessment: { kind: string },
    ) => {
      assert.equal(snapshot, final);
      assert.equal(assessment.kind, "never_dispatched");
      return true;
    },
    publishRefreshSuccessor: async (input: {
      predecessor: unknown;
      successor: unknown;
      predecessorEpisodeId: string;
    }) => {
      assert.equal(input.predecessor, before);
      assert.equal(input.successor, final);
      assert.equal(input.predecessorEpisodeId, episodeId);
      publications.push(input);
    },
    updateJob: async (_execution: unknown, update: Record<string, unknown>) => {
      updates.push(update);
    },
  }) as {
    recoverPersistedAgentActionBoundary(
      conversation: unknown,
      job: unknown,
      request: unknown,
      assessment: unknown,
    ): Promise<boolean>;
  };
  const conversation = {
    conversation: { id: conversationId },
    episodes: [{ id: episodeId, sessionBundle: { id: "before" } }],
  };
  const job = {
    id: "creator_job_multihop_retry",
    jobType: "agent_action",
    episodeId,
    admissionAuthority: ARTIFACT,
  };
  const request = {
    kind: "CreatorActionRequest",
    conversationId,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: "creator_action_multihop_refresh",
    idempotencyKey: "multihop-restart-00001",
  };
  const assessment = { kind: "never_dispatched", providerOutcome: "never_dispatched" };
  assert.equal(
    await harness.recoverPersistedAgentActionBoundary(conversation, job, request, assessment),
    true,
  );
  assert.equal(publications.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.status, "succeeded");
  assert.equal(updates[0]!.phase, "awaiting_plan_approval");
  assert.equal(updates[0]!.providerOutcome, "never_dispatched");
  interrupted.session.promptHash = contentHash("different creator request");
  await assert.rejects(
    harness.recoverPersistedAgentActionBoundary(conversation, job, request, assessment),
    /successor binding/,
  );
  interrupted.session.promptHash = HASH;
  interrupted.session.projectId = "different-project";
  await assert.rejects(
    harness.recoverPersistedAgentActionBoundary(conversation, job, request, assessment),
    /successor binding/,
  );
  assert.equal(publications.length, 1);
  assert.equal(updates.length, 1);
});

test("explicit interrupted refresh retry uses the successor's fresh action instead of a consumed view", async () => {
  const original = {
    action: "act" as const,
    actionId: "transaction_refresh_project" as const,
    sessionId: "before",
    viewId: "consumed",
    viewHash: HASH,
  };
  const bundles = new Map([
    [
      "before",
      {
        session: { id: "before", model: MODEL, promptHash: HASH, status: "superseded" },
        successorSessionId: "interrupted",
      },
    ],
    [
      "interrupted",
      {
        session: { id: "interrupted", model: MODEL, promptHash: HASH, status: "refresh_required" },
        predecessorSessionId: "before",
      },
    ],
  ]);
  const viewed: string[] = [];
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    options: {
      transaction: {
        conversationSnapshot: async (id: string) => ({ bundle: bundles.get(id) }),
        dashboardState: async (id: string) => {
          viewed.push(id);
          return {
            controlView: {
              id: "fresh",
              hash: contentHash("fresh"),
              actions: [{ id: "transaction_refresh_project" }],
            },
          };
        },
      },
    },
  }) as { resumedRefreshAction(input: typeof original): Promise<typeof original> };
  assert.deepEqual(await harness.resumedRefreshAction(original), {
    ...original,
    sessionId: "interrupted",
    viewId: "fresh",
    viewHash: contentHash("fresh"),
  });
  assert.deepEqual(viewed, ["interrupted"]);
  bundles.get("interrupted")!.session.promptHash = contentHash("changed request");
  await assert.rejects(harness.resumedRefreshAction(original), /successor binding/);
  bundles.get("interrupted")!.session.promptHash = HASH;
  bundles.get("interrupted")!.session.status = "awaiting_plan_approval";
  await assert.rejects(harness.resumedRefreshAction(original), /fresh observation boundary/);
  assert.deepEqual(viewed, ["interrupted"]);
});

test("refresh publication reuses the persisted successor identity after a crash between its two appends", async () => {
  const conversationId = "creator_conversation_host_plan_restart";
  const predecessorSessionId = "creator_session_host_plan_before";
  const successorSessionId = "creator_session_host_plan_after";
  const predecessor = {
    session: { id: predecessorSessionId, hash: HASH, currentRevisionHash: HASH, model: MODEL },
    successorSessionId,
    projectRefreshes: [
      {
        refresh: { id: "refresh", hash: HASH, outcome: "superseded", successorSessionId },
        artifact: ARTIFACT,
      },
    ],
  };
  const successor = {
    session: { id: successorSessionId, hash: HASH, currentRevisionHash: HASH, model: MODEL },
    predecessorSessionId,
    creatorRequest: ARTIFACT,
    agentRuns: [],
  };
  let episodes: CreatorWorkEpisode[] = [
    sealCreatorWorkEpisode({
      id: "creator_episode_host_plan_before",
      conversationId,
      ordinal: 1,
      status: "superseded",
      selectedModelId: MODEL,
      initialProjectRevisionHash: HASH,
      currentProjectRevisionHash: HASH,
      sessionBundle: binding(predecessorSessionId),
      creatorTurnId: "creator_turn_host_plan",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ];
  let crash = true;
  let completedPublications = 0;
  let predecessorLinkPublications = 0;
  let persistedSuccessorId: string | undefined;
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    store: { artifactStore: { read: async () => ({ sessionId: successorSessionId }) } },
    now: () => NOW,
    assessJobExecution: async () => ({
      kind: "never_dispatched",
      providerOutcome: "never_dispatched",
    }),
    assertRefreshPlanningBoundary: async () => true,
    load: async () => ({ episodes }),
    writeSessionSnapshot: async () => ARTIFACT,
    append: async (_loaded: unknown, event: { episode: CreatorWorkEpisode }) => {
      predecessorLinkPublications++;
      persistedSuccessorId ??= event.episode.successorEpisodeId;
      // This is the immutable link already committed before the simulated crash.
      assert.equal(event.episode.successorEpisodeId, persistedSuccessorId);
      episodes = [event.episode];
    },
    publishAgentOutcome: async (input: { newEpisodeId: string }) => {
      if (crash) throw new Error("simulated crash before successor publication");
      assert.equal(input.newEpisodeId, persistedSuccessorId);
      completedPublications++;
      const episode = sealCreatorWorkEpisode({
        id: input.newEpisodeId,
        conversationId,
        ordinal: 2,
        status: "awaiting_plan_decision",
        selectedModelId: MODEL,
        initialProjectRevisionHash: HASH,
        currentProjectRevisionHash: HASH,
        sessionBundle: binding(successorSessionId),
        creatorTurnId: "creator_turn_host_plan",
        predecessorEpisodeId: episodes[0]!.id,
        createdAt: NOW,
        updatedAt: NOW,
      });
      episodes.push(episode);
      return episode;
    },
    sessionEpisodes: new Map(),
    transactionHashes: new Map(),
  }) as { publishRefreshSuccessor(input: unknown): Promise<CreatorWorkEpisode> };
  const input = {
    execution: { conversationId },
    job: { selectedModelId: MODEL, agentExecutions: [{ purpose: "planner" }] },
    predecessorEpisodeId: episodes[0]!.id,
    predecessor,
    successor,
  };
  await assert.rejects(harness.publishRefreshSuccessor(input), /simulated crash/);
  assert.ok(persistedSuccessorId);
  crash = false;
  const resumed = await harness.publishRefreshSuccessor(input);
  assert.equal(resumed.id, persistedSuccessorId);
  assert.equal((await harness.publishRefreshSuccessor(input)).id, resumed.id);
  assert.equal(completedPublications, 1);
  assert.equal(predecessorLinkPublications, 1);
});

test("host plan events require explicit recompilation provenance and cannot masquerade as agent events", () => {
  const payload = {
    id: "creator_event_host_plan",
    conversationId: "creator_conversation_host_plan",
    sequence: 1,
    occurredAt: NOW,
    attachments: [],
    eventType: "plan_revision" as const,
    data: {
      planRevision: binding("plan-revision"),
      revision: 1,
      summary: "Review the retained design.",
    },
  };
  assert.throws(() => sealCreatorConversationEvent({ ...payload, authority: "forge" }));
  const recompilation = binding("recompilation");
  assert.throws(
    () =>
      sealCreatorConversationEvent({
        ...payload,
        authority: "agent",
        data: { ...payload.data, recompilation },
      }),
    /cannot claim host recompilation/,
  );
  const event = sealCreatorConversationEvent({
    ...payload,
    authority: "forge",
    data: { ...payload.data, recompilation },
  });
  assert.equal(event.authority, "forge");
});

test("a published model successor missing only its plan revision is completed without another agent turn", async () => {
  const conversationId = "creator_conversation_partial_plan";
  const priorId = "creator_episode_partial_before";
  const nextId = "creator_episode_partial_after";
  const sessionBefore = "creator_session_partial_before";
  const sessionAfter = "creator_session_partial_after";
  const common = {
    conversationId,
    selectedModelId: MODEL,
    initialProjectRevisionHash: HASH,
    currentProjectRevisionHash: HASH,
    creatorTurnId: "creator_turn_partial_plan",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const prior = sealCreatorWorkEpisode({
    ...common,
    id: priorId,
    ordinal: 1,
    status: "superseded",
    sessionBundle: binding(sessionBefore),
    successorEpisodeId: nextId,
  });
  let next = sealCreatorWorkEpisode({
    ...common,
    id: nextId,
    ordinal: 2,
    status: "awaiting_plan_decision",
    sessionBundle: binding(sessionAfter),
    predecessorEpisodeId: priorId,
  });
  let planPublications = 0;
  const plan = { id: "retained-model-plan", hash: HASH };
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    store: { artifactStore: { read: async () => ({ sessionId: sessionAfter }) } },
    assessJobExecution: async () => ({ kind: "terminal", providerOutcome: "response_persisted" }),
    assertRefreshPlanningBoundary: async () => false,
    load: async () => ({ episodes: [prior, next] }),
    append: async () => {
      throw new Error("The predecessor link is already published");
    },
    publishAgentOutcome: async () => {
      throw new Error("The existing model turn must not be published twice");
    },
    publishPlanReview: async (input: {
      episode: CreatorWorkEpisode;
      plan: unknown;
      recompilation?: unknown;
    }) => {
      assert.equal(input.episode.id, nextId);
      assert.equal(input.plan, plan);
      assert.equal(input.recompilation, undefined);
      planPublications++;
      const { kind: _kind, hash: _hash, ...fields } = next;
      next = sealCreatorWorkEpisode({
        ...fields,
        planRevision: { id: "plan-revision", hash: HASH },
      });
      return next;
    },
    sessionEpisodes: new Map(),
    transactionHashes: new Map(),
  }) as { publishRefreshSuccessor(input: unknown): Promise<CreatorWorkEpisode> };
  const input = {
    execution: { conversationId },
    job: {
      selectedModelId: MODEL,
      agentExecutions: [{ purpose: "planner", agentRunId: "agent_run_partial" }],
    },
    predecessorEpisodeId: priorId,
    predecessor: {
      session: { id: sessionBefore, model: MODEL },
      successorSessionId: sessionAfter,
      projectRefreshes: [{ refresh: { outcome: "superseded", successorSessionId: sessionAfter } }],
    },
    successor: {
      session: { id: sessionAfter, hash: HASH, model: MODEL },
      predecessorSessionId: sessionBefore,
      creatorRequest: ARTIFACT,
      agentRuns: [{ agentRunId: "agent_run_partial" }],
      plan,
    },
  };
  assert.equal((await harness.publishRefreshSuccessor(input)).planRevision?.id, "plan-revision");
  assert.equal((await harness.publishRefreshSuccessor(input)).id, nextId);
  assert.equal(planPublications, 1);
});

test("a host plan boundary requires an undispatched planner reservation even when a terminal run used zero tokens", async () => {
  let proof = true;
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    verifiedPlanRecompilation: async () => (proof ? binding("recompilation") : undefined),
  }) as {
    assertRefreshPlanningBoundary(
      job: unknown,
      snapshot: unknown,
      assessment: unknown,
    ): Promise<boolean>;
  };
  const job = { agentExecutions: [{ purpose: "planner" }] };
  assert.equal(
    await harness.assertRefreshPlanningBoundary(
      job,
      {},
      {
        kind: "never_dispatched",
        providerOutcome: "never_dispatched",
      },
    ),
    true,
  );
  await assert.rejects(
    harness.assertRefreshPlanningBoundary(
      job,
      {},
      {
        kind: "terminal",
        providerOutcome: "never_dispatched",
      },
    ),
    /cannot conceal a dispatched planner execution/,
  );
  await assert.rejects(
    harness.assertRefreshPlanningBoundary(
      { agentExecutions: [{ purpose: "builder" }] },
      {},
      {
        kind: "never_dispatched",
        providerOutcome: "never_dispatched",
      },
    ),
    /planner reservation/,
  );
  proof = false;
  await assert.rejects(
    harness.assertRefreshPlanningBoundary(
      job,
      {},
      {
        kind: "never_dispatched",
        providerOutcome: "never_dispatched",
      },
    ),
    /without a terminal planner journal/,
  );
  assert.equal(
    await harness.assertRefreshPlanningBoundary(
      job,
      {},
      {
        kind: "terminal",
        providerOutcome: "response_persisted",
      },
    ),
    false,
  );
});

test("a build stopped for fresh observations settles without inventing a terminal provider run", async () => {
  let status = "refresh_required";
  const updates: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    options: {
      transaction: {
        conversationSnapshot: async (sessionId: string) => {
          assert.equal(sessionId, "creator_session_before_dispatch");
          snapshots++;
          return { bundle: { session: { status } } };
        },
      },
    },
    updateJob: async (_execution: unknown, update: Record<string, unknown>) => {
      updates.push(update);
    },
  }) as {
    settleBuildRefreshBeforeDispatch(
      execution: unknown,
      job: unknown,
      actionId: string,
      sessionId: string,
      assessment: unknown,
    ): Promise<boolean>;
  };
  const job = { agentExecutions: [{ purpose: "builder" }] };
  const undispatched = { kind: "never_dispatched", providerOutcome: "never_dispatched" };
  const settle = (action: string, assessment = undispatched, reservation: unknown = job) =>
    harness.settleBuildRefreshBeforeDispatch(
      {},
      reservation,
      action,
      "creator_session_before_dispatch",
      assessment,
    );
  for (const action of ["build_plan", "retry_build"]) {
    assert.equal(await settle(action), true);
    assert.deepEqual(
      { ...updates.at(-1), message: undefined },
      {
        status: "succeeded",
        phase: "refresh_required",
        providerOutcome: "never_dispatched",
        message: undefined,
      },
    );
    assert.match(String(updates.at(-1)!.message), /No model request was made/);
  }
  const beforeOtherActions = snapshots;
  for (const action of ["refresh_project", "apply_changes", "retry_play", "revise_plan"])
    assert.equal(await settle(action), false);
  assert.equal(
    await settle("retry_build", { kind: "terminal", providerOutcome: "never_dispatched" }),
    false,
  );
  assert.equal(
    await settle("build_plan", {
      kind: "provider_outcome_unknown",
      providerOutcome: "outcome_unknown",
    }),
    false,
  );
  assert.equal(snapshots, beforeOtherActions);
  status = "incomplete";
  assert.equal(await settle("retry_build"), false);
  status = "refresh_required";
  await assert.rejects(
    settle("retry_build", undispatched, { agentExecutions: [{ purpose: "planner" }] }),
    /reserved builder/,
  );
  assert.equal(updates.length, 2);
});
