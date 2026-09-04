import { contentHash, stableJson } from "../../contracts/src/index.js";
import { STUDIO_CAPABILITY_MANIFEST } from "./generated.js";
import {
  assertStudioCapabilityManifest,
  assertStudioValue,
  assertStudioValueForProperty,
} from "./index.js";
import type {
  StudioCapabilityManifest,
  StudioManifestProperty,
  StudioProjectIdentity,
} from "./index.js";
import type { StudioPrimitiveValue, StudioValue } from "./index.js";

export type StudioProjectCompoundAttributeValue = Extract<
  StudioValue,
  {
    readonly kind:
      | "brick_color"
      | "cframe_f32x12"
      | "color3_rgb8"
      | "color_sequence"
      | "number_range"
      | "number_sequence"
      | "rect"
      | "udim"
      | "udim2"
      | "vector2_f32"
      | "vector3_f32";
  }
>;

/** Complete Roblox attribute value domain used by universal project indexes. */
export type StudioProjectAttributeValue =
  StudioPrimitiveValue | StudioProjectCompoundAttributeValue;

/**
 * The identity algebra deliberately keeps observation separate from mutation.
 * Existing Studio objects are read through a connector-epoch-bound digest; an
 * observer must never acquire a durable Forge identity merely by indexing a
 * project. Rojo identities similarly identify a mapping, never a host path.
 */
export type StudioObjectIdentity =
  | { readonly kind: "forge_attribute"; readonly stableId: string }
  | {
      readonly kind: "studio_ephemeral";
      readonly connectorEpoch: string;
      readonly opaqueHash: string;
    }
  | {
      readonly kind: "rojo_sourcemap";
      readonly authorityMapHash: string;
      readonly sourcemapHash: string;
      readonly mappingId: string;
    };

/** One declared resource policy for every creator project-index operation. */
export interface CreatorResourcePolicy {
  readonly kind: "CreatorResourcePolicy";
  readonly maximumInstances: number;
  readonly maximumCanonicalIndexBytes: number;
  readonly maximumSourceBlobBytes: number;
  readonly maximumIndexingDurationMs: number;
  readonly maximumNodesPerShard: number;
  readonly maximumCanonicalShardBytes: number;
  readonly transportChunkBytes: number;
}

export const CREATOR_DEFAULT_RESOURCE_POLICY: CreatorResourcePolicy = Object.freeze({
  kind: "CreatorResourcePolicy",
  maximumInstances: 1_048_576,
  maximumCanonicalIndexBytes: 1_073_741_824,
  maximumSourceBlobBytes: 134_217_728,
  maximumIndexingDurationMs: 600_000,
  maximumNodesPerShard: 512,
  maximumCanonicalShardBytes: 4_194_304,
  transportChunkBytes: 262_144,
});

/**
 * Project-index coverage is closed over the generated manifest.  A node for a
 * manifest class must carry every projectable property exactly once; an
 * unknown class deliberately carries none.  Retain the property rows here as
 * well as their names so indexed values are validated with the same codec and
 * bounds as writer/readback evidence.
 */
function projectPropertiesByClass(
  manifest: StudioCapabilityManifest,
): ReadonlyMap<string, ReadonlyMap<string, StudioManifestProperty>> {
  return new Map(
    manifest.classes.map((entry) => [
      entry.name,
      new Map<string, StudioManifestProperty>(
        entry.properties.map((property) => [property.name, property]),
      ),
    ]),
  );
}

function assertProjectIndexManifestBinding(
  capture: Pick<StudioProjectIndexCapture, "projection" | "indexManifest" | "revision">,
  manifest: StudioCapabilityManifest,
): void {
  const manifestHash = contentHash(stableJson(manifest));
  if (
    capture.projection.manifestHash !== manifestHash ||
    capture.indexManifest.manifestHash !== manifestHash ||
    capture.revision.manifestHash !== manifestHash
  )
    fail("project index capability manifest binding");
}

/**
 * One cross-language identity epoch for opaque Studio handles. The same
 * project-index canonical material is hashed in TypeScript and Luau; neither
 * side may improvise a concatenation or JSON encoding.
 */
export function createStudioConnectorEpoch(input: {
  readonly sessionId: string;
  readonly projectId: string;
  readonly connectorBuildHash: string;
}): string {
  assertId(input.sessionId, "connector epoch session");
  assertId(input.projectId, "connector epoch project");
  assertHash(input.connectorBuildHash, "connector epoch build");
  return projectIndexHash({
    kind: "StudioConnectorEpoch",
    sessionId: input.sessionId,
    projectId: input.projectId,
    connectorBuildHash: input.connectorBuildHash,
  });
}

/**
 * An index projection is the complete, bounded read contract. It is bound to
 * a connector epoch because a studio_ephemeral identity cannot survive a new
 * connector process or a re-pair.
 */
export interface StudioProjectIndexProjection {
  readonly kind: "StudioProjectIndexProjection";
  readonly id: string;
  readonly hash: string;
  readonly manifestHash: string;
  readonly project: StudioProjectIdentity;
  readonly connectorEpoch: string;
  readonly purpose: "creator_project_index";
  readonly roots: readonly string[];
  readonly bounds: CreatorResourcePolicy;
  readonly contentIdentity: string;
}

export interface StudioProjectIndexNode {
  readonly identity: StudioObjectIdentity;
  /** A display-only Studio path. It never serves as an authority handle. */
  readonly displayPath: string;
  /** Exact current Instance.Name, independently captured from displayPath. */
  readonly name: string;
  readonly parentIdentity?: StudioObjectIdentity;
  /**
   * Present only when this exact indexed instance is a manifest-declared
   * engine-owned authoring container. This lets a mutation bind the declared
   * container to its captured identity without treating its display path as
   * an object lookup key.
   */
  readonly engineContainer?: {
    readonly path: string;
    readonly className: string;
  };
  readonly className: string;
  readonly attributes: Readonly<Record<string, StudioProjectAttributeValue>>;
  readonly tags: readonly string[];
  readonly coveredProperties: Readonly<Record<string, unknown>>;
  readonly coveredPropertyNames: readonly string[];
  readonly sourceManifestHash?: string;
}

export interface StudioProjectEvidenceShard {
  readonly kind: "StudioProjectEvidenceShard";
  readonly id: string;
  readonly hash: string;
  readonly root: string;
  readonly ordinal: number;
  readonly nodes: readonly StudioProjectIndexNode[];
  readonly canonicalBytes: number;
}

/** Metadata for a source body; body bytes always travel through chunks. */
export interface StudioSourceBlobManifest {
  readonly kind: "StudioSourceBlobManifest";
  readonly id: string;
  readonly hash: string;
  readonly identity: StudioObjectIdentity;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly chunkHashes: readonly string[];
  /** True only when ScriptEditorService supplied the currently-open buffer. */
  readonly editorSource: boolean;
}

/** A UTF-8-boundary-preserving transport/storage leaf for one source body. */
export interface StudioSourceBlobChunk {
  readonly kind: "StudioSourceBlobChunk";
  readonly id: string;
  readonly hash: string;
  readonly sourceHash: string;
  readonly ordinal: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly utf8: string;
}

/**
 * A proposed source write is deliberately a different evidence domain from an
 * observed Studio source blob.  It has no Studio identity or editor-state
 * claim: it is immutable creator-authored input which must be bound into a
 * sealed change set before the connector can materialize it.
 */
export interface CreatorSourceWriteBlobManifest {
  readonly kind: "CreatorSourceWriteBlobManifest";
  readonly id: string;
  readonly hash: string;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly chunkHashes: readonly string[];
}

/** A UTF-8-safe, independently content-addressed source-write leaf. */
export interface CreatorSourceWriteBlobChunk {
  readonly kind: "CreatorSourceWriteBlobChunk";
  readonly id: string;
  readonly hash: string;
  readonly sourceHash: string;
  readonly ordinal: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly utf8: string;
}

export interface CreatorSourceWriteBlobCapture {
  readonly kind: "CreatorSourceWriteBlobCapture";
  readonly manifest: CreatorSourceWriteBlobManifest;
  readonly chunks: readonly CreatorSourceWriteBlobChunk[];
}

/** Content-addressed complete inventory. `completedAt` is operational only. */
export interface StudioProjectIndexManifest {
  readonly kind: "StudioProjectIndexManifest";
  readonly id: string;
  readonly hash: string;
  readonly manifestHash: string;
  readonly projectionHash: string;
  readonly project: StudioProjectIdentity;
  readonly connectorEpoch: string;
  readonly rootShardHashes: readonly {
    readonly root: string;
    readonly hash: string;
  }[];
  readonly allShardHashes: readonly string[];
  readonly sourceManifestHashes: readonly string[];
  readonly instanceCount: number;
  readonly canonicalBytes: number;
  readonly completedAt: string;
}

