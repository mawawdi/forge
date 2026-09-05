import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  assertGameBuildGraph,
  DEFAULT_GAME_COMPILER_POLICY,
  createGameCheckpointReceipt,
  verifyGameCheckpointPrefix,
  bindGameBuildPartition,
  createGamePartitionBinding,
  gameTopologyFromCapture,
  gameBuildPartitionOperations,
  compareGameBuildArtifactReuse,
  type GameInventoryItem,
  type GamePlan,
} from "../packages/game-compiler/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioEvidenceEnvelope,
  CREATOR_DEFAULT_RESOURCE_POLICY,
  createStudioProjectIndexProjection,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  studioProjectIndexMetadataView,
  type StudioEvidenceProjection,
  type StudioEvidenceFact,
  type StudioProjectIndexCapture,
} from "../packages/studio-evidence/src/index.js";
import {
  adaptCreatorChangeSetMutationOperations,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  reconcileCreatorMutation,
  type CreatorMutationChangeSetLike,
} from "../packages/creator-session/src/mutation-evidence.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import type { CreatorProjectIndexView } from "../packages/creator-session/src/index.js";

const PROJECT = { name: "CompilerFixture", placeId: 0, universeId: 0 };
const PROJECT_ID = "compiler-fixture";
const ACCEPTANCE = contentHash("fixture creator acceptance");
const CHECKS = { status: "eligible" as const, artifactHashes: [contentHash("fixture local gate")] };
const ROOT = { kind: "forge_attribute" as const, stableId: "compiler-workspace" };
const TARGET = {
  kind: "instance" as const,
  identity: { kind: "forge_attribute" as const, stableId: "fixture-folder" },
  path: "Workspace/Existing",
  className: "Folder",
};
const DEFINITION = {
  kind: "GameRecipeDefinition",
  id: "fixture-material",
  abi: "1",
  configSchema: { type: "integer", minimum: 1, maximum: 8192 },
  sourceExports: [],
  ports: [],
  obligations: [],
} as const;
const REGISTRY = createGameDefinitionRegistry([DEFINITION]);

function design(count = 1): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    id: "compiler-fixture",
    intent: "Materialize independently declared editor objects.",
    components: [
      {
        kind: "recipe_instance",
        id: "material",
        definition: gameRecipeDefinitionLock(DEFINITION),
        config: count,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
}
function capture(open?: boolean): StudioProjectIndexCapture {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project: PROJECT,
    connectorEpoch: "a".repeat(64),
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const nodes = [
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
    ...(open === undefined
      ? []
      : [
          {
            identity: TARGET.identity,
            parentIdentity: ROOT,
            displayPath: TARGET.path,
            name: "Existing",
            className: "Folder",
            attributes: { Open: open },
            tags: [],
            coveredProperties: {},
            coveredPropertyNames: [],
          },
        ]),
  ];
  return createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-05T00:00:00.000Z",
    detectorEpoch: 0,
  });
}
function folders(count: number, attributes: Record<string, string> = {}): GameInventoryItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: "folder-" + index.toString().padStart(4, "0"),
    componentId: "material",
    change: {
      id: "folder-" + index.toString().padStart(4, "0"),
      kind: "create",
      className: "Folder",
      initialization: "initial_properties",
      path: "Workspace/Folder" + index,
      parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
    },
    lockedProperties: {},
    valueSlots: [],
    attributes,
    removedAttributes: [],
    dependencies: [],
  }));
}
function plan(
  inventory = folders(1),
  before = capture(),
  policy = DEFAULT_GAME_COMPILER_POLICY,
): GamePlan {
  return compileGamePlan({
    design: design(inventory.length),
    registry: REGISTRY,
    projectId: PROJECT_ID,
    project: PROJECT,
    initialTopology: gameTopologyFromCapture(before),
    sessionId: "compiler-session",
    observedRevisionHash: before.revision.hash,
    inventory,
    policy,
  });
}
function build(compiled: GamePlan) {
  return materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: ACCEPTANCE,
    sources: [],
    values: [],
    checks: CHECKS,
  }).graph;
}

