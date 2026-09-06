import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ImmutableJsonArtifactStore,
  serializeCanonicalJson,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";

export interface AssetInspectionPolicy {
  maximumBytes: number;
  maximumVertices: number;
  maximumTriangles: number;
  maximumAbsoluteCoordinate: number;
}
export const DEFAULT_ASSET_INSPECTION_POLICY: Readonly<AssetInspectionPolicy> = Object.freeze({
  maximumBytes: 16 * 1024 * 1024,
  maximumVertices: 250000,
  maximumTriangles: 500000,
  maximumAbsoluteCoordinate: 1000000,
});
const vectorSchema = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
const assetSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    description: z.string().min(1).max(4096),
    bounds: vectorSchema,
    clearance: z.number().finite().nonnegative(),
    collision: z.enum(["none", "box", "mesh"]),
    namedParts: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(64),
    sockets: z
      .array(
        z
          .object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), position: vectorSchema })
          .strict(),
      )
      .max(64),
    universeId: z.number().int().nonnegative().safe(),
  })
  .strict();
export type AssetSpec = z.infer<typeof assetSpecSchema>;
export type AssetVector = z.infer<typeof vectorSchema>;
export interface AssetPin {
  assetId: string;
  lockHash: string;
}
export interface AssetGeometry {
  vertexCount: number;
  triangleCount: number;
  bounds: { min: AssetVector; max: AssetVector };
  regions: AssetGeometryRegion[];
  topology: AssetTopology;
  warnings: AssetGeometryWarning[];
}
export interface AssetGeometryRegion {
  kind: "object" | "group";
  name: string;
  triangleCount: number;
  referencedVertexCount: number;
  bounds: { min: AssetVector; max: AssetVector } | null;
}
/** Validated source-frame data. The summary alone is retained in AssetLock. */
export interface ParsedObjMesh {
  vertices: AssetVector[];
  triangles: Array<[number, number, number]>;
  regions: Array<{ kind: AssetGeometryRegion["kind"]; name: string; triangleIds: number[] }>;
  appearance: {
    normalCount: number;
    textureCoordinateCount: number;
    smoothingDeclarationCount: number;
  };
  geometry: AssetGeometry;
}
export interface AssetTopology {
  basis: "obj_vertex_indices";
  referencedVertexCount: number;
  unreferencedVertexCount: number;
  edgeCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  inconsistentWindingEdgeCount: number;
  edgeConnectedComponentCount: number;
  duplicateTriangleCount: number;
  unlabelledTriangleCount: number;
}
export interface AssetGeometryWarning {
  code:
    | "boundary_edges"
    | "disconnected_surfaces"
    | "duplicate_triangles"
    | "empty_regions"
    | "inconsistent_winding"
    | "non_manifold_edges"
    | "unreferenced_vertices";
  detail: string;
}
export interface AssetFit {
  scale: number;
  translation: AssetVector;
  bounds: { min: AssetVector; max: AssetVector };
  clearance: number;
}
export interface AssetProvenance {
  kind: "recorded_obj" | "cube_local" | "cube_remote";
  source: string;
  license: string;
  codeHash: string;
  configurationHash: string;
  checkpointHashes: string[];
}
export interface AssetLock {
  kind: "AssetLock";
  assetId: string;
  hash: string;
  spec: AssetSpec;
  sourceHash: string;
  sourceUtf8Bytes: number;
  sourceArtifact: ArtifactReference;
  geometry: AssetGeometry;
  fit: AssetFit;
  dependencies: AssetPin[];
  provenance: AssetProvenance;
  permissions: { status: "unverified"; universeId: number };
  readiness: "locally_inspected";
  limitations: string[];
}
export class AssetError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z
  .object({
    kind: z.enum(["recorded_obj", "cube_local", "cube_remote"]),
    source: z.string().min(1).max(2048),
    license: z.string().min(1).max(2048),
    codeHash: hashSchema,
    configurationHash: hashSchema,
    checkpointHashes: z.array(hashSchema).max(16),
  })
  .strict();
const AXES = ["x", "y", "z"] as const;

