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
import { CreatorTurnNotAdmittedError } from "../packages/creator-control/src/turn-admission-error.js";
import {
  CreatorConversationStore,
  sealCreatorConversationEvent,
  sealCreatorConversationTurn,
  sealCreatorPlanRevision,
  sealCreatorProjectConversation,
  sealCreatorWorkEpisode,
  type CreatorActionRequest,
  type CreatorTurnRequest,
  type CreatorConversationEvent,
  type CreatorConversationAttachment,
  type CreatorControlView,
  type CreatorWorkJob,
  type CreatorWorkEpisode,
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
  type AgentExecutionSlot,
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
// Test-owned static one-pixel PNGs; neither is native rendering evidence.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";

test("a burst of transaction invalidations coalesces while retaining the final update", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-sync-coalescing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const control = coordinator(directory);
  await control.initialize();
  const internals = control as unknown as {
    sessionEpisodes: Map<string, { conversationId: string; episodeId: string }>;
    syncSession: (sessionId: string) => Promise<void>;
    onTransactionInvalidated: () => void;
  };
  internals.sessionEpisodes.set("session", {
    conversationId: "conversation",
    episodeId: "episode",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let revision = "applying";
  const observed: string[] = [];
  internals.syncSession = async () => {
    observed.push(revision);
    if (observed.length === 1) await gate;
  };
  for (let i = 0; i < 100; i++) internals.onTransactionInvalidated();
  await new Promise((resolve) => setImmediate(resolve));
  revision = "completed";
  for (let i = 0; i < 100; i++) internals.onTransactionInvalidated();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ["applying"], "Only one sync may be active for a session");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await control.close();
  assert.deepEqual(
    observed,
    ["applying", "completed"],
    "One follow-up consumes the latest state instead of queuing every intermediate notification",
  );
});

test("renaming the workspace changes display labels while retaining exact conversation authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-names-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedPlanEpisode(directory, undefined, "completed");
  const control = coordinator(directory);
  await control.initialize();
  const before = await control.dashboardState(CONVERSATION_ID);
  await control.renameWorkspace({
    scope: "project",
    conversationId: CONVERSATION_ID,
    name: "Orbital",
  });
  await control.renameWorkspace({
    scope: "conversation",
    conversationId: CONVERSATION_ID,
    name: "Improve the HUD",
  });
  await assert.rejects(
    control.renameWorkspace({ scope: "project", conversationId: "missing", name: "Lost" }),
    /no longer available/,
  );
  await control.close();
  const restarted = coordinator(directory);
  await restarted.initialize();
  t.after(() => restarted.close());
  const after = await restarted.dashboardState(CONVERSATION_ID);
  assert.equal(after.conversations[0]?.title, "Improve the HUD");
  assert.equal(after.conversations[0]?.projectName, "Orbital");
  assert.equal(after.conversations[0]?.hash, before.conversations[0]?.hash);
  assert.deepEqual(after.conversations[0]?.project, before.conversations[0]?.project);
  assert.deepEqual(after.eventPage, before.eventPage);
  assert.deepEqual(after.episodes, before.episodes);
});

