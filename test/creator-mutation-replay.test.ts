import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  compileMutationEvidenceProjection,
  compileProjectStateProjection,
  createStudioEvidenceEnvelope,
  createStudioEvidenceProjection,
  createStudioStateRevision,
  studioEvidenceFactKey,
  type StudioEvidenceEnvelope,
  type StudioEvidenceFact,
  type StudioEvidenceProjection,
} from "../packages/studio-evidence/src/index.js";
import {
  createMutationFailureFacts,
  createIncompleteCreatorMutationAttempt,
  createIncompleteApplyMutationAttempt,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  adaptCreatorChangeSetMutationOperations,
  compileCreatorChangeSetMutationProjection,
  creatorMutationCreateStableId,
  reconcileCreatorMutation,
  replayCreatorMutation,
  type CreatorMutationChangeSetLike,
} from "../packages/creator-session/src/mutation-evidence.js";
import type { CreatorChangeSet } from "../packages/creator-session/src/index.js";

const project = { name: "MutationEvidence", placeId: 0, universeId: 0 } as const;
const target = {
  kind: "instance" as const,
  stableId: "door-folder",
  path: "Workspace/Door",
  className: "Folder",
};
const changeSetHash = "a".repeat(64);
const binding = {
  sessionId: "creator-session-mutation",
  changeSetHash,
  approvalHash: "b".repeat(64),
  revisionHash: "c".repeat(64),
  buildHash: "d".repeat(64),
  dashboardReviewHash: "e".repeat(64),
};
const attributeKey = studioEvidenceFactKey("attribute", target, "Open");
const changeSet: CreatorMutationChangeSetLike = {
  kind: "CreatorChangeSet",
  id: "creator-change-mutation",
  hash: changeSetHash,
  project,
  binding,
  projectionId: "creator-mutation-direct",
  operations: [
    {
      id: "set-open",
      kind: "update",
      target,
      attributes: { Open: false },
    },
  ],
  allowedStateDelta: [attributeKey],
};

function directProjection(): StudioEvidenceProjection {
  return compileMutationEvidenceProjection({
    id: changeSet.projectionId,
    project,
    binding,
    operations: changeSet.operations,
    purpose: "mutation_direct_readback",
    allowedStateDelta: changeSet.allowedStateDelta,
  });
}

function preflightProjection(): StudioEvidenceProjection {
  return compileMutationEvidenceProjection({
    id: "creator-mutation-preflight",
    project,
    binding,
    operations: changeSet.operations,
    purpose: "mutation_preflight",
    allowedStateDelta: changeSet.allowedStateDelta,
  });
}

function finalizationBinding(projection: StudioEvidenceProjection) {
  return {
    sessionId: "creator-session-mutation",
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeRevisionHash: "c".repeat(64),
    recordingId: "creator-recording-test",
  };
}

function attestationEvidence() {
  const target = { kind: "project" as const };
  const projection = createStudioEvidenceProjection({
    id: "studio-capability-attestation-test",
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    purpose: "capability_attestation",
    project,
    binding: { sessionId: "studio-session-attestation" },
    requirements: STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) =>
      classDefinition.properties.map((property) => ({
        key: studioEvidenceFactKey(
          "reflection",
          target,
          `${classDefinition.name}.${property.name}`,
        ),
        kind: "reflection" as const,
        target,
      }))),
    scope: { mode: "exact", roots: [], requireCompleteInventory: false },
    bounds: {
      maximumFacts: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionFacts,
      maximumBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionBytes,
      roots: [],
    },
  });
  const facts: StudioEvidenceFact[] = STUDIO_CAPABILITY_MANIFEST.classes.flatMap(
    (classDefinition) => classDefinition.properties.map((property) => ({
      kind: "reflection" as const,
      key: studioEvidenceFactKey(
        "reflection",
        target,
        `${classDefinition.name}.${property.name}`,
      ),
      target,
      result: {
        status: "observed" as const,
        value: {
          className: classDefinition.name,
          propertyName: property.name,
          owner: property.declaringClass,
          type: { ...property.reflection },
          inherited: property.declaringClass !== classDefinition.name,
          serialized: property.serialized ?? true,
          permits: ["read", "write"] as const,
        },
      },
    })),
  );
  const envelope = createStudioEvidenceEnvelope({
    manifestHash: projection.manifestHash,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:01.000Z",
    completion: "complete",
    facts,
  }, projection);
  return { projection, envelope };
}