export function validateAssetSpec(input: unknown): AssetSpec {
  assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
  const spec = assetSpecSchema.parse(input);
  if (AXES.some((axis) => spec.bounds[axis] <= spec.clearance * 2 || spec.bounds[axis] > 2048))
    throw new AssetError(
      "unsatisfiable_bounds",
      "Requested bounds must leave positive clearance and fit the admitted 2048-stud primitive bound",
    );
  if (
    new Set(spec.namedParts).size !== spec.namedParts.length ||
    new Set(spec.sockets.map((socket) => socket.id)).size !== spec.sockets.length
  )
    throw new AssetError("duplicate_id", "Part and socket names must be unique");
  for (const socket of spec.sockets)
    if (
      AXES.some((axis) => Math.abs(socket.position[axis]) > spec.bounds[axis] / 2 - spec.clearance)
    )
      throw new AssetError(
        "socket_bounds",
        "A requested socket exceeds the declared clearance envelope",
      );
  return {
    ...spec,
    namedParts: [...spec.namedParts].sort(),
    sockets: [...spec.sockets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Inspect plain OBJ geometry only. Material files, URLs and executable/model contents are not loaded. */
export function inspectObj(
  bytes: Uint8Array,
  policy: AssetInspectionPolicy = DEFAULT_ASSET_INSPECTION_POLICY,
): AssetGeometry {
  return parseObjMesh(bytes, policy).geometry;
}

/** One parser owns admission, triangulation, memberships and summary measurements. */
export function parseObjMesh(
  bytes: Uint8Array,
  policy: AssetInspectionPolicy = DEFAULT_ASSET_INSPECTION_POLICY,
): ParsedObjMesh {
  validateInspectionPolicy(policy);
  if (bytes.byteLength < 1 || bytes.byteLength > policy.maximumBytes)
    throw new AssetError("resource_limit", "OBJ bytes exceed inspection policy");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const vertices: AssetVector[] = [];
  const triangles: Array<[number, number, number]> = [];
  const regions = new Map<
    string,
    {
      kind: AssetGeometryRegion["kind"];
      name: string;
      triangleIds: number[];
    }
  >();
  let activeObject: string | undefined;
  let activeGroup: string | undefined;
  let normals = 0;
  let textures = 0;
  let smoothingDeclarations = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0]!.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const tag = parts.shift()!;
    if (tag === "v" || tag === "vn" || tag === "vt") {
      if (
        (tag === "vt" ? parts.length < 2 || parts.length > 3 : parts.length !== 3) ||
        parts.some(
          (part) =>
            !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(part) ||
            !Number.isFinite(Number(part)),
        )
      )
        throw new AssetError("invalid_geometry", "Malformed numeric OBJ record");
      const values = parts.map(Number);
      if (values.some((value) => Math.abs(value) > policy.maximumAbsoluteCoordinate))
        throw new AssetError("geometry_bounds", "OBJ coordinate exceeds inspection policy");
      if (tag === "v") {
        vertices.push({ x: values[0]!, y: values[1]!, z: values[2]! });
        if (vertices.length > policy.maximumVertices)
          throw new AssetError("resource_limit", "OBJ vertex budget exceeded");
      } else if (tag === "vn") normals += 1;
      else textures += 1;
    } else if (tag === "f") {
      if (parts.length < 3 || parts.length > 64)
        throw new AssetError("invalid_geometry", "OBJ faces require 3–64 vertices");
      const face = parts.map((part) => {
        const fields = part.split("/");
        if (fields.length > 3 || !fields[0])
          throw new AssetError("invalid_geometry", "Malformed OBJ face reference");
        const counts = [vertices.length, textures, normals];
        return fields.map((value, index) => {
          if (value === "" && index > 0) return undefined;
          if (!/^-?\d+$/.test(value))
            throw new AssetError("invalid_geometry", "OBJ indices must be integers");
          const number = Number(value);
          const count = counts[index]!;
          const resolved = number > 0 ? number - 1 : count + number;
          if (!Number.isSafeInteger(number) || number === 0 || resolved < 0 || resolved >= count)
            throw new AssetError("invalid_geometry", "OBJ index references an absent element");
          return resolved;
        })[0]!;
      });
      if (face.length > 3) assertConvexPlanarPolygon(face.map((index) => vertices[index]!));
      for (let index = 1; index + 1 < face.length; index++) {
        const triangle: [number, number, number] = [face[0]!, face[index]!, face[index + 1]!];
        triangles.push(triangle);
        if (triangles.length > policy.maximumTriangles)
          throw new AssetError("resource_limit", "OBJ triangle budget exceeded");
        // OBJ object and group declarations are independent, persistent memberships.
        // Vertices alone do not give either region geometry; only subsequent faces do.
        for (const key of [activeObject, activeGroup]) {
          if (key === undefined) continue;
          const region = regions.get(key)!;
          region.triangleIds.push(triangles.length - 1);
        }
      }
    } else if (tag === "g" || tag === "o") {
      if (parts.length !== 1 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parts[0]!))
        throw new AssetError(
          "invalid_geometry",
          "OBJ object/group names must be bounded identifiers",
        );
      const kind = tag === "o" ? "object" : "group";
      const name = parts[0]!;
      const key = `${kind}:${name}`;
      if (!regions.has(key)) regions.set(key, { kind, name, triangleIds: [] });
      if (regions.size > 256)
        throw new AssetError("resource_limit", "OBJ object/group region budget exceeded");
      if (kind === "object") activeObject = key;
      else activeGroup = key;
    } else if (tag === "s") {
      if (parts.length !== 1 || !/^(off|0|[1-9]\d*)$/.test(parts[0]!))
        throw new AssetError("invalid_geometry", "Malformed OBJ smoothing declaration");
      smoothingDeclarations++;
    } else
      throw new AssetError(
        "unsupported_obj_record",
        `OBJ record ${tag} requires a separately admitted ingestion stage`,
      );
  }
  if (vertices.length < 3 || triangles.length < 1)
    throw new AssetError("invalid_geometry", "OBJ must contain vertices and faces");
  for (const face of triangles) {
    const [a, b, c] = face.map((index) => vertices[index]!);
    const u = { x: b!.x - a!.x, y: b!.y - a!.y, z: b!.z - a!.z };
    const v = { x: c!.x - a!.x, y: c!.y - a!.y, z: c!.z - a!.z };
    if (Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x) <= 1e-12)
      throw new AssetError("degenerate_geometry", "OBJ contains a degenerate triangle");
  }
  const memberships = [...regions.values()].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    vertices,
    triangles,
    regions: memberships,
    appearance: {
      normalCount: normals,
      textureCoordinateCount: textures,
      smoothingDeclarationCount: smoothingDeclarations,
    },
    geometry: summarizeObjMesh({ vertices, triangles, regions: memberships }),
  };
}