test("whole candidates partition by native operation and encoded evidence limits", () => {
  const compiled = plan(folders(129));
  const graph = build(compiled);
  assert.deepEqual(
    graph.partitions.map((partition) => partition.operationIds.length),
    [128, 1],
  );
  for (const partition of graph.partitions) {
    assert.ok(partition.preflight.factCount <= 16384);
    assert.ok(partition.readback.canonicalBytes <= 2 * 1024 * 1024);
    assert.equal("binding" in partition.readback, false);
  }
  assert.equal(graph.partitions[1]!.previousPartitionHash, graph.partitions[0]!.hash);
  const compact = build(
    plan(folders(8, { Description: "x".repeat(2000) }), capture(), {
      ...DEFAULT_GAME_COMPILER_POLICY,
      maximumPartitionBytes: 16000,
    }),
  );
  assert.ok(
    compact.partitions.length > 1,
    "encoded evidence, not only operation count, partitions the candidate",
  );
});

test("inseparable components never split silently and missing dependencies fail before writes", () => {
  assert.throws(
    () => build(plan(folders(129).map((item) => ({ ...item, atomicGroup: "one-component" })))),
    /Inseparable component/,
  );
  const missing = folders(1).map((item) => ({ ...item, dependencies: ["absent"] }));
  assert.throws(() => plan(missing), /dependency is undeclared/);
});

test("entrypoints activate only in the final bounded transaction", () => {
  const entrypoint = {
    ...folders(1)[0]!,
    id: "a-entrypoint",
    change: {
      id: "a-entrypoint",
      kind: "create" as const,
      path: "Workspace/FirstAlphabetically",
      parent: { kind: "engine_container" as const, path: "Workspace", className: "Workspace" },
      className: "Script" as const,
      initialization: "inline_source_required" as const,
    },
    source: { fileId: "entrypoint", content: { kind: "slot" as const, maximumUtf8Bytes: 100 } },
  };
  const inventory = [...folders(129), entrypoint];
  const graph = materializeGameBuildGraph({
    plan: plan(inventory),
    acceptanceHash: ACCEPTANCE,
    sources: [{ slotId: "a-entrypoint", source: "print('ready')" }],
    values: [],
    checks: CHECKS,
  }).graph;
  assert.deepEqual(
    graph.partitions.map((partition) => partition.operationIds.length),
    [128, 1, 1],
  );
  assert.equal(
    gameBuildPartitionOperations(graph, 0).some(
      (operation) => operation.target.className === "Script",
    ),
    false,
  );
  assert.equal(
    gameBuildPartitionOperations(graph, 1).some(
      (operation) => operation.target.className === "Script",
    ),
    false,
  );
  assert.equal(
    gameBuildPartitionOperations(graph, 2).every(
      (operation) => operation.target.className === "Script",
    ),
    true,
  );
  const tooMany = Array.from({ length: 129 }, (_, index) => ({
    ...entrypoint,
    id: "entry-" + index,
    change: { ...entrypoint.change, id: "entry-" + index, path: "Workspace/Entry" + index },
    source: { fileId: "entry-" + index, content: { kind: "slot" as const, maximumUtf8Bytes: 100 } },
  }));
  assert.throws(
    () =>
      materializeGameBuildGraph({
        plan: plan(tooMany),
        acceptanceHash: ACCEPTANCE,
        sources: tooMany.map((item) => ({ slotId: item.id, source: "print('ready')" })),
        values: [],
        checks: CHECKS,
      }),
    /Entrypoint activation component/,
  );
});