function exactAttributeEnvelope(
  projection: StudioEvidenceProjection,
  value: boolean | "unavailable",
): StudioEvidenceEnvelope {
  const facts: StudioEvidenceFact[] = projection.requirements.map((requirement) => {
    if (requirement.kind !== "attribute" || requirement.attributeName !== "Open")
      throw new Error("Test fixture only contains the Open attribute requirement");
    return {
      kind: "attribute",
      key: requirement.key,
      target: requirement.target,
      attributeName: requirement.attributeName,
      result:
        value === "unavailable"
          ? { status: "unavailable", code: "not_read" }
          : { status: "observed", value },
    };
  });
  return createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts,
    },
    value === false ? projection : undefined,
  );
}

function stateEvidence(
  id: string,
  open: boolean,
  tags: readonly string[] = [],
  evidenceBinding = binding,
) {
  const projection = compileProjectStateProjection({
    id,
    project,
    binding: evidenceBinding,
    roots: ["Workspace"],
    purpose: "mutation_post_state",
  });
  const inventory: StudioEvidenceFact = {
    kind: "inventory",
    key: studioEvidenceFactKey("inventory", { kind: "project" }),
    target: { kind: "project" },
    result: {
      status: "observed",
      value: [
        { stableId: "door-folder", path: "Workspace/Door", className: "Folder", parentPath: "Workspace" },
      ],
    },
  };
  const facts: StudioEvidenceFact[] = [
    inventory,
    structure(target, "Workspace"),
    { kind: "attribute_inventory", key: studioEvidenceFactKey("attribute_inventory", target), target, result: { status: "observed", value: ["Open"] } },
    { kind: "attribute", key: attributeKey, target, attributeName: "Open", result: { status: "observed", value: open } },
    { kind: "tags", key: studioEvidenceFactKey("tags", target), target, result: { status: "observed", value: tags } },
  ];
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts,
    },
    projection,
  );
  return {
    projection,
    envelope,
    revision: createStudioStateRevision(envelope, projection, "2026-09-01T00:00:01.000Z"),
  };
}

function rehashAttempt<T extends { readonly hash: string }>(attempt: T): T {
  const { hash: previousHash, ...content } = attempt;
  void previousHash;
  return { ...content, hash: contentHash(stableJson(content)) } as T;
}

function structure(
  instance: typeof target,
  parentPath?: string,
): StudioEvidenceFact {
  return {
    kind: "structure",
    key: studioEvidenceFactKey("structure", instance),
    target: instance,
    result: {
      status: "observed",
      value: {
        stableId: instance.stableId,
        path: instance.path,
        className: instance.className,
        ...(parentPath === undefined ? {} : { parentPath }),
      },
    },
  };
}

function reconcile(directValue: boolean | "unavailable") {
  const projection = directProjection();
  return reconcileCreatorMutation({
    sessionId: "creator-session-mutation",
    attemptId: "creator-mutation-attempt",
    manifest: STUDIO_CAPABILITY_MANIFEST,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    changeSet,
    projection,
    preflight: {
      projection: preflightProjection(),
      envelope: exactAttributeEnvelope(preflightProjection(), false),
    },
    directReadback: exactAttributeEnvelope(projection, directValue),
    beforeState: stateEvidence("creator-before-state", true),
    afterState: stateEvidence("creator-after-state", false),
  });
}

