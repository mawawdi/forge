import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  AgentExecutionJournalStore,
  createAgentExecutionSlot,
  DEFAULT_AGENT_BUDGETS,
  type AgentRuntime,
} from "../packages/agent-runtime/src/index.js";
import {
  createCreatorSession,
  advanceSession,
  createCreatorBuildContract,
  prepareCreatorBuildPlan,
  type CreatorSession,
  type CreatorPlan,
  type CreatorApproval,
  type StudioOwnershipMap,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import { LocalCreatorAgentWorker } from "../packages/creator-session/src/worker.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import type { CreatorSessionBundle } from "../packages/creator-session/src/index.js";

test("accepting a plan builds once and hands the sealed graph to checkpoint preparation", async (context) => {
  const saved = await incident();
  const directory = await mkdtemp(join(tmpdir(), "forge-plan-request-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifactStore = new ImmutableJsonArtifactStore(directory);
  let session = createCreatorSession({
    prompt: saved.plan.goal,
    projectId: saved.session.projectId,
    revisionHash: saved.session.currentRevisionHash,
    projectCaptureHash: saved.session.currentProjectCaptureHash,
    ownership: saved.ownership,
  });
  session = advanceSession(session, { status: "planning" });
  session = advanceSession(session, { status: "awaiting_plan_approval", plan: saved.plan });
  const bundle = {
    session,
    creatorRequest: await artifactStore.write({
      kind: "CreatorRequest",
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorText: saved.plan.goal,
      agentPrompt: `Build the approved inventory.\n${saved.plan.goal}`,
      contextCitations: [],
    }),
    plan: saved.plan,
    ownership: saved.ownership,
    approvals: [],
    buildContracts: [],
    agentRuns: [],
    changeSets: [],
  } as unknown as CreatorSessionBundle;
  let builds = 0;
  let applies = 0;
  const graph = { id: "game_build_graph_auto", hash: "a".repeat(64) };
  const harness = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    artifactStore,
    bundles: new Map([[session.id, bundle]]),
    input: {
      worker: {
        build: async (request: {
          creatorPrompt: string;
          agentPrompt: string;
          initialImages: readonly unknown[];
        }) => {
          builds++;
          assert.equal(request.creatorPrompt, saved.plan.goal);
          assert.equal(request.agentPrompt, `Build the approved inventory.\n${saved.plan.goal}`);
          assert.deepEqual(request.initialImages, []);
          return {
            status: "sealed",
            graph,
            summary: "Built the requested graph.",
            buildContract: { hash: "b".repeat(64) },
            evidence: {},
            sourceWriteBlobs: [],
          };
        },
      },
    },
    persist: async (value: unknown) => value,
    publishView: async () => undefined,
    sourceEvidence: async () => ({}),
    observationForBundle: async () => saved.projectIndex,
    retainSourceWriteBlobs: async (value: unknown) => value,
    startGameBuild: async (
      value: CreatorSessionBundle,
      built: typeof graph,
      buildContractHash: string,
      summary: string,
    ) => {
      applies++;
      assert.equal(value.session.status, "building");
      assert.deepEqual(built, graph);
      assert.equal(buildContractHash, "b".repeat(64));
      assert.equal(summary, "Built the requested graph.");
      assert.equal(value.approvals.length, 1);
      assert.equal(value.approvals[0]?.artifactKind, "plan");
      assert.equal(value.approvals[0]?.authority, "creator");
      return "automatically_applied";
    },
  }) as {
    decidePlan(
      bundle: CreatorSessionBundle,
      hash: string,
      decision: string,
      execution: ReturnType<typeof createAgentExecutionSlot>,
    ): Promise<unknown>;
  };
  assert.equal(
    await harness.decidePlan(
      bundle,
      saved.plan.hash,
      "approved",
      createAgentExecutionSlot({ purpose: "builder", ordinal: 1 }),
    ),
    "automatically_applied",
  );
  assert.equal(builds, 1);
  assert.equal(applies, 1);
});

test("retry build retains exact approval only across unchanged authority and allocates a fresh slot", async () => {
  const saved = await incident();
  const original = createAgentExecutionSlot({ purpose: "builder", ordinal: 1 });
  const fresh = createAgentExecutionSlot({ purpose: "builder", ordinal: 2 });
  const artifact = {
    artifactHash: "a".repeat(64),
    locator: `artifacts/${"a".repeat(64)}.json`,
    bytes: 1,
  };
  const bundle = {
    ...saved,
    session: {
      ...saved.session,
      status: "incomplete",
      planApproval: { id: saved.planApproval.id, hash: saved.planApproval.hash },
    },
    approvals: [saved.planApproval],
    mutationAttempts: [],
    rojoSourceMutations: [],
    changeSets: [],
    agentRuns: [],
    buildContracts: [],
    preparationFailure: {
      execution: original,
      failure: {
        stage: "preparation",
        code: "BUILD_PREPARATION_FAILED",
        detail: "Unable to prepare.",
      },
      diagnostic: artifact,
    },
  } as unknown as CreatorSessionBundle;
  const capture = {
    hash: "a".repeat(64),
    revision: {
      hash: saved.session.currentRevisionHash,
      manifestHash: "b".repeat(64),
      merkleRoot: "c".repeat(64),
      connectorEpoch: "epoch-a",
    },
    indexManifest: {
      project: saved.projectIndex.project,
      allShardHashes: [],
      sourceManifestHashes: [],
    },
  };
  let current = structuredClone(capture);
  let clearChecks = 0;
  let builds = 0;
  let refreshes = 0;
  let failCapture = false;
  const harness = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    bundles: new Map([[bundle.session.id, bundle]]),
    currentAttestedStudioSession: async () => ({ projectId: saved.session.projectId }),
    requireClearRecordingInventory: async () => {
      clearChecks++;
    },
    collectProjectIndex: async () => {
      if (failCapture) throw new Error("Studio disconnected during preparation");
      return current;
    },
    captureForBundle: async () => capture,
    decidePlan: async (
      _bundle: unknown,
      hash: string,
      decision: string,
      execution: typeof fresh,
      approval: CreatorApproval,
    ) => {
      builds++;
      assert.equal(hash, saved.plan.hash);
      assert.equal(decision, "approved");
      assert.deepEqual(approval, saved.planApproval);
      assert.deepEqual(execution, fresh);
      return "build";
    },
    requireBuildRefresh: async () => {
      refreshes++;
      return "refresh";
    },
    recordPreparationFailure: async (
      _bundle: unknown,
      execution: typeof fresh,
      failure: { stage: string; detail: string },
    ) => {
      assert.deepEqual(execution, fresh);
      assert.equal(failure.stage, "preparation");
      assert.equal(failure.detail, "Studio disconnected during preparation");
      return "preparation_failed";
    },
  }) as { retryBuild(bundle: CreatorSessionBundle, execution: typeof fresh): Promise<unknown> };
  assert.equal(await harness.retryBuild(bundle, fresh), "build");
  assert.equal(builds, 1);
  assert.equal(clearChecks, 1);
  await assert.rejects(harness.retryBuild(bundle, original), /fresh execution/);
  current.revision.manifestHash = "d".repeat(64);
  assert.equal(await harness.retryBuild(bundle, fresh), "refresh");
  current = structuredClone(capture);
  current.revision.merkleRoot = "e".repeat(64);
  assert.equal(await harness.retryBuild(bundle, fresh), "refresh");
  current = structuredClone(capture);
  current.revision.connectorEpoch = "epoch-b";
  assert.equal(await harness.retryBuild(bundle, fresh), "refresh");
  assert.equal(builds, 1);
  assert.equal(refreshes, 3);
  failCapture = true;
  assert.equal(await harness.retryBuild(bundle, fresh), "preparation_failed");
  await assert.rejects(
    harness.retryBuild({ ...bundle, activeMutation: {} as never }, fresh),
    /cannot be retried/,
  );
  await assert.rejects(
    harness.retryBuild(
      { ...bundle, approvals: [{ ...saved.planApproval, artifactHash: "f".repeat(64) }] },
      fresh,
    ),
    /cannot be retried/,
  );
});

