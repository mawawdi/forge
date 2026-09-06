import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertBoundedGameJson,
  DEFAULT_GAME_ADMISSION_POLICY,
} from "../../game-ir/src/primitives.js";
import {
  AssetError,
  fitAssetGeometry,
  parseObjMesh,
  summarizeObjMesh,
  validateAssetSpec,
  type AssetInspectionPolicy,
  type AssetLock,
  type ParsedObjMesh,
} from "./index.js";

export interface MeshReviewPolicy extends AssetInspectionPolicy {
  maximumJsonBytes: number;
  maximumNativePartitions: number;
}
export const DEFAULT_MESH_REVIEW_POLICY: Readonly<MeshReviewPolicy> = Object.freeze({
  maximumBytes: 16 * 1024 * 1024,
  maximumVertices: 250000,
  maximumTriangles: 500000,
  maximumAbsoluteCoordinate: 1000000,
  maximumJsonBytes: 64 * 1024 * 1024,
  maximumNativePartitions: 512,
});
// Current documented per-EditableMesh limits, not an admitted native constructor.
const NATIVE_MAX_VERTICES = 60_000;
const NATIVE_MAX_TRIANGLES = 20_000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().safe().nonnegative();
const vector = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
const bounds = z.object({ min: vector, max: vector }).strict();
const regionName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const regionKind = z.enum(["object", "group"]);
const fitSchema = z
  .object({
    scale: z.number().finite().positive(),
    translation: vector,
    bounds,
    clearance: z.number().finite().nonnegative(),
  })
  .strict();
const geometrySchema = z
  .object({
    vertexCount: count,
    triangleCount: count,
    bounds,
    regions: z
      .array(
        z
          .object({
            kind: regionKind,
            name: regionName,
            triangleCount: count,
            referencedVertexCount: count,
            bounds: bounds.nullable(),
          })
          .strict(),
      )
      .max(256),
    topology: z
      .object({
        basis: z.literal("obj_vertex_indices"),
        referencedVertexCount: count,
        unreferencedVertexCount: count,
        edgeCount: count,
        boundaryEdgeCount: count,
        nonManifoldEdgeCount: count,
        inconsistentWindingEdgeCount: count,
        edgeConnectedComponentCount: count,
        duplicateTriangleCount: count,
        unlabelledTriangleCount: count,
      })
      .strict(),
    warnings: z
      .array(
        z
          .object({
            code: z.enum([
              "boundary_edges",
              "disconnected_surfaces",
              "duplicate_triangles",
              "empty_regions",
              "inconsistent_winding",
              "non_manifold_edges",
              "unreferenced_vertices",
            ]),
            detail: z.string().max(2048),
          })
          .strict(),
      )
      .max(7),
  })
  .strict();
const chunkSchema = z
  .object({
    id: z.string().regex(/^mesh-chunk-[a-f0-9]{24}$/),
    part: z.union([
      z.object({ kind: regionKind, name: regionName }).strict(),
      z.object({ kind: z.literal("unlabelled") }).strict(),
    ]),
    triangleIds: z.array(count).min(1).max(NATIVE_MAX_TRIANGLES),
    vertexCount: count.max(NATIVE_MAX_VERTICES),
    triangleCount: count.max(NATIVE_MAX_TRIANGLES),
  })
  .strict();
