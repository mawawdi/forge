import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  CreatorConversationStore,
  assertCreatorActionRequest,
  assertCreatorActionRequestBinding,
  assertCreatorControlView,
  assertCreatorDashboardState,
  assertCreatorModelRegistry,
  assertCreatorTurnRequest,
  assertCreatorTurnRequestBinding,
  assertCreatorWorkAdmission,
  assertCreatorWorkJobRequestBinding,
  creatorWorkRequestHash,
  sealCreatorCitation,
  sealCreatorConversationEvent,
  sealCreatorConversationTurn,
  sealCreatorControlView,
  sealCreatorMemoryRevision,
  sealCreatorModelRegistry,
  sealCreatorPlanRevision,
  sealCreatorProjectConversation,
  sealCreatorTurnContract,
  sealCreatorWorkEpisode,
  sealCreatorWorkJob,
  type CreatorArtifactBinding,
  type CreatorConversationAppendInput,
  type CreatorProjectConversation,
  type CreatorWorkEpisode,
} from "../packages/creator-conversation/src/index.js";

const NOW = "2026-09-03T10:00:00.000Z";
const LATER = "2026-09-03T10:00:01.000Z";
const MODEL = "openai/gpt-5.6-luna";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("Apply, Play and finalization remain readable; invalid snapshots never publish a head", async () => {
  await withConversationStore(async (root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_finalization");
    await store.append(first);
    for (const status of [
      "awaiting_plan_decision",
      "building",
      "awaiting_change_decision",
      "applying",
      "awaiting_play",
      "observing_play",
      "finalizing",
      "awaiting_review",
    ] as const) {
      const current = await store.load(first.conversation.id);
      const sequence = current.head.sequence + 1;
      const time = new Date(Date.parse(NOW) + sequence * 1000).toISOString();
      const episode = sealCreatorWorkEpisode({
        ...stripHash(current.episodes[0]!),
        status,
        updatedAt: time,
      });
      const conversation = sealCreatorProjectConversation({
        ...stripHash(current.conversation),
        latestEventSequence: sequence,
        updatedAt: time,
      });
      const event = sealCreatorConversationEvent({
        id: `creator_event_status_${sequence}`,
        conversationId: conversation.id,
        episodeId: episode.id,
        sequence,
        occurredAt: time,
        projectRevisionHash: HASH_A,
        authority: "forge",
        attachments: [],
        eventType: "source_sync",
        data: { status: "awaiting", message: `Host boundary: ${status}` },
      });
      if (status === "finalizing") {
        const invalid = sealCreatorWorkEpisode({ ...stripHash(episode), status: "applying" });
        await assert.rejects(
          store.append({ conversation, episode: invalid, event }),
          /status order/,
        );
        assert.equal((await store.load(conversation.id)).head.sequence, current.head.sequence);
      }
      const result = await store.append({ conversation, episode, event });
      const restarted = await new CreatorConversationStore(root).load(conversation.id);
      assert.deepEqual(result.loaded, restarted);
      assert.equal(restarted.episodes[0]!.status, status);
    }
  });
});

