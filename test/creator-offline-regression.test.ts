import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import {
  captureCreatorOfflineRegression,
  replayCreatorOfflineRegression,
  CREATOR_REGRESSION_BOUNDS,
  type CreatorOfflineRegression,
} from "../packages/creator-session/src/offline-regression.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import {
  createAgentExecutionSlot,
  AgentExecutionJournalStore,
  createRequestIntentCheckpoint,
  type AgentExecutionBoundaryState,
} from "../packages/agent-runtime/src/index.js";
import {
  createStudioProjectIndexProjection,
  createStudioProjectIndexCapture,
  createStudioProjectEvidenceShard,
  studioProjectIndexMetadataView,
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
} from "../packages/studio-evidence/src/index.js";

async function fixture(directory: string, failure = true) {
  const store = new ImmutableJsonArtifactStore(directory);
  const project = { name: "Offline host failure fixture", placeId: 0, universeId: 0 };
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "a".repeat(64),
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const capture = createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes: [] })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-05T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const binding = await writeCreatorProjectIndexArtifacts(store, capture);
  const ownership = createStudioOwnershipMap({
    projectId: "offline-regression",
    revisionHash: capture.revision.hash,
    projectIndex: studioProjectIndexMetadataView(capture),
  });
  let session = createCreatorSession({
    id: "creator_session_offline_fixture",
    prompt: "Create an ordinary utility module",
    projectId: ownership.projectId,
    ownership,
    revisionHash: capture.revision.hash,
    projectCaptureHash: capture.hash,
    now: new Date("2026-09-05T00:00:00.000Z"),
  });
  if (failure)
    session = advanceSession(session, {
      status: "incomplete",
      failure: { code: "FIXTURE_HOST_FAILURE", detail: "Recorded host preparation failure" },
      now: new Date("2026-09-05T00:00:01Z"),
    });
  const creatorRequest = await store.write({
    kind: "CreatorRequest",
    sessionId: session.id,
    promptHash: session.promptHash,
    creatorText: "Create an ordinary utility module",
    agentPrompt: "Create an ordinary utility module",
    contextCitations: [],
  });
  const bundle: CreatorSessionBundle = {
    session,
    ownership,
    creatorRequest,
    projectIndices: [binding],
    projectChanges: [],
    projectRefreshes: [],
    rojoSourceMutations: [],
    sourceWriteBlobs: [],
    sourceIndices: [],
    sourceConsultations: [],
    buildContracts: [],
    approvals: [],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [],
  };
  return { store, bundle };
}
function boundary(): AgentExecutionBoundaryState {
  return {
    runtimeStartedAt: "2026-09-05T00:00:00.000Z",
    usage: {
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    trialStarted: false,
    remaining: {
      turns: 32,
      toolCalls: 256,
      toolResultBytes: 4194304,
      durationMs: 1800000,
      inputTokens: 1000000,
      outputTokens: 128000,
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

test("failed generation capture retains an immutable same-store closure and replays without execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory);
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  assert.deepEqual(
    await captureCreatorOfflineRegression({ store, bundle }),
    captured,
    "same evidence deduplicates to the same immutable manifest",
  );
  assert.equal(captured.manifest.closure.status, "complete");
  assert.equal((await stat(join(directory, captured.pointer.locator))).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, captured.pointer.locator), "utf8")).manifest,
    captured.artifact,
  );
  assert.ok(captured.manifest.closure.references.length > 4);
  assert.equal(captured.manifest.classification.sessionFailure!.code, "FIXTURE_HOST_FAILURE");
  const originalHash = bundle.session.hash;
  bundle.session.hash = "f".repeat(64);
  assert.equal(
    (await store.read<CreatorSessionBundle>(captured.manifest.bundle)).session.hash,
    originalHash,
  );
  const replay = await replayCreatorOfflineRegression({ artifact: captured.artifact, store });
  assert.equal(replay.result, "exact_match", JSON.stringify(replay));
  assert.ok(
    replay.checks.some(
      (check) => check.kind === "host_bundle_contracts" && check.result === "exact_match",
    ),
  );
  assert.match(replay.limitations.join(" "), /not a portable export/);
});