for (const turnKind of ["plan_refinement", "new_work"] as const) {
  test(`${turnKind} preparation failures publish their cause once and survive restart without a provider journal`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "forge-followup-preparation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await seedPlanEpisode(
      directory,
      undefined,
      turnKind === "new_work" ? "completed" : "awaiting_plan_decision",
    );
    let bundle: CreatorSessionBundle;
    let starts = 0;
    const overrides = {
      supersedeConversationCandidate: async () => undefined,
      conversationSnapshot: async () => ({ bundle }),
      action: async (input: {
        creatorSessionId: string;
        agentExecutions: AgentExecutionSlot[];
      }) => {
        starts++;
        const execution = input.agentExecutions[0]!;
        const failure = {
          stage: "source_analysis" as const,
          code: "source_analysis_failed",
          detail: "Pinned Rojo sourcemap failed: Source is missing $className",
        };
        const diagnostic = await new ImmutableJsonArtifactStore(directory).write({
          kind: "CreatorPreparationDiagnostic",
          execution,
          failure,
        });
        bundle = {
          session: {
            id: input.creatorSessionId,
            hash: HASH_FOR_FAILURE,
            status: "incomplete",
            initialRevisionHash: REVISION_HASH,
            currentRevisionHash: REVISION_HASH,
            failure: { code: failure.code, detailHash: contentHash(failure.detail) },
          },
          preparationFailure: { execution, failure, diagnostic },
          agentRuns: [],
          projectIndices: [],
          sourceConsultations: [],
          approvals: [],
          changeSets: [],
          mutationAttempts: [],
          verifications: [],
          projectRefreshes: [],
        } as unknown as CreatorSessionBundle;
        return { creatorSessionId: input.creatorSessionId };
      },
    };
    const configure = () => {
      const control = coordinator(directory);
      Object.assign(
        (control as unknown as { options: { transaction: object } }).options.transaction,
        overrides,
      );
      return control;
    };
    const control = configure();
    await control.initialize();
    const state = await control.dashboardState(CONVERSATION_ID);
    const contract = state.controlView!.turnContract!;
    const admission = await control.submitTurn({
      kind: "CreatorTurnRequest",
      conversationId: CONVERSATION_ID,
      turnContractId: contract.id,
      turnContractHash: contract.hash,
      turnKind,
      text: "Make the UI look better",
      selectedModelId: MODEL,
      idempotencyKey: "source-preparation-followup",
    });
    const store = new CreatorConversationStore(directory);
    const deadline = Date.now() + 5000;
    let loaded = await store.load(CONVERSATION_ID);
    while (loaded.jobs.find((job) => job.id === admission.jobId)?.status !== "failed") {
      assert.ok(Date.now() < deadline, "Follow-up must settle its local preparation failure");
      await new Promise((resolve) => setTimeout(resolve, 10));
      loaded = await store.load(CONVERSATION_ID);
    }
    const job = loaded.jobs.find((entry) => entry.id === admission.jobId)!;
    assert.equal(job.phase, "preparation_failed", JSON.stringify(loaded.events.at(-1)));
    assert.equal(job.failure?.code, "source_analysis_failed");
    assert.equal(job.providerOutcome, "never_dispatched");
    assert.equal(
      await new AgentExecutionJournalStore(store.artifactStore).loadIfPresent(
        job.agentExecutions[0]!.journalId,
      ),
      undefined,
    );
    const results = loaded.events.filter((event) => event.eventType === "terminal_output");
    assert.equal(results.length, 1);
    assert.match(results[0]!.data.message, /couldn't read the project's scripts/);
    assert.ok(
      results[0]!.attachments.some((attachment) => attachment.label === "Preparation error"),
    );
    await control.close();
    const restarted = configure();
    await restarted.initialize();
    await restarted.dashboardState(CONVERSATION_ID);
    const restored = await store.load(CONVERSATION_ID);
    assert.equal(
      restored.jobs.find((entry) => entry.id === job.id)?.failure?.code,
      "source_analysis_failed",
    );
    assert.equal(
      restored.events.filter((event) => event.eventType === "terminal_output").length,
      1,
    );
    assert.equal(starts, 1);
    await restarted.close();
  });
}

const HASH_FOR_FAILURE = "f".repeat(64);

test("built drafts offer corrections before Apply, without offering them during application", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-change-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedPlanEpisode(directory);
  for (const status of ["awaiting_change_approval", "awaiting_verification", "applying"] as const) {
    const view: TransactionControlView = {
      kind: "CreatorTransactionControlView",
      id: "creator_transaction_review",
      hash: "b".repeat(64),
      creatorSessionId: SESSION_ID,
      creatorSessionHash: "c".repeat(64),
      status,
      title: "Review changes",
      detail: "Review this draft.",
      actions:
        status === "awaiting_change_approval"
          ? [
              { id: "transaction_approve_and_apply_changes", label: "Apply", intent: "primary" },
              { id: "transaction_reject_changes", label: "Reject", intent: "secondary" },
            ]
          : [],
      artifacts: {},
    };
    const control = coordinator(directory, view);
    await control.initialize();
    const state = await control.dashboardState(CONVERSATION_ID);
    assert.equal(state.controlView!.status, status === "applying" ? "working" : "awaiting_creator");
    assert.equal(state.conversations[0]!.status, state.controlView!.status);
    const correction = state.controlView!.actions.find(
      (action) => action.actionId === "revise_plan",
    );
    if (status === "awaiting_change_approval") {
      assert.equal(correction?.label, "Request changes");
      assert.equal(correction?.input.kind, "text");
    } else assert.equal(correction, undefined);
    await control.close();
  }
});

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
    assert.equal(failedState.controlView!.status, "awaiting_creator");
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