/**
 * A revision is the semantic index identity. In particular neither capture
 * time nor source/chunk transport timing enters `merkleRoot` or `hash`.
 */
export interface StudioProjectRevision {
  readonly kind: "StudioProjectRevision";
  readonly id: string;
  readonly hash: string;
  readonly manifestHash: string;
  readonly projectionHash: string;
  readonly indexManifestHash: string;
  readonly merkleRoot: string;
  readonly project: StudioProjectIdentity;
  readonly connectorEpoch: string;
  readonly capturedAt: string;
}

/** A transport bundle; the host persists each leaf as a separate artifact. */
export interface StudioProjectIndexCapture {
  readonly kind: "StudioProjectIndexCapture";
  /**
   * Change-monitor epoch sampled before the complete read-only collection.
   * It fences transaction commands but is deliberately outside the Merkle
   * revision, which represents Studio state rather than observation order.
   */
  readonly detectorEpoch: number;
  readonly projection: StudioProjectIndexProjection;
  readonly indexManifest: StudioProjectIndexManifest;
  readonly revision: StudioProjectRevision;
  readonly shards: readonly StudioProjectEvidenceShard[];
  readonly sourceManifests: readonly StudioSourceBlobManifest[];
  readonly sourceChunks: readonly StudioSourceBlobChunk[];
  readonly hash: string;
}

export interface StudioIdentityEnrollment {
  readonly identity: Extract<StudioObjectIdentity, { readonly kind: "studio_ephemeral" }>;
  readonly stableId: string;
}

/** Adapter input for the pure source-intelligence package. */
export interface StudioSourceIndexDocument {
  /** An opaque identity-qualified key. It is not a Forge stable-id claim. */
  readonly documentId: string;
  readonly path: string;
  readonly className: string;
  readonly executionContext: "client" | "server" | "shared";
  readonly sourceHash: string;
  readonly source: string;
}

/**
 * Source metadata suitable for creator planning, ownership, and static
 * indexing.  It deliberately excludes bodies: consumers that need bytes must
 * use the separately verified blob-chunk authority.
 */
export interface StudioSourceDocumentMetadata {
  readonly documentId: string;
  readonly path: string;
  readonly className: string;
  readonly executionContext: "client" | "server" | "shared";
  readonly sourceHash: string;
  readonly utf8Bytes: number;
}

/**
 * A metadata-only project observation. This is the creator-facing project
 * view: source body materialization belongs to a bounded source resolver.
 */
export interface StudioProjectIndexMetadataView {
  readonly project: StudioProjectIdentity;
  readonly revision: StudioProjectRevision;
  readonly instances: readonly {
    readonly objectId: string;
    readonly identity: StudioObjectIdentity;
    readonly path: string;
    readonly name: string;
    readonly parentIdentity?: StudioObjectIdentity;
    readonly engineContainer?: {
      readonly path: string;
      readonly className: string;
    };
    readonly className: string;
    readonly position?: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly properties: Readonly<Record<string, StudioValue>>;
    readonly attributes: Readonly<Record<string, StudioProjectAttributeValue>>;
    readonly tags: readonly string[];
  }[];
  readonly scripts: readonly StudioSourceDocumentMetadata[];
}

/**
 * Host-only materialized view used by planning and local validation. It is
 * derived exclusively from a verified capture and is never a transport or
 * persisted evidence contract.
 */
export interface StudioProjectIndexView {
  readonly project: StudioProjectIdentity;
  readonly revision: StudioProjectRevision;
  readonly instances: readonly {
    readonly objectId: string;
    readonly identity: StudioObjectIdentity;
    readonly path: string;
    readonly name: string;
    readonly parentIdentity?: StudioObjectIdentity;
    readonly engineContainer?: {
      readonly path: string;
      readonly className: string;
    };
    readonly className: string;
    readonly position?: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly properties: Readonly<Record<string, StudioValue>>;
    readonly attributes: Readonly<Record<string, StudioProjectAttributeValue>>;
    readonly tags: readonly string[];
  }[];
  readonly scripts: readonly StudioSourceIndexDocument[];
}

export function studioObjectIdentityKey(identity: StudioObjectIdentity): string {
  assertStudioObjectIdentity(identity);
  switch (identity.kind) {
    case "forge_attribute":
      return `forge_attribute:${identity.stableId}`;
    case "studio_ephemeral":
      return `studio_ephemeral:${identity.connectorEpoch}:${identity.opaqueHash}`;
    case "rojo_sourcemap":
      return `rojo_sourcemap:${identity.authorityMapHash}:${identity.sourcemapHash}:${identity.mappingId}`;
  }
}

export function createStudioProjectIndexProjection(
  input: Omit<StudioProjectIndexProjection, "kind" | "id" | "hash" | "contentIdentity">,
): StudioProjectIndexProjection {
  assertHash(input.manifestHash, "projection manifest hash");
  assertProject(input.project);
  assertId(input.connectorEpoch, "projection connector epoch");
  if (input.purpose !== "creator_project_index") fail("project index projection purpose");
  const roots = canonicalRoots(input.roots);
  assertCreatorResourcePolicy(input.bounds);
  const semantic = {
    manifestHash: input.manifestHash,
    project: input.project,
    connectorEpoch: input.connectorEpoch,
    purpose: input.purpose,
    roots,
    bounds: input.bounds,
  };
  const contentIdentity = projectIndexHash(semantic);
  const hash = projectIndexHash({ ...semantic, contentIdentity });
  return {
    kind: "StudioProjectIndexProjection",
    id: `studio_project_index_projection_${hash.slice(0, 24)}`,
    hash,
    ...semantic,
    contentIdentity,
  };
}

