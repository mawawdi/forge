import { createHash } from "node:crypto";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type {
  AsyncVerifiedSourceResolver,
  SourceDocumentDescriptor,
  VerifiedSourceRange,
} from "../../source-intelligence/src/index.js";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import type {
  StudioProjectChangeDetectedPayload,
  StudioProjectChangeSource,
} from "../../studio-protocol/src/index.js";
import { STUDIO_PROJECT_CHANGE_SOURCES } from "../../studio-protocol/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  assertStudioCapabilityManifest,
  assertStudioProjectEvidenceShard,
  assertStudioProjectIndexManifest,
  assertStudioProjectIndexProjection,
  assertStudioProjectRevision,
  assertStudioSourceBlobChunk,
  assertStudioSourceBlobManifest,
  createStudioProjectIndexCapture,
  studioObjectIdentityKey,
  type StudioProjectIndexMetadataView,
  type StudioProjectEvidenceShard,
  type StudioCapabilityManifest,
  type StudioProjectIndexCapture,
  type StudioProjectIndexManifest,
  type StudioProjectIndexProjection,
  type StudioProjectRevision,
  type StudioSourceBlobChunk,
  type StudioSourceBlobManifest,
} from "../../studio-evidence/src/index.js";

export interface CreatorProjectChangeNotice {
  readonly kind: "CreatorProjectChangeNotice";
  readonly id: string;
  readonly hash: string;
  readonly projectId: string;
  readonly connectorEpoch: string;
  readonly detectorEpoch: number;
  readonly detectedAt: string;
  readonly origin: "studio" | "control_process_restart";
  readonly reasons: readonly (StudioProjectChangeSource | "control_process_restart")[];
}

export interface CreatorProjectDelta {
  readonly kind: "CreatorProjectDelta";
  readonly id: string;
  readonly hash: string;
  /** Exact complete capture before the comparison; a revision alone is not unique. */
  readonly beforeCaptureHash: string;
  /** Exact complete capture after the comparison; a revision alone is not unique. */
  readonly afterCaptureHash: string;
  readonly beforeRevisionHash: string;
  readonly afterRevisionHash: string;
  readonly changed: boolean;
  readonly addedShardHashes: readonly string[];
  readonly removedShardHashes: readonly string[];
  readonly addedSourceManifestHashes: readonly string[];
  readonly removedSourceManifestHashes: readonly string[];
}

export interface CreatorProjectRefresh {
  readonly kind: "CreatorProjectRefresh";
  readonly id: string;
  readonly hash: string;
  readonly predecessorSessionId: string;
  readonly successorSessionId?: string;
  readonly notice: ArtifactReference;
  readonly delta: ArtifactReference;
  readonly beforeCaptureHash: string;
  readonly afterCaptureHash: string;
  readonly beforeRevisionHash: string;
  readonly afterRevisionHash: string;
  readonly outcome: "unchanged" | "superseded";
  readonly refreshedAt: string;
}

/**
 * Immutable outcome of checking an advisory dirty notice while a Forge
 * recording may still be open. The notice is not a revision claim: only its
 * separately retained complete index capture can establish unchanged state or
 * drift. This record has no authority to refresh, replan, mutate, commit, or
 * cancel.
 */
export interface CreatorTransactionProjectChangeConfirmation {
  readonly kind: "CreatorTransactionProjectChangeConfirmation";
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly notice: ArtifactReference;
  readonly expectedCaptureHash: string;
  readonly expectedRevisionHash: string;
  readonly outcome: "unchanged" | "drift" | "incomplete";
  readonly observedCaptureHash?: string;
  readonly observedRevisionHash?: string;
  readonly delta?: ArtifactReference;
  readonly detail: string;
  readonly confirmedAt: string;
}

export interface CreatorProjectIndexArtifactBinding {
  readonly captureId: string;
  readonly captureHash: string;
  /** Exact monitor epoch bound into this complete capture. */
  readonly detectorEpoch: number;
  readonly projection: {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  };
  readonly manifest: {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  };
  readonly revision: {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  };
  readonly shards: readonly {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  }[];
  readonly sourceManifests: readonly {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  }[];
  readonly sourceChunks: readonly {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  }[];
}

/**
 * Metadata leaves plus a revision-bound, artifact-backed range reader.
 * This intentionally does not reconstruct a complete capture: the complete
 * replay path remains `readCreatorProjectIndexArtifacts`, while source
 * navigation reads and verifies only the selected source blob's chunks.
 */
export interface CreatorProjectIndexMetadataArtifacts {
  readonly view: StudioProjectIndexMetadataView;
  readonly sourceDocuments: readonly SourceDocumentDescriptor[];
  readonly sourceResolver: AsyncVerifiedSourceResolver;
}

