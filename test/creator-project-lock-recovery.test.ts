import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import {
  CreatorConversationStore,
  sealCreatorWorkEpisode,
  sealCreatorWorkJob,
  type LoadedCreatorConversation,
  type CreatorWorkEpisode,
  type CreatorWorkJob,
} from "../packages/creator-conversation/src/index.js";
import {
  createCreatorSession,
  advanceSession,
  createStudioOwnershipMap,
  assertCreatorSessionBundle,
  type CreatorSessionBundle,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import {
  createIncompleteCreatorMutationAttempt,
  createMutationFailureFacts,
} from "../packages/creator-session/src/mutation-evidence.js";

const NOW = "2026-09-05T09:00:00.000Z";
const MODEL = "openai/gpt-5.6-luna";
const REVISION = contentHash("synthetic project revision");
const CAPTURE = contentHash("synthetic project capture");
const CONVERSATION = "creator_conversation_project_lock";

// Exercise the real lock decision with its real immutable reader. Full conversation
// append/recovery topology has a separate suite; this projection reads only jobs/episodes.
const predicate = (
  CreatorConversationCoordinator.prototype as unknown as {
    hasUnfinishedAgentWork: (conversation: LoadedCreatorConversation) => Promise<boolean>;
  }
).hasUnfinishedAgentWork;

async function fixture(directory: string) {
  const store = new CreatorConversationStore(directory);
  const leaf = await store.artifactStore.write({ kind: "TestOwnedRecoveryLeaf", value: "fixed" });
  const ownership = createStudioOwnershipMap({
    projectId: "project-lock-test",
    revisionHash: REVISION,
    projectIndex: {
      project: { name: "Synthetic recovery project", placeId: 0, universeId: 0 },
      revision: { hash: REVISION } as CreatorProjectIndexView["revision"],
      instances: [],
      scripts: [],
    },
  });
  const initial = createCreatorSession({
    id: "creator_session_project_lock",
    prompt: "Inspect an ordinary project.",
    projectId: ownership.projectId,
    revisionHash: REVISION,
    projectCaptureHash: CAPTURE,
    ownership,
    model: MODEL,
    now: new Date(NOW),
  });
  const session = advanceSession(initial, {
    status: "incomplete",
    now: new Date(NOW),
    failure: {
      code: "control_process_interrupted",
      detail: "Interrupted before mutation authority.",
    },
  });
  const capture = {
    captureId: "capture-project-lock",
    captureHash: CAPTURE,
    detectorEpoch: 0,
    projection: { id: "projection-project-lock", hash: contentHash("projection"), artifact: leaf },
    manifest: { id: "manifest-project-lock", hash: contentHash("manifest"), artifact: leaf },
    revision: { id: "revision-project-lock", hash: REVISION, artifact: leaf },
    shards: [],
    sourceManifests: [],
    sourceChunks: [],
  };
  const bundle: CreatorSessionBundle = {
    session,
    creatorRequest: leaf,
    ownership,
    projectIndices: [capture],
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
  assertCreatorSessionBundle(bundle);
  const job = sealCreatorWorkJob({
    id: "creator_job_interrupted_builder",
    conversationId: CONVERSATION,
    episodeId: "creator_episode_project_lock",
    idempotencyKey: "project-lock-request-0001",
    requestHash: leaf.artifactHash,
    admittedRequest: leaf,
    admissionAuthority: leaf,
    agentExecutions: [
      {
        purpose: "builder",
        ordinal: 1,
        agentRunId: "agent_run_project_lock",
        journalId: "agent_execution_journal:agent_run_project_lock",
      },
    ],
    jobType: "agent_action",
    status: "outcome_unknown",
    phase: "interrupted",
    providerOutcome: "outcome_unknown",
    selectedModelId: MODEL,
    failure: {
      code: "provider_outcome_unknown",
      detailHash: contentHash("Provider response was not retained."),
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const snapshotFor = (value: CreatorSessionBundle) => ({
    kind: "CreatorSessionEvidenceSnapshot",
    id: value.session.id,
    sessionHash: value.session.hash,
    bundle: value,
  });
  const episodeFor = async (snapshot: unknown): Promise<CreatorWorkEpisode> => {
    const artifact = await store.artifactStore.write(snapshot);
    return sealCreatorWorkEpisode({
      id: job.episodeId!,
      conversationId: CONVERSATION,
      ordinal: 1,
      status: "incomplete",
      selectedModelId: MODEL,
      initialProjectRevisionHash: REVISION,
      currentProjectRevisionHash: REVISION,
      sessionBundle: { id: session.id, hash: artifact.artifactHash, artifact },
      creatorTurnId: "creator_turn_project_lock",
      createdAt: NOW,
      updatedAt: NOW,
    });
  };
  const episode = await episodeFor(snapshotFor(bundle));
  const probe = (
    episodes: readonly CreatorWorkEpisode[] = [episode],
    jobs: readonly CreatorWorkJob[] = [job],
  ) => predicate.call({ store }, { episodes, jobs } as unknown as LoadedCreatorConversation);
  return { store, bundle, initial, job, episode, episodeFor, snapshotFor, probe, leaf, capture };
}

test("immutable terminal pre-mutation builder releases project through the episode binding without rewriting unknown evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-project-lock-positive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(directory);
  assert.equal(f.job.transactionSessionId, undefined);
  const before = stableJson({ job: f.job, episode: f.episode, bundle: f.bundle });
  assert.equal(await f.probe(), false);
  assert.equal(stableJson({ job: f.job, episode: f.episode, bundle: f.bundle }), before);
  assert.equal(f.job.providerOutcome, "outcome_unknown");
  // A fresh store reader must make the same decision solely from retained evidence.
  const fresh = new CreatorConversationStore(directory);
  assert.equal(
    await predicate.call({ store: fresh }, {
      jobs: [f.job],
      episodes: [f.episode],
    } as unknown as LoadedCreatorConversation),
    false,
  );
  assert.deepEqual(
    await fresh.artifactStore.read(f.episode.sessionBundle.artifact),
    f.snapshotFor(f.bundle),
  );
});

test("missing, corrupted and mismatched terminal snapshot evidence keeps the project locked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-project-lock-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(directory);
  assert.equal(await f.probe([]), true, "missing episode");
  const mismatched = {
    ...f.episode,
    sessionBundle: { ...f.episode.sessionBundle, hash: contentHash("wrong binding") },
  };
  assert.equal(await f.probe([mismatched]), true, "semantic artifact hash mismatch");
  const snapshot = f.snapshotFor(f.bundle);
  for (const [label, value] of [
    ["wrong kind", { ...snapshot, kind: "UnrelatedSnapshot" }],
    ["wrong snapshot identity", { ...snapshot, id: "creator_session_unrelated" }],
    ["wrong session hash", { ...snapshot, sessionHash: contentHash("unrelated session") }],
    ["malformed bundle", { ...snapshot, bundle: { ...f.bundle, projectIndices: [] } }],
    ["no bundle", { kind: snapshot.kind, id: snapshot.id, sessionHash: snapshot.sessionHash }],
  ] as const)
    assert.equal(await f.probe([await f.episodeFor(value)]), true, label);
  const path = join(directory, f.episode.sessionBundle.artifact.locator);
  await chmod(path, 0o600);
  await writeFile(path, '{"corrupt":true}\n');
  assert.equal(await f.probe(), true, "corrupted content-addressed bytes");
  await rm(path);
  assert.equal(await f.probe(), true, "missing content-addressed artifact");
});

test("nonterminal sessions, different causes and unrelated execution work remain locked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-project-lock-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(directory);
  const differentCause = advanceSession(f.initial, {
    status: "incomplete",
    now: new Date(NOW),
    failure: { code: "other_failure", detail: "Not an interrupted control process." },
  });
  for (const session of [f.initial, differentCause]) {
    const bundle = { ...f.bundle, session };
    assertCreatorSessionBundle(bundle);
    assert.equal(await f.probe([await f.episodeFor(f.snapshotFor(bundle))]), true);
  }
  for (const patch of [
    { status: "building" as const },
    { currentProjectRevisionHash: contentHash("different revision") },
    { sessionBundle: { ...f.episode.sessionBundle, id: "creator_session_another" } },
  ])
    assert.equal(await f.probe([{ ...f.episode, ...patch }]), true);
  for (const patch of [
    { status: "running" as const, providerOutcome: "intent_persisted" as const },
    { failure: { code: "other_failure", detailHash: contentHash("other") } },
    { agentExecutions: [{ ...f.job.agentExecutions[0]!, purpose: "planner" as const }] },
    {
      agentExecutions: [
        ...f.job.agentExecutions,
        {
          ...f.job.agentExecutions[0]!,
          ordinal: 2,
          agentRunId: "agent_run_extra",
          journalId: "agent_execution_journal:agent_run_extra",
        },
      ],
    },
  ])
    assert.equal(await f.probe([f.episode], [{ ...f.job, ...patch }]), true);
  assert.equal(
    await f.probe(
      [f.episode],
      [
        f.job,
        {
          ...f.job,
          id: "creator_job_active",
          status: "running",
          providerOutcome: "intent_persisted",
        },
      ],
    ),
    true,
    "one releasable historical builder cannot release another active job",
  );
});

test("a valid retained preflight mutation attempt prevents terminal-builder project release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-project-lock-mutation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(directory);
  const binding = { hash: f.leaf.artifactHash, artifact: f.leaf };
  const attempt = createIncompleteCreatorMutationAttempt("mutation-attempt-retained", {
    sessionId: f.bundle.session.id,
    manifest: binding,
    attestation: { projection: binding, envelope: binding },
    changeSet: binding,
    projection: binding,
    preflightProjection: binding,
    beforeIndexCapture: f.capture,
    failureFacts: createMutationFailureFacts([
      { code: "fixture_preflight_stopped", detail: "Synthetic preflight was retained." },
    ]),
  });
  const bundle = { ...f.bundle, mutationAttempts: [attempt] };
  assertCreatorSessionBundle(bundle);
  assert.equal(await f.probe([await f.episodeFor(f.snapshotFor(bundle))]), true);
  // Malformed or incomplete authority-bearing history also fails closed instead of being ignored.
  for (const field of [
    "changeSets",
    "rojoSourceMutations",
    "gameBuilds",
    "verifications",
  ] as const) {
    const invalid = { ...f.bundle, [field]: [{}] };
    assert.equal(
      await f.probe([await f.episodeFor({ ...f.snapshotFor(f.bundle), bundle: invalid })]),
      true,
      field,
    );
  }
  for (const field of ["activeMutation", "closedMutation", "checkpoint"] as const) {
    const invalid = { ...f.bundle, [field]: {} };
    assert.equal(
      await f.probe([await f.episodeFor({ ...f.snapshotFor(f.bundle), bundle: invalid })]),
      true,
      field,
    );
  }
});
