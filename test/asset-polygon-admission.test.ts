import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  AssetRegistry,
  fitAssetGeometry,
  inspectObj,
  validateAssetSpec,
} from "../packages/asset-registry/src/index.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const spec = validateAssetSpec({
  id: "multipart",
  description: "Offline common-frame geometry admission fixture",
  bounds: { x: 12, y: 10, z: 8 },
  clearance: 1,
  collision: "none",
  namedParts: ["Body"],
  sockets: [],
  universeId: 0,
});
const provenance = {
  kind: "recorded_obj",
  source: "Offline regression fixture",
  license: "Repository test fixture",
  codeHash: "a".repeat(64),
  configurationHash: "b".repeat(64),
  checkpointHashes: [],
};
const polygon = (points: readonly (readonly number[])[], indices?: readonly number[]) =>
  Buffer.from(
    points.map((point) => `v ${point.join(" ")}`).join("\n") +
      `\no Body\nf ${(indices ?? points.map((_, index) => index + 1)).join(" ")}\n`,
  );

test("OBJ source artifacts preserve BOM, CRLF and Unicode bytes under exact lock replay", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-obj-source-roundtrip-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(
    "\ufeff# geometry • מקור\r\no Body\r\nv 0 0 0\r\nv 2 0 0\r\nv 0 2 0\r\nf 1 2 3\r\n",
  );
  const store = new ImmutableJsonArtifactStore(directory);
  const lock = await new AssetRegistry(store).ingestRecordedObj({
    bytes,
    expectedSourceHash: hash(bytes),
    spec,
    provenance,
  });
  const reopened = new ImmutableJsonArtifactStore(directory);
  const source = await reopened.read<{ sourceHash: string; utf8Bytes: number; obj: string }>(
    lock.sourceArtifact,
  );
  const replayedBytes = Buffer.from(source.obj, "utf8");
  assert.deepEqual(replayedBytes, bytes);
  assert.equal(source.utf8Bytes, replayedBytes.length);
  assert.equal(source.sourceHash, hash(replayedBytes));
  assert.equal(lock.sourceHash, hash(replayedBytes));
  const geometry = inspectObj(replayedBytes);
  assert.deepEqual(geometry, lock.geometry);
  assert.deepEqual(fitAssetGeometry(geometry, spec), lock.fit);
});

test("escaped OBJ source obeys the caller's artifact capacity before any durable writes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-obj-artifact-budget-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(`# ${"\0".repeat(500)}\no Body\nv 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n`);
  const store = new ImmutableJsonArtifactStore(join(directory, "bounded"), { maxBytes: 1024 });
  let writes = 0;
  const write = store.write.bind(store);
  store.write = async (value) => {
    writes++;
    return write(value);
  };
  assert.ok(bytes.length < store.maxBytes);
  await assert.rejects(
    () =>
      new AssetRegistry(store).ingestRecordedObj({
        bytes,
        expectedSourceHash: hash(bytes),
        spec,
        provenance,
      }),
    { code: "resource_limit", message: /serialized JSON have separate byte limits/ },
  );
  assert.equal(writes, 0);
  const roomy = new ImmutableJsonArtifactStore(join(directory, "roomy"), { maxBytes: 8192 });
  const lock = await new AssetRegistry(roomy).ingestRecordedObj({
    bytes,
    expectedSourceHash: hash(bytes),
    spec,
    provenance: { ...provenance, kind: "cube_remote" },
  });
  assert.equal(lock.provenance.kind, "cube_remote");
  assert.equal(lock.readiness, "locally_inspected");
  assert.equal(lock.permissions.status, "unverified");
});

for (const [name, points] of [
  [
    "concave",
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [1, 0.5, 0],
      [0, 2, 0],
    ],
  ],
  [
    "crossed",
    [
      [0, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
      [2, 0, 0],
    ],
  ],
  [
    "nonplanar",
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 1],
      [0, 2, 0],
    ],
  ],
  [
    "star-shaped",
    [
      [0, 3, 0],
      [-2, -3, 0],
      [3, 1, 0],
      [-3, 1, 0],
      [2, -3, 0],
    ],
  ],
] as const) {
  test(`OBJ admission rejects ${name} polygons instead of inventing a fan surface`, () => {
    assert.throws(() => inspectObj(polygon(points)), {
      code: "unsupported_polygon",
      message: /triangulate/i,
    });
  });
}

test("convex polygons retain winding and exact region topology in arbitrary common frames", () => {
  for (const points of [
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ],
    [
      [0, 0, 0],
      [0, 2, 0],
      [0, 2, 2],
      [0, 0, 2],
    ],
    [
      [100, -80, 20],
      [102, -80, 22],
      [102, -78, 24],
      [100, -78, 22],
    ],
  ]) {
    for (const indices of [
      [1, 2, 3, 4],
      [-1, -2, -3, -4],
    ]) {
      const geometry = inspectObj(polygon(points, indices));
      assert.equal(geometry.triangleCount, 2);
      assert.equal(geometry.topology.boundaryEdgeCount, 4);
      assert.equal(geometry.topology.inconsistentWindingEdgeCount, 0);
      assert.equal(geometry.regions[0]!.referencedVertexCount, 4);
      assert.deepEqual(geometry.regions[0]!.bounds, geometry.bounds);
      assert.doesNotThrow(() => fitAssetGeometry(geometry, spec));
    }
  }
});

test("explicit triangles remain admissible for concave and nonplanar multipart surfaces", () => {
  const bytes = Buffer.from(
    "v 0 0 0\nv 2 0 0\nv 2 2 0\nv 1 .5 0\nv 0 2 0\nv 0 0 1\n" +
      "o Body\nf 1 2 4\nf 2 3 4\nf 1 4 5\no Detail\nf 1 2 6\n",
  );
  const geometry = inspectObj(bytes);
  assert.equal(geometry.triangleCount, 4);
  assert.deepEqual(
    geometry.regions.map((region) => [region.name, region.triangleCount]),
    [
      ["Body", 3],
      ["Detail", 1],
    ],
  );
  assert.doesNotThrow(() => fitAssetGeometry(geometry, spec));
});