test("conversation contracts expose closed browser-safe turn, action, and dashboard data", async () => {
  const registry = sealCreatorModelRegistry({
    id: "creator_model_registry_main",
    generatedAt: NOW,
    defaultModelId: MODEL,
    models: [
      {
        id: MODEL,
        displayName: "GPT-5.6 Luna",
        availability: "available",
        imageInput: "supported",
        requiredCapabilities: ["tools"],
        providerFallback: "disabled",
      },
    ],
  });
  assertCreatorModelRegistry(registry);
  const turnContract = sealCreatorTurnContract({
    id: "creator_turn_contract_1",
    conversationId: "creator_conversation_contract",
    allowedTurnTypes: ["follow_up"],
    modelRegistryHash: registry.hash,
    minimumBytes: 1,
    maximumBytes: 65_536,
    issuedAt: NOW,
  });
  const viewId = "creator_control_view_1";
  const view = sealCreatorControlView({
    id: viewId,
    conversationId: "creator_conversation_contract",
    conversationHash: HASH_A,
    eventSequence: 2,
    status: "awaiting_creator",
    title: "Ready for review",
    detail: "Choose the exact next action.",
    turnContract,
    actions: [
      {
        actionInstanceId: "creator_action_keep_1",
        actionId: "keep_changes",
        label: "Keep changes",
        intent: "primary",
        controlViewId: viewId,
        authorizingEventId: "creator_event_review_1",
        authorizingEventHash: HASH_B,
        target: "none",
        input: {
          kind: "text",
          field: "report",
          label: "What did you observe?",
          minimumBytes: 1,
          maximumBytes: 4096,
          multiline: true,
        },
      },
    ],
    technicalAttachments: [],
  });
  assertCreatorControlView(view);
  const conversation = sealCreatorProjectConversation({
    id: "creator_conversation_contract",
    project: { kind: "local_linked", forgeProjectId: "forge_project_contract" },
    title: "Door Control",
    createdAt: NOW,
    updatedAt: LATER,
    latestEventSequence: 2,
    episodeIds: [],
    memoryHeads: [],
  });
  assertCreatorDashboardState({
    kind: "CreatorDashboardState",
    conversations: [
      {
        id: conversation.id,
        hash: conversation.hash,
        title: conversation.title,
        projectName: conversation.title,
        project: conversation.project,
        status: "awaiting_creator",
        latestEventSequence: 2,
        episodeCount: 0,
        updatedAt: LATER,
      },
    ],
    selectedConversationId: conversation.id,
    selectedConversation: conversation,
    eventPage: { conversationId: conversation.id, events: [], complete: true },
    episodes: [],
    memories: [],
    modelRegistry: registry,
    controlView: view,
    pairedStudio: {
      status: "ready",
      message: "Studio ready",
      project: conversation.project,
      transactionStatus: "clear",
    },
    serverTime: LATER,
  });
  const turnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: conversation.id,
    turnContractId: turnContract.id,
    turnContractHash: turnContract.hash,
    turnKind: "follow_up",
    text: "Make the warning light softer.",
    selectedModelId: MODEL,
    idempotencyKey: "turn_request_00000001",
  } as const;
  assertCreatorTurnRequest(turnRequest);
  assertCreatorTurnRequestBinding(turnContract, registry, turnRequest);
  const admittedJob = sealCreatorWorkJob({
    id: "creator_job_contract_1",
    conversationId: conversation.id,
    turnId: "creator_turn_contract_1",
    idempotencyKey: turnRequest.idempotencyKey,
    requestHash: creatorWorkRequestHash(turnRequest),
    admittedRequest: {
      artifactHash: creatorWorkRequestHash(turnRequest),
      locator: `artifacts/${creatorWorkRequestHash(turnRequest)}.json`,
      bytes: Buffer.byteLength(`${stableJson(turnRequest)}\n`, "utf8"),
    },
    admissionAuthority: {
      artifactHash: turnContract.hash,
      locator: `artifacts/${turnContract.hash}.json`,
      bytes: Buffer.byteLength(`${stableJson(turnContract)}\n`, "utf8"),
    },
    transactionSessionId: "creator_session_contract_1",
    agentExecutions: [plannerExecution("contract_1")],
    jobType: "agent_turn",
    status: "queued",
    phase: "queued",
    providerOutcome: "never_dispatched",
    selectedModelId: turnRequest.selectedModelId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assertCreatorWorkJobRequestBinding(admittedJob, turnRequest);
  const actionRequest = {
    kind: "CreatorActionRequest",
    conversationId: conversation.id,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: "creator_action_keep_1",
    idempotencyKey: "action_request_000001",
    input: { report: "It worked in Play." },
  } as const;
  assertCreatorActionRequest(actionRequest);
  assert.equal(assertCreatorActionRequestBinding(view, actionRequest).actionId, "keep_changes");
  assert.throws(
    () =>
      assertCreatorActionRequestBinding(view, {
        ...actionRequest,
        input: {
          report: "It worked in Play.",
          selectedModelId: MODEL,
          modelRegistryHash: registry.hash,
        },
      }),
    /unauthorized model selection/i,
  );
  assertCreatorWorkAdmission({
    kind: "CreatorWorkAdmission",
    jobId: "creator_job_1",
    conversationId: conversation.id,
    acceptedAt: LATER,
  });
  assert.throws(
    () =>
      assertCreatorControlView({
        ...view,
        actions: [{ ...view.actions[0], controlViewId: "creator_control_view_other" }],
      }),
    /another control view/i,
  );
  assert.throws(
    () =>
      assertCreatorActionRequest({
        kind: "CreatorActionRequest",
        conversationId: conversation.id,
        viewId: view.id,
        viewHash: view.hash,
        actionInstanceId: "creator_action_keep_1",
        idempotencyKey: "action_request_000002",
        input: { report: "yes", text: "ambiguous" },
      }),
    /exactly one/i,
  );
});

test("append persists a private strict hash chain and reconstructs it after restart", async () => {
  await withConversationStore(async (root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_restart");
    const firstResult = await store.append({ ...first, expectedHead: null });
    assert.deepEqual(firstResult.loaded, await store.load(first.conversation.id));
    const second = await agentTurnInput(store, first.conversation, first.episode!, 2);
    const secondResult = await store.append({
      ...second,
      expectedHead: {
        sequence: firstResult.head.sequence,
        commitHash: firstResult.head.commitHash,
      },
    });
    assert.equal(secondResult.commit.previousCommitHash, firstResult.commit.hash);
    assert.deepEqual(secondResult.commit.previousCommit, firstResult.references.commit);
    const headPath = join(root, "conversations", "creator_conversation_restart.head.json");
    assert.equal((await lstat(headPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(headPath, "utf8"), `${stableJson(secondResult.head)}\n`);

    const restarted = new CreatorConversationStore(new ImmutableJsonArtifactStore(root));
    const loaded = await restarted.load("creator_conversation_restart");
    assert.deepEqual(secondResult.loaded, loaded);
    assert.equal(loaded.head.sequence, 2);
    assert.deepEqual(
      loaded.events.map((event) => event.sequence),
      [1, 2],
    );
    assert.deepEqual(
      loaded.turns.map((turn) => turn.role),
      ["creator", "agent"],
    );
    assert.equal(loaded.citations.length, 1);
    assert.equal(loaded.citations[0]?.target.kind, "source_range");
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.episodes[0]?.status, "awaiting_plan_decision");
  });
});

test("append returns verified history without a second traversal of prior artifacts", async (context) => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_append_snapshot");
    const firstResult = await store.append(first);
    const second = await agentTurnInput(store, first.conversation, first.episode!, 2);
    const read = context.mock.method(store.artifactStore, "read");
    const secondResult = await store.append(second);
    const priorCommitReads = () =>
      read.mock.calls.filter(
        (call) => call.arguments[0].artifactHash === firstResult.references.commit.artifactHash,
      ).length;
    // One structural read and one complete graph verification for the prior
    // head. Returning the next snapshot must not run either traversal again.
    assert.equal(priorCommitReads(), 2);
    assert.deepEqual(
      secondResult.loaded.events.map((event) => event.sequence),
      [1, 2],
    );
    assert.deepEqual(secondResult.loaded, await store.load(first.conversation.id));
    assert.equal(priorCommitReads(), 4, "an explicit later load verifies disk independently");
  });
});