test("mutation reconciliation distinguishes a proven difference from unavailable evidence", () => {
  assert.equal(reconcile(false).status, "matched");
  const mismatched = reconcile(true);
  assert.equal(mismatched.status, "mismatched");
  assert.ok(mismatched.failureFacts.some((fact) => fact.code === "direct_readback_fact_mismatch"));
  const incomplete = reconcile("unavailable");
  assert.equal(incomplete.status, "incomplete");
  assert.ok(incomplete.failureFacts.some((fact) => fact.code === "direct_readback_fact_unavailable"));
});

test("complete project-state evidence exposes an unapproved observable delta", () => {
  const projection = directProjection();
  const preflight = preflightProjection();
  const reconciliation = reconcileCreatorMutation({
    sessionId: "creator-session-mutation",
    attemptId: "creator-mutation-unapproved-delta",
    manifest: STUDIO_CAPABILITY_MANIFEST,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    changeSet,
    projection,
    preflight: { projection: preflight, envelope: exactAttributeEnvelope(preflight, false) },
    directReadback: exactAttributeEnvelope(projection, false),
    beforeState: stateEvidence("creator-before-state", true),
    afterState: stateEvidence("creator-after-state", false, ["unapproved-tag"]),
  });
  assert.equal(reconciliation.status, "mismatched");
  assert.ok(reconciliation.failureFacts.some((fact) => fact.code === "unapproved_observable_delta"));
});