export function createStudioProjectEvidenceShard(
  input: Omit<StudioProjectEvidenceShard, "kind" | "id" | "hash" | "canonicalBytes">,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioProjectEvidenceShard {
  assertStudioCapabilityManifest(manifest);
  const nodes = canonicalNodes(input.nodes, manifest);
  assertRoot(input.root, "project index shard root");
  assertNonNegative(input.ordinal, "project index shard ordinal");
  const payload = { root: input.root, ordinal: input.ordinal, nodes };
  const canonicalBytes = utf8Bytes(projectIndexMaterial(payload));
  const hash = projectIndexHash({ ...payload, canonicalBytes });
  return {
    kind: "StudioProjectEvidenceShard",
    id: `studio_project_evidence_shard_${hash.slice(0, 24)}`,
    hash,
    ...payload,
    canonicalBytes,
  };
}

/** Split a source body without tearing a UTF-8 code point. */
export function createStudioSourceBlobCapture(input: {
  readonly identity: StudioObjectIdentity;
  readonly source: string;
  readonly editorSource: boolean;
  readonly transportChunkBytes?: number;
}): {
  readonly manifest: StudioSourceBlobManifest;
  readonly chunks: readonly StudioSourceBlobChunk[];
} {
  assertStudioObjectIdentity(input.identity);
  if (typeof input.source !== "string") fail("source blob source");
  if (typeof input.editorSource !== "boolean") fail("source blob editor source");
  const maximum = input.transportChunkBytes ?? CREATOR_DEFAULT_RESOURCE_POLICY.transportChunkBytes;
  if (!Number.isInteger(maximum) || maximum <= 0) fail("source blob chunk bound");
  const sourceBuffer = Buffer.from(input.source, "utf8");
  const sourceHash = contentHash(input.source);
  const chunks: StudioSourceBlobChunk[] = [];
  let startByte = 0;
  let ordinal = 0;
  while (startByte < sourceBuffer.length || (sourceBuffer.length === 0 && ordinal === 0)) {
    let endByte = Math.min(sourceBuffer.length, startByte + maximum);
    while (endByte < sourceBuffer.length && isUtf8ContinuationByte(sourceBuffer[endByte]!))
      endByte -= 1;
    if (endByte === startByte && endByte < sourceBuffer.length)
      endByte = nextUtf8Boundary(sourceBuffer, startByte);
    const utf8 = sourceBuffer.subarray(startByte, endByte).toString("utf8");
    const payload = { sourceHash, ordinal, startByte, endByte, utf8 };
    const hash = projectIndexHash(payload);
    chunks.push({
      kind: "StudioSourceBlobChunk",
      id: `studio_source_blob_chunk_${hash.slice(0, 24)}`,
      hash,
      ...payload,
    });
    startByte = endByte;
    ordinal += 1;
    if (sourceBuffer.length === 0) break;
  }
  const chunkHashes = chunks.map((chunk) => chunk.hash);
  const manifestPayload = {
    identity: canonicalIdentity(input.identity),
    sourceHash,
    utf8Bytes: sourceBuffer.length,
    chunkHashes,
    editorSource: input.editorSource,
  };
  const hash = projectIndexHash(manifestPayload);
  return {
    manifest: {
      kind: "StudioSourceBlobManifest",
      id: `studio_source_blob_manifest_${hash.slice(0, 24)}`,
      hash,
      ...manifestPayload,
    },
    chunks,
  };
}

/**
 * Materialize proposed source into the same UTF-8-safe, content-addressed
 * leaf algebra used for indexed source.  The payload deliberately excludes a
 * Studio object identity: a new script has no observed object yet, and an
 * edit's target is bound by the enclosing change operation.
 */
export function createCreatorSourceWriteBlobCapture(input: {
  readonly source: string;
  readonly maximumSourceBlobBytes?: number;
  readonly transportChunkBytes?: number;
}): CreatorSourceWriteBlobCapture {
  if (typeof input.source !== "string") fail("source write blob source");
  const maximumSourceBlobBytes =
    input.maximumSourceBlobBytes ?? CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes;
  const transportChunkBytes =
    input.transportChunkBytes ?? CREATOR_DEFAULT_RESOURCE_POLICY.transportChunkBytes;
  if (!Number.isSafeInteger(maximumSourceBlobBytes) || maximumSourceBlobBytes < 0)
    fail("source write blob maximum bytes");
  if (
    !Number.isSafeInteger(transportChunkBytes) ||
    transportChunkBytes <= 0 ||
    transportChunkBytes > maximumSourceBlobBytes
  )
    fail("source write blob chunk bound");
  const sourceBuffer = Buffer.from(input.source, "utf8");
  if (sourceBuffer.length > maximumSourceBlobBytes) fail("source write blob resource bound");
  const sourceHash = contentHash(input.source);
  const chunks: CreatorSourceWriteBlobChunk[] = [];
  let startByte = 0;
  let ordinal = 0;
  while (startByte < sourceBuffer.length || (sourceBuffer.length === 0 && ordinal === 0)) {
    let endByte = Math.min(sourceBuffer.length, startByte + transportChunkBytes);
    while (endByte < sourceBuffer.length && isUtf8ContinuationByte(sourceBuffer[endByte]!))
      endByte -= 1;
    if (endByte === startByte && endByte < sourceBuffer.length)
      endByte = nextUtf8Boundary(sourceBuffer, startByte);
    const utf8 = sourceBuffer.subarray(startByte, endByte).toString("utf8");
    const payload = { sourceHash, ordinal, startByte, endByte, utf8 };
    const hash = projectIndexHash(payload);
    chunks.push({
      kind: "CreatorSourceWriteBlobChunk",
      id: `creator_source_write_blob_chunk_${hash.slice(0, 24)}`,
      hash,
      ...payload,
    });
    startByte = endByte;
    ordinal += 1;
    if (sourceBuffer.length === 0) break;
  }
  const manifestPayload = {
    sourceHash,
    utf8Bytes: sourceBuffer.length,
    chunkHashes: chunks.map((chunk) => chunk.hash),
  };
  const hash = projectIndexHash(manifestPayload);
  const capture: CreatorSourceWriteBlobCapture = {
    kind: "CreatorSourceWriteBlobCapture",
    manifest: {
      kind: "CreatorSourceWriteBlobManifest",
      id: `creator_source_write_blob_manifest_${hash.slice(0, 24)}`,
      hash,
      ...manifestPayload,
    },
    chunks,
  };
  assertCreatorSourceWriteBlobCapture(capture, {
    maximumSourceBlobBytes,
    transportChunkBytes,
  });
  return capture;
}

export function createStudioProjectIndexCapture(
  input: {
    readonly projection: StudioProjectIndexProjection;
    readonly shards: readonly StudioProjectEvidenceShard[];
    readonly sourceManifests: readonly StudioSourceBlobManifest[];
    readonly sourceChunks: readonly StudioSourceBlobChunk[];
    readonly completedAt: string;
    readonly detectorEpoch: number;
  },
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioProjectIndexCapture {
  assertStudioCapabilityManifest(manifest);
  assertStudioProjectIndexProjection(input.projection);
  if (input.projection.manifestHash !== contentHash(stableJson(manifest)))
    fail("project index capability manifest binding");
  assertIso(input.completedAt, "project index completed at");
  const detectorEpoch = input.detectorEpoch;
  if (!Number.isSafeInteger(detectorEpoch) || detectorEpoch < 0)
    fail("project index detector epoch");
  const shards = [...input.shards].sort(compareShard);
  const sourceManifests = [...input.sourceManifests].sort(compareSourceManifest);
  const sourceChunks = [...input.sourceChunks].sort(compareSourceChunk);
  for (const shard of shards) assertStudioProjectEvidenceShard(shard, manifest);
  for (const sourceManifest of sourceManifests) assertStudioSourceBlobManifest(sourceManifest);
  for (const sourceChunk of sourceChunks) assertStudioSourceBlobChunk(sourceChunk);
  assertCompleteIndex(input.projection, shards, sourceManifests, sourceChunks);
  const rootShardHashes = input.projection.roots.map((root) => ({
    root,
    hash: merkleRoot(shards.filter((shard) => shard.root === root).map((shard) => shard.hash)),
  }));
  const allShardHashes = shards.map((shard) => shard.hash);
  const sourceManifestHashes = sourceManifests.map((manifest) => manifest.hash).sort();
  const instanceCount = shards.reduce((total, shard) => total + shard.nodes.length, 0);
  const canonicalBytes =
    shards.reduce((total, shard) => total + shard.canonicalBytes, 0) +
    sourceManifests.reduce(
      (total, sourceManifest) => total + utf8Bytes(projectIndexMaterial(sourceManifest)),
      0,
    ) +
    sourceChunks.reduce(
      (total, sourceChunk) => total + utf8Bytes(projectIndexMaterial(sourceChunk)),
      0,
    );
  const semanticManifest = {
    manifestHash: input.projection.manifestHash,
    projectionHash: input.projection.hash,
    project: input.projection.project,
    connectorEpoch: input.projection.connectorEpoch,
    rootShardHashes,
    allShardHashes,
    sourceManifestHashes,
    instanceCount,
    canonicalBytes,
  };
  // Keep the index hash semantic; capture-level hashing binds the observation
  // interval while a revision deliberately remains replayable across clocks.
  const indexHash = projectIndexHash(semanticManifest);
  const indexManifest: StudioProjectIndexManifest = {
    kind: "StudioProjectIndexManifest",
    id: `studio_project_index_manifest_${indexHash.slice(0, 24)}`,
    hash: indexHash,
    ...semanticManifest,
    completedAt: input.completedAt,
  };
  const merkleRootValue = merkleRoot([
    input.projection.manifestHash,
    input.projection.hash,
    ...rootShardHashes.map((entry) => entry.hash),
    ...allShardHashes,
    ...sourceManifestHashes,
  ]);
  const revisionPayload = {
    manifestHash: input.projection.manifestHash,
    projectionHash: input.projection.hash,
    indexManifestHash: indexManifest.hash,
    merkleRoot: merkleRootValue,
    project: input.projection.project,
    connectorEpoch: input.projection.connectorEpoch,
  };
  const revisionHash = projectIndexHash(revisionPayload);
  const revision: StudioProjectRevision = {
    kind: "StudioProjectRevision",
    id: `studio_project_index_revision_${revisionHash.slice(0, 24)}`,
    hash: revisionHash,
    ...revisionPayload,
    capturedAt: input.completedAt,
  };
  const capturePayload = {
    detectorEpoch,
    projection: input.projection,
    indexManifest,
    revision,
    shards,
    sourceManifests,
    sourceChunks,
  };
  return {
    kind: "StudioProjectIndexCapture",
    ...capturePayload,
    hash: projectIndexHash(capturePayload),
  };
}

export function assertStudioObjectIdentity(value: unknown): asserts value is StudioObjectIdentity {
  if (!isRecord(value)) fail("Studio object identity");
  if (value.kind === "forge_attribute") {
    if (!hasOnly(value, ["kind", "stableId"]) || !isStudioObjectIdentityText(value.stableId))
      fail("forge Studio object identity");
  } else if (value.kind === "studio_ephemeral") {
    if (
      !hasOnly(value, ["kind", "connectorEpoch", "opaqueHash"]) ||
      !isStudioObjectIdentityText(value.connectorEpoch) ||
      !isHash(value.opaqueHash)
    )
      fail("ephemeral Studio object identity");
  } else if (value.kind === "rojo_sourcemap") {
    if (
      !hasOnly(value, ["kind", "authorityMapHash", "sourcemapHash", "mappingId"]) ||
      !isHash(value.authorityMapHash) ||
      !isHash(value.sourcemapHash) ||
      !isStudioObjectIdentityText(value.mappingId)
    )
      fail("Rojo Studio object identity");
  } else fail("Studio object identity kind");
}

export function assertCreatorResourcePolicy(
  value: unknown,
): asserts value is CreatorResourcePolicy {
  if (
    !isRecord(value) ||
    !hasOnly(value, [
      "kind",
      "maximumInstances",
      "maximumCanonicalIndexBytes",
      "maximumSourceBlobBytes",
      "maximumIndexingDurationMs",
      "maximumNodesPerShard",
      "maximumCanonicalShardBytes",
      "transportChunkBytes",
    ]) ||
    value.kind !== "CreatorResourcePolicy"
  )
    fail("creator resource policy");
  const policy = value as unknown as CreatorResourcePolicy;
  for (const field of [
    "maximumInstances",
    "maximumCanonicalIndexBytes",
    "maximumSourceBlobBytes",
    "maximumIndexingDurationMs",
    "maximumNodesPerShard",
    "maximumCanonicalShardBytes",
    "transportChunkBytes",
  ] as const)
    if (!Number.isInteger(policy[field]) || policy[field] <= 0)
      fail(`creator resource policy ${field}`);
  if (
    policy.maximumSourceBlobBytes > policy.maximumCanonicalIndexBytes ||
    policy.transportChunkBytes > policy.maximumSourceBlobBytes
  )
    fail("creator resource policy relationship");
}

export function assertStudioProjectIndexProjection(
  value: unknown,
): asserts value is StudioProjectIndexProjection {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectIndexProjection" ||
    !hasOnly(value, [
      "kind",
      "id",
      "hash",
      "manifestHash",
      "project",
      "connectorEpoch",
      "purpose",
      "roots",
      "bounds",
      "contentIdentity",
    ])
  )
    fail("StudioProjectIndexProjection");
  const created = createStudioProjectIndexProjection({
    manifestHash: value.manifestHash as string,
    project: value.project as StudioProjectIdentity,
    connectorEpoch: value.connectorEpoch as string,
    purpose: value.purpose as "creator_project_index",
    roots: value.roots as readonly string[],
    bounds: value.bounds as CreatorResourcePolicy,
  });
  if (
    value.id !== created.id ||
    value.hash !== created.hash ||
    value.contentIdentity !== created.contentIdentity
  )
    fail("project index projection identity");
}

export function assertStudioProjectIndexNode(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioProjectIndexNode {
  assertStudioCapabilityManifest(manifest);
  if (!isRecord(value)) fail("project index node");
  const expected = [
    "identity",
    "displayPath",
    "name",
    "className",
    "attributes",
    "tags",
    "coveredProperties",
    "coveredPropertyNames",
  ];
  if (value.parentIdentity !== undefined) expected.push("parentIdentity");
  if (value.engineContainer !== undefined) expected.push("engineContainer");
  if (value.sourceManifestHash !== undefined) expected.push("sourceManifestHash");
  if (!hasOnly(value, expected)) fail("project index node fields");
  assertStudioObjectIdentity(value.identity);
  assertDisplayPath(value.displayPath);
  assertStudioInstanceName(value.name);
  if (value.parentIdentity !== undefined) {
    assertStudioObjectIdentity(value.parentIdentity);
    if (studioObjectIdentityKey(value.identity) === studioObjectIdentityKey(value.parentIdentity))
      fail("project index node parent identity");
  }
  if (value.engineContainer !== undefined) {
    if (!isRecord(value.engineContainer) || !hasOnly(value.engineContainer, ["path", "className"]))
      fail("project index engine container");
    assertDisplayPath(value.engineContainer.path);
    assertId(value.engineContainer.className, "project index engine container class");
  }
  assertId(value.className, "project index class");
  if (!isRecord(value.attributes) || !isCanonicalRecord(value.attributes))
    fail("project index attributes");
  for (const attribute of Object.values(value.attributes))
    assertStudioProjectAttributeValue(attribute);
  if (
    !Array.isArray(value.tags) ||
    !isSortedStrings(value.tags) ||
    value.tags.some((tag) => !isId(tag))
  )
    fail("project index tags");
  if (!isRecord(value.coveredProperties) || !isCanonicalRecord(value.coveredProperties))
    fail("project index properties");
  if (
    !Array.isArray(value.coveredPropertyNames) ||
    !isSortedStrings(value.coveredPropertyNames) ||
    value.coveredPropertyNames.some((name) => !isId(name)) ||
    stableJson(Object.keys(value.coveredProperties).sort()) !==
      stableJson(value.coveredPropertyNames)
  )
    fail("project index covered properties");
  const requiredProperties = projectPropertiesByClass(manifest).get(value.className);
  const requiredPropertyNames = [...(requiredProperties?.keys() ?? [])].sort();
  if (stableJson(value.coveredPropertyNames) !== stableJson(requiredPropertyNames))
    fail("project index manifest property coverage");
  for (const [name, property] of Object.entries(value.coveredProperties)) {
    assertStudioValue(property);
    const metadata = requiredProperties?.get(name);
    // Exact name coverage above means this can only fail for an internal
    // invariant violation, never by treating an unsupported property as
    // observed coverage.
    if (metadata === undefined) fail("project index manifest property metadata");
    assertStudioValueForProperty(property, metadata);
  }
  if (value.sourceManifestHash !== undefined)
    assertHash(value.sourceManifestHash, "project index source manifest hash");
}

export function assertStudioProjectEvidenceShard(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioProjectEvidenceShard {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectEvidenceShard" ||
    !hasOnly(value, ["kind", "id", "hash", "root", "ordinal", "nodes", "canonicalBytes"])
  )
    fail("StudioProjectEvidenceShard");
  assertRoot(value.root, "project index shard root");
  assertNonNegative(value.ordinal, "project index shard ordinal");
  if (!Array.isArray(value.nodes)) fail("project index shard nodes");
  const nodes = canonicalNodes(value.nodes as readonly StudioProjectIndexNode[], manifest);
  if (stableJson(nodes) !== stableJson(value.nodes)) fail("project index node ordering");
  if (
    !Number.isInteger(value.canonicalBytes) ||
    value.canonicalBytes !==
      utf8Bytes(
        projectIndexMaterial({
          root: value.root,
          ordinal: value.ordinal,
          nodes,
        }),
      )
  )
    fail("project index shard bytes");
  const payload = {
    root: value.root,
    ordinal: value.ordinal,
    nodes,
    canonicalBytes: value.canonicalBytes,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `studio_project_evidence_shard_${hash.slice(0, 24)}`
  )
    fail("project index shard identity");
}

export function assertStudioSourceBlobManifest(
  value: unknown,
): asserts value is StudioSourceBlobManifest {
  if (
    !isRecord(value) ||
    value.kind !== "StudioSourceBlobManifest" ||
    !hasOnly(value, [
      "kind",
      "id",
      "hash",
      "identity",
      "sourceHash",
      "utf8Bytes",
      "chunkHashes",
      "editorSource",
    ])
  )
    fail("StudioSourceBlobManifest");
  assertStudioObjectIdentity(value.identity);
  assertHash(value.sourceHash, "source blob source hash");
  if (
    !Number.isInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) < 0 ||
    !Array.isArray(value.chunkHashes) ||
    value.chunkHashes.some((hash) => !isHash(hash)) ||
    new Set(value.chunkHashes).size !== value.chunkHashes.length ||
    typeof value.editorSource !== "boolean"
  )
    fail("source blob manifest payload");
  const payload = {
    identity: canonicalIdentity(value.identity),
    sourceHash: value.sourceHash,
    utf8Bytes: value.utf8Bytes,
    chunkHashes: value.chunkHashes,
    editorSource: value.editorSource,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `studio_source_blob_manifest_${hash.slice(0, 24)}`
  )
    fail("source blob manifest identity");
}

export function assertStudioSourceBlobChunk(
  value: unknown,
): asserts value is StudioSourceBlobChunk {
  if (
    !isRecord(value) ||
    value.kind !== "StudioSourceBlobChunk" ||
    !hasOnly(value, ["kind", "id", "hash", "sourceHash", "ordinal", "startByte", "endByte", "utf8"])
  )
    fail("StudioSourceBlobChunk");
  assertHash(value.sourceHash, "source blob chunk source hash");
  assertNonNegative(value.ordinal, "source blob chunk ordinal");
  assertNonNegative(value.startByte, "source blob chunk start");
  assertNonNegative(value.endByte, "source blob chunk end");
  if (
    value.endByte < value.startByte ||
    typeof value.utf8 !== "string" ||
    utf8Bytes(value.utf8) !== value.endByte - value.startByte
  )
    fail("source blob chunk bytes");
  const payload = {
    sourceHash: value.sourceHash,
    ordinal: value.ordinal,
    startByte: value.startByte,
    endByte: value.endByte,
    utf8: value.utf8,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `studio_source_blob_chunk_${hash.slice(0, 24)}`
  )
    fail("source blob chunk identity");
}

export function assertCreatorSourceWriteBlobManifest(
  value: unknown,
): asserts value is CreatorSourceWriteBlobManifest {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorSourceWriteBlobManifest" ||
    !hasOnly(value, ["kind", "id", "hash", "sourceHash", "utf8Bytes", "chunkHashes"])
  )
    fail("CreatorSourceWriteBlobManifest");
  assertHash(value.sourceHash, "source write blob source hash");
  if (
    !Number.isSafeInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) < 0 ||
    !Array.isArray(value.chunkHashes) ||
    value.chunkHashes.some((entry) => !isHash(entry)) ||
    new Set(value.chunkHashes).size !== value.chunkHashes.length
  )
    fail("source write blob manifest payload");
  const payload = {
    sourceHash: value.sourceHash,
    utf8Bytes: value.utf8Bytes,
    chunkHashes: value.chunkHashes,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `creator_source_write_blob_manifest_${hash.slice(0, 24)}`
  )
    fail("source write blob manifest identity");
}