test("append captures its input and returns a detached published snapshot", async () => {
  await withConversationStore(async (_root, store) => {
    const input = await firstTurnInput(store, "creator_conversation_detached_snapshot");
    const original = structuredClone(input);
    const pending = store.append(input);
    Object.assign(input.conversation, { title: "Changed while append was queued" });
    const result = await pending;
    assert.equal(result.loaded.conversation.title, original.conversation.title);
    const published = structuredClone(result.loaded);
    Object.assign(result.head, { sequence: 999 });
    Object.assign(result.commit, { sequence: 999 });
    assert.deepEqual(result.loaded, published);
    Object.assign(result.loaded.conversation, { title: "Changed returned snapshot" });
    assert.deepEqual(await store.load(original.conversation.id), published);
  });
});

test("append rejects skipped order, stale heads, and cross-record bindings", async () => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_order");
    const result = await store.append(first);
    const skipped = await agentTurnInput(store, first.conversation, first.episode!, 3);
    await assert.rejects(store.append(skipped), /exact next sequence/i);
    const second = await agentTurnInput(store, first.conversation, first.episode!, 2);
    await assert.rejects(
      store.append({
        ...second,
        expectedHead: { sequence: result.head.sequence, commitHash: HASH_A },
      }),
      /head changed/i,
    );
    if (second.event.eventType !== "agent_turn") throw new Error("Expected agent turn event");
    const wrongEvent = sealCreatorConversationEvent({
      ...stripHash(second.event),
      conversationId: "creator_conversation_other",
    });
    await assert.rejects(store.append({ ...second, event: wrongEvent }), /another conversation/i);
  });
});

test("interrupted publication leaves no visible history and can be retried exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-conversation-interrupt-"));
  let fail = true;
  const store = new CreatorConversationStore(new ImmutableJsonArtifactStore(root), {
    beforePublishHead() {
      if (fail) throw new Error("injected before head publication");
    },
  });
  try {
    const input = await firstTurnInput(store, "creator_conversation_interrupted");
    await assert.rejects(store.append(input), /injected/);
    assert.deepEqual(await store.enumerate(), { conversations: [], corrupt: [] });
    assert.ok((await readdir(join(root, "artifacts"))).length >= 4);
    fail = false;
    const retried = await store.append(input);
    assert.equal(retried.head.sequence, 1);
    assert.equal((await store.load(input.conversation.id)).events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inconsistent active-job reference is rejected before publishing the conversation head", async () => {
  await withConversationStore(async (_root, store) => {
    const input = await firstTurnInput(store, "creator_conversation_bad_active_job");
    const episode = sealCreatorWorkEpisode({
      ...stripHash(input.episode!),
      activeJob: { id: "creator_job_unbound", hash: HASH_A },
    });
    await assert.rejects(store.append({ ...input, episode }), /active job is not an exact/);
    assert.deepEqual(await store.enumerate(), { conversations: [], corrupt: [] });
    await store.append(input);
    assert.equal((await store.load(input.conversation.id)).head.sequence, 1);
  });
});

test("enumeration isolates a tampered conversation without hiding healthy conversations", async () => {
  await withConversationStore(async (root, store) => {
    const healthy = await firstTurnInput(store, "creator_conversation_healthy");
    const damaged = await firstTurnInput(store, "creator_conversation_damaged");
    await store.append(healthy);
    const damagedResult = await store.append(damaged);
    await writeFile(
      join(root, damagedResult.references.commit.locator),
      '{"tampered":true}\n',
      "utf8",
    );
    const enumeration = await store.enumerate();
    assert.deepEqual(
      enumeration.conversations.map((entry) => entry.conversation.id),
      [healthy.conversation.id],
    );
    assert.equal(enumeration.corrupt.length, 1);
    assert.equal(enumeration.corrupt[0]?.conversationId, damaged.conversation.id);
    assert.match(enumeration.corrupt[0]?.error ?? "", /byte count|sha-256/i);
  });
});