const reviewSchema = z
  .object({
    kind: z.literal("MeshReviewData"),
    hash: sha256,
    assetId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    lockHash: sha256,
    source: z.object({ sha256, utf8Bytes: count.positive() }).strict(),
    coordinateFrame: z.literal("source_obj"),
    positions: z.array(z.number().finite()),
    triangleIndices: z.array(count),
    triangleNormals: z.array(z.number().finite()),
    normalBinding: z.literal("per_triangle"),
    regions: z
      .array(z.object({ kind: regionKind, name: regionName, triangleIds: z.array(count) }).strict())
      .max(256),
    geometry: geometrySchema,
    fit: fitSchema,
    envelope: z.object({ size: vector, clearance: z.number().finite().nonnegative() }).strict(),
    sockets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            position: vector,
            coordinateFrame: z.literal("fitted_asset"),
            status: z.literal("declared"),
          })
          .strict(),
      )
      .max(64),
    appearance: z
      .object({
        normalMode: z.literal("computed_flat"),
        sourceNormalCount: count,
        sourceTextureCoordinateCount: count,
        sourceSmoothingDeclarationCount: count,
        textures: z.literal("not_loaded"),
        materials: z.literal("not_loaded"),
        sourceShading: z.literal("not_reproduced"),
      })
      .strict(),
    nativeImport: z
      .object({
        status: z.literal("incomplete"),
        mayInstantiate: z.literal(false),
        code: z.literal("native_import_unavailable"),
        reason: z.string().max(2048),
        partition: z
          .object({
            kind: z.literal("LosslessMeshPartition"),
            maximumVerticesPerChunk: z.literal(NATIVE_MAX_VERTICES),
            maximumTrianglesPerChunk: z.literal(NATIVE_MAX_TRIANGLES),
            coordinateFrame: z.literal("source_obj"),
            fit: z.literal("shared_uniform_transform"),
            method: z.literal("object_then_group_then_unlabelled_in_source_triangle_order"),
            chunks: z.array(chunkSchema).min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** All arrays are ordinary JSON numbers. Positions and normals are packed XYZ triples. */
export type MeshReviewData = z.infer<typeof reviewSchema>;
export type MeshReviewPartition = MeshReviewData["nativeImport"]["partition"];

function validatePolicy(policy: MeshReviewPolicy): void {
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new AssetError("invalid_policy", "Mesh review limits must be positive safe integers");
}

function assertReviewJson(value: unknown, policy: MeshReviewPolicy): void {
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: policy.maximumJsonBytes,
    maximumJsonNodes: Math.min(Number.MAX_SAFE_INTEGER, policy.maximumJsonBytes),
  });
}

function triangleNormal(
  positions: readonly number[],
  indices: readonly number[],
  offset: number,
): number[] {
  const a = indices[offset]! * 3;
  const b = indices[offset + 1]! * 3;
  const c = indices[offset + 2]! * 3;
  const ux = positions[b]! - positions[a]!;
  const uy = positions[b + 1]! - positions[a + 1]!;
  const uz = positions[b + 2]! - positions[a + 2]!;
  const vx = positions[c]! - positions[a]!;
  const vy = positions[c + 1]! - positions[a + 1]!;
  const vz = positions[c + 2]! - positions[a + 2]!;
  const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const magnitude = Math.hypot(...normal);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12)
    throw new AssetError("degenerate_geometry", "Review triangle is degenerate");
  return normal.map((value) => value / magnitude || 0);
}

/** Lossless inventory advice only: preserves source triangles, winding and common frame. */
export function partitionMeshForNativeReview(input: {
  sourceHash: string;
  triangles: ReadonlyArray<readonly [number, number, number]>;
  regions: ParsedObjMesh["regions"];
  maximumPartitions?: number;
}): MeshReviewPartition {
  sha256.parse(input.sourceHash);
  const maximumPartitions =
    input.maximumPartitions ?? DEFAULT_MESH_REVIEW_POLICY.maximumNativePartitions;
  if (!Number.isSafeInteger(maximumPartitions) || maximumPartitions < 1)
    throw new AssetError("invalid_policy", "Partition budget must be a positive safe integer");
  const owners = new Int32Array(input.triangles.length).fill(-1);
  const membershipKinds = new Uint8Array(input.triangles.length);
  const regions = [...input.regions].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "object" ? -1 : 1) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const [regionIndex, region] of regions.entries())
    for (const triangleId of region.triangleIds) {
      if (!Number.isSafeInteger(triangleId) || triangleId < 0 || triangleId >= owners.length)
        throw new AssetError("invalid_geometry", "Partition region references an absent triangle");
      const kindBit = region.kind === "object" ? 1 : 2;
      if ((membershipKinds[triangleId]! & kindBit) !== 0)
        throw new AssetError(
          "invalid_geometry",
          "A source triangle cannot belong to two simultaneous OBJ objects or two groups",
        );
      membershipKinds[triangleId] = membershipKinds[triangleId]! | kindBit;
      if (owners[triangleId] === -1) owners[triangleId] = regionIndex;
    }
  const groups = new Map<number, number[]>();
  for (let id = 0; id < owners.length; id++) {
    const owner = owners[id]!;
    const group = groups.get(owner) ?? [];
    group.push(id);
    groups.set(owner, group);
  }
  const chunks: MeshReviewPartition["chunks"] = [];
  for (const [owner, triangleIds] of groups) {
    const region = regions[owner];
    const part = region
      ? { kind: region.kind, name: region.name }
      : { kind: "unlabelled" as const };
    let members: number[] = [];
    let vertices = new Set<number>();
    const flush = () => {
      if (!members.length) return;
      if (chunks.length >= maximumPartitions)
        throw new AssetError(
          "review_resource_limit",
          "Lossless native partition budget exceeded; no triangles were sampled or removed",
        );
      chunks.push({
        id: `mesh-chunk-${contentHash(
          stableJson({ sourceHash: input.sourceHash, part, triangleIds: members }),
        ).slice(0, 24)}`,
        part,
        triangleIds: members,
        vertexCount: vertices.size,
        triangleCount: members.length,
      });
      members = [];
      vertices = new Set();
    };
    for (const triangleId of triangleIds) {
      const triangle = input.triangles[triangleId]!;
      if (
        triangle.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0) ||
        new Set(triangle).size !== 3
      )
        throw new AssetError(
          "invalid_geometry",
          "Partition triangle indices must be distinct nonnegative integers",
        );
      const additions = triangle.filter((vertex) => !vertices.has(vertex)).length;
      if (
        members.length === NATIVE_MAX_TRIANGLES ||
        vertices.size + additions > NATIVE_MAX_VERTICES
      )
        flush();
      members.push(triangleId);
      for (const vertex of triangle) vertices.add(vertex);
    }
    flush();
  }
  return {
    kind: "LosslessMeshPartition",
    maximumVerticesPerChunk: NATIVE_MAX_VERTICES,
    maximumTrianglesPerChunk: NATIVE_MAX_TRIANGLES,
    coordinateFrame: "source_obj",
    fit: "shared_uniform_transform",
    method: "object_then_group_then_unlabelled_in_source_triangle_order",
    chunks,
  };
}