export function assertCreatorSourceWriteBlobChunk(
  value: unknown,
): asserts value is CreatorSourceWriteBlobChunk {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorSourceWriteBlobChunk" ||
    !hasOnly(value, ["kind", "id", "hash", "sourceHash", "ordinal", "startByte", "endByte", "utf8"])
  )
    fail("CreatorSourceWriteBlobChunk");
  assertHash(value.sourceHash, "source write blob chunk source hash");
  assertNonNegative(value.ordinal, "source write blob chunk ordinal");
  assertNonNegative(value.startByte, "source write blob chunk start");
  assertNonNegative(value.endByte, "source write blob chunk end");
  if (
    value.endByte < value.startByte ||
    typeof value.utf8 !== "string" ||
    utf8Bytes(value.utf8) !== value.endByte - value.startByte
  )
    fail("source write blob chunk bytes");
  const payload = {
    sourceHash: value.sourceHash,
    ordinal: value.ordinal,
    startByte: value.startByte,
    endByte: value.endByte,
    utf8: value.utf8,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `creator_source_write_blob_chunk_${hash.slice(0, 24)}`
  )
    fail("source write blob chunk identity");
}

export function assertCreatorSourceWriteBlobCapture(
  value: unknown,
  bounds: Pick<
    CreatorResourcePolicy,
    "maximumSourceBlobBytes" | "transportChunkBytes"
  > = CREATOR_DEFAULT_RESOURCE_POLICY,
): asserts value is CreatorSourceWriteBlobCapture {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorSourceWriteBlobCapture" ||
    !hasOnly(value, ["kind", "manifest", "chunks"]) ||
    !Array.isArray(value.chunks)
  )
    fail("CreatorSourceWriteBlobCapture");
  assertCreatorSourceWriteBlobManifest(value.manifest);
  if (
    !Number.isSafeInteger(bounds.maximumSourceBlobBytes) ||
    !Number.isSafeInteger(bounds.transportChunkBytes) ||
    bounds.maximumSourceBlobBytes < 0 ||
    bounds.transportChunkBytes <= 0 ||
    bounds.transportChunkBytes > bounds.maximumSourceBlobBytes
  )
    fail("source write blob resource policy");
  const manifest = value.manifest;
  if (manifest.utf8Bytes > bounds.maximumSourceBlobBytes) fail("source write blob resource bound");
  const chunks = value.chunks as readonly CreatorSourceWriteBlobChunk[];
  if (
    chunks.length !== manifest.chunkHashes.length ||
    stableJson(chunks.map((chunk) => chunk.hash)) !== stableJson(manifest.chunkHashes)
  )
    fail("source write blob chunk coverage");
  let endByte = 0;
  const pieces: string[] = [];
  for (const [ordinal, chunk] of chunks.entries()) {
    assertCreatorSourceWriteBlobChunk(chunk);
    if (
      chunk.sourceHash !== manifest.sourceHash ||
      chunk.ordinal !== ordinal ||
      chunk.startByte !== endByte ||
      utf8Bytes(chunk.utf8) > bounds.transportChunkBytes
    )
      fail("source write blob chunk sequence");
    endByte = chunk.endByte;
    pieces.push(chunk.utf8);
  }
  const source = pieces.join("");
  if (
    endByte !== manifest.utf8Bytes ||
    utf8Bytes(source) !== manifest.utf8Bytes ||
    contentHash(source) !== manifest.sourceHash
  )
    fail("source write blob body");
}