test("restart quarantines a conversation when transitive evidence is missing", async () => {
  await withConversationStore(async (root, store) => {
    const input = await firstTurnInput(store, "creator_conversation_nested_evidence");
    const nested = await store.artifactStore.write({
      kind: "NestedRuntimeEvidence",
      id: "nested_runtime_evidence",
      complete: true,
    });
    const sessionBody = {
      kind: "OpaqueSessionBundle",
      id: "session_creator_conversation_nested_evidence",
      runtimeEvidence: nested,
    };
    const sessionArtifact = await store.artifactStore.write(sessionBody);
    const episode = sealCreatorWorkEpisode({
      ...stripHash(input.episode!),
      sessionBundle: binding(sessionBody.id, hashOf(stableJson(sessionBody)), sessionArtifact),
    });
    const result = await store.append({ ...input, episode });
    assert.deepEqual(result.loaded, await store.load(input.conversation.id));
    await rm(join(root, nested.locator));

    await assert.rejects(store.load(input.conversation.id), /ENOENT|missing/i);
    const second = await agentTurnInput(store, input.conversation, episode, 2);
    await assert.rejects(store.append(second), /ENOENT|missing/i);
    const restarted = new CreatorConversationStore(root);
    await assert.rejects(restarted.load(input.conversation.id), /ENOENT|missing/i);
    const enumeration = await restarted.enumerate();
    assert.equal(enumeration.conversations.length, 0);
    assert.equal(enumeration.corrupt.length, 1);
    assert.equal(enumeration.corrupt[0]?.conversationId, input.conversation.id);
  });
});

test("append rejects a valid artifact body substituted under a forged binding", async () => {
  await withConversationStore(async (_root, store) => {
    const input = await firstTurnInput(store, "creator_conversation_forged_binding");
    const actual = {
      kind: "BoundEvidence",
      id: "bound_evidence_actual",
      hash: HASH_A,
    };
    const artifact = await store.artifactStore.write(actual);
    const wrongIdEpisode = sealCreatorWorkEpisode({
      ...stripHash(input.episode!),
      sessionBundle: binding("bound_evidence_claimed", HASH_A, artifact),
    });
    await assert.rejects(
      store.append({ ...input, episode: wrongIdEpisode }),
      /binding ID does not match/i,
    );

    const wrongHashEpisode = sealCreatorWorkEpisode({
      ...stripHash(input.episode!),
      sessionBundle: binding(actual.id, HASH_B, artifact),
    });
    await assert.rejects(
      store.append({ ...input, episode: wrongHashEpisode }),
      /binding hash does not match/i,
    );
    assert.deepEqual(await store.enumerate(), { conversations: [], corrupt: [] });
  });
});

test("concurrent calls for one conversation serialize in invocation order", async () => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_concurrent");
    const second = await agentTurnInput(store, first.conversation, first.episode!, 2);
    const [one, two] = await Promise.all([store.append(first), store.append(second)]);
    assert.equal(one.head.sequence, 1);
    assert.equal(two.head.sequence, 2);
    const loaded = await store.load(first.conversation.id);
    assert.deepEqual(
      loaded.events.map((event) => event.id),
      [first.event.id, second.event.id],
    );
  });
});

test("plan chronology is proposal-only and decisions bind the exact immutable revision", async () => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_plans");
    await store.append(first);
    const planBody = { kind: "CreatorPlan", id: "creator_plan_one", goal: "Build an airlock." };
    const planArtifact = await store.artifactStore.write(planBody);
    const plan = sealCreatorPlanRevision({
      id: "creator_plan_revision_one",
      conversationId: first.conversation.id,
      episodeId: first.episode!.id,
      revision: 1,
      projectRevisionHash: HASH_A,
      modelId: MODEL,
      plan: binding(planBody.id, planArtifact.artifactHash, planArtifact),
      publishedAt: LATER,
    });
    const planArtifactReference = await store.artifactStore.write(plan);
    const episode = sealCreatorWorkEpisode({
      ...stripHash(first.episode!),
      status: "awaiting_plan_decision",
      planRevision: { id: plan.id, hash: plan.hash },
      updatedAt: LATER,
    });
    const conversation = sealCreatorProjectConversation({
      ...stripHash(first.conversation),
      latestEventSequence: 2,
      updatedAt: LATER,
    });
    const planEvent = sealCreatorConversationEvent({
      id: "creator_event_plan_one",
      conversationId: conversation.id,
      sequence: 2,
      occurredAt: LATER,
      authority: "agent",
      episodeId: episode.id,
      projectRevisionHash: HASH_A,
      attachments: [],
      eventType: "plan_revision",
      data: {
        planRevision: binding(plan.id, plan.hash, planArtifactReference),
        revision: 1,
        summary: "Build an airlock.",
      },
    });
    const result = await store.append({
      conversation,
      episode,
      event: planEvent,
      planRevision: plan,
    });
    assert.deepEqual(result.loaded, await store.load(conversation.id));

    const decidedAt = new Date(Date.parse(LATER) + 1000).toISOString();
    const decidedConversation = sealCreatorProjectConversation({
      ...stripHash(conversation),
      latestEventSequence: 3,
      updatedAt: decidedAt,
    });
    const unboundDecision = sealCreatorConversationEvent({
      id: "creator_event_plan_decision_unbound",
      conversationId: conversation.id,
      sequence: 3,
      occurredAt: decidedAt,
      authority: "creator",
      episodeId: episode.id,
      projectRevisionHash: HASH_A,
      attachments: [],
      eventType: "decision",
      data: {
        actionInstanceId: "creator_action_build_one",
        decision: "build",
      },
    });
    await assert.rejects(
      store.append({ conversation: decidedConversation, episode, event: unboundDecision }),
      /Plan decision is not bound/i,
    );
  });
});