/** Caller supplies the exact replayed lock and source bytes, never a remote URL. */
export function createMeshReview(input: {
  bytes: Uint8Array;
  lock: AssetLock;
  policy?: MeshReviewPolicy;
}): MeshReviewData {
  const policy = input.policy ?? DEFAULT_MESH_REVIEW_POLICY;
  validatePolicy(policy);
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > policy.maximumBytes)
    throw new AssetError("review_resource_limit", "Source exceeds mesh review byte budget");
  // Lock comes from the typed registry/replay API. Canonicalize its signed zeros
  // exactly as the immutable store does, then apply bounded JSON validation.
  const canonicalLock: unknown = JSON.parse(stableJson(input.lock));
  const bytes = Buffer.from(input.bytes);
  assertBoundedGameJson(canonicalLock, DEFAULT_GAME_ADMISSION_POLICY);
  const lock = canonicalLock as unknown as AssetLock;
  const { hash: lockHash, ...body } = lock;
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (
    lock.kind !== "AssetLock" ||
    lock.readiness !== "locally_inspected" ||
    contentHash(stableJson(body)) !== lockHash ||
    sourceHash !== lock.sourceHash ||
    bytes.byteLength !== lock.sourceUtf8Bytes
  )
    throw new AssetError("hash_mismatch", "Review lock and exact source bytes do not match");
  const spec = validateAssetSpec(lock.spec);
  if (spec.id !== lock.assetId)
    throw new AssetError("hash_mismatch", "Review asset identity does not match its specification");
  const parsed = parseObjMesh(bytes, policy);
  const fit = fitAssetGeometry(parsed.geometry, spec);
  if (
    stableJson(parsed.geometry) !== stableJson(lock.geometry) ||
    stableJson(fit) !== stableJson(lock.fit)
  )
    throw new AssetError(
      "hash_mismatch",
      "Source geometry or shared fit differs from the retained lock",
    );
  const positions = parsed.vertices.flatMap((value) => [value.x || 0, value.y || 0, value.z || 0]);
  const triangleIndices = parsed.triangles.flat();
  const triangleNormals: number[] = [];
  for (let offset = 0; offset < triangleIndices.length; offset += 3)
    triangleNormals.push(...triangleNormal(positions, triangleIndices, offset));
  const value = {
    kind: "MeshReviewData" as const,
    assetId: spec.id,
    lockHash,
    source: { sha256: sourceHash, utf8Bytes: bytes.byteLength },
    coordinateFrame: "source_obj" as const,
    positions,
    triangleIndices,
    triangleNormals,
    normalBinding: "per_triangle" as const,
    regions: parsed.regions,
    geometry: parsed.geometry,
    fit,
    envelope: { size: spec.bounds, clearance: spec.clearance },
    sockets: spec.sockets.map((socket) => ({
      ...socket,
      coordinateFrame: "fitted_asset" as const,
      status: "declared" as const,
    })),
    appearance: {
      normalMode: "computed_flat" as const,
      sourceNormalCount: parsed.appearance.normalCount,
      sourceTextureCoordinateCount: parsed.appearance.textureCoordinateCount,
      sourceSmoothingDeclarationCount: parsed.appearance.smoothingDeclarationCount,
      textures: "not_loaded" as const,
      materials: "not_loaded" as const,
      sourceShading: "not_reproduced" as const,
    },
    nativeImport: {
      status: "incomplete" as const,
      mayInstantiate: false as const,
      code: "native_import_unavailable" as const,
      reason:
        "This geometry review and lossless partition are local derived evidence. Fixed native construction, exact normal/part/socket mapping, permissions, collision, undo, and save/reopen remain unverified. No asset upload or editor instance is authorized.",
      partition: partitionMeshForNativeReview({
        sourceHash,
        triangles: parsed.triangles,
        regions: parsed.regions,
        maximumPartitions: policy.maximumNativePartitions,
      }),
    },
  };
  // Normalize signed zero in measured bounds/fit; source bytes retain their original hash.
  const result: MeshReviewData = JSON.parse(
    stableJson({ ...value, hash: contentHash(stableJson(value)) }),
  );
  assertMeshReviewData(result, policy);
  return result;
}

