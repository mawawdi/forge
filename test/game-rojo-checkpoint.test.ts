import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  advanceSession,
  createCreatorApproval,
  createCreatorBuildContract,
  createCreatorPlan,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  SourceConsultationRecorder,
} from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import { writeCreatorSourceWriteArtifacts } from "../packages/creator-session/src/source-write.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  createGameDefinitionRegistry,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  gameTopologyFromCapture,
  createGameRojoCheckpointReceipt,
  verifyGameCheckpointPrefix,
  type GameBuildGraph,
  type GamePlan,
} from "../packages/game-compiler/src/index.js";
import {
  createProjectAuthorityMap,
  createRojoSourcemapArtifact,
  createRojoSourceChangeSet,
  applyRojoSourceChangeSet,
  createRojoSyncProof,
  type ProjectAuthorityManifest,
  type ProjectAuthorityMap,
  type RojoSourcemapArtifact,
} from "../packages/project-authority/src/index.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import {
  rojoStudioNonSourceHash,
  rojoSyncObservation,
} from "../packages/creator-session/src/rojo-evidence.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioProjectIndexProjection,
  createStudioSourceBlobCapture,
  createStudioProjectIndexCapture,
  createStudioProjectEvidenceShard,
  studioProjectIndexMetadataView,
  type StudioProjectIndexCapture,
} from "../packages/studio-evidence/src/index.js";

const PROJECT = { name: "RojoCheckpointFixture", placeId: 0, universeId: 0 };
const PROJECT_ID = "rojo-checkpoint-fixture";
const ROOT = { kind: "forge_attribute" as const, stableId: "rojo-shared-root" };
const FOLDER = { kind: "forge_attribute" as const, stableId: "rojo-shared-folder" };
const TARGET = {
  kind: "instance" as const,
  identity: { kind: "forge_attribute" as const, stableId: "rojo-protocol" },
  path: "ReplicatedStorage/Shared/Protocol",
  className: "ModuleScript",
};

function capture(
  source: string,
  unmappedSource = "return 'untouched'\n",
  addedSource?: string,
  protocolId = TARGET.identity.stableId,
) {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project: PROJECT,
    connectorEpoch: "a".repeat(64),
    purpose: "creator_project_index",
    roots: ["ReplicatedStorage"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const blob = createStudioSourceBlobCapture({
    identity: { kind: "forge_attribute", stableId: protocolId },
    source,
    editorSource: false,
  });
  const unmapped = createStudioSourceBlobCapture({
    identity: { kind: "forge_attribute", stableId: "studio-owned-source" },
    source: unmappedSource,
    editorSource: false,
  });
  const added =
    addedSource === undefined
      ? undefined
      : createStudioSourceBlobCapture({
          identity: { kind: "forge_attribute", stableId: "rojo-added-module" },
          source: addedSource,
          editorSource: false,
        });
  const shared = { attributes: {}, tags: [], coveredProperties: {}, coveredPropertyNames: [] };
  const nodes = [
    {
      ...shared,
      identity: ROOT,
      displayPath: "ReplicatedStorage",
      name: "ReplicatedStorage",
      className: "ReplicatedStorage",
      engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
    },
    {
      ...shared,
      identity: FOLDER,
      parentIdentity: ROOT,
      displayPath: "ReplicatedStorage/Shared",
      name: "Shared",
      className: "Folder",
    },
    {
      ...shared,
      identity: blob.manifest.identity,
      parentIdentity: FOLDER,
      displayPath: TARGET.path,
      name: "Protocol",
      className: "ModuleScript",
      sourceManifestHash: blob.manifest.hash,
    },
    {
      ...shared,
      identity: unmapped.manifest.identity,
      parentIdentity: ROOT,
      displayPath: "ReplicatedStorage/StudioOwned",
      name: "StudioOwned",
      className: "ModuleScript",
      sourceManifestHash: unmapped.manifest.hash,
    },
  ];
  if (added)
    nodes.push({
      ...shared,
      identity: added.manifest.identity,
      parentIdentity: FOLDER,
      displayPath: "ReplicatedStorage/Shared/Added",
      name: "Added",
      className: "ModuleScript",
      sourceManifestHash: added.manifest.hash,
    });
  return createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "ReplicatedStorage", ordinal: 0, nodes })],
    sourceManifests: [blob.manifest, unmapped.manifest, ...(added ? [added.manifest] : [])],
    sourceChunks: [...blob.chunks, ...unmapped.chunks, ...(added?.chunks ?? [])],
    completedAt: "2026-09-05T00:00:00.000Z",
    detectorEpoch: 0,
  });
}

