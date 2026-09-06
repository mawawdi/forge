import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  AgentExecutionJournalStore,
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  createAgentExecutionSlot,
} from "../packages/agent-runtime/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  CreatorBuilderToolHost,
  advanceSession,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import {
  loadCreatorBuildRecovery,
  writeCreatorBuildRecovery,
} from "../packages/creator-session/src/build-recovery.js";
import {
  CreatorSessionCoordinator,
  creatorBuildRetryAvailable,
} from "../packages/creator-session/src/coordinator.js";
import { LocalCreatorAgentWorker } from "../packages/creator-session/src/worker.js";
import {
  creatorBuildRecoveryFixture,
  recoveryToolResult,
  writeRecoveryTestRun,
  RECOVERY_MODEL_DESCRIPTOR,
} from "./helpers/creator-build-recovery-fixture.js";

type Authority = ReturnType<typeof creatorBuildRecoveryFixture>;
const source = (index: number) => `--!strict\nreturn { value = ${index} }\n`;
function builder(authority: Authority) {
  return new CreatorBuilderToolHost({ ...authority, planApproval: authority.approval });
}
function buildInput(authority: Authority) {
  const sources = authority.plan.compiled.inventory
    .filter((item) => item.source)
    .map((item, index) => ({ slotId: item.id, source: source(index) }));
  return {
    activity: "Build the approved sources.",
    ...(sources.length ? { sources } : {}),
    summary: "Created the approved modules.",
  };
}
async function retained(directory: string, authority: Authority) {
  const host = builder(authority);
  const input = buildInput(authority);
  const result = await host.execute("studio.build", input);
  assert.equal(result.ok, true, stableJson(result));
  assert.equal(host.gate().status, "eligible", stableJson(result));
  // The preceding analyzer reported duplicated diagnostics. They are historical;
  // the exact operation/source receipts remain valid under the current analyzer.
  const value = structuredClone(result.value) as Record<string, unknown>;
  value.review = {
    localGate: { status: "rejected", issueHashes: [contentHash("old-duplicate-diagnostic")] },
  };
  const history = await writeRecoveryTestRun(directory, authority, [
    { name: "studio.build", input, result: recoveryToolResult(value), changesState: true },
  ]);
  const saved = await writeCreatorBuildRecovery({ ...authority, ...history });
  return { host, input, history, ...saved };
}

test("verified four-source recovery rechecks current diagnostics and seals with zero provider calls", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-builder-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 4 });
  const saved = await retained(directory, authority);
  let providerCalls = 0;
  const runtime = new ForgeNativeAgentRuntime({
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    complete: async () => {
      providerCalls++;
      throw new Error("Restored eligible work must not request a model turn");
    },
  });
  const execution = createAgentExecutionSlot({ purpose: "builder", ordinal: 2 });
  const result = await new LocalCreatorAgentWorker(runtime, directory).build({
    ...authority,
    planApproval: authority.approval,
    creatorPrompt: authority.prompt,
    agentPrompt: authority.prompt,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution,
    buildRecovery: saved.artifact,
  });
  assert.equal(result.status, "sealed", stableJson(result));
  assert.equal(providerCalls, 0);
  if (result.status !== "sealed") return;
  assert.equal(result.summary, saved.input.summary);
  assert.equal(result.buildContract.hash, authority.contract.hash);
  assert.deepEqual(result.sourceWriteBlobs, saved.host.stagedSourceWriteBlobs());
  assert.deepEqual(result.graph.operations, saved.host.sealedGraph().operations);
  const journal = await new AgentExecutionJournalStore(
    new ImmutableJsonArtifactStore(directory),
  ).load(execution.journalId);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.checkpoint.checkpointType, "terminal");
  const run = (await saved.history.store.read(result.evidence.agentRun)) as {
    usage: unknown;
    modelTurns: unknown[];
  };
  assert.equal(run.modelTurns.length, 0);
});