test("pure mutation replay exactly reproduces a recorded mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-mutation-replay-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const projection = directProjection();
    const preflight = preflightProjection();
    const beforeState = stateEvidence("creator-before-state", true);
    const afterState = stateEvidence("creator-after-state", false);
    const finalState = stateEvidence("creator-final-state", false);
    const directReadback = exactAttributeEnvelope(projection, true);
    const reconciliation = reconcileCreatorMutation({
      sessionId: "creator-session-mutation",
      attemptId: "creator-mutation-attempt",
      manifest: STUDIO_CAPABILITY_MANIFEST,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      changeSet,
      projection,
      preflight: { projection: preflight, envelope: exactAttributeEnvelope(preflight, false) },
      directReadback,
      beforeState,
      afterState,
    });
    assert.equal(reconciliation.status, "mismatched");
    const finalization = createCreatorMutationFinalization({
      attemptId: "creator-mutation-attempt",
      ...finalizationBinding(projection),
      reconciliationHash: reconciliation.hash,
      action: "cancel",
      afterRevisionHash: finalState.revision.stateHash,
      postFinalizeProjectionHash: finalState.projection.contentHash,
      postFinalizeEvidenceHash: finalState.envelope.contentHash,
      status: "cancelled" as const,
    });
    const attestation = attestationEvidence();
    const [manifestArtifact, attestationProjectionArtifact, attestationEnvelopeArtifact, changeSetArtifact, projectionArtifact, preflightProjectionArtifact, preflightEnvelopeArtifact, directArtifact, beforeProjectionArtifact, beforeEnvelopeArtifact, beforeRevisionArtifact, afterProjectionArtifact, afterEnvelopeArtifact, afterRevisionArtifact, finalProjectionArtifact, finalEnvelopeArtifact, finalRevisionArtifact, reconciliationArtifact, finalizationArtifact] = await Promise.all([
      store.write(STUDIO_CAPABILITY_MANIFEST), store.write(attestation.projection), store.write(attestation.envelope), store.write(changeSet), store.write(projection), store.write(preflight), store.write(exactAttributeEnvelope(preflight, false)), store.write(directReadback), store.write(beforeState.projection), store.write(beforeState.envelope), store.write(beforeState.revision), store.write(afterState.projection), store.write(afterState.envelope), store.write(afterState.revision), store.write(finalState.projection), store.write(finalState.envelope), store.write(finalState.revision), store.write(reconciliation), store.write(finalization),
    ]);
    const attempt = createCreatorMutationAttempt("creator-mutation-attempt", {
      sessionId: "creator-session-mutation",
      manifest: { artifact: manifestArtifact, hash: STUDIO_CAPABILITY_MANIFEST_HASH },
      attestation: {
        projection: { artifact: attestationProjectionArtifact, hash: attestation.projection.contentHash },
        envelope: { artifact: attestationEnvelopeArtifact, hash: attestation.envelope.contentHash },
      },
      changeSet: { artifact: changeSetArtifact, hash: changeSet.hash },
      projection: { artifact: projectionArtifact, hash: projection.contentHash },
      preflight: { projection: { artifact: preflightProjectionArtifact, hash: preflight.contentHash }, envelope: { artifact: preflightEnvelopeArtifact, hash: exactAttributeEnvelope(preflight, false).contentHash } },
      directReadback: { artifact: directArtifact, hash: directReadback.contentHash },
      beforeState: { projection: { artifact: beforeProjectionArtifact, hash: beforeState.projection.contentHash }, envelope: { artifact: beforeEnvelopeArtifact, hash: beforeState.envelope.contentHash }, revision: { artifact: beforeRevisionArtifact, hash: beforeState.revision.stateHash } },
      afterState: { projection: { artifact: afterProjectionArtifact, hash: afterState.projection.contentHash }, envelope: { artifact: afterEnvelopeArtifact, hash: afterState.envelope.contentHash }, revision: { artifact: afterRevisionArtifact, hash: afterState.revision.stateHash } },
      finalState: { projection: { artifact: finalProjectionArtifact, hash: finalState.projection.contentHash }, envelope: { artifact: finalEnvelopeArtifact, hash: finalState.envelope.contentHash }, revision: { artifact: finalRevisionArtifact, hash: finalState.revision.stateHash } },
      reconciliation: { artifact: reconciliationArtifact, hash: reconciliation.hash },
      finalization: { artifact: finalizationArtifact, hash: finalization.hash },
    });
    const replay = await replayCreatorMutation(attempt, store);
    assert.equal(replay.result, "exact_match", replay.detail);
    assert.equal(replay.replayedStatus, "mismatched");

    const incompleteAttestationEnvelope = createStudioEvidenceEnvelope(
      {
        manifestHash: attestation.projection.manifestHash,
        projectionId: attestation.projection.id,
        projectionHash: attestation.projection.contentHash,
        bindingHash: attestation.projection.bindingHash,
        project,
        authoritative: true,
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:00:01.000Z",
        completion: "incomplete",
        facts: attestation.envelope.facts.map((fact) => ({
          ...fact,
          result: { status: "unavailable" as const, code: "reflection_unavailable" },
        })),
      },
      attestation.projection,
    );
    const incompleteAttestationArtifact = await store.write(incompleteAttestationEnvelope);
    const incompleteAttestationReplay = await replayCreatorMutation(
      rehashAttempt({
        ...attempt,
        attestation: {
          ...attempt.attestation,
          envelope: { artifact: incompleteAttestationArtifact, hash: incompleteAttestationEnvelope.contentHash },
        },
      }),
      store,
    );
    assert.equal(incompleteAttestationReplay.result, "missing_or_incomplete");

    const illegalCommitFinalization = createCreatorMutationFinalization({
      attemptId: attempt.id,
      ...finalizationBinding(projection),
      reconciliationHash: reconciliation.hash,
      action: "commit",
      afterRevisionHash: finalState.revision.stateHash,
      postFinalizeProjectionHash: finalState.projection.contentHash,
      postFinalizeEvidenceHash: finalState.envelope.contentHash,
      status: "committed",
    });
    const illegalCommitArtifact = await store.write(illegalCommitFinalization);
    const illegalCommitReplay = await replayCreatorMutation(
      rehashAttempt({
        ...attempt,
        finalization: { artifact: illegalCommitArtifact, hash: illegalCommitFinalization.hash },
      }),
      store,
    );
    assert.equal(illegalCommitReplay.result, "mismatch");

    const foreignFinalState = stateEvidence(
      "creator-foreign-final-state",
      false,
      [],
      { ...binding, changeSetHash: "0".repeat(64) },
    );
    const foreignFinalization = createCreatorMutationFinalization({
      attemptId: attempt.id,
      ...finalizationBinding(projection),
      reconciliationHash: reconciliation.hash,
      action: "cancel",
      afterRevisionHash: foreignFinalState.revision.stateHash,
      postFinalizeProjectionHash: foreignFinalState.projection.contentHash,
      postFinalizeEvidenceHash: foreignFinalState.envelope.contentHash,
      status: "cancelled",
    });
    const [foreignProjectionArtifact, foreignEnvelopeArtifact, foreignRevisionArtifact, foreignFinalizationArtifact] = await Promise.all([
      store.write(foreignFinalState.projection),
      store.write(foreignFinalState.envelope),
      store.write(foreignFinalState.revision),
      store.write(foreignFinalization),
    ]);
    const foreignFinalReplay = await replayCreatorMutation(
      rehashAttempt({
        ...attempt,
        finalState: {
          projection: { artifact: foreignProjectionArtifact, hash: foreignFinalState.projection.contentHash },
          envelope: { artifact: foreignEnvelopeArtifact, hash: foreignFinalState.envelope.contentHash },
          revision: { artifact: foreignRevisionArtifact, hash: foreignFinalState.revision.stateHash },
        },
        finalization: { artifact: foreignFinalizationArtifact, hash: foreignFinalization.hash },
      }),
      store,
    );
    assert.equal(foreignFinalReplay.result, "missing_or_incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failure facts are canonical, bounded, and deduplicated", () => {
  const facts = createMutationFailureFacts([
    { code: "b", detail: "second" },
    { code: "a", detail: "first" },
    { code: "a", detail: "first" },
  ]);
  assert.equal(facts.length, 2);
  assert.deepEqual(
    facts.map((fact) => fact.hash),
    [...facts.map((fact) => fact.hash)].sort(),
  );
});

test("failed preflight remains an immutable non-replayable mutation attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-mutation-preflight-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const projection = directProjection();
    const preflight = preflightProjection();
    const before = stateEvidence("mutation-before-preflight-failure", false);
    const attestation = attestationEvidence();
    const [
      manifestArtifact,
      attestationProjectionArtifact,
      attestationEnvelopeArtifact,
      changeSetArtifact,
      projectionArtifact,
      preflightProjectionArtifact,
      beforeProjectionArtifact,
      beforeEnvelopeArtifact,
      beforeRevisionArtifact,
    ] = await Promise.all([
      store.write(STUDIO_CAPABILITY_MANIFEST),
      store.write(attestation.projection),
      store.write(attestation.envelope),
      store.write(changeSet),
      store.write(projection),
      store.write(preflight),
      store.write(before.projection),
      store.write(before.envelope),
      store.write(before.revision),
    ]);
    const attempt = createIncompleteCreatorMutationAttempt(
      "creator-mutation-preflight-failure",
      {
        sessionId: "creator-session-mutation",
        manifest: { artifact: manifestArtifact, hash: STUDIO_CAPABILITY_MANIFEST_HASH },
        attestation: {
          projection: { artifact: attestationProjectionArtifact, hash: attestation.projection.contentHash },
          envelope: { artifact: attestationEnvelopeArtifact, hash: attestation.envelope.contentHash },
        },
        changeSet: { artifact: changeSetArtifact, hash: changeSet.hash },
        projection: { artifact: projectionArtifact, hash: projection.contentHash },
        preflightProjection: { artifact: preflightProjectionArtifact, hash: preflight.contentHash },
        beforeState: {
          projection: { artifact: beforeProjectionArtifact, hash: before.projection.contentHash },
          envelope: { artifact: beforeEnvelopeArtifact, hash: before.envelope.contentHash },
          revision: { artifact: beforeRevisionArtifact, hash: before.revision.stateHash },
        },
        failureFacts: createMutationFailureFacts([
          { code: "capability_preflight_failed", detail: "Detached canary rejected the requested capability." },
        ]),
      },
    );
    const replay = await replayCreatorMutation(attempt, store);
    assert.equal(replay.recordedStatus, "incomplete");
    assert.equal(replay.result, "missing_or_incomplete");
    assert.deepEqual(replay.recordedFailureFactHashes, attempt.failureFacts.map((fact) => fact.hash));

    const invalidFailureFactAttempt = rehashAttempt({
      ...attempt,
      failureFacts: attempt.failureFacts.map((fact) => ({ ...fact, hash: "0".repeat(64) })),
    });
    const invalidFactReplay = await replayCreatorMutation(invalidFailureFactAttempt, store);
    assert.equal(invalidFactReplay.result, "mismatch");

    const passedPreflight = exactAttributeEnvelope(preflight, false);
    const finalState = stateEvidence("mutation-apply-failure-final", false);
    const finalization = createCreatorMutationFinalization({
      attemptId: "creator-mutation-apply-failure",
      ...finalizationBinding(projection),
      action: "cancel",
      afterRevisionHash: finalState.revision.stateHash,
      postFinalizeProjectionHash: finalState.projection.contentHash,
      postFinalizeEvidenceHash: finalState.envelope.contentHash,
      status: "cancelled",
    });
    const [preflightEnvelopeArtifact, finalProjectionArtifact, finalEnvelopeArtifact, finalRevisionArtifact, finalizationArtifact] = await Promise.all([
      store.write(passedPreflight),
      store.write(finalState.projection),
      store.write(finalState.envelope),
      store.write(finalState.revision),
      store.write(finalization),
    ]);
    const applyFailure = createIncompleteApplyMutationAttempt(
      "creator-mutation-apply-failure",
      {
        sessionId: "creator-session-mutation",
        manifest: { artifact: manifestArtifact, hash: STUDIO_CAPABILITY_MANIFEST_HASH },
        attestation: {
          projection: { artifact: attestationProjectionArtifact, hash: attestation.projection.contentHash },
          envelope: { artifact: attestationEnvelopeArtifact, hash: attestation.envelope.contentHash },
        },
        changeSet: { artifact: changeSetArtifact, hash: changeSet.hash },
        projection: { artifact: projectionArtifact, hash: projection.contentHash },
        preflightProjection: { artifact: preflightProjectionArtifact, hash: preflight.contentHash },
        preflight: {
          projection: { artifact: preflightProjectionArtifact, hash: preflight.contentHash },
          envelope: { artifact: preflightEnvelopeArtifact, hash: passedPreflight.contentHash },
        },
        beforeState: {
          projection: { artifact: beforeProjectionArtifact, hash: before.projection.contentHash },
          envelope: { artifact: beforeEnvelopeArtifact, hash: before.envelope.contentHash },
          revision: { artifact: beforeRevisionArtifact, hash: before.revision.stateHash },
        },
        finalState: {
          projection: { artifact: finalProjectionArtifact, hash: finalState.projection.contentHash },
          envelope: { artifact: finalEnvelopeArtifact, hash: finalState.envelope.contentHash },
          revision: { artifact: finalRevisionArtifact, hash: finalState.revision.stateHash },
        },
        finalization: { artifact: finalizationArtifact, hash: finalization.hash },
        failureFacts: createMutationFailureFacts([
          { code: "mutation_execution_failed", detail: "Plugin proved local cancellation after a mid-batch failure." },
        ]),
      },
    );
    const applyFailureReplay = await replayCreatorMutation(applyFailure, store);
    assert.equal(applyFailureReplay.result, "missing_or_incomplete");
    assert.match(applyFailureReplay.detail, /failed and was cancelled/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real CreatorChangeSet operations compile to closed create/update/move/delete/source evidence", () => {
  const realHash = "9".repeat(64);
  const revisionHash = "8".repeat(64);
  const buildHash = "7".repeat(64);
  const realChangeSet: CreatorChangeSet = {
    kind: "CreatorChangeSet",
    id: "creator-change-real",
    hash: realHash,
    sessionId: "creator-session-real",
    attempt: 1,
    promptHash: "6".repeat(64),
    planId: "creator-plan-real",
    planHash: "5".repeat(64),
    charterId: "creator-charter-real",
    charterHash: "4".repeat(64),
    planApprovalId: "creator-plan-approval-real",
    planApprovalHash: "3".repeat(64),
    buildContractId: "creator-build-real",
    buildContractHash: buildHash,
    ownershipMapId: "creator-ownership-real",
    ownershipMapHash: "2".repeat(64),
    expectedRevisionHash: revisionHash,
    operations: [
      {
        id: "create-folder",
        planChangeId: "plan-create",
        kind: "create",
        tempId: "temporary-folder",
        parentPath: "Workspace",
        className: "Folder",
        name: "Created",
        properties: {},
        attributes: { Created: true },
      },
      {
        id: "update-part",
        planChangeId: "plan-update",
        kind: "update",
        stableId: "part-update",
        expectedPath: "Workspace/UpdatePart",
        expectedClass: "Part",
        beforeHash: "1".repeat(64),
        properties: { Anchored: { kind: "boolean", value: false } },
        attributes: { Open: false },
        removedAttributes: ["Legacy"],
      },
      {
        id: "move-part",
        planChangeId: "plan-move",
        kind: "move",
        stableId: "part-move",
        expectedPath: "Workspace/OldPart",
        expectedClass: "Part",
        beforeHash: "0".repeat(64),
        parentPath: "Workspace",
        name: "MovedPart",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "delete-model",
        planChangeId: "plan-delete",
        kind: "delete",
        stableId: "model-delete",
        expectedPath: "Workspace/Deleted",
        expectedClass: "Model",
        beforeHash: "a".repeat(64),
      },
      {
        id: "source-script",
        planChangeId: "plan-source",
        kind: "write_source",
        stableId: "script-source",
        expectedPath: "ServerScriptService/Controller",
        expectedClass: "Script",
        beforeSourceHash: "b".repeat(64),
        source: "print('closed evidence')",
        attributes: {},
        removedAttributes: ["Legacy"],
      },
    ],
    localGate: { status: "eligible", issueHashes: [] },
  };
  const descendants = [
    {
      kind: "instance" as const,
      stableId: "part-deleted-child",
      path: "Workspace/Deleted/Child",
      className: "Part",
    },
  ];
  const adapted = adaptCreatorChangeSetMutationOperations(realChangeSet, [
    { operationId: "delete-model", descendants },
  ]);
  const create = adapted.find((operation) => operation.id === "create-folder");
  assert.deepEqual(create?.target, {
    kind: "instance",
    stableId: creatorMutationCreateStableId(realChangeSet, "temporary-folder"),
    path: "Workspace/Created",
    className: "Folder",
  });
  assert.equal(create?.structure?.parentPath, "Workspace");
  const projection = compileCreatorChangeSetMutationProjection(realChangeSet, {
    project,
    binding: {
      sessionId: realChangeSet.sessionId,
      changeSetHash: realChangeSet.hash,
      approvalHash: "c".repeat(64),
      revisionHash,
      buildHash,
    },
    allowedStateDelta: ["attribute:approved"],
    deletedSubtrees: [{ operationId: "delete-model", descendants }],
  });
  const requirement = (key: string) => projection.requirements.find((entry) => entry.key === key);
  assert.equal(
    requirement(studioEvidenceFactKey("attribute", { kind: "instance", stableId: "part-update", path: "Workspace/UpdatePart", className: "Part" }, "Legacy"))?.expectedStatus,
    "absent",
  );
  assert.equal(
    requirement(studioEvidenceFactKey("structure", { kind: "instance", stableId: "model-delete", path: "Workspace/Deleted", className: "Model" }))?.expectedStatus,
    "absent",
  );
  assert.equal(
    requirement(studioEvidenceFactKey("structure", descendants[0]!))?.expectedStatus,
    "absent",
  );
  assert.equal(
    requirement(studioEvidenceFactKey("source_hash", { kind: "instance", stableId: "script-source", path: "ServerScriptService/Controller", className: "Script" }))?.expected,
    contentHash("print('closed evidence')"),
  );
  assert.equal(
    requirement(studioEvidenceFactKey("structure", { kind: "instance", stableId: "part-move", path: "Workspace/MovedPart", className: "Part" }))?.expectedStatus,
    "observed",
  );
});