/** One summary implementation for validated ingestion and retained review buffers. */
export function summarizeObjMesh(
  mesh: Pick<ParsedObjMesh, "vertices" | "triangles" | "regions">,
): AssetGeometry {
  const labelled = new Uint8Array(mesh.triangles.length);
  const measuredRegions = mesh.regions
    .map((region): AssetGeometryRegion => {
      const vertices = new Set<number>();
      for (const triangleId of region.triangleIds) {
        labelled[triangleId] = 1;
        for (const vertex of mesh.triangles[triangleId]!) vertices.add(vertex);
      }
      return {
        kind: region.kind,
        name: region.name,
        triangleCount: region.triangleIds.length,
        referencedVertexCount: vertices.size,
        bounds: vertices.size ? measureBounds([...vertices].map((id) => mesh.vertices[id]!)) : null,
      };
    })
    .sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  let unlabelledTriangleCount = 0;
  for (const value of labelled) if (!value) unlabelledTriangleCount++;
  const topology = measureTopology(mesh.vertices.length, mesh.triangles, unlabelledTriangleCount);
  return {
    vertexCount: mesh.vertices.length,
    triangleCount: mesh.triangles.length,
    bounds: measureBounds(mesh.vertices),
    regions: measuredRegions,
    topology,
    warnings: geometryWarnings(topology, measuredRegions),
  };
}