test("a second failed retry restores original sources plus exact repairs without replaying provider requests", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-builder-lineage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 4 });
  const first = await retained(directory, authority);
  const retry = builder(authority);
  await retry.restoreRecovery(first.recovery);
  const input = {
    activity: "Update the declared module value.",
    repairs: [
      {
        kind: "source",
        planChangeId: "source-0",
        expectedSourceHash: contentHash(source(0)),
        edits: [{ startLine: 2, deleteCount: 1, replacement: "return { value = 42 }\n" }],
      },
    ],
    summary: "Created the modules and updated the requested value.",
  };
  const result = await retry.execute("studio.repair", input);
  assert.equal(result.ok, true, stableJson(result));
  const second = await writeRecoveryTestRun(
    directory,
    authority,
    [{ name: "studio.repair", input, result, changesState: true }],
    { initialState: 1, rejectedRun: true },
  );
  const saved = await writeCreatorBuildRecovery({
    ...authority,
    ...second,
    priorRecovery: first.artifact,
  });
  const loaded = await loadCreatorBuildRecovery({
    ...authority,
    store: second.store,
    artifact: saved.artifact,
  });
  const restored = builder(authority);
  await restored.restoreRecovery(loaded);
  assert.deepEqual(restored.stagedOperations(), retry.stagedOperations());
  assert.deepEqual(restored.stagedSourceWriteBlobs(), retry.stagedSourceWriteBlobs());
  assert.equal(restored.resultSummary(), input.summary);
  assert.equal(restored.completionStatus().ready, true);
  assert.equal(loaded.calls.length, 2);
  assert.equal(loaded.sourceRuns.length, 2);
  await assert.rejects(restored.restoreRecovery(loaded), /fresh virtual builder/);
});

test("a rejected restored draft is supplied to the fresh builder for a bounded repair", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-recovery-repair-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 4 });
  const initial = builder(authority);
  const input = buildInput(authority);
  const invalid = "--!strict\nreturn undeclaredRecoveryValue\n";
  input.sources![0]!.source = invalid;
  const staged = await initial.execute("studio.build", input);
  assert.equal(staged.ok, true, stableJson(staged));
  assert.equal(initial.gate().status, "rejected", stableJson(staged));
  const history = await writeRecoveryTestRun(directory, authority, [
    { name: "studio.build", input, result: staged, changesState: true },
  ]);
  const saved = await writeCreatorBuildRecovery({ ...authority, ...history });
  let calls = 0;
  const runtime = new ForgeNativeAgentRuntime({
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    complete: async (request) => {
      calls++;
      assert.match(request.system, /forge_build_recovery/);
      assert.match(request.system, /undeclaredRecoveryValue/);
      const toolCalls = [
        {
          id: "repair-restored-source",
          name: "studio.repair",
          arguments: {
            activity: "Repair the retained source diagnostic.",
            repairs: [
              {
                kind: "source",
                planChangeId: "source-0",
                expectedSourceHash: contentHash(invalid),
                edits: [{ startLine: 2, deleteCount: 1, replacement: "return { value = 0 }\n" }],
              },
            ],
            summary: "Repaired the preserved source and completed the approved build.",
          },
        },
      ];
      return {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls },
        stopReason: "tool_calls",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: 0,
        },
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash(stableJson(toolCalls)),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "offline",
          responseId: "fixture-repair",
          latencyMs: 1,
          retryCount: 0,
          finishReason: "tool-calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  });
  const result = await new LocalCreatorAgentWorker(runtime, directory).build({
    ...authority,
    planApproval: authority.approval,
    creatorPrompt: authority.prompt,
    agentPrompt: authority.prompt,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution: createAgentExecutionSlot({ purpose: "builder", ordinal: 2 }),
    buildRecovery: saved.artifact,
  });
  assert.equal(result.status, "sealed", stableJson(result));
  assert.equal(calls, 1);
  if (result.status !== "sealed") return;
  const expected = builder(authority);
  await expected.execute("studio.build", buildInput(authority));
  assert.deepEqual(result.sourceWriteBlobs, expected.stagedSourceWriteBlobs());
  assert.equal(result.buildContract.hash, authority.contract.hash);
});

test("recovery receipt tampering fails preparation before any model request or fresh journal", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-recovery-tamper-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture();
  const saved = await retained(directory, authority);
  const { id: _id, hash: _hash, ...payload } = structuredClone(saved.recovery);
  payload.calls[0]!.expectedChanges[0]!.operationHash = contentHash("altered receipt");
  const hash = contentHash(stableJson(payload));
  const artifact = await saved.history.store.write({
    ...payload,
    id: `creator_build_recovery_${hash.slice(0, 24)}`,
    hash,
  });
  let calls = 0;
  const runtime = new ForgeNativeAgentRuntime({
    descriptor: RECOVERY_MODEL_DESCRIPTOR,
    complete: async () => {
      calls++;
      throw new Error("Invalid recovery reached provider");
    },
  });
  const execution = createAgentExecutionSlot({ purpose: "builder", ordinal: 2 });
  const result = await new LocalCreatorAgentWorker(runtime, directory).build({
    ...authority,
    planApproval: authority.approval,
    creatorPrompt: authority.prompt,
    agentPrompt: authority.prompt,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution,
    buildRecovery: artifact,
  });
  assert.equal(result.status, "preparation_failed");
  assert.equal(calls, 0);
  assert.equal(await saved.history.journals.loadIfPresent(execution.journalId), undefined);
});