test("regression captures the real journal hash chain and nested diagnostic evidence without fabricating an AgentRun", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory);
  const execution = createAgentExecutionSlot({
    purpose: "planner",
    ordinal: 1,
    agentRunId: "agent_run_offline_fixture",
  });
  const journal = new AgentExecutionJournalStore(store);
  await journal.append(
    execution.journalId,
    createRequestIntentCheckpoint(
      1,
      "2026-09-05T00:00:00.000Z",
      {
        model: "fixture/model",
        system: "ordinary host request fixture",
        messages: [{ role: "user", content: "Record only; no provider is called" }],
        tools: [],
        maxOutputTokens: 64,
        timeoutMs: 1000,
      },
      boundary(),
    ),
  );
  const nested = await store.write({
    kind: "OfflineDiagnosticLeaf",
    text: "return require('must never execute')",
  });
  const failure = {
    stage: "preparation" as const,
    code: "FIXTURE_HOST_FAILURE",
    detail: "Recorded host preparation failure",
  };
  bundle.preparationFailure = {
    execution,
    failure,
    diagnostic: await store.write({
      kind: "CreatorPreparationDiagnostic",
      execution,
      failure,
      nested,
    }),
  };
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  const loaded = await journal.load(execution.journalId);
  assert.ok(
    captured.manifest.closure.references.some(
      (row) => row.artifact.artifactHash === loaded.head.entry.artifactHash,
    ),
  );
  assert.ok(
    captured.manifest.closure.references.some(
      (row) => row.artifact.artifactHash === nested.artifactHash,
    ),
  );
  assert.equal(captured.manifest.journals.length, 1);
  assert.equal(bundle.agentRuns.length, 0);
  await rm(join(directory, "agent-execution-journals"), { recursive: true });
  const replay = await replayCreatorOfflineRegression({ artifact: captured.artifact, store });
  assert.equal(replay.result, "exact_match", JSON.stringify(replay));
  assert.ok(
    replay.checks.some(
      (check) => check.kind === "execution_journal" && check.result === "exact_match",
    ),
  );
});

test("coordinator persistence automatically indexes a preparation failure after writing its durable bundle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-coordinator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory, false);
  let notifications = 0;
  // Exercise the production persistence queue without constructing a worker,
  // provider, or Studio bridge. None is needed to retain failed host evidence.
  const coordinator = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    bundlePersistQueues: new Map(),
    bundles: new Map(),
    artifactStore: store,
    input: { directory },
    emit: () => {
      notifications++;
    },
  }) as { persist(value: CreatorSessionBundle): Promise<CreatorSessionBundle> };
  await coordinator.persist(bundle);
  await assert.rejects(readdir(join(directory, "offline-regressions")), { code: "ENOENT" });
  const execution = createAgentExecutionSlot({
    purpose: "planner",
    ordinal: 1,
    agentRunId: "agent_run_preparation_failure",
  });
  const failure = {
    stage: "preparation" as const,
    code: "BUILD_PREPARATION_FAILED",
    detail: "Unable to prepare before any provider request.",
  };
  const failed: CreatorSessionBundle = {
    ...bundle,
    session: advanceSession(bundle.session, { status: "incomplete", failure }),
    preparationFailure: {
      execution,
      failure,
      diagnostic: await store.write({ kind: "CreatorPreparationDiagnostic", execution, failure }),
    },
  };
  const persisted = await coordinator.persist(failed);
  const pointers = await readdir(join(directory, "offline-regressions"));
  assert.equal(pointers.length, 1);
  const pointer = JSON.parse(
    await readFile(join(directory, "offline-regressions", pointers[0]!), "utf8"),
  );
  const manifest = await store.read<CreatorOfflineRegression>(pointer.manifest);
  const durable = JSON.parse(await readFile(join(directory, `${bundle.session.id}.json`), "utf8"));
  assert.deepEqual(durable, persisted);
  assert.deepEqual(await store.read(manifest.bundle), durable);
  assert.equal(manifest.classification.preparation!.code, failure.code);
  assert.equal(manifest.classification.preparation!.detailHash, contentHash(failure.detail));
  assert.equal(durable.agentRuns.length, 0);
  assert.equal(notifications, 2);
  const replay = await replayCreatorOfflineRegression({ artifact: pointer.manifest, store });
  assert.equal(replay.result, "incomplete", "no journal exists before the first request intent");
  assert.ok(
    replay.checks.some(
      (check) => check.kind === "execution_journal" && check.result === "incomplete",
    ),
  );
});