async function incident() {
  return JSON.parse(await readFile("test/fixtures/creator-planning-incident.json", "utf8")) as {
    session: CreatorSession;
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
  };
}

test("the archived 19-change plan cannot bypass current compiled inventory admission", async () => {
  const saved = await incident();
  assert.equal(saved.plan.hash, "386eab8b4377fcd1d292c0fcf83bde100ad6b8dcc5ffb4503f9d59a889d31c6b");
  assert.equal(saved.projectIndex.instances.length, 42);
  assert.equal(saved.plan.changes.length, 19);
  assert.equal(Object.hasOwn(saved.plan, "compiled"), false);
  assert.throws(
    () => prepareCreatorBuildPlan(saved.plan, saved.projectIndex),
    /Invalid CreatorPlan/,
  );
  assert.throws(() => createCreatorBuildContract(saved), /Invalid Creator(?:Plan|Session)/);
});

test("preparation failure retains its diagnostic and cannot claim a provider execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-build-preparation-"));
  let calls = 0;
  const runtime = {
    run: async () => {
      calls++;
      throw new Error("Unexpected dispatch");
    },
  } as unknown as AgentRuntime;
  const worker = new LocalCreatorAgentWorker(runtime, root);
  const saved = await incident();
  const execution = createAgentExecutionSlot({ purpose: "builder", ordinal: 1 });
  try {
    const result = await worker.build({
      ...saved,
      execution,
      creatorPrompt: saved.plan.goal,
      agentPrompt: saved.plan.goal,
      budgets: DEFAULT_AGENT_BUDGETS,
      sourceIndex: { kind: "invalid-preparation-fixture" },
      sourceResolver: {},
      sourceConsultation: {},
    } as unknown as Parameters<LocalCreatorAgentWorker["build"]>[0]);
    assert.equal(result.status, "preparation_failed");
    assert.equal(calls, 0);
    assert.equal(
      await new AgentExecutionJournalStore(new ImmutableJsonArtifactStore(root)).loadIfPresent(
        execution.journalId,
      ),
      undefined,
    );
    if (result.status !== "preparation_failed") return;
    assert.equal(result.failure.stage, "preparation");
    assert.equal(Object.hasOwn(result, "evidence"), false);
    const diagnostic = (await new ImmutableJsonArtifactStore(root).read(result.diagnostic)) as {
      failure: unknown;
      execution: unknown;
    };
    assert.deepEqual(diagnostic.failure, result.failure);
    assert.deepEqual(diagnostic.execution, execution);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