test("retry offers same-approval recovery only before native or Rojo writes and rechecks the current project", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-retry-admission-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture();
  const saved = await retained(directory, authority);
  let session = advanceSession(authority.session, { status: "planning" });
  session = advanceSession(session, { status: "awaiting_plan_approval", plan: authority.plan });
  session = advanceSession(session, { status: "building", approval: authority.approval });
  session = advanceSession(session, {
    status: "incomplete",
    failure: { code: "OFFLINE_FAILURE", detail: "An offline fixture stopped." },
  });
  const bundle = {
    ...authority,
    session,
    approvals: [authority.approval],
    buildContracts: [authority.contract],
    mutationAttempts: [],
    rojoSourceMutations: [],
    changeSets: [],
    agentRuns: [
      {
        phase: "creator_builder",
        agentRunId: saved.history.run.id,
        agentRun: saved.history.priorRun,
        buildContract: authority.expected.buildContract,
        outcome: saved.history.run.creatorPhaseOutcome,
      },
    ],
  } as unknown as CreatorSessionBundle;
  assert.equal(creatorBuildRetryAvailable(bundle), true);
  for (const unsafe of [
    { activeMutation: {} },
    { closedMutation: {} },
    { mutationAttempts: [{}] },
    { rojoSourceMutations: [{}] },
    { changeSets: [{}] },
    { gameBuilds: [{}] },
    { approvals: [{ ...authority.approval, artifactHash: contentHash("different-plan") }] },
    { agentRuns: [{ ...bundle.agentRuns[0], outcome: { status: "sealed" } }] },
  ])
    assert.equal(
      creatorBuildRetryAvailable({ ...bundle, ...unsafe } as CreatorSessionBundle),
      false,
    );
  const capture = {
    hash: authority.session.currentProjectCaptureHash,
    revision: {
      hash: authority.plan.projectRevisionHash,
      manifestHash: contentHash("manifest"),
      merkleRoot: contentHash("merkle"),
      connectorEpoch: "same-epoch",
    },
    indexManifest: {
      project: authority.projectIndex.project,
      allShardHashes: [],
      sourceManifestHashes: [],
    },
  };
  let current = structuredClone(capture);
  let builds = 0;
  let persisted: CreatorSessionBundle | undefined;
  const harness = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    artifactStore: saved.history.store,
    bundles: new Map([[session.id, bundle]]),
    currentAttestedStudioSession: async () => ({ projectId: authority.session.projectId }),
    requireClearRecordingInventory: async () => undefined,
    collectProjectIndex: async () => current,
    captureForBundle: async () => capture,
    persist: async (value: CreatorSessionBundle) => {
      persisted = value;
    },
    decidePlan: async (
      value: CreatorSessionBundle,
      hash: string,
      _decision: string,
      _execution: unknown,
      approval: unknown,
    ) => {
      builds++;
      assert.equal(hash, authority.plan.hash);
      assert.deepEqual(approval, authority.approval);
      assert.deepEqual(value.buildContracts, [authority.contract]);
      assert.ok(value.buildRecovery);
      assert.deepEqual(value.buildRecovery, persisted?.buildRecovery);
      return "restored";
    },
    requireBuildRefresh: async () => "refresh",
    recordPreparationFailure: async (_bundle: unknown, _execution: unknown, failure: unknown) => {
      throw new Error(stableJson(failure));
    },
  }) as {
    retryBuild(
      bundle: CreatorSessionBundle,
      execution: ReturnType<typeof createAgentExecutionSlot>,
    ): Promise<unknown>;
  };
  assert.equal(
    await harness.retryBuild(bundle, createAgentExecutionSlot({ purpose: "builder", ordinal: 2 })),
    "restored",
  );
  current = {
    ...capture,
    revision: { ...capture.revision, merkleRoot: contentHash("external-edit") },
  };
  assert.equal(
    await harness.retryBuild(bundle, createAgentExecutionSlot({ purpose: "builder", ordinal: 3 })),
    "refresh",
  );
  assert.equal(builds, 1);
});