test("visual turn admission durably retains exact creator upload bytes and includes them in idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-visual-turn-admission-"));
  let control: CreatorConversationCoordinator | undefined;
  let studio: StudioBridgeSession | undefined = pairedStudio();
  try {
    await seedPlanEpisode(directory);
    control = coordinator(directory, undefined, undefined, {
      imageCapable: true,
      studio: () => studio,
    });
    await control.initialize();
    const state = await control.dashboardState(CONVERSATION_ID);
    const contract = state.controlView!.turnContract!;
    const request: CreatorTurnRequest = {
      kind: "CreatorTurnRequest",
      conversationId: CONVERSATION_ID,
      turnContractId: contract.id,
      turnContractHash: contract.hash,
      turnKind: "plan_refinement",
      text: "Use this creator reference for the planned visual treatment.",
      selectedModelId: MODEL,
      idempotencyKey: "visual-admission-exact-0001",
      visualObservations: [
        {
          kind: "reference",
          caption: "A creator-supplied visual reference: " + "視".repeat(500),
          image: { mimeType: "image/png", base64: RED_PNG },
        },
      ],
    };
    const admission = await control.submitTurn(request);
    studio = undefined;
    assert.equal((await control.submitTurn(structuredClone(request))).jobId, admission.jobId);
    await assert.rejects(
      () =>
        control!.submitTurn({
          ...request,
          visualObservations: [
            {
              ...request.visualObservations![0]!,
              image: { mimeType: "image/png", base64: BLUE_PNG },
            },
          ],
        }),
      /another admitted request/i,
    );
    const store = new CreatorConversationStore(directory);
    const loaded = await store.load(CONVERSATION_ID);
    const job = loaded.jobs.find((candidate) => candidate.id === admission.jobId)!;
    assert.ok(job);
    const admitted = await store.artifactStore.read<CreatorTurnRequest>(job.admittedRequest);
    assert.deepEqual(admitted, request);
    const { event } = admissionCommit(loaded.events, loaded.commits, admission.jobId);
    const attachment = event.attachments.find((item) => item.role === "visual_observation")!;
    assert.ok(attachment);
    assert.ok(Buffer.byteLength(attachment.label, "utf8") <= 256);
    const upload = await store.artifactStore.read<{
      kind: string;
      source: string;
      evidenceScope: string;
      observation: unknown;
    }>(attachment.binding.artifact);
    assert.equal(upload.kind, "CreatorVisualUpload");
    assert.equal(upload.source, "creator_upload");
    assert.equal(upload.evidenceScope, "creator_reported_visual");
    assert.deepEqual(upload.observation, request.visualObservations![0]);
    assert.equal(
      loaded.jobs.filter((candidate) => candidate.idempotencyKey === request.idempotencyKey).length,
      1,
    );
  } finally {
    await control?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-write turn rejection proves exact non-admission while persistence failures remain uncertain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-turn-rejection-proof-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedPlanEpisode(directory);
  const control = coordinator(directory, undefined, {
    beforePublishHead(head) {
      if (head.sequence === 2) throw new Error("interrupted durable admission");
    },
  });
  await control.initialize();
  t.after(() => control.close());
  const state = await control.dashboardState(CONVERSATION_ID);
  const contract = state.controlView!.turnContract!;
  const request: CreatorTurnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: CONVERSATION_ID,
    turnContractId: "stale-contract",
    turnContractHash: contract.hash,
    turnKind: "plan_refinement",
    text: "Review the facade.",
    selectedModelId: MODEL,
    idempotencyKey: "proven-not-admitted",
  };
  await assert.rejects(control.submitTurn(request), (error: unknown) => {
    assert.ok(error instanceof CreatorTurnNotAdmittedError);
    assert.equal(error.idempotencyKey, request.idempotencyKey);
    assert.match(error.requestHash, /^[a-f0-9]{64}$/);
    return true;
  });
  await assert.rejects(
    control.submitTurn({ ...request, turnContractId: contract.id }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof CreatorTurnNotAdmittedError, false);
      assert.match(error.message, /interrupted durable admission/);
      return true;
    },
  );
});