/** A fan is unambiguous only for a convex planar polygon with its boundary in order. */
function assertConvexPlanarPolygon(points: readonly AssetVector[]): void {
  const reject = () => {
    throw new AssetError(
      "unsupported_polygon",
      "OBJ polygons must be convex and planar with a simple ordered boundary; triangulate this face explicitly before ingestion",
    );
  };
  const bounds = measureBounds(points);
  const extent = Math.max(...AXES.map((axis) => bounds.max[axis] - bounds.min[axis]));
  if (!Number.isFinite(extent) || extent <= 0) reject();
  // Normalize before geometric predicates: translation and source units must
  // not determine whether an otherwise identical polygon is admitted.
  const origin = points[0]!;
  const local = points.map((point) => ({
    x: (point.x - origin.x) / extent,
    y: (point.y - origin.y) / extent,
    z: (point.z - origin.z) / extent,
  }));
  const normal = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < local.length; index++) {
    const a = local[index]!;
    const b = local[(index + 1) % local.length]!;
    normal.x += a.y * b.z - a.z * b.y;
    normal.y += a.z * b.x - a.x * b.z;
    normal.z += a.x * b.y - a.y * b.x;
  }
  const magnitude = Math.hypot(normal.x, normal.y, normal.z);
  const tolerance = Number.EPSILON * 128;
  if (magnitude <= tolerance) reject();
  for (const axis of AXES) normal[axis] /= magnitude;
  if (
    local.some(
      (point) => Math.abs(point.x * normal.x + point.y * normal.y + point.z * normal.z) > 1e-9,
    )
  )
    reject();
  // Every nonincident vertex must lie strictly on the interior side of each
  // oriented edge. Unlike adjacent-turn tests, this also rejects star polygons.
  // Faces have at most 64 vertices, bounding these pairwise predicates.
  for (let index = 0; index < local.length; index++) {
    const next = (index + 1) % local.length;
    const a = local[index]!;
    const b = local[next]!;
    const edge = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    for (let other = 0; other < local.length; other++) {
      if (other === index || other === next) continue;
      const point = local[other]!;
      const delta = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z };
      const side =
        (edge.y * delta.z - edge.z * delta.y) * normal.x +
        (edge.z * delta.x - edge.x * delta.z) * normal.y +
        (edge.x * delta.y - edge.y * delta.x) * normal.z;
      if (side <= tolerance) reject();
    }
  }
}

function measureBounds(vertices: Iterable<AssetVector>): { min: AssetVector; max: AssetVector } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const vertex of vertices)
    for (const axis of AXES) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  return { min, max };
}

/** Index connectivity is reproducible evidence, not a geometric watertightness or visual-quality test. */
function measureTopology(
  vertexCount: number,
  triangles: readonly number[][],
  unlabelledTriangleCount: number,
): AssetTopology {
  const referenced = new Set<number>();
  const faces = new Set<string>();
  const edges = new Map<string, { count: number; direction: number; triangle: number }>();
  const parents = Int32Array.from({ length: triangles.length }, (_, index) => index);
  const ranks = new Uint8Array(triangles.length);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  let components = triangles.length;
  let duplicates = 0;
  for (const [index, face] of triangles.entries()) {
    const faceKey = [...face].sort((a, b) => a - b).join(":");
    if (faces.has(faceKey)) duplicates++;
    faces.add(faceKey);
    for (let corner = 0; corner < 3; corner++) {
      const a = face[corner]!;
      const b = face[(corner + 1) % 3]!;
      referenced.add(a);
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const direction = a < b ? 1 : -1;
      const edge = edges.get(key);
      if (!edge) edges.set(key, { count: 1, direction, triangle: index });
      else {
        edge.count++;
        edge.direction += direction;
        let first = find(index);
        let second = find(edge.triangle);
        if (first !== second) {
          if (ranks[first]! < ranks[second]!) [first, second] = [second, first];
          parents[second] = first;
          if (ranks[first] === ranks[second]) ranks[first] = ranks[first]! + 1;
          components--;
        }
      }
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let inconsistentWinding = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) boundary++;
    if (edge.count > 2) nonManifold++;
    if (edge.count === 2 && edge.direction !== 0) inconsistentWinding++;
  }
  return {
    basis: "obj_vertex_indices",
    referencedVertexCount: referenced.size,
    unreferencedVertexCount: vertexCount - referenced.size,
    edgeCount: edges.size,
    boundaryEdgeCount: boundary,
    nonManifoldEdgeCount: nonManifold,
    inconsistentWindingEdgeCount: inconsistentWinding,
    edgeConnectedComponentCount: components,
    duplicateTriangleCount: duplicates,
    unlabelledTriangleCount,
  };
}

