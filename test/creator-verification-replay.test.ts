import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";
import type {
  CreatorSessionBundle,
  CreatorVerificationRecord,
  VerificationCharterClause,
} from "../packages/creator-session/src/index.js";
import {
  createCharterExecution,
  createVerificationFailureFacts,
  replayCreatorVerification,
  verificationEvidenceHash,
} from "../packages/creator-session/src/verification.js";
import type { StudioSnapshotObservation } from "../packages/semantic-map/src/index.js";
import {
  STUDIO_CAPABILITY_SET,
  createStudioExecutionPlan,
  type RuntimeObservationEnvelope,
} from "../packages/studio-capabilities/src/index.js";

const observation: StudioSnapshotObservation = {
  kind: "StudioSnapshotObservation",
  project: { name: "DoorControl", placeId: 0, universeId: 0 },
  capturedAt: "2026-09-01T00:00:00.000Z",
  instances: [
    {
      stableId: "forge_workspace",
      path: "Workspace",
      className: "Workspace",
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "forge_preserved",
      path: "Workspace/PreservedScenery",
      className: "Model",
      properties: [],
      attributes: [],
      tags: [],
    },
  ],
  scripts: [],
  remotes: [],
};
const clauses: VerificationCharterClause[] = [
  {
    id: "preservation",
    kind: "snapshot_check",
    check: "subtree_unchanged",
    statement: "Preserved scenery remains unchanged.",
    path: "Workspace/PreservedScenery",
    expectedClass: "Model",
    baselineHash: contentHash("intentionally-different"),
  },
  {
    id: "exists",
    kind: "studio_check",
    check: "instance_exists",
    statement: "Preserved scenery exists.",
    path: "Workspace/PreservedScenery",
    expectedClass: "Model",
  },
];