test("source dependency changes invalidate importer check inputs without rewriting equal bytes", () => {
  const before = capture();
  const spec: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "imports",
    intent: "Compose ordinary source dependencies.",
    components: [
      {
        kind: "source_package",
        id: "code",
        ports: [],
        obligations: [],
        files: ["base", "consumer"].map((id) => ({
          id,
          path: id + ".luau",
          context: "shared" as const,
          role: "module" as const,
          imports: id === "consumer" ? [{ componentId: "code", fileId: "base" }] : [],
          content: { kind: "slot" as const, maximumUtf8Bytes: 100 },
          placement: {
            kind: "create" as const,
            operationId: id,
            name: id,
            className: "ModuleScript" as const,
            parent: {
              kind: "engine_container" as const,
              path: "Workspace",
              className: "Workspace",
            },
          },
        })),
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const context = {
    design: spec,
    registry: createGameDefinitionRegistry([]),
    projectId: PROJECT_ID,
    project: PROJECT,
    initialTopology: gameTopologyFromCapture(before),
  };
  const expanded = expandGameDesign(context);
  const compiled = compileGamePlan({
    ...context,
    ...expanded,
    sessionId: "dependencies",
    observedRevisionHash: before.revision.hash,
  });
  const material = (base: string) =>
    materializeGameBuildGraph({
      plan: compiled,
      acceptanceHash: ACCEPTANCE,
      sources: [
        { slotId: "base", source: base },
        { slotId: "consumer", source: "return {}" },
      ],
      values: [],
      checks: CHECKS,
    }).graph;
  const first = material("return 1");
  const second = material("return 2");
  const consumer = (graph: typeof first) =>
    graph.artifacts.find(
      (artifact) => artifact.kind === "source" && artifact.fileId === "consumer",
    )!;
  assert.equal(consumer(first).hash, consumer(second).hash);
  assert.notEqual(consumer(first).inputHash, consumer(second).inputHash);
  assert.equal(compareGameBuildArtifactReuse(first, second).reusableSourceBytes, 0);
  assert.equal(compareGameBuildArtifactReuse(first, first).changedSourceBytes, 0);
});

test("ordinary installed source packages retain a declared hash-bound import closure without redundant writes", () => {
  const base = {
    kind: "instance" as const,
    identity: { kind: "forge_attribute" as const, stableId: "installed-base" },
    path: "Workspace/Base",
    className: "ModuleScript",
  };
  const library = {
    kind: "instance" as const,
    identity: { kind: "forge_attribute" as const, stableId: "installed-library" },
    path: "Workspace/Library",
    className: "ModuleScript",
  };
  const revisionHash = contentHash("fixture declared observed source metadata");
  const observed = [base, library].map((target) => ({
    ...target,
    objectId: "forge_attribute:" + target.identity.stableId,
    name: target.path.split("/").at(-1)!,
    parentIdentity: ROOT,
    properties: {},
    attributes: {},
    tags: [],
  }));
  const observation: CreatorProjectIndexView = {
    project: PROJECT,
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [...studioProjectIndexMetadataView(capture()).instances, ...observed],
    scripts: observed.map((node) => ({
      documentId: node.objectId,
      path: node.path,
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: contentHash(node.path),
      utf8Bytes: 20,
    })),
  };
  const spec: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "existing-source",
    intent: "Compose existing ordinary modules without rewriting them.",
    connections: [],
    artifactDependencies: [],
    components: [
      {
        kind: "source_package",
        id: "modules",
        ports: [],
        obligations: [],
        files: [
          ...[base, library].map((target, index) => ({
            id: index === 0 ? "base" : "library",
            path: (index === 0 ? "base" : "library") + ".luau",
            role: "module" as const,
            context: "shared" as const,
            content: {
              kind: "locked" as const,
              sourceHash: contentHash(target.path),
              utf8Bytes: 20,
            },
            placement: { kind: "observed" as const, target },
            imports: index === 0 ? [] : [{ componentId: "modules", fileId: "base" }],
          })),
          {
            id: "consumer",
            path: "consumer.luau",
            role: "module",
            context: "shared",
            content: { kind: "slot", maximumUtf8Bytes: 100 },
            placement: {
              kind: "create",
              operationId: "consumer",
              name: "Consumer",
              className: "ModuleScript",
              parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
            },
            imports: [{ componentId: "modules", fileId: "library" }],
          },
        ],
      },
    ],
  };
  const input = {
    design: spec,
    registry: createGameDefinitionRegistry([]),
    projectId: PROJECT_ID,
    project: PROJECT,
    initialTopology: observation.instances,
    observation,
  };
  const expanded = expandGameDesign(input);
  assert.equal(expanded.inventory.length, 1);
  assert.equal(expanded.observedSources.length, 2);
  const compiled = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "observed-source",
    observedRevisionHash: revisionHash,
  });
  const material = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: ACCEPTANCE,
    values: [],
    sources: [{ slotId: "consumer", source: "return {}" }],
    checks: CHECKS,
  });
  assert.equal(material.graph.operations.length, 1);
  assert.equal(material.sourceWriteBlobs.length, 1);
  const dependency = material.graph.artifacts.find(
    (artifact) => artifact.kind === "dependency_source" && artifact.fileId === "library",
  )!;
  assert.deepEqual(dependency.dependencyHashes, [contentHash(base.path)]);
  const stale = {
    ...observation,
    scripts: observation.scripts.map((script) => ({
      ...script,
      sourceHash: contentHash("changed"),
    })),
  };
  assert.throws(
    () => expandGameDesign({ ...input, observation: stale }),
    /captured hash and byte evidence/,
  );
  const missing = structuredClone(spec);
  const component = missing.components[0]!;
  assert.ok(component.kind === "source_package");
  component.files.shift();
  assert.throws(() => expandGameDesign({ ...input, design: missing }), /admission failed/);
  assert.throws(
    () =>
      compileGamePlan({
        ...input,
        ...expanded,
        sessionId: "wrong-revision",
        observedRevisionHash: contentHash("other revision"),
      }),
    /observation revision/,
  );
});