function geometryWarnings(
  topology: AssetTopology,
  regions: readonly AssetGeometryRegion[],
): AssetGeometryWarning[] {
  const warnings: AssetGeometryWarning[] = [];
  if (topology.boundaryEdgeCount)
    warnings.push({
      code: "boundary_edges",
      detail: `${topology.boundaryEdgeCount} index edges have one incident triangle; inspect open surfaces or split vertex seams.`,
    });
  if (topology.edgeConnectedComponentCount > 1)
    warnings.push({
      code: "disconnected_surfaces",
      detail: `${topology.edgeConnectedComponentCount} triangle components share no index edges; inspect intentional separate pieces, fragmentation or split seams.`,
    });
  if (topology.duplicateTriangleCount)
    warnings.push({
      code: "duplicate_triangles",
      detail: `${topology.duplicateTriangleCount} triangles repeat an existing set of vertex indices, ignoring winding.`,
    });
  const emptyRegions = regions.filter((region) => region.triangleCount === 0).length;
  if (emptyRegions)
    warnings.push({
      code: "empty_regions",
      detail: `${emptyRegions} object/group labels contain no faces and cannot satisfy a requested part.`,
    });
  if (topology.inconsistentWindingEdgeCount)
    warnings.push({
      code: "inconsistent_winding",
      detail: `${topology.inconsistentWindingEdgeCount} edges with two incident triangles have matching edge direction; inspect face orientation.`,
    });
  if (topology.nonManifoldEdgeCount)
    warnings.push({
      code: "non_manifold_edges",
      detail: `${topology.nonManifoldEdgeCount} index edges have more than two incident triangles; inspect overlapping or non-manifold surfaces.`,
    });
  if (topology.unreferencedVertexCount)
    warnings.push({
      code: "unreferenced_vertices",
      detail: `${topology.unreferencedVertexCount} vertices have no faces but remain included in the conservative fit bounds.`,
    });
  return warnings;
}

export function fitAssetGeometry(geometry: AssetGeometry, spec: AssetSpec): AssetFit {
  const ratios = AXES.filter((axis) => geometry.bounds.max[axis] > geometry.bounds.min[axis]).map(
    (axis) =>
      (spec.bounds[axis] - 2 * spec.clearance) /
      (geometry.bounds.max[axis] - geometry.bounds.min[axis]),
  );
  const scale = Math.min(...ratios);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new AssetError("unsatisfiable_bounds", "Cannot fit degenerate geometry");
  const translation = { x: 0, y: 0, z: 0 };
  const min = { x: 0, y: 0, z: 0 };
  const max = { x: 0, y: 0, z: 0 };
  for (const axis of AXES) {
    translation[axis] = (-(geometry.bounds.min[axis] + geometry.bounds.max[axis]) * scale) / 2;
    min[axis] = geometry.bounds.min[axis] * scale + translation[axis];
    max[axis] = geometry.bounds.max[axis] * scale + translation[axis];
    if (
      Math.max(Math.abs(min[axis]), Math.abs(max[axis])) >
      spec.bounds[axis] / 2 - spec.clearance + 1e-9
    )
      throw new AssetError("unsatisfiable_bounds", "Fitted geometry violates clearance");
  }
  for (const part of spec.namedParts)
    if (!geometry.regions.some((region) => region.name === part && region.triangleCount > 0))
      throw new AssetError("missing_part", `Requested OBJ object/group has no faces: ${part}`);
  return { scale, translation, bounds: { min, max }, clearance: spec.clearance };
}