test("memory revisions are immutable artifacts and current heads reconstruct exactly", async () => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_memory");
    await store.append(first);
    const memory = sealCreatorMemoryRevision({
      id: "creator_memory_revision_1",
      conversationId: first.conversation.id,
      itemId: "creator_memory_item_style",
      revision: 1,
      operation: "remember",
      category: "preference",
      text: "Keep warning lights restrained.",
      state: "active",
      pinned: true,
      authority: "creator",
      createdAt: LATER,
    });
    const memoryReference = await store.artifactStore.write(memory);
    const conversation = sealCreatorProjectConversation({
      ...stripHash(first.conversation),
      updatedAt: LATER,
      latestEventSequence: 2,
      memoryHeads: [{ itemId: memory.itemId, revisionId: memory.id, revisionHash: memory.hash }],
    });
    const event = sealCreatorConversationEvent({
      id: "creator_event_memory_1",
      conversationId: conversation.id,
      sequence: 2,
      occurredAt: LATER,
      authority: "creator",
      episodeId: first.episode!.id,
      projectRevisionHash: HASH_A,
      attachments: [],
      eventType: "memory",
      data: {
        memoryRevision: binding(memory.id, memory.hash, memoryReference),
        operation: "remember",
      },
    });
    const result = await store.append({
      conversation,
      episode: first.episode!,
      event,
      memoryRevision: memory,
    });
    const loaded = await store.load(conversation.id);
    assert.deepEqual(result.loaded, loaded);
    assert.equal(loaded.memoryRevisions.length, 1);
    assert.equal(loaded.conversation.memoryHeads[0]?.revisionHash, memory.hash);
  });
});

