import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  AssetRegistry,
  inspectObj,
  parseObjMesh,
  type AssetLock,
} from "../packages/asset-registry/src/index.js";
import {
  assertMeshReviewData,
  createMeshReview,
  DEFAULT_MESH_REVIEW_POLICY,
  partitionMeshForNativeReview,
  type MeshReviewData,
} from "../packages/asset-registry/src/mesh-review.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const source =
  "v 10 20 30\nv 12 20 30\nv 12 22 30\nv 10 22 30\n" +
  "v 20 20 30\nv 22 20 30\nv 20 22 30\no Shell\ng Front\nf 1 2 3 4\n" +
  "o Insert\ng Front\nf 5 6 7\no Empty\n";
async function fixture(
  run: (lock: AssetLock, bytes: Buffer) => void | Promise<void>,
  text = source,
) {
  const root = await mkdtemp(join(tmpdir(), "forge-mesh-review-"));
  try {
    const bytes = Buffer.from(text);
    const registry = new AssetRegistry(new ImmutableJsonArtifactStore(root));
    const lock = await registry.ingestRecordedObj({
      bytes,
      expectedSourceHash: contentHash(text),
      spec: {
        id: "sculpture",
        description: "Generic geometric review fixture",
        bounds: { x: 20, y: 12, z: 10 },
        clearance: 1,
        collision: "none",
        namedParts: [],
        sockets: [{ id: "mount", position: { x: 0, y: 4, z: 0 } }],
        universeId: 0,
      },
      provenance: {
        kind: "recorded_obj",
        source: "Offline fixture",
        license: "Repository fixture",
        codeHash: "a".repeat(64),
        configurationHash: "b".repeat(64),
        checkpointHashes: [],
      },
    });
    await run(lock, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function rehash<T extends { hash: string }>(value: T): T {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: contentHash(stableJson(body)) } as T;
}

test("shared OBJ parser preserves inspection summaries and exact source-order memberships", () => {
  const mesh = parseObjMesh(Buffer.from(source));
  assert.deepEqual(mesh.geometry, inspectObj(Buffer.from(source)));
  assert.deepEqual(mesh.triangles, [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
  ]);
  assert.deepEqual(mesh.regions, [
    { kind: "group", name: "Front", triangleIds: [0, 1, 2] },
    { kind: "object", name: "Empty", triangleIds: [] },
    { kind: "object", name: "Insert", triangleIds: [2] },
    { kind: "object", name: "Shell", triangleIds: [0, 1] },
  ]);
});

test("review renders exact buffers, counterclockwise flat normals and one common fit", async () => {
  await fixture((lock, bytes) => {
    const review = createMeshReview({ bytes, lock });
    assert.equal(review.source.sha256, lock.sourceHash);
    assert.equal(review.source.utf8Bytes, bytes.byteLength);
    assert.equal(review.lockHash, lock.hash);
    assert.deepEqual(review.positions.slice(0, 6), [10, 20, 30, 12, 20, 30]);
    assert.deepEqual(review.triangleIndices, [0, 1, 2, 0, 2, 3, 4, 5, 6]);
    assert.deepEqual(review.triangleNormals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.equal(review.normalBinding, "per_triangle");
    assert.deepEqual(review.fit, JSON.parse(stableJson(lock.fit)));
    const firstX = review.positions[0]! * review.fit.scale + review.fit.translation.x;
    const insertX = review.positions[12]! * review.fit.scale + review.fit.translation.x;
    assert.equal(insertX - firstX, 10 * review.fit.scale);
    assert.deepEqual(review.sockets, [
      {
        id: "mount",
        position: { x: 0, y: 4, z: 0 },
        coordinateFrame: "fitted_asset",
        status: "declared",
      },
    ]);
    assert.equal(review.nativeImport.mayInstantiate, false);
    assert.deepEqual(
      review.nativeImport.partition.chunks.map((chunk) => chunk.triangleIds),
      [[0, 1], [2]],
    );
    assert.doesNotThrow(() => assertMeshReviewData(JSON.parse(JSON.stringify(review))));
    assert.equal(createMeshReview({ bytes, lock }).hash, review.hash);
  });
});

test("negative OBJ references and source shading data are admitted without inventing shading fidelity", async () => {
  await fixture((lock, bytes) => {
    const review = createMeshReview({ bytes, lock });
    assert.deepEqual(review.triangleIndices, [0, 2, 1]);
    assert.deepEqual(review.triangleNormals, [0, 0, -1]);
    assert.deepEqual(review.appearance, {
      normalMode: "computed_flat",
      sourceNormalCount: 1,
      sourceTextureCoordinateCount: 1,
      sourceSmoothingDeclarationCount: 1,
      sourceShading: "not_reproduced",
      materials: "not_loaded",
      textures: "not_loaded",
    });
  }, "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 1 0 0\ns 1\nf -3/1/1 -1/1/1 -2/1/1\n");
});

test("review binds source and independently recomputes lock geometry and fit", async () => {
  await fixture((lock, bytes) => {
    assert.throws(
      () => createMeshReview({ bytes: Buffer.from(source + "# different\n"), lock }),
      /exact source/,
    );
    const wrongGeometry = structuredClone(lock);
    wrongGeometry.geometry.triangleCount++;
    assert.throws(
      () => createMeshReview({ bytes, lock: rehash(wrongGeometry) }),
      /geometry or shared fit/,
    );
    const wrongFit = structuredClone(lock);
    wrongFit.fit.translation.x++;
    assert.throws(
      () => createMeshReview({ bytes, lock: rehash(wrongFit) }),
      /geometry or shared fit/,
    );
  });
});

test("retained payload rejects rehashed buffer, normal, membership, partition and socket corruption", async () => {
  await fixture((lock, bytes) => {
    const initial = createMeshReview({ bytes, lock });
    const corruptions: Array<(review: MeshReviewData) => void> = [
      (review) => {
        review.geometry.topology.boundaryEdgeCount = 0;
      },
      (review) => {
        review.geometry.bounds.max.x += 2;
      },
      (review) => {
        review.triangleIndices[0] = review.geometry.vertexCount;
      },
      (review) => {
        review.triangleNormals[2] = -1;
      },
      (review) => {
        review.regions[0]!.triangleIds = [1, 0, 2];
      },
      (review) => {
        review.nativeImport.partition.chunks[0]!.triangleIds = [1];
      },
      (review) => {
        review.sockets[0]!.position.x = 1000;
      },
    ];
    for (const corrupt of corruptions) {
      const changed = structuredClone(initial);
      corrupt(changed);
      assert.throws(() => assertMeshReviewData(rehash(changed)));
    }
  });
});

test("native advice losslessly partitions beyond 20k triangles without welding or recentering", () => {
  const triangles = Array.from({ length: 20_001 }, (_, index): [number, number, number] => [
    index * 3,
    index * 3 + 1,
    index * 3 + 2,
  ]);
  const partition = partitionMeshForNativeReview({
    sourceHash: "a".repeat(64),
    triangles,
    regions: [
      { kind: "object", name: "Sculpture", triangleIds: triangles.map((_, index) => index) },
    ],
  });
  assert.deepEqual(
    partition.chunks.map(({ triangleCount, vertexCount }) => ({ triangleCount, vertexCount })),
    [
      { triangleCount: 20_000, vertexCount: 60_000 },
      { triangleCount: 1, vertexCount: 3 },
    ],
  );
  assert.deepEqual(
    partition.chunks.flatMap((chunk) => chunk.triangleIds),
    triangles.map((_, index) => index),
  );
  assert.equal(new Set(partition.chunks.map((chunk) => chunk.id)).size, 2);
  assert.equal(partition.coordinateFrame, "source_obj");
  assert.equal(partition.fit, "shared_uniform_transform");
  assert.throws(
    () =>
      partitionMeshForNativeReview({
        sourceHash: "a".repeat(64),
        triangles,
        regions: [],
        maximumPartitions: 1,
      }),
    /no triangles were sampled/,
  );
});

test("object memberships own partitions once; overlapping groups and unlabelled faces stay inspectable", () => {
  const triangles: Array<[number, number, number]> = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ];
  const regions = [
    { kind: "object" as const, name: "Shell", triangleIds: [0] },
    { kind: "group" as const, name: "Selection", triangleIds: [0, 1] },
  ];
  const partition = partitionMeshForNativeReview({
    sourceHash: "a".repeat(64),
    triangles,
    regions,
  });
  assert.deepEqual(
    partition.chunks.map((chunk) => [chunk.part, chunk.triangleIds]),
    [
      [{ kind: "object", name: "Shell" }, [0]],
      [{ kind: "group", name: "Selection" }, [1]],
      [{ kind: "unlabelled" }, [2]],
    ],
  );
  assert.throws(
    () =>
      partitionMeshForNativeReview({
        sourceHash: "a".repeat(64),
        triangles,
        regions: [...regions, { kind: "object", name: "Another", triangleIds: [0] }],
      }),
    /two simultaneous OBJ objects/,
  );
});

test("review resource exhaustion fails explicitly without truncating geometry", async () => {
  await fixture((lock, bytes) => {
    assert.throws(
      () =>
        createMeshReview({
          bytes,
          lock,
          policy: { ...DEFAULT_MESH_REVIEW_POLICY, maximumTriangles: 2 },
        }),
      /triangle budget/,
    );
    assert.throws(
      () =>
        createMeshReview({
          bytes,
          lock,
          policy: { ...DEFAULT_MESH_REVIEW_POLICY, maximumJsonBytes: 100 },
        }),
      /byte budget/,
    );
  });
});