/** Stores inspected local bytes. This never asserts Roblox ownership, moderation or loading permission. */
export class AssetRegistry {
  private readonly locks = new Map<string, AssetLock>();
  constructor(
    readonly store: ImmutableJsonArtifactStore,
    readonly policy: AssetInspectionPolicy = DEFAULT_ASSET_INSPECTION_POLICY,
  ) {
    validateInspectionPolicy(policy);
  }
  async ingestRecordedObj(input: {
    bytes: Uint8Array;
    expectedSourceHash: string;
    spec: unknown;
    provenance: unknown;
    dependencies?: readonly AssetPin[];
  }): Promise<AssetLock> {
    const spec = validateAssetSpec(input.spec);
    assertBoundedGameJson(input.provenance, DEFAULT_GAME_ADMISSION_POLICY);
    const provenance = provenanceSchema.parse(input.provenance);
    hashSchema.parse(input.expectedSourceHash);
    const sourceHash = createHash("sha256").update(input.bytes).digest("hex");
    if (sourceHash !== input.expectedSourceHash)
      throw new AssetError(
        "hash_mismatch",
        "Recorded OBJ bytes do not match their declared content hash",
      );
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > this.policy.maximumBytes)
      throw new AssetError("resource_limit", "OBJ bytes exceed inspection policy");
    const sourceRecord = {
      kind: "RecordedObjBytes",
      sourceHash,
      utf8Bytes: input.bytes.byteLength,
      // Keep a leading UTF-8 BOM so re-encoding reproduces the exact pinned bytes.
      obj: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes),
    };
    const sourceArtifactBytes = Buffer.byteLength(serializeCanonicalJson(sourceRecord), "utf8");
    if (sourceArtifactBytes > this.store.maxBytes)
      throw new AssetError(
        "resource_limit",
        `OBJ source artifact exceeds the configured artifact store byte limit (${sourceArtifactBytes} > ${this.store.maxBytes}); raw source and serialized JSON have separate byte limits`,
      );
    const geometry = inspectObj(input.bytes, this.policy);
    const fit = fitAssetGeometry(geometry, spec);
    const dependencies = [...(input.dependencies ?? [])];
    assertBoundedGameJson(dependencies, DEFAULT_GAME_ADMISSION_POLICY);
    const seen = new Set<string>();
    for (const pin of dependencies) {
      if (
        !pin ||
        Object.keys(pin).sort().join(",") !== "assetId,lockHash" ||
        seen.has(pin.assetId) ||
        pin.assetId === spec.id
      )
        throw new AssetError(
          "invalid_dependency",
          "Asset dependencies require distinct exact pins and cannot self-reference",
        );
      const dependency = this.locks.get(pin.assetId);
      if (!dependency || dependency.hash !== pin.lockHash)
        throw new AssetError(
          "invalid_dependency",
          "Asset dependency has not been inspected under its exact lock",
        );
      if (dependency.spec.universeId !== spec.universeId)
        throw new AssetError(
          "universe_mismatch",
          "Asset dependencies must target the same universe",
        );
      seen.add(pin.assetId);
    }
    dependencies.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    const sourceArtifact = await this.store.write(sourceRecord);
    const value = {
      kind: "AssetLock" as const,
      assetId: spec.id,
      spec,
      sourceHash,
      sourceUtf8Bytes: input.bytes.byteLength,
      sourceArtifact,
      geometry,
      fit,
      dependencies,
      provenance,
      permissions: { status: "unverified" as const, universeId: spec.universeId },
      readiness: "locally_inspected" as const,
      limitations: [
        "Recorded geometry and a requested fit transform are inspected locally; the original bytes are preserved unchanged.",
        "The fit transform must be applied and rechecked by a separately admitted importer. Roblox upload, ownership, moderation, asset permission, rendering, collision and persistence are unverified.",
        "OBJ object/group membership and bounds are measured from faces; labels are not proof of separate engine parts. Socket coordinates are declarations within the requested envelope.",
        "Topology counts use OBJ vertex indices without welding. Warnings are inspection facts, not a visual-quality score or proof of watertightness; self-intersections, coincident shells, appearance, texture quality and semantic part meaning are unchecked.",
      ],
    };
    const lock: AssetLock = { ...value, hash: contentHash(stableJson(value)) };
    const existing = this.locks.get(spec.id);
    if (existing && existing.hash !== lock.hash)
      throw new AssetError(
        "asset_conflict",
        "Asset identity already has a different immutable lock",
      );
    await this.store.write(lock);
    this.locks.set(spec.id, structuredClone(lock));
    return lock;
  }
  get(pin: AssetPin): AssetLock {
    const lock = this.locks.get(pin.assetId);
    if (!lock || lock.hash !== pin.lockHash)
      throw new AssetError("invalid_dependency", "Unknown exact asset lock");
    return structuredClone(lock);
  }
}

const cubeGenerationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("cube3d"),
      seed: z.number().int().min(0).max(2147483647),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cubepart"),
      seed: z.number().int().min(0).max(2147483647),
      input: z
        .object({
          sourceArtifact: z
            .object({
              locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/),
              artifactHash: hashSchema,
              bytes: z.number().int().safe().positive(),
            })
            .strict()
            .refine(
              (reference) => reference.locator === `artifacts/${reference.artifactHash}.json`,
              "CubePart input artifact locator must match its hash",
            ),
          sha256: hashSchema,
          bytes: z
            .number()
            .int()
            .positive()
            .max(16 * 1024 * 1024),
        })
        .strict(),
      parts: z
        .array(
          z
            .object({
              id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
              prompt: z.string().min(1).max(512),
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .refine(
          (parts) => new Set(parts.map((part) => part.id)).size === parts.length,
          "CubePart part identifiers must be unique",
        ),
    })
    .strict(),
]);
export type CubeGeneration = z.infer<typeof cubeGenerationSchema>;

