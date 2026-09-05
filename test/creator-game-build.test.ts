import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../packages/artifact-store/src/index.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  advanceSession,
  createCreatorApproval,
  createCreatorBuildContract,
  createCreatorPlan,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorSessionBundle,
  type CreatorChangeSet,
} from "../packages/creator-session/src/index.js";
import {
  adaptCreatorChangeSetMutationOperations,
  creatorStructuralParentsFromProjectIndex,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  reconcileCreatorMutation,
  type CreatorMutationChangeSetLike,
} from "../packages/creator-session/src/mutation-evidence.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
} from "../packages/game-ir/src/index.js";
import {
  bindGameBuildPartition,
  compileGamePlan,
  gameTopologyAfter,
  gameTopologyFromCapture,
  materializeGameBuildGraph,
  type GameBuildGraph,
  type GameInventoryItem,
} from "../packages/game-compiler/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  SourceConsultationRecorder,
} from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioEvidenceEnvelope,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  studioProjectIndexMetadataView,
  type StudioEvidenceFact,
  type StudioEvidenceProjection,
  type StudioProjectIndexCapture,
  type StudioProjectIndexNode,
} from "../packages/studio-evidence/src/index.js";

const PROJECT = { name: "AggregateFixture", placeId: 0, universeId: 0 };
const PROJECT_ID = "aggregate-fixture";
const ROOT = { kind: "forge_attribute" as const, stableId: "aggregate-workspace" };
const NOW = "2026-09-05T00:00:00.000Z";

function capture(nodes: readonly StudioProjectIndexNode[] = []): StudioProjectIndexCapture {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project: PROJECT,
    connectorEpoch: "a".repeat(64),
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  return createStudioProjectIndexCapture({
    projection,
    shards: [
      createStudioProjectEvidenceShard({
        root: "Workspace",
        ordinal: 0,
        nodes: [
          {
            identity: ROOT,
            displayPath: "Workspace",
            name: "Workspace",
            className: "Workspace",
            engineContainer: { path: "Workspace", className: "Workspace" },
            attributes: {},
            tags: [],
            coveredProperties: {},
            coveredPropertyNames: [],
          },
          ...nodes,
        ],
      }),
    ],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: NOW,
    detectorEpoch: 0,
  });
}

function envelope(projection: StudioEvidenceProjection) {
  const facts = projection.requirements.map((requirement) => ({
    kind: requirement.kind,
    key: requirement.key,
    target: requirement.target,
    ...(requirement.propertyName ? { propertyName: requirement.propertyName } : {}),
    ...(requirement.attributeName ? { attributeName: requirement.attributeName } : {}),
    result:
      requirement.expectedStatus === "absent"
        ? { status: "absent" }
        : { status: "observed", value: requirement.expected },
  })) as StudioEvidenceFact[];
  return createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project: PROJECT,
      authoritative: true,
      startedAt: NOW,
      endedAt: NOW,
      completion: "complete",
      facts,
    },
    projection,
  );
}