export function assertStudioProjectIndexManifest(
  value: unknown,
): asserts value is StudioProjectIndexManifest {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectIndexManifest" ||
    !hasOnly(value, [
      "kind",
      "id",
      "hash",
      "manifestHash",
      "projectionHash",
      "project",
      "connectorEpoch",
      "rootShardHashes",
      "allShardHashes",
      "sourceManifestHashes",
      "instanceCount",
      "canonicalBytes",
      "completedAt",
    ])
  )
    fail("StudioProjectIndexManifest");
  assertHash(value.manifestHash, "index manifest capability manifest hash");
  assertHash(value.projectionHash, "index manifest projection hash");
  assertProject(value.project);
  assertId(value.connectorEpoch, "index manifest connector epoch");
  if (
    !Array.isArray(value.rootShardHashes) ||
    !isSortedRoots(value.rootShardHashes) ||
    value.rootShardHashes.some(
      (entry) =>
        !isRecord(entry) ||
        !hasOnly(entry, ["root", "hash"]) ||
        !isRoot(entry.root) ||
        !isHash(entry.hash),
    )
  )
    fail("index manifest root shards");
  if (
    !Array.isArray(value.allShardHashes) ||
    value.allShardHashes.some((hash) => !isHash(hash)) ||
    new Set(value.allShardHashes).size !== value.allShardHashes.length
  )
    fail("index manifest shards");
  if (
    !Array.isArray(value.sourceManifestHashes) ||
    !isSortedStrings(value.sourceManifestHashes) ||
    value.sourceManifestHashes.some((hash) => !isHash(hash)) ||
    new Set(value.sourceManifestHashes).size !== value.sourceManifestHashes.length
  )
    fail("index manifest sources");
  assertNonNegative(value.instanceCount, "index manifest instances");
  assertNonNegative(value.canonicalBytes, "index manifest bytes");
  assertIso(value.completedAt, "index manifest completed at");
  const payload = {
    manifestHash: value.manifestHash,
    projectionHash: value.projectionHash,
    project: value.project,
    connectorEpoch: value.connectorEpoch,
    rootShardHashes: value.rootShardHashes,
    allShardHashes: value.allShardHashes,
    sourceManifestHashes: value.sourceManifestHashes,
    instanceCount: value.instanceCount,
    canonicalBytes: value.canonicalBytes,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `studio_project_index_manifest_${hash.slice(0, 24)}`
  )
    fail("index manifest identity");
}

export function assertStudioProjectRevision(
  value: unknown,
): asserts value is StudioProjectRevision {
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectRevision" ||
    !hasOnly(value, [
      "kind",
      "id",
      "hash",
      "manifestHash",
      "projectionHash",
      "indexManifestHash",
      "merkleRoot",
      "project",
      "connectorEpoch",
      "capturedAt",
    ])
  )
    fail("StudioProjectRevision");
  assertHash(value.manifestHash, "index revision manifest hash");
  assertHash(value.projectionHash, "index revision projection hash");
  assertHash(value.indexManifestHash, "index revision index manifest hash");
  assertHash(value.merkleRoot, "index revision merkle root");
  assertProject(value.project);
  assertId(value.connectorEpoch, "index revision connector epoch");
  assertIso(value.capturedAt, "index revision captured at");
  const payload = {
    manifestHash: value.manifestHash,
    projectionHash: value.projectionHash,
    indexManifestHash: value.indexManifestHash,
    merkleRoot: value.merkleRoot,
    project: value.project,
    connectorEpoch: value.connectorEpoch,
  };
  const hash = projectIndexHash(payload);
  if (
    !isHash(value.hash) ||
    value.hash !== hash ||
    value.id !== `studio_project_index_revision_${hash.slice(0, 24)}`
  )
    fail("index revision identity");
}