/**
 * Persist a project index as one immutable evidence graph. There is
 * intentionally no aggregate capture artifact: replay must prove that every
 * bounded leaf is present and still reproduces the retained revision.
 */
export async function writeCreatorProjectIndexArtifacts(
  store: ImmutableJsonArtifactStore,
  capture: StudioProjectIndexCapture,
): Promise<CreatorProjectIndexArtifactBinding> {
  const [
    projectionArtifact,
    manifestArtifact,
    revisionArtifact,
    shards,
    sourceManifests,
    sourceChunks,
  ] = await Promise.all([
    store.write(capture.projection),
    store.write(capture.indexManifest),
    store.write(capture.revision),
    Promise.all(
      capture.shards.map(async (shard) => ({
        id: shard.id,
        hash: shard.hash,
        artifact: await store.write(shard),
      })),
    ),
    Promise.all(
      capture.sourceManifests.map(async (manifest) => ({
        id: manifest.id,
        hash: manifest.hash,
        artifact: await store.write(manifest),
      })),
    ),
    Promise.all(
      capture.sourceChunks.map(async (chunk) => ({
        id: chunk.id,
        hash: chunk.hash,
        artifact: await store.write(chunk),
      })),
    ),
  ]);
  return {
    captureId: `studio_project_index_capture_${capture.hash.slice(0, 24)}`,
    captureHash: capture.hash,
    detectorEpoch: capture.detectorEpoch,
    projection: {
      id: capture.projection.id,
      hash: capture.projection.hash,
      artifact: projectionArtifact,
    },
    manifest: {
      id: capture.indexManifest.id,
      hash: capture.indexManifest.hash,
      artifact: manifestArtifact,
    },
    revision: {
      id: capture.revision.id,
      hash: capture.revision.hash,
      artifact: revisionArtifact,
    },
    shards,
    sourceManifests,
    sourceChunks,
  };
}

/** Reconstruct and verify a complete capture solely from its leaf graph. */
export async function readCreatorProjectIndexArtifacts(
  store: ImmutableJsonArtifactStore,
  binding: CreatorProjectIndexArtifactBinding,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): Promise<StudioProjectIndexCapture> {
  assertStudioCapabilityManifest(manifest);
  assertProjectIndexArtifactBinding(binding);
  const [projection, indexManifest, revision, shards, sourceManifests, sourceChunks] =
    await Promise.all([
      readBoundArtifact<StudioProjectIndexProjection>(
        store,
        binding.projection,
        assertStudioProjectIndexProjection,
      ),
      readBoundArtifact<StudioProjectIndexManifest>(
        store,
        binding.manifest,
        assertStudioProjectIndexManifest,
      ),
      readBoundArtifact<StudioProjectRevision>(
        store,
        binding.revision,
        assertStudioProjectRevision,
      ),
      Promise.all(
        binding.shards.map((entry) =>
          readBoundArtifact<StudioProjectEvidenceShard>(store, entry, (value) =>
            assertStudioProjectEvidenceShard(value, manifest),
          ),
        ),
      ),
      Promise.all(
        binding.sourceManifests.map((entry) =>
          readBoundArtifact<StudioSourceBlobManifest>(store, entry, assertStudioSourceBlobManifest),
        ),
      ),
      Promise.all(
        binding.sourceChunks.map((entry) =>
          readBoundArtifact<StudioSourceBlobChunk>(store, entry, assertStudioSourceBlobChunk),
        ),
      ),
    ]);
  const capture = createStudioProjectIndexCapture(
    {
      projection,
      shards,
      sourceManifests,
      sourceChunks,
      completedAt: indexManifest.completedAt,
      detectorEpoch: binding.detectorEpoch,
    },
    manifest,
  );
  if (
    capture.hash !== binding.captureHash ||
    binding.captureId !== `studio_project_index_capture_${capture.hash.slice(0, 24)}` ||
    stableJson(capture.indexManifest) !== stableJson(indexManifest) ||
    stableJson(capture.revision) !== stableJson(revision) ||
    stableJson(capture.shards.map(({ id, hash }) => ({ id, hash }))) !==
      stableJson(binding.shards.map(({ id, hash }) => ({ id, hash }))) ||
    stableJson(capture.sourceManifests.map(({ id, hash }) => ({ id, hash }))) !==
      stableJson(binding.sourceManifests.map(({ id, hash }) => ({ id, hash }))) ||
    stableJson(capture.sourceChunks.map(({ id, hash }) => ({ id, hash }))) !==
      stableJson(binding.sourceChunks.map(({ id, hash }) => ({ id, hash })))
  )
    fail("Project-index artifact graph mismatch");
  return capture;
}

