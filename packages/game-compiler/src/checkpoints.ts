import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertProjectAuthorityMap,
  assertRojoSourceChangeSet,
  assertRojoMutationAttempt,
  assertRojoSyncProof,
  createFilesystemSourceRevision,
  createRojoSourceChangeSet,
  createRojoSyncProof,
  replayRojoMutation,
} from "../../project-authority/src/index.js";
import {
  rojoStudioNonSourceHash,
  rojoSyncObservation,
} from "../../creator-session/src/rojo-evidence.js";
import {
  assertArtifactReference,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  adaptCreatorChangeSetMutationOperations,
  assertCreatorMutationAttempt,
  assertCreatorMutationFinalization,
  creatorDeleteSubtreesFromProjectIndex,
  creatorStructuralParentsFromProjectIndex,
  compileCreatorChangeSetMutationProjection,
  replayCreatorMutation,
  type CreatorMutationChangeSetLike,
} from "../../creator-session/src/mutation-evidence.js";
import { readCreatorProjectIndexArtifacts } from "../../creator-session/src/project-refresh.js";
import {
  assertStudioProjectIndexCapture,
  assertStudioProjectIndexNode,
  studioProjectIndexMetadataView,
  STUDIO_CAPABILITY_MANIFEST,
  studioObjectIdentityKey,
  type StudioProjectIndexCapture,
  type StudioObservedPropertyValue,
} from "../../studio-evidence/src/index.js";
import type { CreatorTransactionTopologyNode } from "../../creator-session/src/transaction-topology.js";
import type { StudioChangeOperation } from "../../creator-session/src/index.js";
import { assertGameBuildGraph, gameBuildPartitionOperations } from "./build.js";
import type { GameBuildGraph, GamePlan } from "./types.js";

export interface GameStudioCheckpointReceipt {
  readonly kind: "GameCheckpointReceipt";
  readonly hash: string;
  readonly graphHash: string;
  readonly partitionHash: string;
  readonly ordinal: number;
  readonly previousReceiptHash?: string;
  readonly attempt: ArtifactReference;
  readonly acknowledgement: ArtifactReference;
  readonly beforeRevisionHash: string;
  readonly afterRevisionHash: string;
  readonly reconciliationHash: string;
  readonly finalizationHash: string;
}

export interface GameRojoCheckpointReceipt {
  readonly kind: "GameRojoCheckpointReceipt";
  readonly hash: string;
  readonly graphHash: string;
  readonly partitionHash: string;
  readonly ordinal: number;
  readonly previousReceiptHash?: string;
  readonly authorityMap: ArtifactReference;
  readonly sourceChangeSet: ArtifactReference;
  readonly attempt: ArtifactReference;
  readonly syncProof: ArtifactReference;
  readonly beforeIndexCapture: import("../../creator-session/src/project-refresh.js").CreatorProjectIndexArtifactBinding;
  readonly afterIndexCapture: import("../../creator-session/src/project-refresh.js").CreatorProjectIndexArtifactBinding;
  readonly beforeRevisionHash: string;
  readonly afterRevisionHash: string;
  readonly replayHash: string;
}

export type GameCheckpointReceipt = GameStudioCheckpointReceipt | GameRojoCheckpointReceipt;

export interface GameCheckpointPrefix {
  readonly kind: "GameCheckpointPrefix";
  readonly graphHash: string;
  readonly status: "incomplete" | "matched";
  readonly receipts: readonly GameCheckpointReceipt[];
  readonly currentRevisionHash: string;
  readonly nextPartitionOrdinal: number;
}

export interface GamePartitionBinding {
  readonly kind: "GamePartitionBinding";
  readonly hash: string;
  readonly planHash: string;
  readonly graphHash: string;
  readonly acceptanceHash: string;
  readonly partitionHash: string;
  readonly ordinal: number;
  readonly verifiedPrefixHash: string;
  readonly beforeRevisionHash: string;
}

