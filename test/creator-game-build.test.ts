import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../packages/artifact-store/src/index.js";
import {
  CreatorSessionCoordinator,
  restoredCreatorControlDetail,
} from "../packages/creator-session/src/coordinator.js";
import {
  advanceSession,
  assertCreatorChangeSet,
  createCreatorApproval,
  createCreatorBuildContract,
  createCreatorPlan,
  createCreatorSession,
  createStudioOwnershipMap,
  persistCreatorBundle,
  type CreatorSessionBundle,
  type CreatorChangeSet,
} from "../packages/creator-session/src/index.js";
import {
  AgentExecutionJournalStore,
  createAgentExecutionSlot,
  createRequestIntentCheckpoint,
  type AgentExecutionSlot,
} from "../packages/agent-runtime/src/index.js";
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
      worldAuthoring: { mode: "none" },
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
    creatorRequest: await store.write({
      kind: "CreatorRequest",
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorText: prompt,
      agentPrompt: `Build the approved inventory.\n${prompt}`,
      contextCitations: [],
    }),
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
    decidePlan(
      bundle: CreatorSessionBundle,
      hash: string,
      decision: "approved",
      execution: AgentExecutionSlot,
      retainedApproval: CreatorSessionBundle["approvals"][number],
    ): Promise<unknown>;
    sourceEvidence(): Promise<unknown>;
    observationForBundle(): Promise<unknown>;
    recordGameCheckpoint(
      bundle: CreatorSessionBundle,
      attemptHash: string,
      acknowledgement: ArtifactReference,
    ): Promise<unknown>;
    prepareNextGamePartition(bundle: CreatorSessionBundle): Promise<unknown>;
    resumeGameBuild(bundle: CreatorSessionBundle): Promise<unknown>;
    currentAttestedStudioSession(): Promise<unknown>;
    requireClearRecordingInventory(): Promise<void>;
    requireBuildRefresh(
      bundle: CreatorSessionBundle,
      studio: unknown,
      message?: string,
    ): Promise<unknown>;
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
  coordinator.requireBuildRefresh = async (retained) => {
    const refreshed = {
      ...retained,
      ...(retained.gameBuilds
        ? {
            gameBuilds: retained.gameBuilds.map((build) =>
              build.status === "complete" ? build : { ...build, status: "incomplete" as const },
            ),
          }
        : {}),
      session: advanceSession(retained.session, { status: "refresh_required" }),
    };
    return coordinator.finish(refreshed);
  };
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
    approval,
    sourceIndex,
    observation,
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
    const summary = "Created 129 folders.\n" + "Verified checkpoint details.\n".repeat(400);
    await run.coordinator.startGameBuild(run.bundle, run.graph, run.contract.hash, summary);
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
    for (const changeSet of run.applies) {
      assert.equal(changeSet.summary, summary);
      assert.doesNotThrow(() => assertCreatorChangeSet(changeSet));
    }
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
    assert.match(restoredCreatorControlDetail(run.currentBundle()), /Resume verified build/);
    run.deliverAcknowledgements();
    await run.coordinator.resumeGameBuild(run.currentBundle());
    assert.equal(run.applies.length, 2);
    assert.equal(run.currentBundle().session.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external edit between verified partitions retains its index and requires refresh", async () => {
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
    assert.equal(run.currentBundle().session.status, "refresh_required");
    assert.equal(run.currentBundle().session.failure, undefined);
    assert.equal(run.currentBundle().projectIndices.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withPersistedWorkerBindings(run: Awaited<ReturnType<typeof fixture>>) {
  const store = run.coordinator.artifactStore;
  const consultation = new SourceConsultationRecorder(
    run.sourceIndex,
    createTestFixtureSourceResolver([]),
  ).seal();
  const indexArtifact = await store.write(run.sourceIndex);
  const consultationArtifact = await store.write(consultation);
  // This fixture mocks the worker boundary, not AgentRun/journal admission.
  // The real bundle writer must still check the sealed phase/graph/contract edges.
  const boundary = await store.write({ kind: "FixtureWorkerEvidence" });
  const reference: CreatorSessionBundle["agentRuns"][number] = {
    phase: "creator_builder",
    agentRunId: "agent_run_persisted_aggregate",
    agentRun: boundary,
    traceId: "trace_persisted_aggregate",
    trace: boundary,
    traceBuildKey: "trace_build_persisted_aggregate",
    creatorSessionHash: run.bundle.session.hash,
    buildContract: { id: run.contract.id, hash: run.contract.hash },
    outcome: {
      status: "sealed",
      artifact: { kind: "game_build_graph", id: run.graph.id, hash: run.graph.hash },
      attemptHash: contentHash("fixture sealed attempt"),
    },
  };
  return {
    ...run.bundle,
    sourceIndices: [
      {
        id: run.sourceIndex.id,
        hash: run.sourceIndex.hash,
        artifact: indexArtifact,
        analysis: {
          id: "fixture_analysis",
          hash: boundary.artifactHash,
          artifact: boundary,
        },
      },
    ],
    sourceConsultations: [
      {
        id: consultation.id,
        hash: consultation.hash,
        indexId: run.sourceIndex.id,
        indexHash: run.sourceIndex.hash,
        artifact: consultationArtifact,
      },
    ],
    agentRuns: [reference],
  } satisfies CreatorSessionBundle;
}

test("a sealed builder graph crosses real bundle persistence before native preparation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-aggregate-persistence-"));
  try {
    const run = await fixture(directory, "complete");
    const bundle = await withPersistedWorkerBindings(run);
    run.coordinator.persist = async (retained) => {
      await persistCreatorBundle(retained, directory);
    };
    let preparations = 0;
    run.coordinator.prepareNextGamePartition = async () => {
      preparations++;
    };
    await run.coordinator.startGameBuild(bundle, run.graph, run.contract.hash, "Created folders.");
    const saved = JSON.parse(
      await readFile(join(directory, `${bundle.session.id}.json`), "utf8"),
    ) as CreatorSessionBundle;
    assert.equal(saved.session.status, "building");
    assert.equal(saved.agentRuns[0]!.outcome.status, "sealed");
    assert.equal(saved.gameBuilds![0]!.graph.hash, run.graph.hash);
    assert.equal(saved.gameBuilds![0]!.receipts.length, 0);
    assert.equal(preparations, 1);
    assert.equal(run.applies.length, 0);
    const graphArtifact = await run.coordinator.artifactStore.write(run.graph);
    assert.deepEqual(await run.coordinator.artifactStore.read(graphArtifact), run.graph);
    await assert.rejects(
      persistCreatorBundle({ ...bundle, gameBuilds: [] }, directory),
      /not linked to its build graph and contract/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const boundary of ["artifact", "bundle"] as const) {
  test(`a post-seal ${boundary} persistence failure retains the exact graph for provider-free explicit resume`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-aggregate-seal-recovery-"));
    try {
      const run = await fixture(directory, "complete");
      const completedWorker = await withPersistedWorkerBindings(run);
      const bundle: CreatorSessionBundle = {
        ...completedWorker,
        buildContracts: [],
        agentRuns: [],
        session: advanceSession(run.bundle.session, {
          status: "incomplete",
          failure: {
            code: "BUILD_PREPARATION_FAILED",
            detail: "Fixture retries before any worker execution.",
          },
        }),
      };
      const execution = createAgentExecutionSlot({
        purpose: "builder",
        ordinal: 1,
        agentRunId: completedWorker.agentRuns[0]!.agentRunId,
      });
      await new AgentExecutionJournalStore(run.coordinator.artifactStore).append(
        execution.journalId,
        createRequestIntentCheckpoint(
          1,
          NOW,
          {
            model: "fixture",
            system: "fixture",
            messages: [],
            tools: [],
            maxOutputTokens: 100,
            timeoutMs: 1000,
          },
          {
            runtimeStartedAt: NOW,
            usage: {
              turns: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              reasoningTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
            },
            trialStarted: false,
            remaining: {
              turns: 10,
              toolCalls: 100,
              toolResultBytes: 1000000,
              durationMs: 100000,
              inputTokens: null,
              outputTokens: null,
              budgetUsd: null,
            },
            seenToolCallIds: [],
            rejectedBatchRepeats: [],
            noProgressBatchRepeats: [],
            prematureCompletionRepairs: 0,
            toolHostProgressTokenHash: null,
            materializedToolCalls: 0,
            materializedToolResultBytes: 0,
          },
        ),
      );
      let workerCalls = 0;
      run.coordinator.input = {
        worker: {
          build: async (request: {
            creatorPrompt: string;
            agentPrompt: string;
            initialImages: readonly unknown[];
          }) => {
            workerCalls++;
            assert.equal(request.creatorPrompt, run.bundle.plan!.goal);
            assert.equal(
              request.agentPrompt,
              `Build the approved inventory.\n${run.bundle.plan!.goal}`,
            );
            assert.deepEqual(request.initialImages, []);
            return {
              status: "sealed",
              graph: run.graph,
              buildContract: run.contract,
              summary: "Created folders.",
              sourceWriteBlobs: [],
              evidence: completedWorker.agentRuns[0]!,
            };
          },
        },
      };
      run.coordinator.sourceEvidence = async () => ({});
      run.coordinator.observationForBundle = async () => run.observation;
      let injected = false;
      const writeArtifact = run.coordinator.artifactStore.write.bind(run.coordinator.artifactStore);
      run.coordinator.artifactStore.write = async (value) => {
        if (boundary === "artifact" && value === run.graph && !injected) {
          injected = true;
          throw new Error("fixture post-seal graph artifact persistence unavailable");
        }
        return writeArtifact(value);
      };
      run.coordinator.persist = async (retained) => {
        if (boundary === "bundle" && retained.gameBuilds?.length && !injected) {
          injected = true;
          throw new Error("fixture post-seal bundle persistence unavailable");
        }
        await persistCreatorBundle(retained, directory);
      };
      run.coordinator.failIncomplete = (
        CreatorSessionCoordinator.prototype as unknown as typeof run.coordinator
      ).failIncomplete;
      await run.coordinator.decidePlan(
        bundle,
        bundle.plan!.hash,
        "approved",
        execution,
        run.approval,
      );
      const stopped = JSON.parse(
        await readFile(join(directory, `${bundle.session.id}.json`), "utf8"),
      ) as CreatorSessionBundle;
      assert.equal(stopped.session.status, "incomplete");
      assert.equal(stopped.session.failure?.code, "builder_execution_failed");
      assert.equal(stopped.gameBuilds![0]!.status, "incomplete");
      assert.equal(stopped.gameBuilds![0]!.graph.hash, run.graph.hash);
      assert.equal(stopped.gameBuilds![0]!.receipts.length, 0);
      assert.equal(run.applies.length, 0);
      assert.equal(stopped.mutationAttempts.length, 0);
      const resumed: CreatorChangeSet[] = [];
      run.coordinator.apply = async (retained) => {
        resumed.push(retained.changeSets.at(-1)!);
      };
      await run.coordinator.resumeGameBuild(stopped);
      assert.equal(
        workerCalls,
        1,
        "resume must consume the retained graph without invoking the worker",
      );
      assert.equal(run.currentBundle().session.status, "preflighting");
      assert.equal(run.currentBundle().gameBuilds![0]!.graph.hash, run.graph.hash);
      assert.equal(run.currentBundle().gameBuilds![0]!.receipts.length, 0);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]!.operations.length, 128);
      assert.equal(resumed[0]!.planApprovalHash, run.approval.hash);
      assert.equal(resumed[0]!.partition.graphHash, run.graph.hash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
