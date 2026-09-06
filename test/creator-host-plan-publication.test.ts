import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  AgentExecutionJournalStore,
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  createAgentExecutionSlot,
} from "../packages/agent-runtime/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import {
  sealCreatorConversationEvent,
  type CreatorConversationEvent,
  type CreatorWorkEpisode,
} from "../packages/creator-conversation/src/index.js";
import {
  advanceSession,
  assertCreatorSessionBundle,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import { recompileRetainedCreatorPlan } from "../packages/creator-session/src/plan-recompilation.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import { creatorPlanRecompilationFixture } from "./helpers/creator-plan-recompilation-fixture.js";
import { RECOVERY_MODEL_DESCRIPTOR } from "./helpers/creator-build-recovery-fixture.js";

const NOW = "2026-09-06T05:00:00.000Z";
type PublicationHarness = {
  publishAgentOutcome(input: unknown): Promise<CreatorWorkEpisode>;
  verifiedPlanRecompilation(snapshot: CreatorSessionBundle): Promise<unknown>;
  assertRefreshPlanningBoundary(
    job: unknown,
    snapshot: CreatorSessionBundle,
    assessment: unknown,
  ): Promise<boolean>;
  assessJobExecution(job: unknown): Promise<{ kind: string; providerOutcome: string }>;
};

async function fixture(directory: string) {
  const store = new ImmutableJsonArtifactStore(directory);
  const design = creatorPlanRecompilationFixture();
  const prior = design.previous;
  const next = {
    ...design,
    ...recompileRetainedCreatorPlan({
      ...design,
      predecessorPlan: await store.write(design.previousPlan),
    }),
  };
  let session = advanceSession(next.session, { status: "planning" });
  session = advanceSession(session, { status: "awaiting_plan_approval", plan: next.plan });
  const record = next.recompilation;
  const hash = record.hash;
  const artifact = await store.write(record);
  const leaf = await store.write({ kind: "OfflineAnalysisFixture" });
  const origin: CreatorSessionBundle = {
    session: advanceSession(advanceSession(prior.session, { status: "planning" }), {
      status: "awaiting_plan_approval",
      plan: design.previousPlan,
    }),
    plan: design.previousPlan,
    ownership: prior.ownership,
    creatorRequest: await store.write({
      kind: "CreatorRequest",
      sessionId: prior.session.id,
      promptHash: prior.session.promptHash,
      creatorText: design.creatorPrompt,
      agentPrompt: design.creatorPrompt,
      contextCitations: [],
    }),
    projectIndices: [await writeCreatorProjectIndexArtifacts(store, design.beforeCapture)],
    projectChanges: [],
    projectRefreshes: [],
    rojoSourceMutations: [],
    sourceWriteBlobs: [],
    sourceIndices: [
      {
        id: prior.sourceIndex.id,
        hash: prior.sourceIndex.hash,
        artifact: await store.write(prior.sourceIndex),
        analysis: { id: "analysis-fixture", hash: contentHash("analysis"), artifact: leaf },
      },
    ],
    sourceConsultations: [
      {
        id: prior.sourceConsultation.id,
        hash: prior.sourceConsultation.hash,
        indexId: prior.sourceIndex.id,
        indexHash: prior.sourceIndex.hash,
        artifact: await store.write(prior.sourceConsultation),
      },
    ],
    buildContracts: [],
    approvals: [],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [],
  };
  assertCreatorSessionBundle(origin);
  const snapshot = {
    session,
    plan: next.plan,
    predecessorSessionId: prior.session.id,
    planRecompilation: {
      id: record.id,
      hash,
      artifact,
      refreshLineage: [await store.write(origin)],
    },
    approvals: [],
    agentRuns: [],
    sourceConsultations: [],
  } as unknown as CreatorSessionBundle;
  const events: CreatorConversationEvent[] = [];
  const loaded = { jobs: [], episodes: [], planRevisions: [], events };
  const harness = Object.assign(Object.create(CreatorConversationCoordinator.prototype), {
    store: { artifactStore: store },
    now: () => NOW,
    writeSessionSnapshot: (value: unknown) => store.write(value),
    load: async () => loaded,
    technicalAttachments: async () => [],
    append: async (_loaded: unknown, input: CreatorConversationEvent) => {
      events.push(
        sealCreatorConversationEvent({
          ...input,
          id: "creator_event_" + events.length,
          conversationId: "conversation_host_plan",
          sequence: events.length + 1,
          occurredAt: NOW,
        }),
      );
      return loaded;
    },
  }) as PublicationHarness;
  return { store, record, snapshot, harness, events };
}

test("a verified host-recompiled plan publishes a Forge review without an agent turn or model attribution", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-host-plan-publication-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { store, snapshot, harness, events } = await fixture(directory);
  const episode = await harness.publishAgentOutcome({
    conversationId: "conversation_host_plan",
    creatorTurnId: "creator_turn_source",
    request: { selectedModelId: snapshot.session.model },
    snapshot,
    contextArtifact: await store.write({ kind: "FixtureContext" }),
  });
  assert.equal(episode.status, "awaiting_plan_decision");
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.eventType, "plan_revision");
  assert.equal(event.authority, "forge");
  if (event.eventType !== "plan_revision") return;
  assert.equal(event.data.recompilation?.hash, snapshot.planRecompilation!.hash);
  assert.equal("agentRunId" in event.data, false);
  assert.equal("usage" in event.data, false);
  assert.equal("providerId" in event.data, false);
  const { hash: _hash, ...payload } = event;
  const { recompilation: _recompilation, ...unboundData } = event.data;
  assert.throws(
    () =>
      sealCreatorConversationEvent({
        ...payload,
        data: unboundData,
      }),
    /recompilation/,
  );
  assert.throws(
    () => sealCreatorConversationEvent({ ...payload, authority: "agent" }),
    /cannot claim host/,
  );
});