/** Replays durable native evidence; a list of caller-supplied hashes is never a receipt. */
export async function createGameCheckpointReceipt(input: {
  readonly plan: GamePlan;
  readonly graph: GameBuildGraph;
  readonly ordinal: number;
  readonly attempt: ArtifactReference;
  readonly acknowledgement: ArtifactReference;
  readonly previousReceipt?: GameCheckpointReceipt;
  readonly store: ImmutableJsonArtifactStore;
}): Promise<GameStudioCheckpointReceipt> {
  assertGameBuildGraph(input.graph, input.plan);
  const partition = input.graph.partitions[input.ordinal];
  if (
    !partition ||
    input.ordinal !== (input.previousReceipt ? input.previousReceipt.ordinal + 1 : 0)
  )
    throw new Error("Checkpoint receipt must extend the contiguous graph prefix");
  if (
    input.previousReceipt &&
    (input.previousReceipt.graphHash !== input.graph.hash ||
      input.previousReceipt.partitionHash !== input.graph.partitions[input.ordinal - 1]!.hash)
  )
    throw new Error("Previous receipt belongs to another graph or partition");
  const attempt = await input.store.read(input.attempt, assertCreatorMutationAttempt);
  if (attempt.completion !== "settled")
    throw new Error("Incomplete or unknown Apply cannot produce a checkpoint");
  const replay = await replayCreatorMutation(attempt, input.store);
  if (replay.result !== "exact_match" || replay.replayedStatus !== "matched")
    throw new Error("Checkpoint requires independently replayed matched mutation evidence");
  const finalization = await input.store.read(
    attempt.finalization.artifact,
    assertCreatorMutationFinalization,
  );
  if (finalization.action !== "commit" || finalization.status !== "committed")
    throw new Error("Only committed native mutations extend the graph prefix");
  const before = await readCreatorProjectIndexArtifacts(input.store, attempt.beforeIndexCapture);
  const expectedBefore =
    input.previousReceipt?.afterRevisionHash ?? input.graph.observedRevisionHash;
  if (
    before.revision.hash !== expectedBefore ||
    stableJson(before.revision.project) !== stableJson(input.plan.project)
  )
    throw new Error("Checkpoint before revision/project differs from the verified prefix");
  const changeSet = await input.store.read<CreatorMutationChangeSetLike>(
    attempt.changeSet.artifact,
  );
  const operations = gameBuildPartitionOperations(input.graph, partition.ordinal);
  const sealed = {
    id: changeSet.id,
    hash: changeSet.hash,
    sessionId: attempt.sessionId,
    expectedRevisionHash: before.revision.hash,
    buildContractHash: changeSet.binding.buildHash!,
    operations,
  };
  const expectedOperations = adaptCreatorChangeSetMutationOperations(
    sealed,
    gameTopologyFromCapture(before),
    creatorDeleteSubtreesFromProjectIndex(sealed, before),
    creatorStructuralParentsFromProjectIndex(sealed, before),
  );
  if (stableJson(expectedOperations) !== stableJson(changeSet.operations))
    throw new Error("Replayed mutation is not the exact graph partition");
  const ack = await input.store.read(input.acknowledgement);
  if (
    !isRecord(ack) ||
    ack.kind !== "CreatorChangeFinalizationAcknowledgement" ||
    ack.projectId !== input.plan.projectId ||
    ack.resultingRecordingState !== "none" ||
    typeof ack.requestId !== "string" ||
    !ack.requestId ||
    typeof ack.acknowledgedAt !== "string"
  )
    throw new Error("Checkpoint lacks an exact consumed finalization acknowledgement");
  assertArtifactReference(ack.receipt);
  if (ack.authorityHash !== attempt.hash)
    throw new Error("Finalization acknowledgement must bind the settled mutation attempt");
  const nativeReceipt = await input.store.read(ack.receipt);
  if (
    !isRecord(nativeReceipt) ||
    nativeReceipt.creatorSessionId !== attempt.sessionId ||
    nativeReceipt.changeSetId !== changeSet.id ||
    nativeReceipt.changeSetHash !== changeSet.hash ||
    nativeReceipt.recordingId !== finalization.recordingId ||
    nativeReceipt.status !== "committed" ||
    nativeReceipt.action !== "commit" ||
    nativeReceipt.projectionId !== finalization.projectionId ||
    nativeReceipt.projectionHash !== finalization.projectionHash ||
    nativeReceipt.manifestHash !== finalization.manifestHash ||
    nativeReceipt.beforeProjectRevisionHash !== finalization.beforeIndexRevisionHash ||
    nativeReceipt.afterProjectRevisionHash !== finalization.finalIndexRevisionHash
  )
    throw new Error("Finalization acknowledgement does not bind the committed native receipt");
  const payload = {
    kind: "GameCheckpointReceipt" as const,
    graphHash: input.graph.hash,
    partitionHash: partition.hash,
    ordinal: input.ordinal,
    ...(input.previousReceipt ? { previousReceiptHash: input.previousReceipt.hash } : {}),
    attempt: input.attempt,
    acknowledgement: input.acknowledgement,
    beforeRevisionHash: before.revision.hash,
    afterRevisionHash: finalization.finalIndexRevisionHash,
    reconciliationHash: attempt.reconciliation.hash,
    finalizationHash: finalization.hash,
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

/** A guarded filesystem mutation extends the graph only after independently replayed Studio sync. */
export async function createGameRojoCheckpointReceipt(input: {
  readonly plan: GamePlan;
  readonly graph: GameBuildGraph;
  readonly ordinal: number;
  readonly authorityMap: ArtifactReference;
  readonly sourceChangeSet: ArtifactReference;
  readonly attempt: ArtifactReference;
  readonly syncProof: ArtifactReference;
  readonly beforeIndexCapture: GameRojoCheckpointReceipt["beforeIndexCapture"];
  readonly afterIndexCapture: GameRojoCheckpointReceipt["afterIndexCapture"];
  readonly previousReceipt?: GameCheckpointReceipt;
  readonly store: ImmutableJsonArtifactStore;
}): Promise<GameRojoCheckpointReceipt> {
  assertGameBuildGraph(input.graph, input.plan);
  const partition = input.graph.partitions[input.ordinal];
  if (
    !partition ||
    input.ordinal !== (input.previousReceipt ? input.previousReceipt.ordinal + 1 : 0) ||
    (input.previousReceipt &&
      (input.previousReceipt.graphHash !== input.graph.hash ||
        input.previousReceipt.partitionHash !== input.graph.partitions[input.ordinal - 1]!.hash))
  )
    throw new Error("Rojo checkpoint must extend the contiguous exact graph prefix");
  const [authorityMap, sourceChangeSet, attempt, syncProof, before, after] = await Promise.all([
    input.store.read(input.authorityMap, assertProjectAuthorityMap),
    input.store.read(input.sourceChangeSet, assertRojoSourceChangeSet),
    input.store.read(input.attempt, assertRojoMutationAttempt),
    input.store.read(input.syncProof, assertRojoSyncProof),
    readCreatorProjectIndexArtifacts(input.store, input.beforeIndexCapture),
    readCreatorProjectIndexArtifacts(input.store, input.afterIndexCapture),
  ]);
  const expectedBefore =
    input.previousReceipt?.afterRevisionHash ?? input.graph.observedRevisionHash;
  if (
    !authorityMap.rojo ||
    authorityMap.projectId !== input.plan.projectId ||
    authorityMap.studioRevisionHash !== expectedBefore ||
    before.revision.hash !== expectedBefore ||
    stableJson(before.revision.project) !== stableJson(input.plan.project) ||
    stableJson(after.revision.project) !== stableJson(input.plan.project) ||
    sourceChangeSet.authorityMapHash !== authorityMap.hash ||
    attempt.authorityMapHash !== authorityMap.hash ||
    attempt.beforeFilesystemRevision.hash !== authorityMap.rojo.filesystemRevision.hash ||
    sourceChangeSet.beforeStudioRevisionHash !== expectedBefore
  )
    throw new Error(
      "Rojo checkpoint project, authority map or before revision differs from the exact graph prefix",
    );
  const beforeObservation = rojoSyncObservation(
    before,
    authorityMap.rojo.filesystemRevision.entries,
  );
  if (
    createFilesystemSourceRevision(
      authorityMap.rojo.sourcemap.hash,
      beforeObservation.sourceEntries,
    ).hash !== authorityMap.rojo.filesystemRevision.hash
  )
    throw new Error(
      "Rojo checkpoint initial Studio source differs from the guarded filesystem revision",
    );
  const rematerialized = createRojoSourceChangeSet({
    id: sourceChangeSet.id,
    authorityMap,
    beforeStudioRevisionHash: before.revision.hash,
    beforeStudioNonSourceHash: rojoStudioNonSourceHash(studioProjectIndexMetadataView(before)),
    afterStudioNonSourceHash: rojoStudioNonSourceHash(
      studioProjectIndexMetadataView(before),
      sourceChangeSet.operations,
    ),
    operations: sourceChangeSet.operations,
    maxSourceBytes: sourceChangeSet.maximumSourceBytes,
  });
  if (stableJson(rematerialized) !== stableJson(sourceChangeSet))
    throw new Error("Rojo source change set does not reproduce against the observed authority map");
  const operations = gameBuildPartitionOperations(input.graph, partition.ordinal);
  if (operations.length !== sourceChangeSet.operations.length)
    throw new Error("Rojo source operation count differs from the graph partition");
  for (const operation of operations) {
    const source = sourceChangeSet.operations.find((candidate) => candidate.id === operation.id);
    if (!source) throw new Error("Rojo source operation is absent from the exact graph partition");
    if (operation.kind === "edit_source" && source.kind === "edit_source") {
      if (
        source.studioPath !== operation.target.path ||
        source.className !== operation.target.className ||
        source.beforeHash !== operation.beforeSourceHash ||
        source.finalSourceHash !== operation.finalSourceHash ||
        source.finalByteCount !== operation.finalByteCount ||
        source.edits.length !== operation.edits.length ||
        source.edits.some((edit, index) => {
          const expected = operation.edits[index]!;
          return (
            edit.startByte !== expected.startByte ||
            edit.endByte !== expected.endByte ||
            contentHash(edit.replacement) !== expected.replacementBlob.sourceHash ||
            Buffer.byteLength(edit.replacement, "utf8") !== expected.replacementBlob.utf8Bytes
          );
        })
      )
        throw new Error("Rojo source edit differs from the sealed graph source bytes or ranges");
    } else if (
      operation.kind === "create" &&
      operation.sourceBlob &&
      source.kind === "create_source"
    ) {
      if (
        source.parentStudioPath !== operation.parent.path ||
        source.name !== operation.name ||
        source.className !== operation.className ||
        contentHash(source.source) !== operation.sourceBlob.sourceHash ||
        Buffer.byteLength(source.source, "utf8") !== operation.sourceBlob.utf8Bytes ||
        Object.keys(operation.properties).length ||
        Object.keys(operation.attributes).length
      )
        throw new Error("Rojo source creation differs from the exact graph source-only allocation");
    } else throw new Error("Rojo checkpoint cannot prove a non-source graph operation");
  }
  const reproducedProof = createRojoSyncProof({
    attempt,
    changeSet: sourceChangeSet,
    observation: rojoSyncObservation(after, attempt.afterFilesystemRevision.entries),
  });
  const afterTopology = new Map(
    gameTopologyFromCapture(after).map((node) => [studioObjectIdentityKey(node.identity), node]),
  );
  if (
    gameTopologyFromCapture(before).some((node) => {
      const observed = afterTopology.get(studioObjectIdentityKey(node.identity));
      return (
        !observed ||
        observed.path !== node.path ||
        observed.className !== node.className ||
        stableJson(observed.parentIdentity) !== stableJson(node.parentIdentity)
      );
    })
  )
    throw new Error("Rojo checkpoint replaced or moved an existing editor identity");
  // The source-authority sync proof covers mapped files. The graph also
  // preserves every other captured script source, including Studio-owned code.
  const sourceRows = (capture: StudioProjectIndexCapture) =>
    studioProjectIndexMetadataView(capture).scripts.map((script) => ({
      path: script.path,
      className: script.className,
      sourceHash: script.sourceHash,
      utf8Bytes: script.utf8Bytes,
    }));
  const expectedSources = new Map(
    sourceRows(before).map((source) => [source.path + "\u0000" + source.className, source]),
  );
  for (const operation of sourceChangeSet.operations) {
    const path =
      operation.kind === "edit_source"
        ? operation.studioPath
        : operation.parentStudioPath + "/" + operation.name;
    expectedSources.set(path + "\u0000" + operation.className, {
      path,
      className: operation.className,
      sourceHash:
        operation.kind === "edit_source"
          ? operation.finalSourceHash
          : contentHash(operation.source),
      utf8Bytes:
        operation.kind === "edit_source"
          ? operation.finalByteCount
          : Buffer.byteLength(operation.source, "utf8"),
    });
  }
  const canonicalSources = (
    sources: readonly { path: string; className: string; sourceHash: string; utf8Bytes: number }[],
  ) =>
    stableJson(
      [...sources].sort((a, b) => {
        const left = a.path + "\u0000" + a.className,
          right = b.path + "\u0000" + b.className;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    );
  if (canonicalSources([...expectedSources.values()]) !== canonicalSources(sourceRows(after)))
    throw new Error("Rojo checkpoint changed source outside the exact graph partition");
  if (
    attempt.status !== "applied" ||
    reproducedProof.status !== "matched" ||
    stableJson(reproducedProof) !== stableJson(syncProof)
  )
    throw new Error(
      "Rojo checkpoint requires a complete independently captured matched Studio sync proof",
    );
  const replay = replayRojoMutation({ changeSet: sourceChangeSet, attempt, syncProof });
  if (replay.status !== "exact_match" || replay.finalization !== "synced")
    throw new Error("Rojo source mutation and sync evidence did not replay exactly");
  const payload = {
    kind: "GameRojoCheckpointReceipt" as const,
    graphHash: input.graph.hash,
    partitionHash: partition.hash,
    ordinal: input.ordinal,
    ...(input.previousReceipt ? { previousReceiptHash: input.previousReceipt.hash } : {}),
    authorityMap: input.authorityMap,
    sourceChangeSet: input.sourceChangeSet,
    attempt: input.attempt,
    syncProof: input.syncProof,
    beforeIndexCapture: input.beforeIndexCapture,
    afterIndexCapture: input.afterIndexCapture,
    beforeRevisionHash: before.revision.hash,
    afterRevisionHash: after.revision.hash,
    replayHash: replay.hash,
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

export async function verifyGameCheckpointPrefix(input: {
  readonly plan: GamePlan;
  readonly graph: GameBuildGraph;
  readonly receipts: readonly GameCheckpointReceipt[];
  readonly store: ImmutableJsonArtifactStore;
  readonly unknownApplyPartitionHash?: string;
}): Promise<GameCheckpointPrefix> {
  assertGameBuildGraph(input.graph, input.plan);
  if (input.unknownApplyPartitionHash)
    throw new Error(
      "Unknown Apply outcome requires explicit recording recovery before graph continuation",
    );
  if (input.receipts.length > input.graph.partitions.length)
    throw new Error("Checkpoint prefix exceeds graph partitions");
  const verified: GameCheckpointReceipt[] = [];
  for (const receipt of input.receipts) {
    if (receipt.ordinal !== verified.length || receipt.graphHash !== input.graph.hash)
      throw new Error("Checkpoint prefix has a gap, duplicate or foreign graph");
    const common = {
      plan: input.plan,
      graph: input.graph,
      ordinal: verified.length,
      attempt: receipt.attempt,
      store: input.store,
      ...(verified.length ? { previousReceipt: verified.at(-1)! } : {}),
    };
    let reproduced: GameCheckpointReceipt;
    if (receipt.kind === "GameCheckpointReceipt")
      reproduced = await createGameCheckpointReceipt({
        ...common,
        acknowledgement: receipt.acknowledgement,
      });
    else if (receipt.kind === "GameRojoCheckpointReceipt")
      reproduced = await createGameRojoCheckpointReceipt({
        ...common,
        authorityMap: receipt.authorityMap,
        sourceChangeSet: receipt.sourceChangeSet,
        syncProof: receipt.syncProof,
        beforeIndexCapture: receipt.beforeIndexCapture,
        afterIndexCapture: receipt.afterIndexCapture,
      });
    else throw new Error("Unknown graph checkpoint evidence domain");
    if (stableJson(reproduced) !== stableJson(receipt))
      throw new Error("Checkpoint receipt does not reproduce from durable evidence");
    verified.push(reproduced);
  }
  return {
    kind: "GameCheckpointPrefix",
    graphHash: input.graph.hash,
    status: verified.length === input.graph.partitions.length ? "matched" : "incomplete",
    receipts: verified,
    currentRevisionHash: verified.at(-1)?.afterRevisionHash ?? input.graph.observedRevisionHash,
    nextPartitionOrdinal: verified.length,
  };
}

/** Pure preparation for the existing Apply coordinator; this function sends no commands. */
export async function bindGameBuildPartition(input: {
  readonly plan: GamePlan;
  readonly graph: GameBuildGraph;
  readonly receipts: readonly GameCheckpointReceipt[];
  readonly store: ImmutableJsonArtifactStore;
  readonly capture: StudioProjectIndexCapture;
  readonly unknownApplyPartitionHash?: string;
  readonly transaction: {
    readonly sessionId: string;
    readonly changeSetId: string;
    readonly changeSetHash: string;
    readonly buildContractHash: string;
    readonly approvalHash: string;
    readonly dashboardReviewHash: string;
  };
}): Promise<{
  prefix: GameCheckpointPrefix;
  operations: readonly StudioChangeOperation[];
  partitionBinding: GamePartitionBinding;
  preflight: ReturnType<typeof compileCreatorChangeSetMutationProjection>;
  readback: ReturnType<typeof compileCreatorChangeSetMutationProjection>;
}> {
  const prefix = await verifyGameCheckpointPrefix(input);
  if (input.graph.localChecks.status !== "eligible")
    throw new Error("The complete graph has not passed its local gate");
  const partition = input.graph.partitions[prefix.nextPartitionOrdinal];
  if (!partition) throw new Error("The graph already has a complete checkpoint prefix");
  assertStudioProjectIndexCapture(input.capture, STUDIO_CAPABILITY_MANIFEST);
  if (
    input.capture.revision.hash !== prefix.currentRevisionHash ||
    stableJson(input.capture.revision.project) !== stableJson(input.plan.project)
  )
    throw new Error(
      "Fresh capture differs from the exact verified prefix; graph recovery or a new approved plan is required",
    );
  const operations = gameBuildPartitionOperations(input.graph, partition.ordinal);
  const changeSet = {
    id: input.transaction.changeSetId,
    hash: input.transaction.changeSetHash,
    sessionId: input.transaction.sessionId,
    expectedRevisionHash: input.capture.revision.hash,
    buildContractHash: input.transaction.buildContractHash,
    operations,
  };
  const binding = {
    sessionId: input.transaction.sessionId,
    changeSetHash: input.transaction.changeSetHash,
    approvalHash: input.transaction.approvalHash,
    revisionHash: input.capture.revision.hash,
    buildHash: input.transaction.buildContractHash,
    dashboardReviewHash: input.transaction.dashboardReviewHash,
  };
  const context = {
    project: input.plan.project,
    initialTopology: gameTopologyFromCapture(input.capture),
    binding,
    structuralParents: creatorStructuralParentsFromProjectIndex(changeSet, input.capture),
    deletedSubtrees: creatorDeleteSubtreesFromProjectIndex(changeSet, input.capture),
  };
  return {
    prefix,
    operations,
    partitionBinding: createGamePartitionBinding(
      prefix,
      input.graph,
      input.plan,
      input.capture.revision.hash,
    ),
    preflight: compileCreatorChangeSetMutationProjection(changeSet, {
      ...context,
      purpose: "mutation_preflight",
    }),
    readback: compileCreatorChangeSetMutationProjection(changeSet, {
      ...context,
      purpose: "mutation_direct_readback",
    }),
  };
}

/** Structural binding only; callers must independently verify its receipts and creator acceptance. */
export function createGamePartitionBinding(
  prefix: GameCheckpointPrefix,
  graph: GameBuildGraph,
  plan: GamePlan,
  beforeRevisionHash: string,
): GamePartitionBinding {
  assertGameBuildGraph(graph, plan);
  const partition = graph.partitions[prefix.nextPartitionOrdinal];
  if (
    prefix.graphHash !== graph.hash ||
    !partition ||
    prefix.nextPartitionOrdinal !== prefix.receipts.length ||
    prefix.currentRevisionHash !== beforeRevisionHash
  )
    throw new Error("Partition binding does not extend the exact graph prefix");
  if (
    prefix.receipts.some(
      (receipt, ordinal) =>
        receipt.ordinal !== ordinal ||
        receipt.graphHash !== graph.hash ||
        receipt.partitionHash !== graph.partitions[ordinal]?.hash ||
        (ordinal === 0
          ? receipt.previousReceiptHash !== undefined
          : receipt.previousReceiptHash !== prefix.receipts[ordinal - 1]!.hash),
    )
  )
    throw new Error("Partition prefix has inconsistent receipt bindings");
  if (
    beforeRevisionHash !== (prefix.receipts.at(-1)?.afterRevisionHash ?? graph.observedRevisionHash)
  )
    throw new Error("Partition before revision is not the checkpoint revision");
  const payload = {
    kind: "GamePartitionBinding" as const,
    planHash: plan.hash,
    graphHash: graph.hash,
    acceptanceHash: graph.acceptanceHash,
    partitionHash: partition.hash,
    ordinal: partition.ordinal,
    verifiedPrefixHash: contentHash(stableJson(prefix)),
    beforeRevisionHash,
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

export function gameTopologyFromCapture(
  capture: StudioProjectIndexCapture,
): CreatorTransactionTopologyNode[] {
  return capture.shards
    .flatMap((shard) => shard.nodes)
    .map((node) => {
      assertStudioProjectIndexNode(node);
      const properties = node.coveredProperties as Readonly<
        Record<string, StudioObservedPropertyValue>
      >;
      return {
        identity: node.identity,
        ...(node.parentIdentity ? { parentIdentity: node.parentIdentity } : {}),
        path: node.displayPath,
        name: node.name,
        className: node.className,
        properties,
        ...(node.engineContainer ? { engineContainer: node.engineContainer } : {}),
      };
    })
    .sort((a, b) =>
      studioObjectIdentityKey(a.identity) < studioObjectIdentityKey(b.identity) ? -1 : 1,
    );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