/**
 * Read only index metadata leaves. Source chunks are kept as immutable
 * artifact references and are loaded, range-sliced, and hash-verified on
 * demand by the returned resolver.
 */
export async function readCreatorProjectIndexMetadataArtifacts(
  store: ImmutableJsonArtifactStore,
  binding: CreatorProjectIndexArtifactBinding,
): Promise<CreatorProjectIndexMetadataArtifacts> {
  assertProjectIndexArtifactBinding(binding);
  const [projection, indexManifest, revision, shards, sourceManifests] = await Promise.all([
    readBoundArtifact<StudioProjectIndexProjection>(
      store,
      binding.projection,
      assertStudioProjectIndexProjection,
    ),
    readBoundArtifact<StudioProjectIndexManifest>(
      store,
      binding.manifest,
      assertStudioProjectIndexManifest,
    ),
    readBoundArtifact<StudioProjectRevision>(store, binding.revision, assertStudioProjectRevision),
    Promise.all(
      binding.shards.map((entry) =>
        readBoundArtifact<StudioProjectEvidenceShard>(
          store,
          entry,
          assertStudioProjectEvidenceShard,
        ),
      ),
    ),
    Promise.all(
      binding.sourceManifests.map((entry) =>
        readBoundArtifact<StudioSourceBlobManifest>(store, entry, assertStudioSourceBlobManifest),
      ),
    ),
  ]);
  assertMetadataLeafGraph({
    projection,
    indexManifest,
    revision,
    shards,
    sourceManifests,
    binding,
  });

  const manifests = new Map(sourceManifests.map((manifest) => [manifest.hash, manifest] as const));
  const sourceDocuments: SourceDocumentDescriptor[] = [];
  const instances: StudioProjectIndexMetadataView["instances"][number][] = [];
  for (const node of shards.flatMap((shard) => shard.nodes)) {
    const objectId = studioObjectIdentityKey(node.identity);
    const positionValue = node.coveredProperties.Position;
    const position =
      record(positionValue) &&
      positionValue.kind === "vector3_f32" &&
      typeof positionValue.x === "number" &&
      typeof positionValue.y === "number" &&
      typeof positionValue.z === "number"
        ? { x: positionValue.x, y: positionValue.y, z: positionValue.z }
        : undefined;
    instances.push({
      objectId,
      identity: node.identity,
      path: node.displayPath,
      name: node.name,
      ...(node.parentIdentity === undefined ? {} : { parentIdentity: node.parentIdentity }),
      ...(node.engineContainer === undefined ? {} : { engineContainer: node.engineContainer }),
      className: node.className,
      ...(position ? { position } : {}),
      properties:
        node.coveredProperties as StudioProjectIndexMetadataView["instances"][number]["properties"],
      attributes:
        node.attributes as StudioProjectIndexMetadataView["instances"][number]["attributes"],
      tags: [...node.tags],
    });
    if (node.sourceManifestHash === undefined) continue;
    const manifest = manifests.get(node.sourceManifestHash);
    if (!manifest || studioObjectIdentityKey(manifest.identity) !== objectId)
      fail("Project-index source manifest identity binding");
    sourceDocuments.push({
      documentId: objectId,
      path: node.displayPath,
      className: node.className,
      executionContext: sourceExecutionContext(node.className),
      sourceHash: manifest.sourceHash,
      utf8Bytes: manifest.utf8Bytes,
    });
  }
  const orderedDocuments = sourceDocuments.sort(compareSourceDocument);
  if (
    new Set(orderedDocuments.map((document) => document.documentId)).size !==
    orderedDocuments.length
  )
    fail("Project-index duplicate source document identity");
  const view: StudioProjectIndexMetadataView = {
    project: indexManifest.project,
    revision,
    instances: instances.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.objectId.localeCompare(right.objectId),
    ),
    scripts: orderedDocuments,
  };
  return {
    view,
    sourceDocuments: orderedDocuments,
    sourceResolver: createArtifactRangeResolver({
      store,
      documents: orderedDocuments,
      manifests,
      sourceChunks: binding.sourceChunks,
    }),
  };
}

export function creatorProjectIndexArtifactReferences(
  binding: CreatorProjectIndexArtifactBinding,
): readonly ArtifactReference[] {
  assertProjectIndexArtifactBinding(binding);
  return [
    binding.projection.artifact,
    binding.manifest.artifact,
    binding.revision.artifact,
    ...binding.shards.map((entry) => entry.artifact),
    ...binding.sourceManifests.map((entry) => entry.artifact),
    ...binding.sourceChunks.map((entry) => entry.artifact),
  ];
}