test("memory and prior-evidence citations must bind host-retained conversation history", async () => {
  await withConversationStore(async (_root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_context_citations");
    await store.append(first);
    const evidenceBody = {
      kind: "CreatorPlanEvidence",
      id: "creator_plan_context_citation",
      hash: HASH_A,
    };
    const evidenceArtifact = await store.artifactStore.write(evidenceBody);
    const evidenceConversation = sealCreatorProjectConversation({
      ...stripHash(first.conversation),
      latestEventSequence: 2,
      updatedAt: LATER,
    });
    const evidenceEvent = sealCreatorConversationEvent({
      id: "creator_event_context_evidence",
      conversationId: first.conversation.id,
      sequence: 2,
      occurredAt: LATER,
      authority: "forge",
      attachments: [
        {
          role: "plan",
          label: "Approved plan evidence",
          binding: binding(evidenceBody.id, evidenceBody.hash, evidenceArtifact),
        },
      ],
      eventType: "project_change",
      data: { state: "unchanged", message: "The indexed project remains current." },
    });
    await store.append({ conversation: evidenceConversation, event: evidenceEvent });

    const memory = sealCreatorMemoryRevision({
      id: "creator_memory_revision_context",
      conversationId: first.conversation.id,
      itemId: "creator_memory_context",
      revision: 1,
      operation: "remember",
      category: "convention",
      text: "Keep the warning lights restrained.",
      state: "active",
      pinned: true,
      authority: "creator",
      createdAt: "2026-09-03T10:00:02.000Z",
    });
    const memoryArtifact = await store.artifactStore.write(memory);
    const memoryConversation = sealCreatorProjectConversation({
      ...stripHash(evidenceConversation),
      latestEventSequence: 3,
      updatedAt: memory.createdAt,
      memoryHeads: [{ itemId: memory.itemId, revisionId: memory.id, revisionHash: memory.hash }],
    });
    const memoryEvent = sealCreatorConversationEvent({
      id: "creator_event_context_memory",
      conversationId: first.conversation.id,
      sequence: 3,
      occurredAt: memory.createdAt,
      authority: "creator",
      episodeId: first.episode!.id,
      projectRevisionHash: HASH_A,
      attachments: [],
      eventType: "memory",
      data: {
        memoryRevision: binding(memory.id, memory.hash, memoryArtifact),
        operation: "remember",
      },
    });
    await store.append({
      conversation: memoryConversation,
      episode: first.episode!,
      event: memoryEvent,
      memoryRevision: memory,
    });

    const agentTime = "2026-09-03T10:00:03.000Z";
    const validCitations = [
      sealCreatorCitation({
        id: "creator_citation_context_memory",
        conversationId: first.conversation.id,
        issuedForAgentRunId: "agent_run_context_citations",
        handle: "creator_citation_memory",
        label: "Creator memory",
        target: {
          kind: "memory",
          memoryItemId: memory.itemId,
          revisionId: memory.id,
          revisionHash: memory.hash,
        },
        authority: "forge",
      }),
      sealCreatorCitation({
        id: "creator_citation_context_evidence",
        conversationId: first.conversation.id,
        issuedForAgentRunId: "agent_run_context_citations",
        handle: "creator_citation_evidence",
        label: "Approved plan evidence",
        target: {
          kind: "prior_evidence",
          eventId: evidenceEvent.id,
          eventHash: evidenceEvent.hash,
          evidence: binding(evidenceBody.id, evidenceBody.hash, evidenceArtifact),
        },
        authority: "forge",
      }),
    ];
    const agentTurn = sealCreatorConversationTurn({
      id: "agent_turn_context_citations",
      conversationId: first.conversation.id,
      episodeId: first.episode!.id,
      role: "agent",
      outcome: "answer",
      text: "I will retain the saved convention and plan evidence.",
      modelId: MODEL,
      providerId: "openrouter",
      responseModelId: MODEL,
      agentRunId: "agent_run_context_citations",
      timing: { startedAt: agentTime, endedAt: agentTime, durationMs: 0 },
      usage: {
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputTokens: 10,
        outputTokens: 8,
        costUsd: 0.001,
      },
      citations: validCitations,
      createdAt: agentTime,
    });
    if (agentTurn.role !== "agent") throw new Error("Expected an agent turn");
    const agentArtifact = await store.artifactStore.write(agentTurn);
    const agentConversation = sealCreatorProjectConversation({
      ...stripHash(memoryConversation),
      latestEventSequence: 4,
      updatedAt: agentTime,
    });
    const agentEvent = sealCreatorConversationEvent({
      id: "creator_event_context_agent",
      conversationId: first.conversation.id,
      sequence: 4,
      occurredAt: agentTime,
      authority: "agent",
      episodeId: first.episode!.id,
      attachments: [],
      eventType: "agent_turn",
      data: {
        turn: binding(agentTurn.id, agentTurn.hash, agentArtifact),
        outcome: agentTurn.outcome,
        modelId: agentTurn.modelId,
        providerId: agentTurn.providerId,
        responseModelId: agentTurn.responseModelId,
        agentRunId: agentTurn.agentRunId,
        timing: agentTurn.timing,
        usage: agentTurn.usage,
        text: agentTurn.text,
        citations: agentTurn.citations,
      },
    });
    await store.append({
      conversation: agentConversation,
      episode: first.episode!,
      event: agentEvent,
      turn: agentTurn,
    });

    const restarted = new CreatorConversationStore(store.artifactStore);
    const loaded = await restarted.load(first.conversation.id);
    const cited = loaded.turns.at(-1);
    assert.equal(cited?.role, "agent");
    if (cited?.role !== "agent") throw new Error("Expected restored agent turn");
    assert.deepEqual(
      cited.citations.map((citation) => citation.target.kind),
      ["memory", "prior_evidence"],
    );

    const forgedMemory = sealCreatorCitation({
      ...stripHash(validCitations[0]!),
      id: "creator_citation_context_forged_memory",
      target: {
        kind: "memory",
        memoryItemId: memory.itemId,
        revisionId: "creator_memory_revision_missing",
        revisionHash: HASH_B,
      },
    });
    const forgedTurn = sealCreatorConversationTurn({
      ...stripHash(agentTurn),
      id: "agent_turn_context_forged",
      citations: [forgedMemory],
    });
    if (forgedTurn.role !== "agent") throw new Error("Expected a forged agent turn");
    const forgedArtifact = await store.artifactStore.write(forgedTurn);
    const forgedConversation = sealCreatorProjectConversation({
      ...stripHash(agentConversation),
      latestEventSequence: 5,
      updatedAt: "2026-09-03T10:00:04.000Z",
    });
    const forgedEvent = sealCreatorConversationEvent({
      id: "creator_event_context_forged",
      conversationId: first.conversation.id,
      episodeId: first.episode!.id,
      sequence: 5,
      occurredAt: "2026-09-03T10:00:04.000Z",
      authority: "agent",
      eventType: "agent_turn",
      attachments: [],
      data: {
        turn: binding(forgedTurn.id, forgedTurn.hash, forgedArtifact),
        outcome: forgedTurn.outcome,
        modelId: forgedTurn.modelId,
        providerId: forgedTurn.providerId,
        responseModelId: forgedTurn.responseModelId,
        agentRunId: forgedTurn.agentRunId,
        timing: forgedTurn.timing,
        usage: forgedTurn.usage,
        text: forgedTurn.text,
        citations: forgedTurn.citations,
      },
    });
    await assert.rejects(
      store.append({
        conversation: forgedConversation,
        episode: first.episode!,
        event: forgedEvent,
        turn: forgedTurn,
      }),
      /not issued from prior conversation history/i,
    );
  });
});

