import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CreatorBuilderToolHost,
  createCreatorApproval,
  createCreatorBuildContract,
} from "../packages/creator-session/src/index.js";
import { recompileRetainedCreatorPlan } from "../packages/creator-session/src/plan-recompilation.js";
import {
  createCreatorBuildProposal,
  loadCreatorBuildProposal,
} from "../packages/creator-session/src/build-proposal.js";
import {
  creatorBuildRecoveryBinding,
  loadCreatorBuildRecovery,
  writeCreatorBuildRecovery,
} from "../packages/creator-session/src/build-recovery.js";
import {
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  createAgentExecutionSlot,
} from "../packages/agent-runtime/src/index.js";
import { LocalCreatorAgentWorker } from "../packages/creator-session/src/worker.js";
import { studioProjectIndexSourceDocuments } from "../packages/studio-evidence/src/index.js";
import { creatorPlanRecompilationFixture } from "./helpers/creator-plan-recompilation-fixture.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import {
  recoveryToolResult,
  creatorBuildRecoveryFixture,
  writeRecoveryTestRun,
  RECOVERY_MODEL_DESCRIPTOR,
} from "./helpers/creator-build-recovery-fixture.js";

function authority(fixture: ReturnType<typeof creatorPlanRecompilationFixture>, fresh = false) {
  const facts = fresh ? fixture : fixture.previous;
  const plan = fresh ? recompileRetainedCreatorPlan(fixture).plan : fixture.previousPlan;
  const approval = createCreatorApproval({
    sessionId: facts.session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-06T12:30:00.000Z",
  });
  const projectIndex = facts.observation;
  const contract = createCreatorBuildContract({
    session: facts.session,
    plan,
    planApproval: approval,
    ownership: facts.ownership,
    projectIndex,
  });
  return {
    ...facts,
    plan,
    approval,
    contract,
    projectIndex,
    prompt: fixture.creatorPrompt,
    sourceResolver: createTestFixtureSourceResolver(
      studioProjectIndexSourceDocuments(fresh ? fixture.afterCapture : fixture.beforeCapture),
    ),
    expected: creatorBuildRecoveryBinding({ session: facts.session, plan, approval, contract }),
  };
}
test("newly approved recompiled plan checks retained sources with zero provider calls and fresh operation authority", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-build-proposal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = creatorPlanRecompilationFixture();
  const previous = authority(fixture);
  const next = authority(fixture, true);
  const oldHost = new CreatorBuilderToolHost({ ...previous, planApproval: previous.approval });
  const input = {
    sources: [{ slotId: "new-module", source: "--!strict\nreturn { value = 1 }\n" }],
    summary: "Created the declared composition.",
    activity: "Build the declared composition",
  };
  const result = await oldHost.execute("studio.build", input);
  assert.equal(result.ok, true, stableJson(result));
  const history = await writeRecoveryTestRun(directory, previous, [
    { name: "studio.build", input, result, changesState: true },
  ]);
  const recovery = await writeCreatorBuildRecovery({ ...previous, ...history });
  const proposal = await createCreatorBuildProposal({
    store: history.store,
    plan: next.plan,
    predecessor: {
      plan: await history.store.write(previous.plan),
      approval: await history.store.write(previous.approval),
      contract: await history.store.write(previous.contract),
      recovery: recovery.artifact,
    },
  });
  const artifact = await history.store.write(proposal);
  assert.deepEqual(
    (await loadCreatorBuildProposal({ store: history.store, artifact, plan: next.plan })).input,
    inputWithoutActivity(input),
  );
  assert.notEqual(previous.approval.hash, next.approval.hash);
  let calls = 0;
  const runtime = new ForgeNativeAgentRuntime({
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    complete: async () => {
      calls++;
      throw new Error("No model generation needed for eligible retained input");
    },
  });
  const built = await new LocalCreatorAgentWorker(runtime, directory).build({
    ...next,
    planApproval: next.approval,
    creatorPrompt: next.prompt,
    agentPrompt: next.prompt,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution: createAgentExecutionSlot({ purpose: "builder", ordinal: 1 }),
    buildProposal: artifact,
  });
  assert.equal(built.status, "sealed", stableJson(built));
  assert.equal(calls, 0);
  if (built.status !== "sealed") return;
  assert.equal(built.buildContract.planApprovalHash, next.approval.hash);
  assert.notEqual(built.buildContract.hash, previous.contract.hash);
  const noWrites = await writeRecoveryTestRun(directory, next, [], { initialState: 1 });
  const emptyRecovery = await writeCreatorBuildRecovery({
    ...next,
    ...noWrites,
    initialProposal: artifact,
  });
  const noWriteHost = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await noWriteHost.restoreProposal(proposal);
  const initialReview = JSON.parse(noWriteHost.restoredContext()!).review;
  assert.ok(initialReview);
  await noWriteHost.restoreRecovery(emptyRecovery.recovery);
  assert.deepEqual(JSON.parse(noWriteHost.restoredContext()!).review, initialReview);
  const host = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await host.restoreProposal(proposal);
  const repair = {
    activity: "Refine the retained module",
    summary: "Created the declared composition.",
    repairs: [
      {
        kind: "source",
        planChangeId: "new-module",
        expectedSourceHash: contentHash(input.sources[0]!.source),
        edits: [{ startLine: 2, deleteCount: 1, replacement: "return { value = 2 }\n" }],
      },
    ],
  };
  const repaired = await host.execute("studio.repair", repair);
  assert.equal(repaired.ok, true, stableJson(repaired));
  const subsequent = await writeRecoveryTestRun(
    directory,
    next,
    [
      {
        name: "studio.repair",
        input: repair,
        result: recoveryToolResult(repaired.value),
        changesState: true,
      },
    ],
    { initialState: 1 },
  );
  const retained = await writeCreatorBuildRecovery({
    ...next,
    ...subsequent,
    initialProposal: artifact,
  });
  const loaded = await loadCreatorBuildRecovery({
    ...next,
    store: history.store,
    artifact: retained.artifact,
  });
  assert.equal(loaded.calls[0]?.name, "studio.repair");
  const finalHost = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await finalHost.restoreProposal(proposal);
  await finalHost.restoreRecovery(loaded);
  assert.deepEqual(finalHost.stagedOperations(), host.stagedOperations());
  const tampered = {
    ...proposal,
    input: {
      ...proposal.input,
      sources: [{ slotId: "new-module", source: "return 'injected'\n" }],
    },
  };
  const { id: _id, hash: _hash, ...payload } = tampered;
  const digest = contentHash(stableJson(payload));
  const forged = await history.store.write({
    ...payload,
    id: "creator_build_proposal_" + digest.slice(0, 24),
    hash: digest,
  });
  await assert.rejects(
    () => loadCreatorBuildProposal({ store: history.store, artifact: forged, plan: next.plan }),
    /provenance/,
  );
  await assert.rejects(
    () => loadCreatorBuildProposal({ store: history.store, artifact, plan: previous.plan }),
    /another newly reviewed plan/,
  );
});
function inputWithoutActivity(input: {
  sources: { slotId: string; source: string }[];
  summary: string;
  activity: string;
}) {
  const { activity: _activity, ...rest } = input;
  return rest;
}