async function fixture(directory: string, mode: "complete" | "lost_ack" | "external_edit") {
  const store = new ImmutableJsonArtifactStore(directory);
  let current = capture();
  const observation = studioProjectIndexMetadataView(current);
  const ownership = createStudioOwnershipMap({
    projectId: PROJECT_ID,
    revisionHash: current.revision.hash,
    projectIndex: observation,
  });
  const prompt = "Create 129 independent folders in bounded transactions.";
  let session = createCreatorSession({
    id: "creator_session_aggregate",
    prompt,
    projectId: PROJECT_ID,
    revisionHash: current.revision.hash,
    projectCaptureHash: current.hash,
    ownership,
  });
  const definition = {
    kind: "GameRecipeDefinition",
    id: "test-folders",
    abi: "1",
    configSchema: { type: "null" },
    sourceExports: [],
    ports: [],
    obligations: [],
  } as const;
  const inventory: GameInventoryItem[] = Array.from({ length: 129 }, (_, index) => ({
    id: "folder-" + index.toString().padStart(3, "0"),
    componentId: "folders",
    change: {
      id: "folder-" + index.toString().padStart(3, "0"),
      kind: "create",
      className: "Folder",
      initialization: "initial_properties",
      path: "Workspace/Folder" + index,
      parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
    },
    lockedProperties: {},
    valueSlots: [],
    attributes: {},
    removedAttributes: [],
    dependencies: [],
  }));
  const compiled = compileGamePlan({
    design: {
      kind: "GameDesignSpec",
      id: "aggregate",
      intent: prompt,
      components: [
        {
          kind: "recipe_instance",
          id: "folders",
          definition: gameRecipeDefinitionLock(definition),
          config: null,
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
    registry: createGameDefinitionRegistry([definition]),
    projectId: PROJECT_ID,
    project: PROJECT,
    sessionId: session.id,
    observedRevisionHash: current.revision.hash,
    initialTopology: gameTopologyFromCapture(current),
    inventory,
  });
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: current.hash, documents: [] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("test config"),
      pinnedToolchainProof: {
        hash: contentHash("test proof"),
        lockHash: contentHash("test lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("test sourcemap"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const plan = createCreatorPlan(
    {
      compiled,
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorPrompt: prompt,
      projectRevisionHash: current.revision.hash,
      projectCaptureHash: current.hash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      sourceIndex,
      sourceConsultation: new SourceConsultationRecorder(
        sourceIndex,
        createTestFixtureSourceResolver([]),
      ).seal(),
      inspectionPaths: [],
      steps: [
        { id: "install", statement: prompt, changeIds: compiled.inventory.map((item) => item.id) },
      ],
      changes: compiled.inventory.map((item) => item.change),
      charter: {
        clauses: compiled.inventory.map((item) => ({
          id: item.id,
          kind: "studio_check" as const,
          check: "instance_exists" as const,
          path: item.change.kind === "create" ? item.change.path : "",
          expectedClass: "Folder" as const,
        })),
      },
    },
    observation,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: NOW,
  });
  session = advanceSession(session, { status: "planning" });
  session = advanceSession(session, { status: "awaiting_plan_approval", plan });
  session = advanceSession(session, { status: "building", approval });
  const contract = createCreatorBuildContract({
    session,
    plan,
    planApproval: approval,
    ownership,
    projectIndex: observation,
  });
  const graph = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: approval.hash,
    sources: [],
    values: [],
    checks: { status: "eligible", artifactHashes: [contentHash("fixture local gate")] },
  }).graph;
  const bundle: CreatorSessionBundle = {
    session,
    creatorRequest: await store.write({ prompt }),
    projectIndices: [await writeCreatorProjectIndexArtifacts(store, current)],
    projectChanges: [],
    projectRefreshes: [],
    ownership,
    rojoSourceMutations: [],
    sourceIndices: [],
    sourceConsultations: [],
    sourceWriteBlobs: [],
    plan,
    buildContracts: [contract],
    approvals: [approval],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [],
  };
  interface Harness {
    input: object;
    artifactStore: ImmutableJsonArtifactStore;
    bundles: Map<string, CreatorSessionBundle>;
    startGameBuild(
      bundle: CreatorSessionBundle,
      graph: GameBuildGraph,
      contractHash: string,
      summary: string,
    ): Promise<unknown>;
    recordGameCheckpoint(
      bundle: CreatorSessionBundle,
      attemptHash: string,
      acknowledgement: ArtifactReference,
    ): Promise<unknown>;
    prepareNextGamePartition(bundle: CreatorSessionBundle): Promise<unknown>;
    resumeGameBuild(bundle: CreatorSessionBundle): Promise<unknown>;
    currentAttestedStudioSession(): Promise<unknown>;
    requireClearRecordingInventory(): Promise<void>;
    collectProjectIndex(): Promise<StudioProjectIndexCapture>;
    retainProjectIndex(
      bundle: CreatorSessionBundle,
      capture: StudioProjectIndexCapture,
    ): Promise<CreatorSessionBundle>;
    persist(bundle: CreatorSessionBundle): Promise<void>;
    publishView(): Promise<void>;
    finish(bundle: CreatorSessionBundle): Promise<unknown>;
    lockProject<T>(projectId: string, callback: () => Promise<T>): Promise<T>;
    apply(bundle: CreatorSessionBundle): Promise<unknown>;
    failIncomplete(bundle: CreatorSessionBundle, code: string, detail: string): Promise<unknown>;
  }
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as Harness;
  coordinator.input = {};
  coordinator.artifactStore = store;
  coordinator.bundles = new Map([[session.id, bundle]]);
  coordinator.currentAttestedStudioSession = async () => ({
    id: "studio-fixture",
    projectId: PROJECT_ID,
  });
  coordinator.requireClearRecordingInventory = async () => {};
  coordinator.collectProjectIndex = async () => current;
  coordinator.retainProjectIndex = async (retained, next) => ({
    ...retained,
    projectIndices: [
      ...retained.projectIndices,
      await writeCreatorProjectIndexArtifacts(store, next),
    ],
  });
  coordinator.persist = async (retained) => {
    await store.write(retained);
  };
  coordinator.publishView = async () => {};
  coordinator.finish = async (retained) => {
    coordinator.bundles.set(session.id, retained);
    await coordinator.persist(retained);
    return retained.session.status;
  };
  coordinator.lockProject = async (_id, callback) => callback();
  coordinator.failIncomplete = async (failed, code, detail) => {
    if (code !== "game_checkpoint_continuation_stopped") throw new Error(code + ": " + detail);
    const incomplete = {
      ...failed,
      session: advanceSession(failed.session, { status: "incomplete", failure: { code, detail } }),
    };
    return coordinator.finish(incomplete);
  };
  const applies: CreatorChangeSet[] = [];
  let retainedAck: ArtifactReference | undefined;
  // Mock only the existing Apply boundary. All aggregate state transitions,
  // change-set creation, inherited approval and checkpoint replay remain real.
  coordinator.apply = async (live) => {
    const build = live.gameBuilds!.at(-1)!;
    const changeSet = live.changeSets.at(-1)!;
    const transactionApproval = live.approvals.at(-1)!;
    assert.equal(transactionApproval.authority, "accepted_plan");
    assert.equal(transactionApproval.planAuthorization?.hash, approval.hash);
    const before = current;
    const bound = await bindGameBuildPartition({
      plan: compiled,
      graph,
      receipts: build.receipts,
      store,
      capture: before,
      transaction: {
        sessionId: session.id,
        changeSetId: changeSet.id,
        changeSetHash: changeSet.hash,
        buildContractHash: contract.hash,
        approvalHash: transactionApproval.hash,
        dashboardReviewHash: transactionApproval.hash,
      },
    });
    assert.equal(stableJson(bound.operations), stableJson(changeSet.operations));
    applies.push(changeSet);
    const nodes = gameTopologyAfter(gameTopologyFromCapture(before), bound.operations)
      .filter((node) => !node.engineContainer)
      .map((node) => ({
        identity: node.identity,
        ...(node.parentIdentity ? { parentIdentity: node.parentIdentity } : {}),
        displayPath: node.path,
        name: node.name,
        className: node.className,
        attributes: {},
        tags: [],
        coveredProperties: node.properties ?? {},
        coveredPropertyNames: Object.keys(node.properties ?? {}),
      }));
    const after = capture(nodes);
    const sealed = {
      id: changeSet.id,
      hash: changeSet.hash,
      sessionId: session.id,
      expectedRevisionHash: before.revision.hash,
      buildContractHash: contract.hash,
      operations: bound.operations,
    };
    const mutation: CreatorMutationChangeSetLike = {
      kind: "CreatorChangeSet",
      id: sealed.id,
      hash: sealed.hash,
      project: PROJECT,
      binding: bound.readback.binding,
      projectionId: bound.readback.id,
      operations: adaptCreatorChangeSetMutationOperations(
        sealed,
        gameTopologyFromCapture(before),
        [],
        creatorStructuralParentsFromProjectIndex(sealed, before),
      ),
    };
    const attemptId = "aggregate-attempt-" + applies.length;
    const preflight = envelope(bound.preflight),
      direct = envelope(bound.readback);
    const reconciliation = reconcileCreatorMutation({
      sessionId: session.id,
      attemptId,
      manifest: STUDIO_CAPABILITY_MANIFEST,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      changeSet: mutation,
      projection: bound.readback,
      preflight: { projection: bound.preflight, envelope: preflight },
      directReadback: direct,
      beforeIndexCapture: before,
      afterIndexCapture: after,
    });
    assert.equal(reconciliation.status, "matched", stableJson(reconciliation.failureFacts));
    const finalization = createCreatorMutationFinalization({
      attemptId,
      sessionId: session.id,
      changeSetId: sealed.id,
      changeSetHash: sealed.hash,
      projectionId: bound.readback.id,
      projectionHash: bound.readback.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeIndexCaptureHash: before.hash,
      beforeIndexRevisionHash: before.revision.hash,
      afterIndexCaptureHash: after.hash,
      afterIndexRevisionHash: after.revision.hash,
      finalIndexCaptureHash: after.hash,
      finalIndexRevisionHash: after.revision.hash,
      recordingId: "recording-" + applies.length,
      reconciliationHash: reconciliation.hash,
      action: "commit",
      status: "committed",
    });
    const preflightBinding = {
      projection: {
        artifact: await store.write(bound.preflight),
        hash: bound.preflight.contentHash,
      },
      envelope: { artifact: await store.write(preflight), hash: preflight.contentHash },
    };
    const afterBinding = await writeCreatorProjectIndexArtifacts(store, after);
    const attempt = createCreatorMutationAttempt(attemptId, {
      sessionId: session.id,
      manifest: {
        artifact: await store.write(STUDIO_CAPABILITY_MANIFEST),
        hash: STUDIO_CAPABILITY_MANIFEST_HASH,
      },
      attestation: preflightBinding,
      changeSet: { artifact: await store.write(mutation), hash: mutation.hash },
      projection: { artifact: await store.write(bound.readback), hash: bound.readback.contentHash },
      preflight: preflightBinding,
      directReadback: { artifact: await store.write(direct), hash: direct.contentHash },
      beforeIndexCapture: await writeCreatorProjectIndexArtifacts(store, before),
      afterIndexCapture: afterBinding,
      finalIndexCapture: afterBinding,
      reconciliation: { artifact: await store.write(reconciliation), hash: reconciliation.hash },
      finalization: { artifact: await store.write(finalization), hash: finalization.hash },
    });
    const receipt = await store.write({
      creatorSessionId: session.id,
      changeSetId: sealed.id,
      changeSetHash: sealed.hash,
      projectionId: bound.readback.id,
      projectionHash: bound.readback.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectRevisionHash: before.revision.hash,
      afterProjectRevisionHash: after.revision.hash,
      recordingId: finalization.recordingId,
      status: "committed",
      action: "commit",
    });
    retainedAck = await store.write({
      kind: "CreatorChangeFinalizationAcknowledgement",
      studioSessionId: "studio-fixture",
      projectId: PROJECT_ID,
      receipt,
      authorityHash: attempt.hash,
      requestId: "ack-" + applies.length,
      resultingRecordingState: "none",
      acknowledgedAt: NOW,
    });
    let committedSession = advanceSession(live.session, { status: "applying" });
    committedSession = advanceSession(committedSession, { status: "committing" });
    const committed = {
      ...live,
      session: committedSession,
      mutationAttempts: [...live.mutationAttempts, attempt],
      gameBuilds: live.gameBuilds!.map((candidate) => ({
        ...candidate,
        status: "awaiting_checkpoint" as const,
      })),
    };
    coordinator.bundles.set(session.id, committed);
    await coordinator.persist(committed);
    current =
      mode === "external_edit"
        ? capture([
            ...nodes,
            {
              identity: { kind: "forge_attribute", stableId: "external-edit" },
              parentIdentity: ROOT,
              displayPath: "Workspace/External",
              name: "External",
              className: "Folder",
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
          ])
        : after;
    if (mode === "lost_ack") return committed.session.status;
    return coordinator.recordGameCheckpoint(committed, attempt.hash, retainedAck);
  };
  return {
    coordinator,
    bundle,
    graph,
    contract,
    applies,
    get retainedAck() {
      return retainedAck;
    },
    currentBundle: () => coordinator.bundles.get(session.id)!,
    deliverAcknowledgements: () => {
      mode = "complete";
    },
  };
}

test("coordinator consumes two exact partitions under one accepted plan and completes after both replayed acknowledgements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-aggregate-positive-"));
  try {
    const run = await fixture(directory, "complete");
    await run.coordinator.startGameBuild(
      run.bundle,
      run.graph,
      run.contract.hash,
      "Created 129 folders.",
    );
    assert.equal(
      run.currentBundle().session.failure,
      undefined,
      stableJson(run.currentBundle().session.failure),
    );
    assert.deepEqual(
      run.applies.map((changeSet) => changeSet.operations.length),
      [128, 1],
    );
    assert.equal(run.currentBundle().session.status, "completed");
    assert.equal(run.currentBundle().gameBuilds![0]!.receipts.length, 2);
    assert.notEqual(run.applies[0]!.expectedRevisionHash, run.applies[1]!.expectedRevisionHash);
    assert.equal(run.applies[0]!.planHash, run.applies[1]!.planHash);
    const complete = run.currentBundle();
    const corrupted = structuredClone(complete);
    corrupted.gameBuilds![0]!.status = "building";
    Object.assign(corrupted.gameBuilds![0]!.receipts[0]!, {
      partitionHash: contentHash("wrong partition"),
    });
    await assert.rejects(
      () => run.coordinator.prepareNextGamePartition(corrupted),
      /receipt|identity|prefix/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost consumed acknowledgement prevents the next partition and cannot report completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-aggregate-ack-"));
  try {
    const run = await fixture(directory, "lost_ack");
    await run.coordinator.startGameBuild(
      run.bundle,
      run.graph,
      run.contract.hash,
      "Created 129 folders.",
    );
    assert.equal(run.applies.length, 1);
    assert.equal(run.currentBundle().session.status, "committing");
    assert.equal(run.currentBundle().gameBuilds![0]!.receipts.length, 0);
    await assert.rejects(
      () => run.coordinator.prepareNextGamePartition(run.currentBundle()),
      /closed recording/,
    );
    const pending = run.currentBundle();
    const recovered = {
      ...pending,
      session: advanceSession(pending.session, { status: "recovery_required" }),
    };
    run.coordinator.bundles.set(recovered.session.id, recovered);
    await run.coordinator.recordGameCheckpoint(
      recovered,
      recovered.mutationAttempts.at(-1)!.hash,
      run.retainedAck!,
    );
    assert.equal(run.currentBundle().session.status, "incomplete");
    assert.equal(run.currentBundle().gameBuilds![0]!.receipts.length, 1);
    assert.equal(run.applies.length, 1, "recovered acknowledgements require explicit continuation");
    run.deliverAcknowledgements();
    await run.coordinator.resumeGameBuild(run.currentBundle());
    assert.equal(run.applies.length, 2);
    assert.equal(run.currentBundle().session.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external edit between verified partitions stops aggregate continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-aggregate-drift-"));
  try {
    const run = await fixture(directory, "external_edit");
    await run.coordinator.startGameBuild(
      run.bundle,
      run.graph,
      run.contract.hash,
      "Created 129 folders.",
    );
    assert.equal(run.applies.length, 1);
    assert.equal(run.currentBundle().gameBuilds![0]!.receipts.length, 1);
    assert.equal(run.currentBundle().session.status, "incomplete");
    assert.equal(run.currentBundle().session.failure?.code, "game_checkpoint_continuation_stopped");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