export function assertStudioProjectIndexCapture(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioProjectIndexCapture {
  assertStudioCapabilityManifest(manifest);
  if (
    !isRecord(value) ||
    value.kind !== "StudioProjectIndexCapture" ||
    !hasOnly(value, [
      "kind",
      "detectorEpoch",
      "projection",
      "indexManifest",
      "revision",
      "shards",
      "sourceManifests",
      "sourceChunks",
      "hash",
    ])
  )
    fail("StudioProjectIndexCapture");
  if (!Number.isSafeInteger(value.detectorEpoch) || Number(value.detectorEpoch) < 0)
    fail("StudioProjectIndexCapture detector epoch");
  assertStudioProjectIndexProjection(value.projection);
  assertStudioProjectIndexManifest(value.indexManifest);
  assertStudioProjectRevision(value.revision);
  assertProjectIndexManifestBinding(
    value as Pick<StudioProjectIndexCapture, "projection" | "indexManifest" | "revision">,
    manifest,
  );
  if (
    !Array.isArray(value.shards) ||
    !Array.isArray(value.sourceManifests) ||
    !Array.isArray(value.sourceChunks)
  )
    fail("project index capture members");
  // Transport assembly must retain the canonical artifact order. Sorting here
  // would make a reordered or duplicated stream look like authentic evidence.
  if (
    stableJson(value.shards) !== stableJson([...value.shards].sort(compareShard)) ||
    stableJson(value.sourceManifests) !==
      stableJson([...value.sourceManifests].sort(compareSourceManifest)) ||
    stableJson(value.sourceChunks) !== stableJson([...value.sourceChunks].sort(compareSourceChunk))
  )
    fail("project index capture artifact ordering");
  const rebuilt = createStudioProjectIndexCapture(
    {
      projection: value.projection,
      shards: value.shards,
      sourceManifests: value.sourceManifests,
      sourceChunks: value.sourceChunks,
      completedAt: value.indexManifest.completedAt,
      detectorEpoch: Number(value.detectorEpoch),
    },
    manifest,
  );
  if (
    stableJson(rebuilt.indexManifest) !== stableJson(value.indexManifest) ||
    stableJson(rebuilt.revision) !== stableJson(value.revision)
  )
    fail("project index capture bindings");
  const payload = {
    detectorEpoch: rebuilt.detectorEpoch,
    projection: rebuilt.projection,
    indexManifest: rebuilt.indexManifest,
    revision: rebuilt.revision,
    shards: rebuilt.shards,
    sourceManifests: rebuilt.sourceManifests,
    sourceChunks: rebuilt.sourceChunks,
  };
  if (!isHash(value.hash) || value.hash !== projectIndexHash(payload))
    fail("project index capture identity");
}

export function studioProjectIndexSourceDocuments(
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): readonly StudioSourceIndexDocument[] {
  assertStudioProjectIndexCapture(capture, manifest);
  const manifestByHash = new Map(
    capture.sourceManifests.map((manifest) => [manifest.hash, manifest]),
  );
  const chunksBySource = new Map<string, StudioSourceBlobChunk[]>();
  for (const chunk of capture.sourceChunks)
    chunksBySource.set(chunk.sourceHash, [...(chunksBySource.get(chunk.sourceHash) ?? []), chunk]);
  const documents: StudioSourceIndexDocument[] = [];
  for (const node of capture.shards.flatMap((shard) => shard.nodes)) {
    if (node.sourceManifestHash === undefined) continue;
    const sourceManifest = manifestByHash.get(node.sourceManifestHash);
    if (!sourceManifest) fail("source document manifest");
    const source = (chunksBySource.get(sourceManifest.sourceHash) ?? [])
      .sort(compareSourceChunk)
      .map((chunk) => chunk.utf8)
      .join("");
    const executionContext =
      node.className === "LocalScript"
        ? "client"
        : node.className === "Script"
          ? "server"
          : "shared";
    documents.push({
      documentId: studioObjectIdentityKey(node.identity),
      path: node.displayPath,
      className: node.className,
      executionContext,
      sourceHash: sourceManifest.sourceHash,
      source,
    });
  }
  return documents.sort(
    (left, right) =>
      compareCanonicalString(left.path, right.path) ||
      compareCanonicalString(left.documentId, right.documentId),
  );
}

/**
 * Return source descriptors without joining any source blob chunks. This
 * expects a capture already assembled by the evidence transport; callers
 * that need full replay validation may still use `assertStudioProjectIndexCapture`.
 */
export function studioProjectIndexSourceMetadata(
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): readonly StudioSourceDocumentMetadata[] {
  assertStudioProjectIndexMetadataCapture(capture, manifest);
  const manifestByHash = new Map(
    capture.sourceManifests.map((manifest) => [manifest.hash, manifest]),
  );
  const documents: StudioSourceDocumentMetadata[] = [];
  for (const node of capture.shards.flatMap((shard) => shard.nodes)) {
    if (node.sourceManifestHash === undefined) continue;
    const sourceManifest = manifestByHash.get(node.sourceManifestHash);
    if (
      !sourceManifest ||
      studioObjectIdentityKey(sourceManifest.identity) !== studioObjectIdentityKey(node.identity)
    )
      fail("source document manifest");
    documents.push({
      documentId: studioObjectIdentityKey(node.identity),
      path: node.displayPath,
      className: node.className,
      executionContext:
        node.className === "LocalScript"
          ? "client"
          : node.className === "Script"
            ? "server"
            : "shared",
      sourceHash: sourceManifest.sourceHash,
      utf8Bytes: sourceManifest.utf8Bytes,
    });
  }
  return documents.sort(
    (left, right) =>
      compareCanonicalString(left.path, right.path) ||
      compareCanonicalString(left.documentId, right.documentId),
  );
}

/** Metadata-only project view; it never joins source chunks. */
export function studioProjectIndexMetadataView(
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioProjectIndexMetadataView {
  assertStudioProjectIndexMetadataCapture(capture, manifest);
  const instances = capture.shards
    .flatMap((shard) => shard.nodes)
    .map((node) => {
      const properties = node.coveredProperties as Readonly<Record<string, StudioValue>>;
      const positionValue = properties.Position;
      const position =
        isRecord(positionValue) &&
        positionValue.kind === "vector3_f32" &&
        typeof positionValue.x === "number" &&
        typeof positionValue.y === "number" &&
        typeof positionValue.z === "number"
          ? { x: positionValue.x, y: positionValue.y, z: positionValue.z }
          : undefined;
      return {
        objectId: studioObjectIdentityKey(node.identity),
        identity: canonicalIdentity(node.identity),
        path: node.displayPath,
        name: node.name,
        ...(node.parentIdentity === undefined
          ? {}
          : { parentIdentity: canonicalIdentity(node.parentIdentity) }),
        ...(node.engineContainer === undefined
          ? {}
          : {
              engineContainer: {
                path: node.engineContainer.path,
                className: node.engineContainer.className,
              },
            }),
        className: node.className,
        ...(position ? { position } : {}),
        properties,
        attributes: node.attributes,
        tags: [...node.tags],
      };
    })
    .sort(
      (left, right) =>
        compareCanonicalString(left.path, right.path) ||
        compareCanonicalString(left.objectId, right.objectId),
    );
  return {
    project: capture.indexManifest.project,
    revision: capture.revision,
    instances,
    scripts: studioProjectIndexSourceMetadata(capture, manifest),
  };
}

export function studioProjectIndexView(
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioProjectIndexView {
  assertStudioProjectIndexCapture(capture, manifest);
  const instances = capture.shards
    .flatMap((shard) => shard.nodes)
    .map((node) => {
      const properties = node.coveredProperties as Readonly<Record<string, StudioValue>>;
      const positionValue = properties.Position;
      const position =
        isRecord(positionValue) &&
        positionValue.kind === "vector3_f32" &&
        typeof positionValue.x === "number" &&
        typeof positionValue.y === "number" &&
        typeof positionValue.z === "number"
          ? { x: positionValue.x, y: positionValue.y, z: positionValue.z }
          : undefined;
      return {
        objectId: studioObjectIdentityKey(node.identity),
        identity: canonicalIdentity(node.identity),
        path: node.displayPath,
        name: node.name,
        ...(node.parentIdentity === undefined
          ? {}
          : { parentIdentity: canonicalIdentity(node.parentIdentity) }),
        ...(node.engineContainer === undefined
          ? {}
          : {
              engineContainer: {
                path: node.engineContainer.path,
                className: node.engineContainer.className,
              },
            }),
        className: node.className,
        ...(position ? { position } : {}),
        properties,
        attributes: node.attributes,
        tags: [...node.tags],
      };
    })
    .sort(
      (left, right) =>
        compareCanonicalString(left.path, right.path) ||
        compareCanonicalString(left.objectId, right.objectId),
    );
  return {
    project: capture.indexManifest.project,
    revision: capture.revision,
    instances,
    scripts: studioProjectIndexSourceDocuments(capture, manifest),
  };
}

/**
 * Validate the structural and metadata portions of a capture without joining
 * source chunks. Source bytes are checked by the blob resolver or the full
 * replay assertion, depending on the operation being performed.
 */
function assertStudioProjectIndexMetadataCapture(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioProjectIndexCapture {
  assertStudioCapabilityManifest(manifest);
  if (!isRecord(value) || value.kind !== "StudioProjectIndexCapture")
    fail("StudioProjectIndexCapture");
  assertStudioProjectIndexProjection(value.projection);
  assertStudioProjectIndexManifest(value.indexManifest);
  assertStudioProjectRevision(value.revision);
  assertProjectIndexManifestBinding(
    value as Pick<StudioProjectIndexCapture, "projection" | "indexManifest" | "revision">,
    manifest,
  );
  if (
    !Array.isArray(value.shards) ||
    !Array.isArray(value.sourceManifests) ||
    !Array.isArray(value.sourceChunks)
  )
    fail("project index capture members");
  const shards = (value.shards as unknown[]).map((entry) => {
    assertStudioProjectEvidenceShard(entry, manifest);
    return entry;
  });
  const sourceManifests = (value.sourceManifests as unknown[]).map((entry) => {
    assertStudioSourceBlobManifest(entry);
    return entry;
  });
  const sourceChunks = (value.sourceChunks as unknown[]).map((entry) => {
    assertStudioSourceBlobChunk(entry);
    return entry;
  });
  if (
    stableJson(shards) !== stableJson([...shards].sort(compareShard)) ||
    stableJson(sourceManifests) !== stableJson([...sourceManifests].sort(compareSourceManifest)) ||
    stableJson(sourceChunks) !== stableJson([...sourceChunks].sort(compareSourceChunk))
  )
    fail("project index capture artifact ordering");
  const manifestHashes = new Set(sourceManifests.map((manifest) => manifest.hash));
  for (const node of shards.flatMap((shard) => shard.nodes)) {
    if (node.sourceManifestHash !== undefined && !manifestHashes.has(node.sourceManifestHash))
      fail("project index missing source manifest");
  }
}

function assertCompleteIndex(
  projection: StudioProjectIndexProjection,
  shards: readonly StudioProjectEvidenceShard[],
  sourceManifests: readonly StudioSourceBlobManifest[],
  sourceChunks: readonly StudioSourceBlobChunk[],
): void {
  const roots = new Set(projection.roots);
  const actualRoots = [...new Set(shards.map((shard) => shard.root))].sort();
  if (stableJson(actualRoots) !== stableJson(projection.roots))
    fail("project index root enumeration");
  const seenOrdinals = new Map<string, number>();
  const identities = new Set<string>();
  const sourceReferences = new Set<string>();
  const parentReferences: StudioObjectIdentity[] = [];
  const nodeSourceReferences: {
    readonly sourceManifestHash: string;
    readonly identity: StudioObjectIdentity;
  }[] = [];
  let instanceCount = 0;
  let canonicalBytes = 0;
  for (const shard of shards) {
    if (!roots.has(shard.root)) fail("project index extra root");
    const expectedOrdinal = seenOrdinals.get(shard.root) ?? 0;
    if (shard.ordinal !== expectedOrdinal) fail("project index shard ordinal");
    seenOrdinals.set(shard.root, expectedOrdinal + 1);
    if (
      shard.nodes.length > projection.bounds.maximumNodesPerShard ||
      shard.canonicalBytes > projection.bounds.maximumCanonicalShardBytes
    )
      fail("project index shard resource bound");
    instanceCount += shard.nodes.length;
    canonicalBytes += shard.canonicalBytes;
    for (const node of shard.nodes) {
      const identity = studioObjectIdentityKey(node.identity);
      if (identities.has(identity)) fail("project index duplicate node");
      identities.add(identity);
      if (node.parentIdentity !== undefined) parentReferences.push(node.parentIdentity);
      if (!node.displayPath.startsWith(`${shard.root}/`) && node.displayPath !== shard.root)
        fail("project index node root");
      if (node.sourceManifestHash !== undefined) {
        if (sourceReferences.has(node.sourceManifestHash))
          fail("project index duplicate source ref");
        sourceReferences.add(node.sourceManifestHash);
        nodeSourceReferences.push({
          sourceManifestHash: node.sourceManifestHash,
          identity: node.identity,
        });
      }
    }
  }
  if (instanceCount > projection.bounds.maximumInstances) fail("project index resource bound");
  if (parentReferences.some((identity) => !identities.has(studioObjectIdentityKey(identity))))
    fail("project index missing parent node");
  const manifests = new Map<string, StudioSourceBlobManifest>();
  for (const sourceManifest of sourceManifests) {
    if (manifests.has(sourceManifest.hash)) fail("project index duplicate source manifest");
    manifests.set(sourceManifest.hash, sourceManifest);
    if (!sourceReferences.has(sourceManifest.hash)) fail("project index extra source manifest");
    if (sourceManifest.utf8Bytes > projection.bounds.maximumSourceBlobBytes)
      fail("project index source resource bound");
    canonicalBytes += utf8Bytes(projectIndexMaterial(sourceManifest));
  }
  if (sourceReferences.size !== sourceManifests.length)
    fail("project index missing source manifest");
  for (const reference of nodeSourceReferences) {
    const sourceManifest = manifests.get(reference.sourceManifestHash);
    if (
      !sourceManifest ||
      studioObjectIdentityKey(sourceManifest.identity) !==
        studioObjectIdentityKey(reference.identity)
    )
      fail("project index source identity binding");
  }
  const chunksBySource = new Map<string, StudioSourceBlobChunk[]>();
  for (const chunk of sourceChunks) {
    if (utf8Bytes(chunk.utf8) > projection.bounds.transportChunkBytes)
      fail("project index source chunk bound");
    chunksBySource.set(chunk.sourceHash, [...(chunksBySource.get(chunk.sourceHash) ?? []), chunk]);
    canonicalBytes += utf8Bytes(projectIndexMaterial(chunk));
  }
  for (const sourceManifest of sourceManifests) {
    const chunks = (chunksBySource.get(sourceManifest.sourceHash) ?? []).sort(compareSourceChunk);
    if (
      chunks.length !== sourceManifest.chunkHashes.length ||
      stableJson(chunks.map((chunk) => chunk.hash)) !== stableJson(sourceManifest.chunkHashes)
    )
      fail("project index source chunk coverage");
    let endByte = 0;
    for (const [ordinal, chunk] of chunks.entries()) {
      if (
        chunk.ordinal !== ordinal ||
        chunk.startByte !== endByte ||
        chunk.sourceHash !== sourceManifest.sourceHash
      )
        fail("project index source chunk sequence");
      endByte = chunk.endByte;
    }
    const source = chunks.map((chunk) => chunk.utf8).join("");
    if (
      endByte !== sourceManifest.utf8Bytes ||
      utf8Bytes(source) !== sourceManifest.utf8Bytes ||
      contentHash(source) !== sourceManifest.sourceHash
    )
      fail("project index source body");
  }
  const knownSourceHashes = new Set(sourceManifests.map((manifest) => manifest.sourceHash));
  if (sourceChunks.some((chunk) => !knownSourceHashes.has(chunk.sourceHash)))
    fail("project index extra source chunk");
  if (canonicalBytes > projection.bounds.maximumCanonicalIndexBytes)
    fail("project index resource bound");
}

function canonicalNodes(
  nodes: readonly StudioProjectIndexNode[],
  manifest: StudioCapabilityManifest,
): StudioProjectIndexNode[] {
  const canonical = nodes.map((node) => {
    assertStudioProjectIndexNode(node, manifest);
    return {
      identity: canonicalIdentity(node.identity),
      displayPath: node.displayPath,
      name: node.name,
      ...(node.parentIdentity === undefined
        ? {}
        : { parentIdentity: canonicalIdentity(node.parentIdentity) }),
      ...(node.engineContainer === undefined
        ? {}
        : {
            engineContainer: {
              path: node.engineContainer.path,
              className: node.engineContainer.className,
            },
          }),
      className: node.className,
      attributes: canonicalRecord(node.attributes) as Record<string, StudioProjectAttributeValue>,
      tags: [...node.tags],
      coveredProperties: canonicalRecord(node.coveredProperties),
      coveredPropertyNames: [...node.coveredPropertyNames],
      ...(node.sourceManifestHash === undefined
        ? {}
        : { sourceManifestHash: node.sourceManifestHash }),
    };
  });
  canonical.sort(
    (left, right) =>
      compareCanonicalString(left.displayPath, right.displayPath) ||
      compareCanonicalString(
        studioObjectIdentityKey(left.identity),
        studioObjectIdentityKey(right.identity),
      ),
  );
  if (
    new Set(canonical.map((node) => studioObjectIdentityKey(node.identity))).size !==
    canonical.length
  )
    fail("project index duplicate node");
  return canonical;
}

function canonicalIdentity(identity: StudioObjectIdentity): StudioObjectIdentity {
  switch (identity.kind) {
    case "forge_attribute":
      return { kind: identity.kind, stableId: identity.stableId };
    case "studio_ephemeral":
      return {
        kind: identity.kind,
        connectorEpoch: identity.connectorEpoch,
        opaqueHash: identity.opaqueHash,
      };
    case "rojo_sourcemap":
      return {
        kind: identity.kind,
        authorityMapHash: identity.authorityMapHash,
        sourcemapHash: identity.sourcemapHash,
        mappingId: identity.mappingId,
      };
  }
}

function assertStudioProjectAttributeValue(
  value: unknown,
): asserts value is StudioProjectAttributeValue {
  if (typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("project index attribute number");
    return;
  }
  assertStudioValue(value);
  if (
    ![
      "brick_color",
      "cframe_f32x12",
      "color3_rgb8",
      "color_sequence",
      "number_range",
      "number_sequence",
      "rect",
      "udim",
      "udim2",
      "vector2_f32",
      "vector3_f32",
    ].includes(value.kind)
  )
    fail("project index attribute type");
}

/**
 * The project-index hash domain is deliberately not JSON. JSON leaves numeric
 * spelling, negative zero, and object encoding details to the host runtime.
 * This material is a closed typed tree: every field and child is tagged and
 * byte-length delimited, numeric values are their IEEE-754 binary64 bits, and
 * object keys sort by UTF-8 bytes (the order Luau uses for the same strings).
 *
 * Canonical JSON remains a transport representation only. Any decoded JSON
 * whose values cannot reconstruct this material is rejected by the hash
 * binding instead of becoming an ambiguous evidence claim.
 */
export function projectIndexMaterial(value: unknown): string {
  return projectIndexMaterialInner(value);
}

export function projectIndexHash(value: unknown): string {
  return contentHash(projectIndexMaterial(value));
}

function projectIndexMaterialInner(value: unknown): string {
  if (value === null) return projectIndexTagged("null", "");
  switch (typeof value) {
    case "boolean":
      return projectIndexTagged("boolean", value ? "1" : "0");
    case "string":
      return projectIndexTagged("utf8", checkedUtf8(value));
    case "number":
      return projectIndexTagged("float64", float64Bits(value));
    case "object":
      break;
    default:
      fail("project index canonical material value");
  }
  if (Array.isArray(value)) {
    // Do not let a sparse JS array or arbitrary own fields have an implicit
    // representation. Luau tables used as sequences satisfy this exactly.
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
      fail("project index canonical array");
    return projectIndexTagged("array", projectIndexSequence(value.map(projectIndexMaterialInner)));
  }
  if (!isRecord(value) || !isPlainDataRecord(value)) fail("project index canonical record");
  const keys = Object.keys(value).sort(compareUtf8);
  const entries = keys.map((key) =>
    projectIndexTagged(
      "entry",
      projectIndexTagged("key", checkedUtf8(key)) +
        projectIndexTagged("value", projectIndexMaterialInner(value[key])),
    ),
  );
  return projectIndexTagged("object", projectIndexSequence(entries));
}

function projectIndexTagged(tag: string, payload: string): string {
  return `${utf8Bytes(tag)}:${tag}${utf8Bytes(payload)}:${payload}`;
}

function projectIndexSequence(parts: readonly string[]): string {
  return projectIndexTagged(
    "sequence",
    projectIndexTagged("count", String(parts.length)) +
      parts.map((part) => projectIndexTagged("item", part)).join(""),
  );
}

function float64Bits(value: number): string {
  if (!Number.isFinite(value)) fail("project index canonical number");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return `${view.getUint32(0, false).toString(16).padStart(8, "0")}${view.getUint32(4, false).toString(16).padStart(8, "0")}`;
}

function checkedUtf8(value: string): string {
  // Node otherwise replaces an unpaired UTF-16 surrogate with U+FFFD, which
  // would give two distinct host values the same evidence bytes.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) fail("project index canonical UTF-8");
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Every ordered project-index sequence is canonical evidence, not a
 * locale-facing presentation. Locale collation differs by machine and does
 * not match the byte ordering used by Luau or the evidence hash domain.
 */
function compareCanonicalString(left: string, right: string): number {
  return compareUtf8(left, right);
}

function isPlainDataRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function canonicalRoots(roots: readonly string[]): string[] {
  if (!Array.isArray(roots)) fail("project index roots");
  const output = [...roots];
  if (output.length === 0 || !isSortedStrings(output) || output.some((root) => !isRoot(root)))
    fail("project index roots");
  return output;
}
function canonicalRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!isRecord(value) || !isCanonicalRecord(value)) fail("canonical record");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}
function compareShard(left: StudioProjectEvidenceShard, right: StudioProjectEvidenceShard): number {
  return (
    compareCanonicalString(left.root, right.root) ||
    left.ordinal - right.ordinal ||
    compareCanonicalString(left.hash, right.hash)
  );
}
function compareSourceManifest(
  left: StudioSourceBlobManifest,
  right: StudioSourceBlobManifest,
): number {
  return (
    compareCanonicalString(
      studioObjectIdentityKey(left.identity),
      studioObjectIdentityKey(right.identity),
    ) || compareCanonicalString(left.hash, right.hash)
  );
}
function compareSourceChunk(left: StudioSourceBlobChunk, right: StudioSourceBlobChunk): number {
  return (
    compareCanonicalString(left.sourceHash, right.sourceHash) ||
    left.ordinal - right.ordinal ||
    compareCanonicalString(left.hash, right.hash)
  );
}
function merkleRoot(hashes: readonly string[]): string {
  return projectIndexHash([...hashes]);
}
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}
function nextUtf8Boundary(value: Buffer, start: number): number {
  let end = start + 1;
  while (end < value.length && isUtf8ContinuationByte(value[end]!)) end += 1;
  return end;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/\s/.test(value);
}

/**
 * Closed wire-string domain for StudioObjectIdentity. Byte length and Unicode
 * whitespace are explicit so the TypeScript and generated Luau validators
 * accept precisely the same representable identities.
 */
function isStudioObjectIdentityText(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0) return false;
  if (Buffer.byteLength(value, "utf8") > 512) return false;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  return !/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(
    value,
  );
}
function assertId(value: unknown, label: string): asserts value is string {
  if (!isId(value)) fail(label);
}
function isRoot(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length <= 255;
}
function assertRoot(value: unknown, label: string): asserts value is string {
  if (!isRoot(value)) fail(label);
}
function assertDisplayPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8192 ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    fail("project index display path");
}
function assertStudioInstanceName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > 100 ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  )
    fail("project index instance name");
}
function assertProject(value: unknown): asserts value is StudioProjectIdentity {
  if (
    !isRecord(value) ||
    !hasOnly(value, ["name", "placeId", "universeId"]) ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.placeId) ||
    !Number.isInteger(value.universeId)
  )
    fail("project index project identity");
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (!isHash(value)) fail(label);
}
function assertNonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) fail(label);
}
function isSortedStrings(values: readonly unknown[]): values is readonly string[] {
  return values.every(
    (value, index) =>
      typeof value === "string" &&
      (index === 0 || compareCanonicalString(String(values[index - 1]), value) < 0),
  );
}
function isSortedRoots(
  values: readonly unknown[],
): values is readonly { readonly root: string; readonly hash: string }[] {
  return values.every(
    (value, index) =>
      isRecord(value) &&
      (index === 0 ||
        compareCanonicalString(
          String((values[index - 1] as Record<string, unknown>).root),
          String(value.root),
        ) < 0),
  );
}
function isCanonicalRecord(value: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(value) === stableJson(value);
  } catch {
    return false;
  }
}
function assertIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(label);
}
function fail(message: string): never {
  throw new Error(`Invalid Studio project index: ${message}`);
}