test("source-free proposals use the exact source-free build schema", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-source-free-proposal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const previous = creatorBuildRecoveryFixture();
  const next = creatorBuildRecoveryFixture();
  const host = new CreatorBuilderToolHost({ ...previous, planApproval: previous.approval });
  const input = { activity: "Create the folder", summary: "Created the approved folder." };
  const result = await host.execute("studio.build", input);
  assert.equal(result.ok, true, stableJson(result));
  const history = await writeRecoveryTestRun(directory, previous, [
    { name: "studio.build", input, result, changesState: true },
  ]);
  const recovery = await writeCreatorBuildRecovery({ ...previous, ...history });
  const proposal = await createCreatorBuildProposal({
    store: history.store,
    plan: next.plan,
    predecessor: {
      plan: await history.store.write(previous.plan),
      approval: await history.store.write(previous.approval),
      contract: await history.store.write(previous.contract),
      recovery: recovery.artifact,
    },
  });
  assert.deepEqual(proposal.input.sources, []);
  const fresh = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await fresh.restoreProposal(proposal);
  assert.equal(fresh.gate().status, "eligible");
});

test("new approval retains journaled invalid-member obligations across source proposals", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-member-source-proposal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = creatorPlanRecompilationFixture();
  const previous = authority(fixture);
  const next = authority(fixture, true);
  const before =
    "--!strict\nlocal function setVisible(instance: BasePart)\n  instance.Visible = true\nend\nreturn setVisible\n";
  const after = before.replace("instance: BasePart", "instance: any");
  const host = new CreatorBuilderToolHost({ ...previous, planApproval: previous.approval });
  const input = {
    sources: [{ slotId: "new-module", source: before }],
    summary: "Created the declared module.",
    activity: "Build the declared module",
  };
  const built = await host.execute("studio.build", input);
  assert.equal(built.ok, true, stableJson(built));
  assert.equal(host.gate().status, "rejected");
  const repair = {
    repairs: [
      {
        kind: "source",
        planChangeId: "new-module",
        expectedSourceHash: contentHash(before),
        edits: [
          {
            startLine: 2,
            deleteCount: 1,
            replacement: "local function setVisible(instance: any)\n",
          },
        ],
      },
    ],
    summary: "Changed only the receiver annotation.",
    activity: "Repair the declared module",
  };
  const repaired = await host.execute("studio.repair", repair);
  assert.equal(repaired.ok, true, stableJson(repaired));
  assert.equal(host.gate().status, "rejected", stableJson(repaired));
  const run = await writeRecoveryTestRun(directory, previous, [
    { name: "studio.build", input, result: built, changesState: true },
    { name: "studio.repair", input: repair, result: repaired, changesState: true },
  ]);
  const recovery = await writeCreatorBuildRecovery({ ...previous, ...run });
  const proposal = await createCreatorBuildProposal({
    store: run.store,
    plan: next.plan,
    predecessor: {
      plan: await run.store.write(previous.plan),
      approval: await run.store.write(previous.approval),
      contract: await run.store.write(previous.contract),
      recovery: recovery.artifact,
    },
  });
  assert.equal(proposal.input.sources[0]!.source, after);
  assert.equal(proposal.sourceMemberHistory.length, 1);
  assert.equal(proposal.sourceMemberHistory[0]!.source, before);
  const restored = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await restored.restoreProposal(proposal);
  assert.equal(restored.gate().status, "rejected", restored.restoredContext());
  assert.match(restored.restoredContext()!, /CREATOR_MEMBER_DIAGNOSTIC_RETAINED/);

  const artifact = await run.store.write(proposal);
  const emptyRun = await writeRecoveryTestRun(directory, next, [], { initialState: 1 });
  const emptyRecovery = await writeCreatorBuildRecovery({
    ...next,
    ...emptyRun,
    initialProposal: artifact,
  });
  const restarted = new CreatorBuilderToolHost({ ...next, planApproval: next.approval });
  await restarted.restoreProposal(proposal);
  await restarted.restoreRecovery(emptyRecovery.recovery);
  assert.equal(restarted.gate().status, "rejected");

  const { id: _id, hash: _hash, ...payload } = { ...proposal, sourceMemberHistory: [] };
  const hash = contentHash(stableJson(payload));
  const erased = await run.store.write({
    ...payload,
    id: "creator_build_proposal_" + hash.slice(0, 24),
    hash,
  });
  await assert.rejects(
    () => loadCreatorBuildProposal({ store: run.store, artifact: erased, plan: next.plan }),
    /provenance/,
  );
});