test("restart retains the latest legal work-job snapshot and explicit provider boundary", async () => {
  await withConversationStore(async (root, store) => {
    const first = await firstTurnInput(store, "creator_conversation_jobs");
    await store.append(first);
    const running = await jobEventInput(
      store,
      first.conversation,
      first.episode!,
      2,
      "running",
      "intent_persisted",
    );
    await store.append(running);
    const completed = await jobEventInput(
      store,
      running.conversation,
      running.episode!,
      3,
      "succeeded",
      "response_persisted",
    );
    const result = await store.append(completed);
    const restarted = new CreatorConversationStore(root);
    const loaded = await restarted.load(first.conversation.id);
    assert.deepEqual(result.loaded, loaded);
    assert.equal(loaded.jobs.length, 1);
    assert.equal(loaded.jobs[0]?.status, "succeeded");
    assert.equal(loaded.jobs[0]?.providerOutcome, "response_persisted");
    assert.equal(loaded.episodes[0]?.activeJob, undefined);
  });
});

async function firstTurnInput(
  store: CreatorConversationStore,
  conversationId: string,
): Promise<CreatorConversationAppendInput> {
  const session = await opaqueBinding(store, `session_${conversationId}`);
  const turn = sealCreatorConversationTurn({
    id: `creator_turn_${conversationId}`,
    conversationId,
    episodeId: `creator_episode_${conversationId}`,
    role: "creator",
    turnType: "new_work",
    text: "Add a smooth airlock interaction.",
    selectedModelId: MODEL,
    projectRevisionHash: HASH_A,
    createdAt: NOW,
  });
  if (turn.role !== "creator") throw new Error("Expected creator turn");
  const turnReference = await store.artifactStore.write(turn);
  const episode = sealCreatorWorkEpisode({
    id: `creator_episode_${conversationId}`,
    conversationId,
    ordinal: 1,
    status: "planning",
    selectedModelId: MODEL,
    initialProjectRevisionHash: HASH_A,
    currentProjectRevisionHash: HASH_A,
    sessionBundle: session,
    creatorTurnId: turn.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const conversation = sealCreatorProjectConversation({
    id: conversationId,
    project: { kind: "local_linked", forgeProjectId: `forge_project_${conversationId}` },
    title: "Orbital Freight Airlock",
    createdAt: NOW,
    updatedAt: NOW,
    latestEventSequence: 1,
    episodeIds: [episode.id],
    activeEpisodeId: episode.id,
    memoryHeads: [],
  });
  const event = sealCreatorConversationEvent({
    id: `creator_event_${conversationId}_1`,
    conversationId,
    sequence: 1,
    occurredAt: NOW,
    authority: "creator",
    projectRevisionHash: HASH_A,
    episodeId: episode.id,
    attachments: [],
    eventType: "creator_turn",
    data: {
      turn: binding(turn.id, turn.hash, turnReference),
      turnType: turn.turnType,
      text: turn.text,
      selectedModelId: turn.selectedModelId,
    },
  });
  return { conversation, episode, event, turn };
}

async function agentTurnInput(
  store: CreatorConversationStore,
  priorConversation: CreatorProjectConversation,
  priorEpisode: CreatorWorkEpisode,
  sequence: number,
): Promise<CreatorConversationAppendInput> {
  const eventTime = new Date(Date.parse(NOW) + sequence * 1000).toISOString();
  const citation = sealCreatorCitation({
    id: `creator_citation_${priorConversation.id}_${sequence}`,
    conversationId: priorConversation.id,
    issuedForAgentRunId: `agent_run_${sequence}`,
    handle: `source_${sequence}`,
    label: "AirlockService",
    target: {
      kind: "source_range",
      projectRevisionHash: HASH_A,
      sourceIndexHash: HASH_B,
      sourceHash: hashOf("airlock-source"),
      displayPath: "ServerScriptService/AirlockService",
      startByte: 0,
      endByte: 32,
    },
    authority: "forge",
  });
  const turn = sealCreatorConversationTurn({
    id: `agent_turn_${priorConversation.id}_${sequence}`,
    conversationId: priorConversation.id,
    episodeId: priorEpisode.id,
    role: "agent",
    outcome: "answer",
    text: "I found the server-authoritative airlock state machine.",
    modelId: MODEL,
    providerId: "openrouter",
    responseModelId: MODEL,
    agentRunId: `agent_run_${sequence}`,
    timing: {
      startedAt: eventTime,
      endedAt: eventTime,
      durationMs: 0,
    },
    usage: {
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputTokens: 40,
      outputTokens: 12,
      costUsd: 0.001,
    },
    projectRevisionHash: HASH_A,
    citations: [citation],
    createdAt: eventTime,
  });
  if (turn.role !== "agent") throw new Error("Expected agent turn");
  const turnReference = await store.artifactStore.write(turn);
  const episode = sealCreatorWorkEpisode({
    ...stripHash(priorEpisode),
    status: "awaiting_plan_decision",
    updatedAt: eventTime,
  });
  const conversation = sealCreatorProjectConversation({
    ...stripHash(priorConversation),
    updatedAt: eventTime,
    latestEventSequence: sequence,
  });
  const event = sealCreatorConversationEvent({
    id: `creator_event_${priorConversation.id}_${sequence}`,
    conversationId: priorConversation.id,
    sequence,
    occurredAt: eventTime,
    authority: "agent",
    projectRevisionHash: HASH_A,
    episodeId: priorEpisode.id,
    attachments: [],
    eventType: "agent_turn",
    data: {
      turn: binding(turn.id, turn.hash, turnReference),
      outcome: turn.outcome,
      modelId: turn.modelId,
      providerId: turn.providerId,
      responseModelId: turn.responseModelId,
      agentRunId: turn.agentRunId,
      timing: turn.timing,
      usage: turn.usage,
      text: turn.text,
      citations: turn.citations,
    },
  });
  return { conversation, episode, event, turn };
}

async function jobEventInput(
  store: CreatorConversationStore,
  priorConversation: CreatorProjectConversation,
  priorEpisode: CreatorWorkEpisode,
  sequence: number,
  status: "running" | "succeeded",
  providerOutcome: "intent_persisted" | "response_persisted",
): Promise<CreatorConversationAppendInput> {
  const eventTime = new Date(Date.parse(NOW) + sequence * 1000).toISOString();
  const turnContract = sealCreatorTurnContract({
    id: "creator_turn_contract_jobs",
    conversationId: priorConversation.id,
    allowedTurnTypes: ["new_work"],
    modelRegistryHash: HASH_B,
    minimumBytes: 1,
    maximumBytes: 65_536,
    issuedAt: NOW,
  });
  const admissionAuthority = await store.artifactStore.write(turnContract);
  const admittedRequest = {
    kind: "CreatorTurnRequest",
    conversationId: priorConversation.id,
    turnContractId: "creator_turn_contract_jobs",
    turnContractHash: turnContract.hash,
    turnKind: "new_work",
    text: "Build the airlock.",
    selectedModelId: MODEL,
    idempotencyKey: "creator_job_request_0001",
  } as const;
  const admittedRequestArtifact = await store.artifactStore.write(admittedRequest);
  const conversationContext = await store.artifactStore.write({
    kind: "CreatorConversationContext",
    conversationId: priorConversation.id,
    includedMemories: [],
    includedTurns: [],
    includedDecisions: [],
    budget: { maximumBytes: 131_072, materializedBytes: 2 },
  });
  const job = sealCreatorWorkJob({
    id: `creator_job_${priorConversation.id}`,
    conversationId: priorConversation.id,
    episodeId: priorEpisode.id,
    turnId: priorEpisode.creatorTurnId,
    idempotencyKey: "creator_job_request_0001",
    requestHash: creatorWorkRequestHash(admittedRequest),
    admittedRequest: admittedRequestArtifact,
    admissionAuthority,
    transactionSessionId: "creator_session_jobs",
    agentExecutions: [plannerExecution("jobs")],
    conversationContext,
    jobType: "agent_turn",
    status,
    phase: status === "running" ? "planning" : "complete",
    providerOutcome,
    selectedModelId: MODEL,
    providerRequestId: "openrouter_request_1",
    ...(status === "succeeded" ? { resultEventId: `creator_event_job_${sequence}` } : {}),
    createdAt: new Date(Date.parse(NOW) + 2000).toISOString(),
    updatedAt: eventTime,
  });
  const jobReference = await store.artifactStore.write(job);
  const { activeJob: _activeJob, ...episodeWithoutActiveJob } = stripHash(priorEpisode);
  const episode = sealCreatorWorkEpisode({
    ...episodeWithoutActiveJob,
    status: status === "running" ? "planning" : "awaiting_plan_decision",
    ...(status === "running" ? { activeJob: { id: job.id, hash: job.hash } } : {}),
    updatedAt: eventTime,
  });
  const conversation = sealCreatorProjectConversation({
    ...stripHash(priorConversation),
    latestEventSequence: sequence,
    updatedAt: eventTime,
  });
  const event = sealCreatorConversationEvent({
    id: `creator_event_job_${sequence}`,
    conversationId: conversation.id,
    sequence,
    occurredAt: eventTime,
    authority: "forge",
    projectRevisionHash: HASH_A,
    episodeId: episode.id,
    attachments: [],
    eventType: "job",
    data: {
      job: binding(job.id, job.hash, jobReference),
      status: job.status,
      message: status === "running" ? "Planning the change." : "Plan complete.",
    },
  });
  return { conversation, episode, event, job };
}

function plannerExecution(suffix: string) {
  const agentRunId = `agent_run_${suffix}`;
  return {
    purpose: "planner" as const,
    ordinal: 1,
    agentRunId,
    journalId: `agent_execution_journal:${agentRunId}`,
  };
}

async function opaqueBinding(
  store: CreatorConversationStore,
  id: string,
): Promise<CreatorArtifactBinding> {
  const body = { kind: "OpaqueSessionBundle", id, safe: true };
  const artifact = await store.artifactStore.write(body);
  return binding(id, hashOf(stableJson(body)), artifact);
}

function binding(
  id: string,
  hash: string,
  artifact: CreatorArtifactBinding["artifact"],
): CreatorArtifactBinding {
  return { id, hash, artifact };
}

function hashOf(value: string): string {
  return contentHash(value);
}

function stripHash<T extends { readonly hash: string }>(value: T): Omit<T, "hash"> {
  const { hash: _hash, ...draft } = value;
  return draft;
}

async function withConversationStore(
  run: (root: string, store: CreatorConversationStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-conversation-"));
  try {
    await run(root, new CreatorConversationStore(new ImmutableJsonArtifactStore(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