test("compiler identity is independent of declaration order and rejected graph edits cannot reseal authority", () => {
  const inventory = folders(3);
  const first = plan(inventory);
  const second = plan([...inventory].reverse());
  assert.equal(first.hash, second.hash);
  assert.equal(build(first).hash, build(second).hash);
  const graph = build(first);
  const changed = structuredClone(graph);
  Object.assign(changed.operations[0]!, { name: "Unapproved" });
  assert.throws(() => assertGameBuildGraph(changed, first), /identity mismatch/);
});

test("ordinary source packages materialize exact locks and approved slots without embedding source in operations", () => {
  const source = "return { answer = 42 }\n";
  const spec: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "novel-code",
    intent: "Install an ordinary module with novel behavior.",
    components: [
      {
        kind: "source_package",
        id: "code",
        files: [
          {
            id: "main",
            path: "main.luau",
            context: "shared",
            role: "module",
            imports: [],
            content: { kind: "slot", maximumUtf8Bytes: 1024 },
            placement: {
              operationId: "main",
              kind: "create",
              parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
              name: "Novel",
              className: "ModuleScript",
            },
          },
        ],
        ports: [],
        obligations: [],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const registry = createGameDefinitionRegistry([]);
  const before = capture();
  const context = {
    design: spec,
    registry,
    projectId: PROJECT_ID,
    project: PROJECT,
    initialTopology: gameTopologyFromCapture(before),
  };
  const expanded = expandGameDesign(context);
  const compiled = compileGamePlan({
    ...context,
    sessionId: "source-session",
    observedRevisionHash: before.revision.hash,
    inventory: expanded.inventory,
  });
  const result = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: ACCEPTANCE,
    sources: [{ slotId: "main", source }],
    values: [],
    checks: CHECKS,
  });
  assert.equal(result.sourceWriteBlobs[0]!.manifest.sourceHash, contentHash(source));
  assert.equal(stableJson(result.graph.operations).includes(source), false);
  assert.equal(result.graph.sourceWriteBlobs[0]!.sourceHash, contentHash(source));
  assert.throws(
    () =>
      materializeGameBuildGraph({
        plan: compiled,
        acceptanceHash: ACCEPTANCE,
        sources: [{ slotId: "main", source: "x".repeat(1025) }],
        values: [],
        checks: CHECKS,
      }),
    /exceeds approved source slot/,
  );
  const locked = structuredClone(spec);
  const component = locked.components[0]!;
  assert.ok(component.kind === "source_package");
  component.files[0]!.content = {
    kind: "locked",
    sourceHash: contentHash(source),
    utf8Bytes: Buffer.byteLength(source),
  };
  const expandedLock = expandGameDesign({ ...context, design: locked });
  const lockedPlan = compileGamePlan({
    ...context,
    design: locked,
    sessionId: "locked-session",
    observedRevisionHash: before.revision.hash,
    inventory: expandedLock.inventory,
  });
  assert.throws(
    () =>
      materializeGameBuildGraph({
        plan: lockedPlan,
        acceptanceHash: ACCEPTANCE,
        sources: [{ slotId: "main", source: source + "-- changed" }],
        values: [],
        checks: CHECKS,
      }),
    /differs from its exact lock/,
  );
});

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
      startedAt: "2026-09-05T00:00:01.000Z",
      endedAt: "2026-09-05T00:00:02.000Z",
      completion: "complete",
      facts,
    },
    projection,
  );
}