/** Validate a retained review payload. Its hash is not native approval or a source-byte replay. */
export function assertMeshReviewData(
  value: unknown,
  policy: MeshReviewPolicy = DEFAULT_MESH_REVIEW_POLICY,
): asserts value is MeshReviewData {
  validatePolicy(policy);
  assertReviewJson(value, policy);
  const data = reviewSchema.parse(value);
  const { hash, ...body } = data;
  if (contentHash(stableJson(body)) !== hash)
    throw new AssetError("hash_mismatch", "Mesh review payload hash mismatch");
  const vertices = data.positions.length / 3;
  const triangles = data.triangleIndices.length / 3;
  if (
    !Number.isInteger(vertices) ||
    vertices < 3 ||
    vertices > policy.maximumVertices ||
    !Number.isInteger(triangles) ||
    triangles < 1 ||
    triangles > policy.maximumTriangles ||
    data.triangleNormals.length !== triangles * 3 ||
    data.geometry.vertexCount !== vertices ||
    data.geometry.triangleCount !== triangles ||
    data.source.utf8Bytes > policy.maximumBytes ||
    data.positions.some((number) => Math.abs(number) > policy.maximumAbsoluteCoordinate) ||
    data.triangleIndices.some((index) => index >= vertices)
  )
    throw new AssetError(
      "invalid_geometry",
      "Mesh review buffer layout, counts or indices are invalid",
    );
  for (let offset = 0; offset < data.triangleIndices.length; offset += 3) {
    const expected = triangleNormal(data.positions, data.triangleIndices, offset);
    if (expected.some((number, axis) => number !== data.triangleNormals[offset + axis]))
      throw new AssetError("invalid_geometry", "Review face normal does not match source winding");
  }
  const seenRegions = new Set<string>();
  for (const region of data.regions) {
    const key = `${region.kind}:${region.name}`;
    if (
      seenRegions.has(key) ||
      region.triangleIds.some(
        (id, index) => id >= triangles || (index > 0 && id <= region.triangleIds[index - 1]!),
      )
    )
      throw new AssetError(
        "invalid_geometry",
        "Review regions must be unique with ordered triangle membership",
      );
    seenRegions.add(key);
    const measured = data.geometry.regions.find(
      (entry) => entry.kind === region.kind && entry.name === region.name,
    );
    if (!measured || measured.triangleCount !== region.triangleIds.length)
      throw new AssetError(
        "invalid_geometry",
        "Review region count differs from the inspection summary",
      );
  }
  if (data.regions.length !== data.geometry.regions.length)
    throw new AssetError("invalid_geometry", "Review omitted an inspection region");
  const spec = validateAssetSpec({
    id: data.assetId,
    description: "Retained geometry review",
    bounds: data.envelope.size,
    clearance: data.envelope.clearance,
    collision: "none",
    namedParts: [],
    sockets: data.sockets.map(({ id, position }) => ({ id, position })),
    universeId: 0,
  });
  if (
    new Set(data.sockets.map((socket) => socket.id)).size !== data.sockets.length ||
    stableJson(fitAssetGeometry(data.geometry, spec)) !== stableJson(data.fit)
  )
    throw new AssetError(
      "invalid_geometry",
      "Review fit or sockets differ from the declared envelope",
    );
  const sourceTriangles = Array.from({ length: triangles }, (_, id): [number, number, number] => [
    data.triangleIndices[id * 3]!,
    data.triangleIndices[id * 3 + 1]!,
    data.triangleIndices[id * 3 + 2]!,
  ]);
  const expectedPartition = partitionMeshForNativeReview({
    sourceHash: data.source.sha256,
    triangles: sourceTriangles,
    regions: data.regions,
    maximumPartitions: policy.maximumNativePartitions,
  });
  const sourceVertices = Array.from({ length: vertices }, (_, index) => ({
    x: data.positions[index * 3]!,
    y: data.positions[index * 3 + 1]!,
    z: data.positions[index * 3 + 2]!,
  }));
  if (
    stableJson(
      summarizeObjMesh({
        vertices: sourceVertices,
        triangles: sourceTriangles,
        regions: data.regions,
      }),
    ) !== stableJson(data.geometry)
  )
    throw new AssetError(
      "invalid_geometry",
      "Review geometry summary must match its exact buffers and memberships",
    );
  if (stableJson(expectedPartition) !== stableJson(data.nativeImport.partition))
    throw new AssetError(
      "invalid_geometry",
      "Native partition must preserve every exact source triangle once in its common frame",
    );
}
