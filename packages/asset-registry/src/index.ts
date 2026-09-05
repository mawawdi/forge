import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ImmutableJsonArtifactStore,
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
  groups: string[];
}
export interface AssetFit {
  scale: number;
  translation: AssetVector;
  bounds: { min: AssetVector; max: AssetVector };
  clearance: number;
}
export interface AssetProvenance {
  kind: "recorded_obj" | "cube_local";
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
    kind: z.enum(["recorded_obj", "cube_local"]),
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
  validateInspectionPolicy(policy);
  if (bytes.byteLength < 1 || bytes.byteLength > policy.maximumBytes)
    throw new AssetError("resource_limit", "OBJ bytes exceed inspection policy");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const vertices: AssetVector[] = [];
  const triangles: number[][] = [];
  const groups = new Set<string>();
  let normals = 0;
  let textures = 0;
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
      for (let index = 1; index + 1 < face.length; index++) {
        triangles.push([face[0]!, face[index]!, face[index + 1]!]);
        if (triangles.length > policy.maximumTriangles)
          throw new AssetError("resource_limit", "OBJ triangle budget exceeded");
      }
    } else if (tag === "g" || tag === "o") {
      if (parts.length !== 1 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parts[0]!))
        throw new AssetError(
          "invalid_geometry",
          "OBJ object/group names must be bounded identifiers",
        );
      groups.add(parts[0]!);
      if (groups.size > 256) throw new AssetError("resource_limit", "OBJ group budget exceeded");
    } else if (tag === "s") {
      if (parts.length !== 1 || !/^(off|0|[1-9]\d*)$/.test(parts[0]!))
        throw new AssetError("invalid_geometry", "Malformed OBJ smoothing declaration");
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
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const vertex of vertices)
    for (const axis of AXES) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  return {
    vertexCount: vertices.length,
    triangleCount: triangles.length,
    bounds: { min, max },
    groups: [...groups].sort(),
  };
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
    if (!geometry.groups.includes(part))
      throw new AssetError("missing_part", `Requested OBJ group is absent: ${part}`);
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
    const sourceArtifact = await this.store.write({
      kind: "RecordedObjBytes",
      sourceHash,
      utf8Bytes: input.bytes.byteLength,
      obj: new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    });
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
        "Named OBJ groups are labels, not proof of separate engine parts. Socket coordinates are declarations within the requested envelope.",
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

export interface CubeJobIntent {
  kind: "CubeJobIntent";
  jobId: string;
  spec: AssetSpec;
  codeHash: string;
  configurationHash: string;
  checkpointHashes: string[];
  hash: string;
}
export function createCubeJobIntent(input: {
  spec: unknown;
  codeHash: string;
  configurationHash: string;
  checkpointHashes: string[];
}): CubeJobIntent {
  const spec = validateAssetSpec(input.spec);
  hashSchema.parse(input.codeHash);
  hashSchema.parse(input.configurationHash);
  if (input.checkpointHashes.length !== 2)
    throw new AssetError("invalid_pin", "Cube needs exact GPT and shape checkpoint hashes");
  input.checkpointHashes.forEach((hash) => hashSchema.parse(hash));
  const value = {
    kind: "CubeJobIntent" as const,
    jobId: randomUUID(),
    spec,
    codeHash: input.codeHash,
    configurationHash: input.configurationHash,
    checkpointHashes: [...input.checkpointHashes],
  };
  return { ...value, hash: contentHash(stableJson(value)) };
}
export function assertCubeJobIntent(intent: CubeJobIntent): void {
  assertBoundedGameJson(intent as unknown, DEFAULT_GAME_ADMISSION_POLICY);
  if (intent.kind !== "CubeJobIntent" || !/^[a-f0-9-]{36}$/.test(intent.jobId))
    throw new AssetError("invalid_job", "Malformed Cube job identity");
  const { hash, ...value } = intent;
  if (contentHash(stableJson(value)) !== hash)
    throw new AssetError("hash_mismatch", "Cube intent hash mismatch");
  validateAssetSpec(intent.spec);
  hashSchema.parse(intent.codeHash);
  hashSchema.parse(intent.configurationHash);
  if (intent.checkpointHashes.length !== 2)
    throw new AssetError("invalid_pin", "Cube checkpoint inventory mismatch");
  intent.checkpointHashes.forEach((pin) => hashSchema.parse(pin));
}

export function connectedAssetProviderStatus(provider: "generation_service" | "open_cloud"): {
  status: "unavailable";
  provider: string;
  reason: string;
  recovery: string;
} {
  return {
    status: "unavailable",
    provider,
    reason: "No credential/native-context admission is configured for this adapter.",
    recovery:
      "Obtain an exact provider operation ID after an ambiguous submission and reconcile it before retrying; no external request has been made by this adapter.",
  };
}
export function externalAssetJobRecovery(input: {
  submittedIntentHash: string;
  providerOperationId?: string;
  receiptState: "absent" | "pending" | "unknown";
}): { status: "recovery_required"; mayResubmit: false; action: string } {
  hashSchema.parse(input.submittedIntentHash);
  return {
    status: "recovery_required",
    mayResubmit: false,
    action: input.providerOperationId
      ? "Query the existing provider operation and reconcile its exact output hashes."
      : "Recover the provider operation identity or establish non-submission before creating another job.",
  };
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