test("host refresh settlement requires a never-dispatched reservation and exact fresh plan binding", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-host-plan-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { snapshot, harness } = await fixture(directory);
  const job = { agentExecutions: [createAgentExecutionSlot({ purpose: "planner", ordinal: 1 })] };
  assert.equal(
    await harness.assertRefreshPlanningBoundary(job, snapshot, {
      kind: "never_dispatched",
      providerOutcome: "never_dispatched",
    }),
    true,
  );
  await assert.rejects(
    harness.assertRefreshPlanningBoundary(job, snapshot, {
      kind: "terminal",
      providerOutcome: "response_persisted",
    }),
    /conceal a dispatched/,
  );
  await assert.rejects(
    harness.assertRefreshPlanningBoundary({ agentExecutions: [] }, snapshot, {
      kind: "never_dispatched",
    }),
    /reservation/,
  );
  await assert.rejects(
    harness.verifiedPlanRecompilation({
      ...snapshot,
      planRecompilation: { ...snapshot.planRecompilation!, hash: contentHash("wrong binding") },
    }),
    /fresh-plan/,
  );
  await assert.rejects(
    harness.verifiedPlanRecompilation({ ...snapshot, predecessorSessionId: "different-session" }),
    /immediate predecessor/,
  );
  await assert.rejects(
    harness.verifiedPlanRecompilation({
      ...snapshot,
      agentRuns: [{}] as CreatorSessionBundle["agentRuns"],
    }),
    /fresh-plan/,
  );
  const { planRecompilation: _recompilation, ...withoutHostPlan } = snapshot;
  await assert.rejects(
    harness.assertRefreshPlanningBoundary(job, withoutHostPlan, { kind: "never_dispatched" }),
    /terminal planner journal/,
  );
});

test("a terminal journal from restored eligible work reports no provider dispatch", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-no-provider-terminal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { store, harness } = await fixture(directory);
  const execution = createAgentExecutionSlot({ purpose: "builder", ordinal: 1 });
  let calls = 0;
  await new ForgeNativeAgentRuntime({
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    complete: async () => {
      calls++;
      throw new Error("No provider call expected");
    },
  }).run({
    model: "fake/model",
    systemPrompt: "Use the verified restored candidate.",
    prompt: "Retry build.",
    budgets: DEFAULT_AGENT_BUDGETS,
    tools: {
      definitions: () => [],
      validateBatch: () => {
        throw new Error("No tools expected");
      },
      execute: async () => {
        throw new Error("No tools expected");
      },
      completionStatus: () => ({ ready: true }),
    },
    executionJournal: new AgentExecutionJournalStore(store).sink(execution.journalId),
  });
  const assessment = await harness.assessJobExecution({ agentExecutions: [execution] });
  assert.equal(calls, 0);
  assert.equal(assessment.kind, "terminal");
  assert.equal(assessment.providerOutcome, "never_dispatched");
});