test("completed snapshot failures replay exactly without Studio or a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-replay-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const { targets, calls } = createCharterExecution(clauses);
    const plan = createStudioExecutionPlan({
      purpose: "creator_verification",
      capabilitySetId: STUDIO_CAPABILITY_SET.id,
      capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
      binding: {
        runId: "creator_replay_run",
        correlationId: "creator_replay_correlation",
        sessionId: "studio_session",
        projectId: "studio_project",
        project: observation.project,
        projectSnapshotHash: contentHash("revision"),
      },
      targets,
      calls,
      budget: { maxExecutionMs: 1000, maxResultBytes: 4096 },
    });
    const planArtifact = await store.write(plan);
    const failureFacts = createVerificationFailureFacts([
      "Preserved scenery remains unchanged.",
    ]);
    const verification: CreatorVerificationRecord = {
      kind: "CreatorVerificationRecord",
      id: "creator_verification_replay",
      hash: "a".repeat(64),
      sessionId: "creator_session_replay",
      changeSetId: "change",
      changeSetHash: "b".repeat(64),
      charterId: "charter",
      charterHash: "c".repeat(64),
      snapshotRevisionHash: contentHash("revision"),
      snapshotObservationHash: verificationEvidenceHash(observation),
      executionPlan: { id: plan.id, hash: plan.hash, artifact: planArtifact },
      status: "failed",
      failureFacts,
    };
    const bundle = {
      session: { id: verification.sessionId },
      observationHistory: [
        {
          revisionHash: verification.snapshotRevisionHash,
          observation,
        },
      ],
      plan: { charter: { clauses } },
    } as unknown as CreatorSessionBundle;
    const replay = await replayCreatorVerification(bundle, verification, store);
    assert.equal(replay.result, "exact_match");
    assert.equal(replay.replayedStatus, "failed");

    const changed = await replayCreatorVerification(
      bundle,
      { ...verification, failureFacts: [] },
      store,
    );
    assert.equal(changed.result, "mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete connector runs remain explicitly non-replayable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-replay-incomplete-"));
  try {
    const verification = {
      status: "incomplete",
      nonReplayableReason: "connector stopped",
      failureFacts: [],
      id: "verification_incomplete",
      sessionId: "creator_session_incomplete",
    } as unknown as CreatorVerificationRecord;
    const replay = await replayCreatorVerification(
      { session: { id: verification.sessionId } } as unknown as CreatorSessionBundle,
      verification,
      new ImmutableJsonArtifactStore(root),
    );
    assert.equal(replay.result, "missing_or_incomplete");
    assert.match(replay.detail, /connector stopped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime passes and failures replay exactly while missing or changed bodies fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-replay-runtime-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const runtimeClauses: VerificationCharterClause[] = [
      {
        id: "exists",
        kind: "studio_check",
        check: "instance_exists",
        statement: "Preserved scenery exists.",
        path: "Workspace/PreservedScenery",
        expectedClass: "Model",
      },
      {
        id: "diagnostics",
        kind: "studio_check",
        check: "playtest_diagnostics",
        statement: "Play Solo has no errors or warnings.",
        maximumErrors: 0,
        maximumWarnings: 0,
      },
    ];
    const { targets, calls } = createCharterExecution(runtimeClauses);
    const plan = createStudioExecutionPlan({
      purpose: "creator_verification",
      capabilitySetId: STUDIO_CAPABILITY_SET.id,
      capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
      binding: {
        runId: "creator_runtime_replay",
        correlationId: "creator_runtime_correlation",
        sessionId: "studio_session",
        projectId: "studio_project",
        project: observation.project,
        projectSnapshotHash: contentHash("runtime-revision"),
      },
      targets,
      calls,
      budget: { maxExecutionMs: 1000, maxResultBytes: 4096 },
    });
    const planArtifact = await store.write(plan);
    const envelope = (warnings: number): RuntimeObservationEnvelope => ({
      kind: "RuntimeObservationEnvelope",
      executionPlanId: plan.id,
      executionPlanHash: plan.hash,
      binding: plan.binding,
      nonce: "creator_runtime_nonce_0123456789",
      nonceCommitment: contentHash("creator_runtime_nonce_0123456789"),
      authoritative: true,
      startedAt: "2026-09-01T00:00:01.000Z",
      endedAt: "2026-09-01T00:00:02.000Z",
      durationMs: 1000,
      results: [
        {
          id: "resolve_creator_target_1",
          capability: "instance.resolve",
          targetId: "creator_target_1",
          status: "resolved",
          path: "Workspace/PreservedScenery",
          className: "Model",
        },
      ],
      diagnostics: {
        errors: 0,
        warnings,
        messageHashes: warnings > 0 ? [contentHash("warning")] : [],
        truncated: false,
      },
    });
    const passingEnvelope = envelope(0);
    const passingArtifact = await store.write(passingEnvelope);
    const base: CreatorVerificationRecord = {
      kind: "CreatorVerificationRecord",
      id: "creator_verification_runtime",
      hash: "d".repeat(64),
      sessionId: "creator_session_runtime",
      changeSetId: "change",
      changeSetHash: "e".repeat(64),
      charterId: "charter",
      charterHash: "f".repeat(64),
      snapshotRevisionHash: contentHash("runtime-revision"),
      snapshotObservationHash: verificationEvidenceHash(observation),
      executionPlan: { id: plan.id, hash: plan.hash, artifact: planArtifact },
      runtimeObservation: {
        observationHash: verificationEvidenceHash(passingEnvelope),
        diagnosticsHash: verificationEvidenceHash(passingEnvelope.diagnostics),
        artifact: passingArtifact,
      },
      status: "passed",
      failureFacts: [],
    };
    const bundle = {
      session: { id: base.sessionId },
      observationHistory: [
        { revisionHash: base.snapshotRevisionHash, observation },
      ],
      plan: { charter: { clauses: runtimeClauses } },
    } as unknown as CreatorSessionBundle;

    assert.equal(
      (await replayCreatorVerification(bundle, base, store)).result,
      "exact_match",
    );
    const { runtimeObservation: _runtimeObservation, ...missingRuntime } = base;
    assert.equal(
      (await replayCreatorVerification(bundle, missingRuntime, store)).result,
      "missing_or_incomplete",
    );

    const failingEnvelope = envelope(1);
    const failingArtifact = await store.write(failingEnvelope);
    const failureFacts = createVerificationFailureFacts([
      "Play Solo has no errors or warnings.",
    ]);
    const failed: CreatorVerificationRecord = {
      ...base,
      status: "failed",
      failureFacts,
      runtimeObservation: {
        observationHash: verificationEvidenceHash(failingEnvelope),
        diagnosticsHash: verificationEvidenceHash(failingEnvelope.diagnostics),
        artifact: failingArtifact,
      },
    };
    assert.equal(
      (await replayCreatorVerification(bundle, failed, store)).result,
      "exact_match",
    );
    assert.equal(
      (
        await replayCreatorVerification(
          bundle,
          {
            ...failed,
            runtimeObservation: {
              ...failed.runtimeObservation!,
              observationHash: base.runtimeObservation!.observationHash,
            },
          },
          store,
        )
      ).result,
      "mismatch",
    );

    const changedPlan = createStudioExecutionPlan({
      purpose: plan.purpose,
      capabilitySetId: plan.capabilitySetId,
      capabilitySetHash: plan.capabilitySetHash,
      binding: plan.binding,
      targets: plan.targets.map((target) => ({
        ...target,
        path: "Workspace/ChangedTarget",
        expectedClass: "Folder",
      })),
      calls: plan.calls,
      budget: plan.budget,
    });
    const changedPlanArtifact = await store.write(changedPlan);
    assert.equal(
      (
        await replayCreatorVerification(
          bundle,
          {
            ...base,
            executionPlan: {
              id: changedPlan.id,
              hash: changedPlan.hash,
              artifact: changedPlanArtifact,
            },
          },
          store,
        )
      ).result,
      "mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