export function createCreatorProjectChangeNotice(input: {
  readonly projectId: string;
  readonly connectorEpoch: string;
  readonly payload: StudioProjectChangeDetectedPayload;
}): CreatorProjectChangeNotice {
  if (!nonEmpty(input.projectId) || !nonEmpty(input.connectorEpoch))
    fail("Project-change notice binding");
  if (!Number.isSafeInteger(input.payload.epoch) || input.payload.epoch < 1)
    fail("Project-change detector epoch");
  if (Number.isNaN(Date.parse(input.payload.observedAt))) fail("Project-change notice time");
  const reasons = [...new Set(input.payload.sources)].sort();
  if (
    reasons.length === 0 ||
    reasons.some((reason) => !STUDIO_PROJECT_CHANGE_SOURCES.includes(reason))
  )
    fail("Project-change reasons");
  const payload = {
    projectId: input.projectId,
    connectorEpoch: input.connectorEpoch,
    detectorEpoch: input.payload.epoch,
    detectedAt: input.payload.observedAt,
    origin: "studio" as const,
    reasons,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorProjectChangeNotice",
    id: `creator_project_change_notice_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function createCreatorRestartChangeNotice(input: {
  readonly projectId: string;
  readonly connectorEpoch: string;
  readonly detectedAt?: string;
}): CreatorProjectChangeNotice {
  if (!nonEmpty(input.projectId) || !nonEmpty(input.connectorEpoch))
    fail("Restart project-change notice binding");
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(detectedAt))) fail("Restart project-change notice time");
  const payload = {
    projectId: input.projectId,
    connectorEpoch: input.connectorEpoch,
    detectorEpoch: 0,
    detectedAt,
    origin: "control_process_restart" as const,
    reasons: ["control_process_restart" as const],
  };
  const noticeHash = contentHash(stableJson(payload));
  return {
    kind: "CreatorProjectChangeNotice",
    id: `creator_project_change_notice_${noticeHash.slice(0, 24)}`,
    hash: noticeHash,
    ...payload,
  };
}

export function createCreatorProjectDelta(
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
): CreatorProjectDelta {
  if (stableJson(before.indexManifest.project) !== stableJson(after.indexManifest.project))
    fail("Project delta project binding");
  const addedShardHashes = difference(
    after.indexManifest.allShardHashes,
    before.indexManifest.allShardHashes,
  );
  const removedShardHashes = difference(
    before.indexManifest.allShardHashes,
    after.indexManifest.allShardHashes,
  );
  const addedSourceManifestHashes = difference(
    after.indexManifest.sourceManifestHashes,
    before.indexManifest.sourceManifestHashes,
  );
  const removedSourceManifestHashes = difference(
    before.indexManifest.sourceManifestHashes,
    after.indexManifest.sourceManifestHashes,
  );
  return createCreatorProjectDeltaFromPayload({
    beforeCaptureHash: before.hash,
    afterCaptureHash: after.hash,
    beforeRevisionHash: before.revision.hash,
    afterRevisionHash: after.revision.hash,
    changed:
      before.revision.merkleRoot !== after.revision.merkleRoot ||
      before.revision.connectorEpoch !== after.revision.connectorEpoch,
    addedShardHashes,
    removedShardHashes,
    addedSourceManifestHashes,
    removedSourceManifestHashes,
  });
}

export function createCreatorProjectRefresh(
  input: Omit<CreatorProjectRefresh, "kind" | "id" | "hash">,
): CreatorProjectRefresh {
  if (
    !nonEmpty(input.predecessorSessionId) ||
    (input.successorSessionId !== undefined && !nonEmpty(input.successorSessionId))
  )
    fail("Project refresh session binding");
  assertArtifactReference(input.notice);
  assertArtifactReference(input.delta);
  if (
    !hash(input.beforeCaptureHash) ||
    !hash(input.afterCaptureHash) ||
    !hash(input.beforeRevisionHash) ||
    !hash(input.afterRevisionHash)
  )
    fail("Project refresh capture binding");
  if (input.outcome !== "unchanged" && input.outcome !== "superseded")
    fail("Project refresh outcome");
  if (input.outcome === "unchanged" && input.successorSessionId !== undefined)
    fail("Unchanged refresh successor");
  if (input.outcome === "superseded" && input.successorSessionId === undefined)
    fail("Superseded refresh successor");
  if (Number.isNaN(Date.parse(input.refreshedAt))) fail("Project refresh time");
  const value = { ...input };
  const resultHash = contentHash(stableJson(value));
  return {
    kind: "CreatorProjectRefresh",
    id: `creator_project_refresh_${resultHash.slice(0, 24)}`,
    hash: resultHash,
    ...value,
  };
}

export function createCreatorTransactionProjectChangeConfirmation(
  input: Omit<CreatorTransactionProjectChangeConfirmation, "kind" | "id" | "hash">,
): CreatorTransactionProjectChangeConfirmation {
  if (!nonEmpty(input.sessionId)) fail("Transaction project-change session");
  assertArtifactReference(input.notice);
  if (!hash(input.expectedCaptureHash) || !hash(input.expectedRevisionHash))
    fail("Transaction project-change expected index");
  if (!["unchanged", "drift", "incomplete"].includes(input.outcome))
    fail("Transaction project-change outcome");
  if (!nonEmpty(input.detail) || Buffer.byteLength(input.detail, "utf8") > 4_096)
    fail("Transaction project-change detail");
  if (Number.isNaN(Date.parse(input.confirmedAt)))
    fail("Transaction project-change confirmation time");
  const hasObserved =
    input.observedCaptureHash !== undefined || input.observedRevisionHash !== undefined;
  if (input.outcome === "incomplete") {
    if (hasObserved || input.delta !== undefined)
      fail("Incomplete transaction project-change confirmation has observation");
  } else {
    if (
      !hash(input.observedCaptureHash) ||
      !hash(input.observedRevisionHash) ||
      input.delta === undefined
    )
      fail("Complete transaction project-change confirmation lacks index");
    assertArtifactReference(input.delta);
  }
  const value = { ...input };
  const resultHash = contentHash(stableJson(value));
  return {
    kind: "CreatorTransactionProjectChangeConfirmation",
    id: `creator_transaction_project_change_confirmation_${resultHash.slice(0, 24)}`,
    hash: resultHash,
    ...value,
  };
}

export function assertCreatorProjectChangeNotice(
  value: unknown,
): asserts value is CreatorProjectChangeNotice {
  if (record(value) && value.origin === "control_process_restart") {
    assertRecreated(value, "CreatorProjectChangeNotice", (entry) =>
      createCreatorRestartChangeNotice({
        projectId: entry.projectId as string,
        connectorEpoch: entry.connectorEpoch as string,
        detectedAt: entry.detectedAt as string,
      }),
    );
    return;
  }
  assertRecreated(value, "CreatorProjectChangeNotice", (entry) =>
    createCreatorProjectChangeNotice({
      projectId: entry.projectId as string,
      connectorEpoch: entry.connectorEpoch as string,
      payload: {
        project: { name: "artifact-only", placeId: 0, universeId: 0 },
        connectorEpoch: entry.connectorEpoch as string,
        epoch: entry.detectorEpoch as number,
        observedAt: entry.detectedAt as string,
        sources: entry.reasons as StudioProjectChangeSource[],
      },
    }),
  );
}

/** Recreate the content-bound delta identity rather than trusting bundle metadata. */
export function assertCreatorProjectDelta(value: unknown): asserts value is CreatorProjectDelta {
  assertRecreated(value, "CreatorProjectDelta", (entry) =>
    createCreatorProjectDeltaFromPayload({
      beforeCaptureHash: entry.beforeCaptureHash as string,
      afterCaptureHash: entry.afterCaptureHash as string,
      beforeRevisionHash: entry.beforeRevisionHash as string,
      afterRevisionHash: entry.afterRevisionHash as string,
      changed: entry.changed as boolean,
      addedShardHashes: entry.addedShardHashes as string[],
      removedShardHashes: entry.removedShardHashes as string[],
      addedSourceManifestHashes: entry.addedSourceManifestHashes as string[],
      removedSourceManifestHashes: entry.removedSourceManifestHashes as string[],
    }),
  );
}

/** Recreate the content-bound refresh identity and validate both evidence pointers. */
export function assertCreatorProjectRefresh(
  value: unknown,
): asserts value is CreatorProjectRefresh {
  assertRecreated(value, "CreatorProjectRefresh", (entry) =>
    createCreatorProjectRefresh({
      predecessorSessionId: entry.predecessorSessionId as string,
      ...(entry.successorSessionId === undefined
        ? {}
        : { successorSessionId: entry.successorSessionId as string }),
      notice: artifactReference(entry.notice),
      delta: artifactReference(entry.delta),
      beforeCaptureHash: entry.beforeCaptureHash as string,
      afterCaptureHash: entry.afterCaptureHash as string,
      beforeRevisionHash: entry.beforeRevisionHash as string,
      afterRevisionHash: entry.afterRevisionHash as string,
      outcome: entry.outcome as CreatorProjectRefresh["outcome"],
      refreshedAt: entry.refreshedAt as string,
    }),
  );
}

export function assertCreatorTransactionProjectChangeConfirmation(
  value: unknown,
): asserts value is CreatorTransactionProjectChangeConfirmation {
  assertRecreated(value, "CreatorTransactionProjectChangeConfirmation", (entry) =>
    createCreatorTransactionProjectChangeConfirmation({
      sessionId: entry.sessionId as string,
      notice: artifactReference(entry.notice),
      expectedCaptureHash: entry.expectedCaptureHash as string,
      expectedRevisionHash: entry.expectedRevisionHash as string,
      outcome: entry.outcome as CreatorTransactionProjectChangeConfirmation["outcome"],
      ...(entry.observedCaptureHash === undefined
        ? {}
        : { observedCaptureHash: entry.observedCaptureHash as string }),
      ...(entry.observedRevisionHash === undefined
        ? {}
        : { observedRevisionHash: entry.observedRevisionHash as string }),
      ...(entry.delta === undefined ? {} : { delta: artifactReference(entry.delta) }),
      detail: entry.detail as string,
      confirmedAt: entry.confirmedAt as string,
    }),
  );
}

type BoundArtifact = {
  readonly id: string;
  readonly hash: string;
  readonly artifact: ArtifactReference;
};

function createCreatorProjectDeltaFromPayload(
  input: Omit<CreatorProjectDelta, "kind" | "id" | "hash">,
): CreatorProjectDelta {
  if (
    !hash(input.beforeCaptureHash) ||
    !hash(input.afterCaptureHash) ||
    !hash(input.beforeRevisionHash) ||
    !hash(input.afterRevisionHash) ||
    typeof input.changed !== "boolean"
  )
    fail("Project delta revision binding");
  for (const hashes of [
    input.addedShardHashes,
    input.removedShardHashes,
    input.addedSourceManifestHashes,
    input.removedSourceManifestHashes,
  ]) {
    if (!canonicalHashes(hashes)) fail("Project delta hash collection");
  }
  const payload = { ...input };
  const resultHash = contentHash(stableJson(payload));
  return {
    kind: "CreatorProjectDelta",
    id: `creator_project_delta_${resultHash.slice(0, 24)}`,
    hash: resultHash,
    ...payload,
  };
}

function assertMetadataLeafGraph(input: {
  readonly projection: StudioProjectIndexProjection;
  readonly indexManifest: StudioProjectIndexManifest;
  readonly revision: StudioProjectRevision;
  readonly shards: readonly StudioProjectEvidenceShard[];
  readonly sourceManifests: readonly StudioSourceBlobManifest[];
  readonly binding: CreatorProjectIndexArtifactBinding;
}): void {
  const { projection, indexManifest, revision, shards, sourceManifests, binding } = input;
  if (
    projection.manifestHash !== indexManifest.manifestHash ||
    indexManifest.projectionHash !== projection.hash ||
    revision.projectionHash !== projection.hash ||
    revision.indexManifestHash !== indexManifest.hash ||
    revision.manifestHash !== projection.manifestHash ||
    stableJson(revision.project) !== stableJson(indexManifest.project) ||
    revision.connectorEpoch !== indexManifest.connectorEpoch
  )
    fail("Project-index metadata leaf graph binding");
  const shardHashes = shards.map((shard) => shard.hash).sort();
  const manifestShardHashes = [...indexManifest.allShardHashes].sort();
  if (stableJson(shardHashes) !== stableJson(manifestShardHashes))
    fail("Project-index metadata shard coverage");
  const sourceManifestHashes = sourceManifests.map((manifest) => manifest.hash).sort();
  if (
    stableJson(sourceManifestHashes) !== stableJson([...indexManifest.sourceManifestHashes].sort())
  )
    fail("Project-index metadata source-manifest coverage");
  const sourceManifestByHash = new Map(
    sourceManifests.map((manifest) => [manifest.hash, manifest] as const),
  );
  const sourceNodes = shards
    .flatMap((shard) => shard.nodes)
    .filter((node) => node.sourceManifestHash !== undefined);
  if (sourceNodes.length !== sourceManifests.length)
    fail("Project-index metadata source-node coverage");
  const sourceChunkBindings = new Map(
    binding.sourceChunks.map((entry) => [entry.hash, entry] as const),
  );
  const referencedChunkHashes = new Set<string>();
  for (const node of sourceNodes) {
    const manifest = sourceManifestByHash.get(node.sourceManifestHash!);
    if (
      !manifest ||
      studioObjectIdentityKey(manifest.identity) !== studioObjectIdentityKey(node.identity)
    )
      fail("Project-index metadata source identity binding");
    for (const chunkHash of manifest.chunkHashes) {
      if (!sourceChunkBindings.has(chunkHash) || referencedChunkHashes.has(chunkHash))
        fail("Project-index metadata source-chunk coverage");
      referencedChunkHashes.add(chunkHash);
    }
  }
  if (referencedChunkHashes.size !== sourceChunkBindings.size)
    fail("Project-index metadata has unreferenced source chunks");
}

function createArtifactRangeResolver(input: {
  readonly store: ImmutableJsonArtifactStore;
  readonly documents: readonly SourceDocumentDescriptor[];
  readonly manifests: ReadonlyMap<string, StudioSourceBlobManifest>;
  readonly sourceChunks: readonly BoundArtifact[];
}): AsyncVerifiedSourceResolver {
  const documentsById = new Map(
    input.documents.map((document) => [document.documentId, document] as const),
  );
  const manifestsByDocumentId = new Map<string, StudioSourceBlobManifest>();
  for (const document of input.documents) {
    const manifest = [...input.manifests.values()].find(
      (entry) => studioObjectIdentityKey(entry.identity) === document.documentId,
    );
    if (
      !manifest ||
      manifest.sourceHash !== document.sourceHash ||
      manifest.utf8Bytes !== document.utf8Bytes
    )
      fail("Project-index artifact source descriptor binding");
    manifestsByDocumentId.set(document.documentId, manifest);
  }
  const chunksByHash = new Map(input.sourceChunks.map((entry) => [entry.hash, entry] as const));
  return {
    authority: "verified_source_blob",
    async readRange(document, requested): Promise<VerifiedSourceRange> {
      const expected = documentsById.get(document.documentId);
      if (!expected || !sameSourceLocator(expected, document))
        fail("Artifact source resolver document binding");
      if (
        !Number.isSafeInteger(requested.startByte) ||
        !Number.isSafeInteger(requested.endByte) ||
        requested.startByte < 0 ||
        requested.endByte < requested.startByte ||
        requested.endByte > expected.utf8Bytes
      )
        fail("Artifact source resolver range binding");
      if (requested.endByte - requested.startByte > 32 * 1024)
        fail("Artifact source resolver range exceeds 32 KiB page bound");
      const manifest = manifestsByDocumentId.get(expected.documentId);
      if (!manifest) fail("Artifact source resolver missing source manifest");
      const chunks = await Promise.all(
        manifest.chunkHashes.map(async (chunkHash) => {
          const binding = chunksByHash.get(chunkHash);
          if (!binding) fail("Artifact source resolver missing source chunk binding");
          return readBoundArtifact<StudioSourceBlobChunk>(
            input.store,
            binding,
            assertStudioSourceBlobChunk,
          );
        }),
      );
      assertSourceChunksForManifest(manifest, chunks);
      const startByte = nextUtf8Boundary(chunks, requested.startByte, manifest.utf8Bytes);
      const endByte = previousUtf8Boundary(chunks, requested.endByte, manifest.utf8Bytes);
      if (endByte <= startByte && startByte < manifest.utf8Bytes)
        fail("Artifact source resolver range cannot contain a complete UTF-8 code point");
      const source = sourceRangeFromChunks(chunks, startByte, endByte);
      if (Buffer.byteLength(source, "utf8") !== endByte - startByte)
        fail("Artifact source resolver source-range byte binding");
      return { startByte, endByte, source };
    },
  };
}

function assertSourceChunksForManifest(
  manifest: StudioSourceBlobManifest,
  chunks: readonly StudioSourceBlobChunk[],
): void {
  if (
    chunks.length !== manifest.chunkHashes.length ||
    stableJson(chunks.map((chunk) => chunk.hash)) !== stableJson(manifest.chunkHashes)
  )
    fail("Artifact source resolver source-chunk order");
  let endByte = 0;
  const digest = createHash("sha256");
  for (const [ordinal, chunk] of chunks.entries()) {
    if (
      chunk.sourceHash !== manifest.sourceHash ||
      chunk.ordinal !== ordinal ||
      chunk.startByte !== endByte ||
      chunk.endByte < chunk.startByte
    )
      fail("Artifact source resolver source-chunk sequence");
    digest.update(chunk.utf8, "utf8");
    endByte = chunk.endByte;
  }
  if (endByte !== manifest.utf8Bytes || digest.digest("hex") !== manifest.sourceHash)
    fail("Artifact source resolver source-body hash");
}

function nextUtf8Boundary(
  chunks: readonly StudioSourceBlobChunk[],
  offset: number,
  totalBytes: number,
): number {
  let value = offset;
  while (value < totalBytes && isUtf8ContinuationByte(sourceByteAt(chunks, value))) value += 1;
  return value;
}

function previousUtf8Boundary(
  chunks: readonly StudioSourceBlobChunk[],
  offset: number,
  totalBytes: number,
): number {
  if (offset === totalBytes) return totalBytes;
  let value = offset;
  while (value > 0 && isUtf8ContinuationByte(sourceByteAt(chunks, value))) value -= 1;
  return value;
}

function sourceByteAt(chunks: readonly StudioSourceBlobChunk[], offset: number): number {
  const chunk = chunks.find((entry) => offset >= entry.startByte && offset < entry.endByte);
  if (!chunk) fail("Artifact source resolver byte range");
  return Buffer.from(chunk.utf8, "utf8")[offset - chunk.startByte]!;
}

function isUtf8ContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function sourceRangeFromChunks(
  chunks: readonly StudioSourceBlobChunk[],
  startByte: number,
  endByte: number,
): string {
  if (startByte === endByte) return "";
  const pieces: Buffer[] = [];
  for (const chunk of chunks) {
    if (chunk.endByte <= startByte || chunk.startByte >= endByte) continue;
    const bytes = Buffer.from(chunk.utf8, "utf8");
    pieces.push(
      bytes.subarray(
        Math.max(startByte, chunk.startByte) - chunk.startByte,
        Math.min(endByte, chunk.endByte) - chunk.startByte,
      ),
    );
  }
  return Buffer.concat(pieces).toString("utf8");
}

function sourceExecutionContext(className: string): SourceDocumentDescriptor["executionContext"] {
  return className === "LocalScript" ? "client" : className === "Script" ? "server" : "shared";
}

function sameSourceLocator(
  document: SourceDocumentDescriptor,
  locator: {
    readonly documentId: string;
    readonly path: string;
    readonly className: string;
    readonly executionContext: SourceDocumentDescriptor["executionContext"];
    readonly sourceHash: string;
  },
): boolean {
  return (
    document.documentId === locator.documentId &&
    document.path === locator.path &&
    document.className === locator.className &&
    document.executionContext === locator.executionContext &&
    document.sourceHash === locator.sourceHash
  );
}

function compareSourceDocument(
  left: SourceDocumentDescriptor,
  right: SourceDocumentDescriptor,
): number {
  return left.path.localeCompare(right.path) || left.documentId.localeCompare(right.documentId);
}

function assertProjectIndexArtifactBinding(
  value: unknown,
): asserts value is CreatorProjectIndexArtifactBinding {
  if (
    !record(value) ||
    !nonEmpty(value.captureId) ||
    !hash(value.captureHash) ||
    !Number.isSafeInteger(value.detectorEpoch) ||
    Number(value.detectorEpoch) < 0
  )
    fail("Project-index artifact binding");
  for (const key of ["projection", "manifest", "revision"] as const)
    assertBoundArtifact(value[key], `Project-index ${key} binding`);
  for (const key of ["shards", "sourceManifests", "sourceChunks"] as const) {
    const entries = value[key];
    if (!Array.isArray(entries)) fail(`Project-index ${key} bindings`);
    for (const entry of entries) assertBoundArtifact(entry, `Project-index ${key} binding`);
    if (new Set(entries.map((entry) => entry.hash)).size !== entries.length)
      fail(`Project-index duplicate ${key} binding`);
  }
}
function assertBoundArtifact(value: unknown, label: string): asserts value is BoundArtifact {
  if (!record(value) || !nonEmpty(value.id) || !hash(value.hash) || !record(value.artifact))
    fail(label);
}
async function readBoundArtifact<T extends { readonly id: string; readonly hash: string }>(
  store: ImmutableJsonArtifactStore,
  binding: BoundArtifact,
  assertion: (value: unknown) => asserts value is T,
): Promise<T> {
  const value = await store.read(binding.artifact, assertion);
  if (value.id !== binding.id || value.hash !== binding.hash)
    fail("Project-index leaf binding changed");
  return value;
}
function difference(left: readonly string[], right: readonly string[]): string[] {
  const excluded = new Set(right);
  return [...new Set(left)].filter((value) => !excluded.has(value)).sort();
}
function canonicalHashes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(hash) &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function artifactReference(value: unknown): ArtifactReference {
  assertArtifactReference(value);
  return value;
}
function assertRecreated<T extends { kind: string; id: string; hash: string }>(
  value: unknown,
  kind: T["kind"],
  recreate: (value: Record<string, unknown>) => T,
): void {
  if (!record(value) || value.kind !== kind || !nonEmpty(value.id) || !hash(value.hash)) fail(kind);
  const rebuilt = recreate(value);
  if (stableJson(rebuilt) !== stableJson(value)) fail(`${kind} identity`);
}
function fail(message: string): never {
  throw new Error(`Invalid creator project refresh: ${message}`);
}