test("checkpoint continuation requires replayed committed evidence and the exact consumed acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-compiler-checkpoint-"));
  try {
    const store = new ImmutableJsonArtifactStore(directory);
    const before = capture(false),
      after = capture(true);
    const observed = studioProjectIndexMetadataView(before).instances.find(
      (node) => node.path === TARGET.path,
    )!;
    const inventory: GameInventoryItem[] = [
      {
        id: "update-open",
        componentId: "material",
        change: { id: "update-open", kind: "update", target: TARGET, expectedClass: "Folder" },
        beforeHash: contentHash(stableJson(observed)),
        lockedProperties: {},
        valueSlots: [],
        attributes: { Open: true },
        removedAttributes: [],
        dependencies: [],
      },
    ];
    const compiled = plan(inventory, before);
    const graph = build(compiled);
    const transaction = {
      sessionId: "partition-session",
      changeSetId: "partition-change",
      changeSetHash: contentHash("partition change"),
      buildContractHash: contentHash("partition contract"),
      approvalHash: ACCEPTANCE,
      dashboardReviewHash: ACCEPTANCE,
    };
    const bound = await bindGameBuildPartition({
      plan: compiled,
      graph,
      receipts: [],
      store,
      capture: before,
      transaction,
    });
    assert.equal(bound.partitionBinding.acceptanceHash, ACCEPTANCE);
    const sealed = {
      id: transaction.changeSetId,
      hash: transaction.changeSetHash,
      sessionId: transaction.sessionId,
      expectedRevisionHash: before.revision.hash,
      buildContractHash: transaction.buildContractHash,
      operations: bound.operations,
    };
    const changeSet: CreatorMutationChangeSetLike = {
      kind: "CreatorChangeSet",
      id: sealed.id,
      hash: sealed.hash,
      project: PROJECT,
      binding: bound.readback.binding,
      projectionId: bound.readback.id,
      operations: adaptCreatorChangeSetMutationOperations(sealed, gameTopologyFromCapture(before)),
    };
    const reconciliationInput = {
      sessionId: transaction.sessionId,
      attemptId: "partition-attempt",
      manifest: STUDIO_CAPABILITY_MANIFEST,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      changeSet,
      projection: bound.readback,
      preflight: { projection: bound.preflight, envelope: envelope(bound.preflight) },
      directReadback: envelope(bound.readback),
      beforeIndexCapture: before,
      afterIndexCapture: after,
    };
    const reconciliation = reconcileCreatorMutation(reconciliationInput);
    assert.equal(reconciliation.status, "matched", stableJson(reconciliation.failureFacts));
    const finalization = createCreatorMutationFinalization({
      attemptId: reconciliationInput.attemptId,
      sessionId: transaction.sessionId,
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
      recordingId: "recording-fixture",
      reconciliationHash: reconciliation.hash,
      action: "commit",
      status: "committed",
    });
    const [
      manifestRef,
      changeRef,
      projectionRef,
      preflightRef,
      preflightEnvelopeRef,
      directRef,
      reconciliationRef,
      finalRef,
      beforeRef,
      afterRef,
    ] = await Promise.all([
      store.write(STUDIO_CAPABILITY_MANIFEST),
      store.write(changeSet),
      store.write(bound.readback),
      store.write(bound.preflight),
      store.write(reconciliationInput.preflight.envelope),
      store.write(reconciliationInput.directReadback),
      store.write(reconciliation),
      store.write(finalization),
      writeCreatorProjectIndexArtifacts(store, before),
      writeCreatorProjectIndexArtifacts(store, after),
    ]);
    const preflightBinding = {
      projection: { artifact: preflightRef, hash: bound.preflight.contentHash },
      envelope: {
        artifact: preflightEnvelopeRef,
        hash: reconciliationInput.preflight.envelope.contentHash,
      },
    };
    const attempt = createCreatorMutationAttempt(reconciliationInput.attemptId, {
      sessionId: transaction.sessionId,
      manifest: { artifact: manifestRef, hash: STUDIO_CAPABILITY_MANIFEST_HASH },
      attestation: preflightBinding,
      changeSet: { artifact: changeRef, hash: changeSet.hash },
      projection: { artifact: projectionRef, hash: bound.readback.contentHash },
      preflight: preflightBinding,
      directReadback: { artifact: directRef, hash: reconciliationInput.directReadback.contentHash },
      beforeIndexCapture: beforeRef,
      afterIndexCapture: afterRef,
      finalIndexCapture: afterRef,
      reconciliation: { artifact: reconciliationRef, hash: reconciliation.hash },
      finalization: { artifact: finalRef, hash: finalization.hash },
    });
    const attemptRef = await store.write(attempt);
    const nativeReceiptRef = await store.write({
      creatorSessionId: transaction.sessionId,
      changeSetId: sealed.id,
      changeSetHash: sealed.hash,
      projectionId: bound.readback.id,
      projectionHash: bound.readback.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectRevisionHash: before.revision.hash,
      afterProjectRevisionHash: after.revision.hash,
      recordingId: "recording-fixture",
      status: "committed",
      action: "commit",
    });
    const acknowledgement = {
      kind: "CreatorChangeFinalizationAcknowledgement",
      studioSessionId: "studio-fixture",
      projectId: PROJECT_ID,
      receipt: nativeReceiptRef,
      authorityHash: attempt.hash,
      requestId: "ack-fixture",
      resultingRecordingState: "none",
      acknowledgedAt: "2026-09-05T00:00:03.000Z",
    };
    const ackRef = await store.write(acknowledgement);
    const receipt = await createGameCheckpointReceipt({
      plan: compiled,
      graph,
      ordinal: 0,
      attempt: attemptRef,
      acknowledgement: ackRef,
      store,
    });
    const prefix = await verifyGameCheckpointPrefix({
      plan: compiled,
      graph,
      receipts: [receipt],
      store,
    });
    assert.equal(prefix.status, "matched");
    assert.equal(prefix.currentRevisionHash, after.revision.hash);
    await assert.rejects(
      () =>
        verifyGameCheckpointPrefix({ plan: compiled, graph, receipts: [receipt, receipt], store }),
      /exceeds/,
    );
    await assert.rejects(
      () =>
        verifyGameCheckpointPrefix({
          plan: compiled,
          graph,
          receipts: [],
          store,
          unknownApplyPartitionHash: graph.partitions[0]!.hash,
        }),
      /Unknown Apply/,
    );
    const wrongAck = await store.write({
      ...acknowledgement,
      authorityHash: nativeReceiptRef.artifactHash,
    });
    await assert.rejects(
      () =>
        createGameCheckpointReceipt({
          plan: compiled,
          graph,
          ordinal: 0,
          attempt: attemptRef,
          acknowledgement: wrongAck,
          store,
        }),
      /settled mutation attempt/,
    );
    await assert.rejects(
      () =>
        bindGameBuildPartition({
          plan: compiled,
          graph,
          receipts: [],
          store,
          capture: after,
          transaction,
        }),
      /Fresh capture differs/,
    );
    assert.throws(
      () =>
        createGamePartitionBinding(
          { ...bound.prefix, currentRevisionHash: after.revision.hash },
          graph,
          compiled,
          after.revision.hash,
        ),
      /checkpoint revision/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