test("missing leaves remain incomplete and changed failure classification is a mismatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory);
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  if (captured.status !== "captured") assert.fail("expected fixture");
  const { hash: _hash, id: _id, ...payload } = captured.manifest;
  payload.classification = {
    ...payload.classification,
    sessionFailure: { code: "DIFFERENT_FAILURE", detailHash: contentHash("different") },
  };
  const hash = contentHash(stableJson(payload));
  const forged = await store.write({
    ...payload,
    hash,
    id: "creator_regression_" + hash.slice(0, 24),
  });
  assert.equal(
    (await replayCreatorOfflineRegression({ artifact: forged, store })).result,
    "mismatch",
  );
  await rm(join(directory, bundle.creatorRequest.locator));
  assert.equal(
    (await replayCreatorOfflineRegression({ artifact: captured.artifact, store })).result,
    "incomplete",
  );
  const partial = await captureCreatorOfflineRegression({ store, bundle });
  if (partial.status !== "captured") assert.fail("expected failed capture");
  assert.equal(partial.manifest.closure.status, "incomplete");
  assert.equal(
    JSON.stringify(partial.manifest).includes(directory),
    false,
    "artifact diagnostics redact the host store path",
  );
});

test("nonfailed sessions are not regressions and closure budgets fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory, false);
  assert.deepEqual(await captureCreatorOfflineRegression({ store, bundle }), {
    status: "not_failed",
  });
  bundle.session = advanceSession(bundle.session, {
    status: "incomplete",
    failure: { code: "FIXTURE_HOST_FAILURE", detail: "Recorded host preparation failure" },
  });
  const execution = createAgentExecutionSlot({ purpose: "planner", ordinal: 1 });
  const failure = {
    stage: "preparation" as const,
    code: "FIXTURE_HOST_FAILURE",
    detail: "Recorded host preparation failure",
  };
  const huge = {
    locator: "artifacts/" + "f".repeat(64) + ".json",
    artifactHash: "f".repeat(64),
    bytes: CREATOR_REGRESSION_BOUNDS.maximumAggregateBytes + 1,
  };
  bundle.preparationFailure = {
    execution,
    failure,
    diagnostic: await store.write({
      kind: "CreatorPreparationDiagnostic",
      execution,
      failure,
      huge,
    }),
  };
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  if (captured.status !== "captured") assert.fail("expected fixture");
  assert.equal(captured.manifest.closure.status, "incomplete");
  assert.match(captured.manifest.closure.issues.join(" "), /resource bound/);
});

test("regression CLI resolves an exact artifact hash and rejects absent or unsafe inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory);
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  if (captured.status !== "captured") assert.fail("expected fixture");
  const cli = fileURLToPath(new URL("../packages/cli/src/index.js", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "creator", "replay-regression", ...args], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
  const replay = run(captured.artifact.artifactHash, "--session-dir", directory);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).result, "exact_match");
  assert.equal(run("f".repeat(64), "--session-dir", directory).status, 2);
  assert.equal(run("../unsafe").status, 2);
  assert.match(run().stderr, /Usage:/);
});

test("regression discovery rejects symlink replacement instead of following or overwriting it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-regression-pointer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle } = await fixture(directory);
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  if (captured.status !== "captured") assert.fail("expected fixture");
  await rm(join(directory, captured.pointer.locator));
  await symlink(
    join(directory, captured.artifact.locator),
    join(directory, captured.pointer.locator),
  );
  await assert.rejects(
    captureCreatorOfflineRegression({ store, bundle }),
    /ELOOP|symbolic|symlink/,
  );
  await store.verify(captured.artifact);
});