/** Declared host-pinned inputs only; parsing does not retrieve or verify input bytes. */
export function parseCubeGeneration(input: unknown): CubeGeneration {
  assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
  return cubeGenerationSchema.parse(input);
}

export interface CubeJobIntent {
  kind: "CubeJobIntent";
  jobId: string;
  spec: AssetSpec;
  codeHash: string;
  configurationHash: string;
  checkpointHashes: string[];
  generation: CubeGeneration;
  hash: string;
}
export function createCubeJobIntent(input: {
  spec: unknown;
  codeHash: string;
  configurationHash: string;
  checkpointHashes: string[];
  generation?: CubeGeneration;
}): CubeJobIntent {
  const spec = validateAssetSpec(input.spec);
  hashSchema.parse(input.codeHash);
  hashSchema.parse(input.configurationHash);
  const checkpointHashes = z.array(hashSchema).min(1).max(16).parse(input.checkpointHashes);
  const value = {
    kind: "CubeJobIntent" as const,
    jobId: randomUUID(),
    spec,
    codeHash: input.codeHash,
    configurationHash: input.configurationHash,
    checkpointHashes,
    generation: parseCubeGeneration(
      input.generation === undefined ? { operation: "cube3d", seed: 0 } : input.generation,
    ),
  };
  return { ...value, hash: contentHash(stableJson(value)) };
}
const cubeJobIntentSchema = z
  .object({
    kind: z.literal("CubeJobIntent"),
    jobId: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    spec: assetSpecSchema,
    codeHash: hashSchema,
    configurationHash: hashSchema,
    checkpointHashes: z.array(hashSchema).min(1).max(16),
    generation: cubeGenerationSchema,
    hash: hashSchema,
  })
  .strict();

export function assertCubeJobIntent(intent: unknown): asserts intent is CubeJobIntent {
  assertBoundedGameJson(intent, DEFAULT_GAME_ADMISSION_POLICY);
  const parsed = cubeJobIntentSchema.parse(intent);
  const { hash, ...value } = parsed;
  if (contentHash(stableJson(value)) !== hash)
    throw new AssetError("hash_mismatch", "Cube intent hash mismatch");
  validateAssetSpec(parsed.spec);
}

function validateInspectionPolicy(policy: AssetInspectionPolicy): void {
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new AssetError("invalid_policy", "Inspection limits must be positive safe integers");
}
export async function ensureAssetDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new AssetError("unsafe_path", "Asset roots must be absolute");
  const absolute = resolve(path);
  const parent = resolve(absolute, "..");
  if (parent !== absolute) await ensureAssetDirectory(parent);
  try {
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AssetError("unsafe_path", "Asset directories cannot traverse symlinks");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(absolute);
  }
  return absolute;
}
export async function readPinnedAssetFile(
  root: string,
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "") ||
    path.includes("\0")
  )
    throw new AssetError("unsafe_path", "Asset locators must be regular relative paths");
  const base = resolve(root);
  const destination = resolve(base, path);
  if (relative(base, destination).startsWith(".." + sep) || destination === base)
    throw new AssetError("unsafe_path", "Asset locator escaped its root");
  const canonicalRoot = await realpath(base);
  if (canonicalRoot !== base)
    throw new AssetError("unsafe_path", "Asset roots cannot traverse symlinks");
  let current = base;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new AssetError("unsafe_path", "Asset locator traverses a symlink");
  }
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes)
      throw new AssetError("resource_limit", "Asset file exceeds its regular-file byte budget");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size)
      throw new AssetError("file_changed", "Asset file changed during bounded read");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export * from "./cube-worker.js";
export * from "./cube-remote.js";
export * from "./jobs.js";
export * from "./mesh-review.js";
export * from "./mesh-review-html.js";
export type {
  ReviewedAssetCompositionPin,
  ReviewedAssetCompositionBinding,
  ReviewedAssetCompositionResolution,
  ReviewedAssetCompositionCatalog,
} from "./composition.js";