test("Rojo graph checkpoints replay guarded source receipts and independently captured Studio sync without native acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-game-rojo-"));
  try {
    const original = "return { version = 1 }\n",
      replacement = "return { version = 2 }\n";
    await mkdir(join(root, "src", "Shared"), { recursive: true });
    await writeFile(join(root, "default.project.json"), "{}\n");
    await writeFile(join(root, "src", "Shared", "Protocol.luau"), original);
    const before = capture(original),
      after = capture(replacement);
    const manifest: ProjectAuthorityManifest = {
      kind: "ProjectAuthorityManifest",
      studioRoots: ["ReplicatedStorage"],
      rojo: { projectFile: "default.project.json", sourceRoots: ["src"] },
    };
    const sourcemap = createRojoSourcemapArtifact({
      manifest,
      projectFileHash: contentHash("{}\n"),
      tool: { version: "fixture", binaryHash: contentHash("recorded fixture sourcemap") },
      sourceMapJson: JSON.stringify({
        name: "DataModel",
        className: "DataModel",
        children: [
          {
            name: "ReplicatedStorage",
            className: "ReplicatedStorage",
            children: [
              {
                name: "Shared",
                className: "Folder",
                filePaths: ["src/Shared"],
                children: [
                  {
                    name: "Protocol",
                    className: "ModuleScript",
                    filePaths: ["src/Shared/Protocol.luau"],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const authorityMap = await createProjectAuthorityMap({
      projectId: PROJECT_ID,
      studioRevisionHash: before.revision.hash,
      manifest,
      workspaceRoot: root,
      rojo: { sourcemap },
    });
    const design: GameDesignSpec = {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "rojo-package",
      intent: "Change one ordinary source module through its existing guarded source authority.",
      connections: [],
      artifactDependencies: [],
      components: [
        {
          kind: "source_package",
          id: "protocol",
          ports: [],
          obligations: [],
          files: [
            {
              id: "main",
              path: "Protocol.luau",
              context: "shared",
              role: "module",
              imports: [],
              content: { kind: "slot", maximumUtf8Bytes: 1000 },
              placement: {
                kind: "edit_source",
                operationId: "edit-protocol",
                target: TARGET,
                beforeSourceHash: contentHash(original),
                beforeSourceBytes: Buffer.byteLength(original),
              },
            },
          ],
        },
      ],
    };
    const input = {
      design,
      registry: createGameDefinitionRegistry([]),
      projectId: PROJECT_ID,
      project: PROJECT,
      initialTopology: gameTopologyFromCapture(before),
    };
    const plan = compileGamePlan({
      ...input,
      ...expandGameDesign(input),
      sessionId: "creator_session_rojo_checkpoint",
      observedRevisionHash: before.revision.hash,
    });
    const graph = materializeGameBuildGraph({
      plan,
      acceptanceHash: contentHash("fixture approval"),
      sources: [{ slotId: "edit-protocol", source: replacement }],
      values: [],
      checks: { status: "eligible", artifactHashes: [contentHash("fixture local checks")] },
    }).graph;
    const operation = graph.operations[0]!;
    assert.ok(operation.kind === "edit_source");
    const changeSet = createRojoSourceChangeSet({
      id: "rojo-checkpoint-change",
      authorityMap,
      beforeStudioRevisionHash: before.revision.hash,
      beforeStudioNonSourceHash: rojoStudioNonSourceHash(studioProjectIndexMetadataView(before)),
      afterStudioNonSourceHash: rojoStudioNonSourceHash(studioProjectIndexMetadataView(after)),
      operations: [
        {
          id: operation.id,
          kind: "edit_source",
          studioPath: TARGET.path,
          className: "ModuleScript",
          beforeHash: contentHash(original),
          edits: [{ startByte: 0, endByte: Buffer.byteLength(original), replacement }],
          finalSourceHash: contentHash(replacement),
          finalByteCount: Buffer.byteLength(replacement),
        },
      ],
    });
    const attempt = await applyRojoSourceChangeSet({
      workspaceRoot: root,
      authorityMap,
      changeSet,
    });
    const proof = createRojoSyncProof({
      attempt,
      changeSet,
      observation: rojoSyncObservation(after, attempt.afterFilesystemRevision.entries),
    });
    assert.equal(proof.status, "matched");
    const store = new ImmutableJsonArtifactStore(join(root, "evidence"));
    const evidence = {
      plan,
      graph,
      ordinal: 0,
      authorityMap: await store.write(authorityMap),
      sourceChangeSet: await store.write(changeSet),
      attempt: await store.write(attempt),
      syncProof: await store.write(proof),
      beforeIndexCapture: await writeCreatorProjectIndexArtifacts(store, before),
      afterIndexCapture: await writeCreatorProjectIndexArtifacts(store, after),
      store,
    };
    const receipt = await createGameRojoCheckpointReceipt(evidence);
    assert.equal(receipt.kind, "GameRojoCheckpointReceipt");
    assert.equal("acknowledgement" in receipt, false);
    const prefix = await verifyGameCheckpointPrefix({ plan, graph, receipts: [receipt], store });
    assert.equal(prefix.status, "matched");
    assert.equal(prefix.currentRevisionHash, after.revision.hash);
    const awaiting = await store.write(createRojoSyncProof({ attempt, changeSet }));
    await assert.rejects(
      () => createGameRojoCheckpointReceipt({ ...evidence, syncProof: awaiting }),
      /matched Studio sync proof/,
    );
    const collateral = capture(replacement, "return 'changed'\n");
    const mappedOnlyProof = createRojoSyncProof({
      attempt,
      changeSet,
      observation: rojoSyncObservation(collateral, attempt.afterFilesystemRevision.entries),
    });
    assert.equal(
      mappedOnlyProof.status,
      "matched",
      "Mapped sync evidence does not cover Studio-owned source",
    );
    const collateralProof = await store.write(mappedOnlyProof);
    const collateralCapture = await writeCreatorProjectIndexArtifacts(store, collateral);
    await assert.rejects(
      () =>
        createGameRojoCheckpointReceipt({
          ...evidence,
          syncProof: collateralProof,
          afterIndexCapture: collateralCapture,
        }),
      /changed source outside the exact graph partition/,
    );
    const replacedIdentity = capture(
      replacement,
      undefined,
      undefined,
      "unexpected-protocol-replacement",
    );
    const replacedProof = await store.write(
      createRojoSyncProof({
        attempt,
        changeSet,
        observation: rojoSyncObservation(replacedIdentity, attempt.afterFilesystemRevision.entries),
      }),
    );
    const replacedCapture = await writeCreatorProjectIndexArtifacts(store, replacedIdentity);
    await assert.rejects(
      () =>
        createGameRojoCheckpointReceipt({
          ...evidence,
          syncProof: replacedProof,
          afterIndexCapture: replacedCapture,
        }),
      /replaced or moved an existing editor identity/,
    );
    await assert.rejects(
      () =>
        createGameRojoCheckpointReceipt({
          ...evidence,
          afterIndexCapture: evidence.beforeIndexCapture,
        }),
      /changed source outside the exact graph partition/,
    );
    const changedGraph = materializeGameBuildGraph({
      plan,
      acceptanceHash: graph.acceptanceHash,
      sources: [{ slotId: "edit-protocol", source: "return { version = 3 }\n" }],
      values: [],
      checks: graph.localChecks,
    }).graph;
    await assert.rejects(
      () => createGameRojoCheckpointReceipt({ ...evidence, graph: changedGraph }),
      /sealed graph source bytes or ranges/,
    );
    await exerciseRojoCoordinator({
      root,
      store,
      compiled: plan,
      before,
      after,
      original,
      replacement,
      manifest,
      sourcemap,
      authorityMap,
    });
    await exerciseRojoCoordinator({
      root,
      store,
      compiled: plan,
      before,
      after,
      original,
      replacement,
      manifest,
      sourcemap,
      authorityMap,
      multiple: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exerciseRojoCoordinator(input: {
  root: string;
  store: ImmutableJsonArtifactStore;
  compiled: GamePlan;
  before: StudioProjectIndexCapture;
  after: StudioProjectIndexCapture;
  original: string;
  replacement: string;
  manifest: ProjectAuthorityManifest;
  sourcemap: RojoSourcemapArtifact;
  authorityMap: ProjectAuthorityMap;
  multiple?: boolean;
}) {
  const { root, store, before, original, replacement, manifest, multiple } = input;
  let { compiled, after, sourcemap, authorityMap } = input;
  let executable = "/fixture/no-process-is-launched";
  const addedSource = "return { added = true }\n";
  await writeFile(join(root, "src", "Shared", "Protocol.luau"), original);
  if (multiple) {
    const design: GameDesignSpec = {
      ...compiled.design,
      components: compiled.design.components.map((component) =>
        component.kind === "source_package"
          ? {
              ...component,
              files: [
                ...component.files.map((file) => ({
                  ...file,
                  imports: [{ componentId: component.id, fileId: "added" }],
                })),
                {
                  id: "added",
                  path: "Added.luau",
                  role: "module",
                  context: "shared",
                  imports: [],
                  content: { kind: "slot", maximumUtf8Bytes: 1000 },
                  placement: {
                    kind: "create",
                    operationId: "a-create-added",
                    parent: {
                      kind: "instance",
                      identity: FOLDER,
                      path: "ReplicatedStorage/Shared",
                      className: "Folder",
                    },
                    name: "Added",
                    className: "ModuleScript",
                  },
                },
              ],
            }
          : component,
      ),
    };
    const compileInput = {
      design,
      registry: createGameDefinitionRegistry([]),
      projectId: PROJECT_ID,
      project: PROJECT,
      initialTopology: gameTopologyFromCapture(before),
    };
    compiled = compileGamePlan({
      ...compileInput,
      ...expandGameDesign(compileInput),
      sessionId: compiled.sessionId,
      observedRevisionHash: before.revision.hash,
      policy: { ...compiled.policy, maximumPartitionOperations: 1 },
    });
    const tree = (names: readonly string[]) =>
      JSON.stringify({
        name: "DataModel",
        className: "DataModel",
        children: [
          {
            name: "ReplicatedStorage",
            className: "ReplicatedStorage",
            children: [
              {
                name: "Shared",
                className: "Folder",
                filePaths: ["src/Shared"],
                children: names.map((name) => ({
                  name,
                  className: "ModuleScript",
                  filePaths: ["src/Shared/" + name + ".luau"],
                })),
              },
            ],
          },
        ],
      });
    const script = "#!/bin/sh\nprintf '%s' '" + tree(["Protocol", "Added"]) + '\' > "$4"\n';
    executable = join(root, "fixture-rojo");
    await writeFile(executable, script, { mode: 0o700 });
    sourcemap = createRojoSourcemapArtifact({
      manifest,
      projectFileHash: sourcemap.projectFileHash,
      sourceMapJson: tree(["Protocol"]),
      tool: { version: "7.7.0", binaryHash: contentHash(script) },
    });
    authorityMap = await createProjectAuthorityMap({
      projectId: PROJECT_ID,
      studioRevisionHash: before.revision.hash,
      manifest,
      workspaceRoot: root,
      rojo: { sourcemap },
    });
    after = capture(replacement, undefined, addedSource);
  }
  const observation = studioProjectIndexMetadataView(before);
  const ownership = createStudioOwnershipMap({
    projectId: PROJECT_ID,
    revisionHash: before.revision.hash,
    projectIndex: observation,
    projectAuthority: manifest,
    rojoOwnedPaths: ["ReplicatedStorage/Shared", TARGET.path],
  });
  const prompt = compiled.design.intent;
  let session = createCreatorSession({
    id: compiled.sessionId,
    prompt,
    projectId: PROJECT_ID,
    revisionHash: before.revision.hash,
    projectCaptureHash: before.hash,
    ownership,
  });
  const documents = observation.scripts.map((script) => ({
    documentId: script.documentId,
    path: script.path,
    className: script.className,
    executionContext: script.executionContext,
    sourceHash: script.sourceHash,
    source: script.path === TARGET.path ? original : "return 'untouched'\n",
  }));
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: before.hash, documents },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("fixture config"),
      pinnedToolchainProof: {
        hash: contentHash("fixture proof"),
        lockHash: contentHash("fixture lock"),
        platform: "test",
      },
      sourcemapHash: sourcemap.hash,
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const recorder = new SourceConsultationRecorder(
    sourceIndex,
    createTestFixtureSourceResolver(documents),
  );
  for (const document of sourceIndex.documents) recorder.read({ documentId: document.documentId });
  const plan = createCreatorPlan(
    {
      compiled,
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorPrompt: prompt,
      projectRevisionHash: before.revision.hash,
      projectCaptureHash: before.hash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      sourceIndex,
      sourceConsultation: recorder.seal(),
      inspectionPaths: [TARGET.path],
      steps: [
        { id: "source", statement: prompt, changeIds: compiled.inventory.map((item) => item.id) },
      ],
      changes: compiled.inventory.map((item) => item.change),
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "module",
            kind: "studio_check",
            check: "instance_exists",
            path: TARGET.path,
            expectedClass: "ModuleScript",
          },
          ...(multiple
            ? [
                {
                  id: "added",
                  kind: "studio_check" as const,
                  check: "instance_exists" as const,
                  path: "ReplicatedStorage/Shared/Added",
                  expectedClass: "ModuleScript" as const,
                },
              ]
            : []),
        ],
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
    decidedAt: "2026-09-05T00:00:00.000Z",
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
  const materialized = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: approval.hash,
    sources: [
      { slotId: "edit-protocol", source: replacement },
      ...(multiple ? [{ slotId: "a-create-added", source: addedSource }] : []),
    ],
    values: [],
    checks: {
      status: "eligible",
      artifactHashes: [contentHash("recorded fixture local gate, not source analysis proof")],
    },
  });
  const bundle: CreatorSessionBundle = {
    session,
    creatorRequest: await store.write({ prompt }),
    projectIndices: [await writeCreatorProjectIndexArtifacts(store, before)],
    projectChanges: [],
    projectRefreshes: [],
    ownership,
    projectAuthority: {
      authorityMap: {
        id: authorityMap.id,
        hash: authorityMap.hash,
        artifact: await store.write(authorityMap),
      },
    },
    rojoSourceMutations: [],
    sourceIndices: [],
    sourceConsultations: [],
    sourceWriteBlobs: await Promise.all(
      materialized.sourceWriteBlobs.map((blob) => writeCreatorSourceWriteArtifacts(store, blob)),
    ),
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
    views: Map<string, { hash: string }>;
    startGameBuild(
      bundle: CreatorSessionBundle,
      graph: GameBuildGraph,
      contractHash: string,
      summary: string,
    ): Promise<unknown>;
    checkRojoSourceSync(bundle: CreatorSessionBundle): Promise<unknown>;
    revertRojoSourceChanges(bundle: CreatorSessionBundle): Promise<unknown>;
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
    lockProject<T>(id: string, callback: () => Promise<T>): Promise<T>;
    apply(bundle: CreatorSessionBundle): Promise<unknown>;
    applyRojoSourceChanges(bundle: CreatorSessionBundle, authority: object): Promise<unknown>;
    awaitProjectAuthority<T>(authority: object, operation: Promise<T>): Promise<T>;
    assertProjectAuthority(): void;
  }
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as Harness;
  coordinator.input = {
    projectAuthority: { manifest, workspaceRoot: root, rojo: { sourcemap, executable } },
  };
  coordinator.artifactStore = store;
  coordinator.bundles = new Map([[session.id, bundle]]);
  coordinator.views = new Map();
  let current = before;
  coordinator.currentAttestedStudioSession = async () => ({
    projectId: PROJECT_ID,
    project: PROJECT,
  });
  coordinator.requireClearRecordingInventory = async () => {};
  coordinator.collectProjectIndex = async () => current;
  coordinator.retainProjectIndex = async (value, captured) => ({
    ...value,
    projectIndices: [
      ...value.projectIndices,
      await writeCreatorProjectIndexArtifacts(store, captured),
    ],
  });
  coordinator.persist = async (value) => {
    await store.write(value);
  };
  coordinator.publishView = async () => {};
  coordinator.finish = async (value) => {
    coordinator.bundles.set(session.id, value);
    await coordinator.persist(value);
    return value.session.status;
  };
  coordinator.lockProject = async (_id, callback) => callback();
  coordinator.assertProjectAuthority = () => {};
  coordinator.awaitProjectAuthority = async (_authority, operation) => operation;
  // Only the paired connector capture, persistence display and project lock are fixture boundaries.
  // Translation, guarded filesystem Apply, approval and graph checkpoint continuation are real.
  coordinator.apply = (value) => coordinator.applyRojoSourceChanges(value, {});
  await coordinator.startGameBuild(
    bundle,
    materialized.graph,
    contract.hash,
    "Fixture source synchronized; no gameplay claim.",
  );
  if (multiple) {
    const first = coordinator.bundles.get(session.id)!;
    assert.equal(first.session.status, "awaiting_source_sync");
    assert.equal(first.gameBuilds!.at(-1)!.graph.partitions.length, 2);
    current = capture(original, undefined, addedSource);
    await coordinator.checkRojoSourceSync(first);
    const second = coordinator.bundles.get(session.id)!;
    assert.equal(
      second.session.status,
      "awaiting_source_sync",
      JSON.stringify(second.session.failure),
    );
    assert.equal(second.gameBuilds!.at(-1)!.receipts.length, 1);
    assert.equal(second.rojoSourceMutations.length, 2);
    const refreshed = (await store.read(
      second.projectAuthority!.authorityMap.artifact,
    )) as ProjectAuthorityMap;
    assert.deepEqual(
      refreshed.rojo!.sourcemap.scripts.map((entry) => entry.studioPath),
      ["ReplicatedStorage/Shared/Added", TARGET.path],
    );
    assert.equal(refreshed.rojo!.filesystemRevision.entries.length, 2);
    current = after;
    await coordinator.checkRojoSourceSync(second);
    const complete = coordinator.bundles.get(session.id)!;
    assert.equal(complete.session.status, "completed");
    assert.equal(complete.session.currentProjectCaptureHash, after.hash);
    assert.equal(complete.session.currentRevisionHash, after.revision.hash);
    assert.equal(
      complete.session.currentRevisionHash,
      complete.gameBuilds!.at(-1)!.receipts.at(-1)!.afterRevisionHash,
    );
    assert.equal(complete.gameBuilds!.at(-1)!.receipts.length, 2);
    assert.equal(complete.gameBuilds!.at(-1)!.status, "complete");
    assert.equal(
      complete.gameBuilds!.at(-1)!.receipts[1]!.beforeRevisionHash,
      second.gameBuilds!.at(-1)!.receipts[0]!.afterRevisionHash,
    );
    return;
  }
  const awaiting = coordinator.bundles.get(session.id)!;
  assert.equal(awaiting.session.status, "awaiting_source_sync");
  assert.equal(awaiting.gameBuilds!.at(-1)!.receipts.length, 0);
  assert.equal(awaiting.gameBuilds!.at(-1)!.status, "awaiting_checkpoint");
  await coordinator.checkRojoSourceSync(awaiting);
  assert.equal(
    coordinator.bundles.get(session.id)!.session.status,
    "awaiting_source_sync",
    "A filesystem write is not a synchronization checkpoint",
  );
  current = capture(replacement, "return 'changed'\n");
  await coordinator.checkRojoSourceSync(awaiting);
  assert.equal(coordinator.bundles.get(session.id)!.session.status, "recovery_required");
  assert.equal(coordinator.bundles.get(session.id)!.gameBuilds!.at(-1)!.receipts.length, 0);
  current = after;
  await coordinator.checkRojoSourceSync(awaiting);
  const completed = coordinator.bundles.get(session.id)!;
  assert.equal(completed.session.status, "completed");
  assert.equal(completed.session.currentProjectCaptureHash, after.hash);
  assert.equal(completed.session.currentRevisionHash, after.revision.hash);
  assert.equal(
    completed.session.currentRevisionHash,
    completed.gameBuilds!.at(-1)!.receipts.at(-1)!.afterRevisionHash,
  );
  assert.equal(completed.gameBuilds!.at(-1)!.status, "complete");
  assert.equal(completed.gameBuilds!.at(-1)!.receipts[0]!.kind, "GameRojoCheckpointReceipt");
  assert.equal(
    completed.mutationAttempts.length,
    0,
    "Rojo has no native ChangeHistory attempt or acknowledgement",
  );
  // Replay the separately retained pre-finalization state to exercise explicit reverse sync.
  coordinator.bundles.set(session.id, awaiting);
  await coordinator.revertRojoSourceChanges(awaiting);
  current = before;
  await coordinator.checkRojoSourceSync(coordinator.bundles.get(session.id)!);
  const reverted = coordinator.bundles.get(session.id)!;
  assert.equal(reverted.session.status, "incomplete");
  assert.equal(reverted.gameBuilds!.at(-1)!.status, "incomplete");
  assert.equal(reverted.gameBuilds!.at(-1)!.receipts.length, 0);
}