test("visual admission rejects unconfirmed model modality, malformed PNG and unknown current view before dispatch or persistence", async () => {
  for (const scenario of ["unsupported-model", "malformed-image", "unknown-view"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "forge-visual-rejection-"));
    let control: CreatorConversationCoordinator | undefined;
    let dispatches = 0;
    try {
      await seedPlanEpisode(directory);
      control = coordinator(directory, undefined, undefined, {
        imageCapable: scenario !== "unsupported-model",
        currentViewIds: ["known-view"],
        onDispatch: () => {
          dispatches++;
        },
      });
      await control.initialize();
      const state = await control.dashboardState(CONVERSATION_ID);
      const contract = state.controlView!.turnContract!;
      const request: CreatorTurnRequest = {
        kind: "CreatorTurnRequest",
        conversationId: CONVERSATION_ID,
        turnContractId: contract.id,
        turnContractHash: contract.hash,
        turnKind: "plan_refinement",
        text: "Consider the attached view.",
        selectedModelId: MODEL,
        idempotencyKey: `visual-rejected-${scenario}`,
        visualObservations: [
          {
            kind: "rendered_view",
            caption: "Creator-reported test image",
            image: {
              mimeType: "image/png",
              base64: scenario === "malformed-image" ? "AAAA" : RED_PNG,
            },
            ...(scenario === "unknown-view" ? { viewId: "not-in-current-plan" } : {}),
          },
        ],
      };
      const expected =
        scenario === "unsupported-model"
          ? /does not confirm image input/
          : scenario === "malformed-image"
            ? /PNG signature/
            : /outside the current game plan/;
      await assert.rejects(() => control!.submitTurn(request), expected);
      const loaded = await new CreatorConversationStore(directory).load(CONVERSATION_ID);
      assert.equal(loaded.head.sequence, 1);
      assert.equal(loaded.jobs.length, 0);
      assert.equal(
        loaded.events
          .flatMap((event) => event.attachments)
          .some((item) => item.role === "visual_observation"),
        false,
      );
      assert.equal(dispatches, 0);
    } finally {
      await control?.close();
      await rm(directory, { recursive: true, force: true });
    }
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
    const internals = control as unknown as { controlViews: Map<string, CreatorControlView> };
    internals.controlViews.set(view.conversationId, { ...view, status: "working" });
    const afterSwitch = await control.dashboardState(result.conversationId);
    assert.notEqual(
      afterSwitch.conversations.find((item) => item.id === view.conversationId)?.status,
      "working",
      "a stale cached control view must not keep a finished sibling conversation working",
    );
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
    let publicProgress = "Checking that reset cancels the door animation.";
    const additionalCheckpoints: unknown[] = [];
    // Persistence/hash validation has its own journal suite. Here the real
    // coordinator projection must satisfy the exact browser consumer contract.
    t.mock.method(
      AgentExecutionJournalStore.prototype,
      "loadIfPresent",
      async () =>
        ({
          entries: [
            {
              checkpoint: {
                checkpointType: "response_received",
                occurredAt: NOW,
                result: {
                  kind: "assistant",
                  stopReason: "tool_calls",
                  message: {
                    content: "I’m connecting the controls, then checking reset cancellation.",
                    toolCalls: [
                      {
                        id: "inspect",
                        name: "project.inspect",
                        arguments: { activity: publicProgress },
                      },
                    ],
                    continuation: { payload: "PRIVATE_REASONING_MUST_NOT_APPEAR" },
                  },
                },
                turn: {
                  usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    reasoningTokens: null,
                    cacheReadTokens: null,
                    cacheWriteTokens: null,
                    costUsd: null,
                  },
                },
              },
            },
            ...[structuredError, "界😀".repeat(200), undefined].map((message, index) => ({
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
            ...additionalCheckpoints,
          ],
        }) as unknown as LoadedAgentExecutionJournal,
    );
    const projection = control as unknown as {
      readAgentActivity(
        conversation: LoadedCreatorConversation,
      ): Promise<NonNullable<CreatorDashboardState["agentActivities"]>[number] | undefined>;
    };
    const working = {
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
    };
    const activity = await projection.readAgentActivity(working);
    assert.ok(activity);
    assert.equal(activity.steps.length, 3);
    assert.deepEqual(activity.commentary, [
      { sequence: 1, text: "I’m connecting the controls, then checking reset cancellation." },
    ]);
    assert.equal(activity.currentStep, "Checking that reset cancels the door animation.");
    assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_REASONING_MUST_NOT_APPEAR/);
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
    assert.doesNotThrow(() =>
      assertCreatorDashboardState({ ...state, agentActivities: [activity] }),
    );
    publicProgress = "";
    additionalCheckpoints.push({
      checkpoint: {
        checkpointType: "tool_completed",
        occurredAt: NOW,
        toolCall: {
          name: "project.inspect",
          input: { objectIds: ["door1", "door2"] },
          result: {
            ok: true,
            value: {
              instances: [
                { objectId: "door1", path: "Workspace/Airlock/OuterDoor" },
                { objectId: "door2", path: "Workspace/Airlock/InnerDoor" },
              ],
            },
          },
        },
      },
    });
    const observed = await projection.readAgentActivity(working);
    assert.equal(observed?.currentStep, "Planning your request");
    assert.equal(observed?.steps.at(-1)?.detail, "OuterDoor, InnerDoor");
    assert.equal(observed?.steps.at(-1)?.label, "Inspected OuterDoor, InnerDoor");
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_REASONING_MUST_NOT_APPEAR/);
    assert.doesNotThrow(() =>
      assertCreatorDashboardState({ ...state, agentActivities: [observed] }),
    );
    additionalCheckpoints.push({
      checkpoint: {
        checkpointType: "tool_completed",
        occurredAt: NOW,
        toolCall: {
          name: "studio.build",
          input: { changes: [] },
          result: { ok: true, value: { review: { status: "rejected", issues: [] } } },
        },
      },
    });
    const rejected = await projection.readAgentActivity(working);
    assert.equal(
      rejected?.steps.at(-1)?.status,
      "failed",
      "A successful check call must not turn a rejected draft green",
    );
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function coordinator(
  directory: string,
  controlView?: TransactionControlView,
  conversationStoreOptions?: ConstructorParameters<typeof CreatorConversationStore>[1],
  visual?: {
    imageCapable?: boolean;
    currentViewIds?: readonly string[];
    onDispatch?: () => void;
    studio?: () => StudioBridgeSession | undefined;
  },
): CreatorConversationCoordinator {
  const studio = pairedStudio();
  const transaction = {
    subscribe: () => () => undefined,
    pairedStudio: visual?.studio ?? (() => studio),
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
      visual?.onDispatch?.();
      throw new Error("test stops before a lower transaction dispatch");
    },
    ...(visual?.currentViewIds
      ? {
          conversationSnapshot: async () => ({
            bundle: {
              plan: {
                compiled: {
                  design: {
                    visualDirection: { views: visual.currentViewIds!.map((id) => ({ id })) },
                  },
                },
              },
            },
          }),
        }
      : {}),
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
    modelCatalog: availableCatalog(visual?.imageCapable),
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
  initialStatus: CreatorWorkEpisode["status"] = "awaiting_plan_decision",
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
    status: initialStatus,
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

function availableCatalog(imageCapable = false) {
  return parseOpenRouterModelCatalog(
    {
      data: CREATOR_MODEL_IDS.map((id) => ({
        id,
        supported_parameters: ["tools"],
        ...(imageCapable ? { architecture: { input_modalities: ["text", "image"] } } : {}),
      })),
    },
    NOW,
  );
}
