import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_ASSET_INSPECTION_POLICY,
  fitAssetGeometry,
  inspectObj,
  validateAssetSpec,
} from "../packages/asset-registry/src/index.js";

const inspect = (source: string) => inspectObj(Buffer.from(source));
const vertices = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\n";
const partSpec = (name: string) =>
  validateAssetSpec({
    id: "part-evidence",
    description: "A source geometry inspection fixture",
    bounds: { x: 10, y: 10, z: 10 },
    clearance: 1,
    collision: "none",
    namedParts: [name],
    sockets: [],
    universeId: 0,
  });

test("a closed oriented tetrahedron has exact index topology and face-based object evidence", async () => {
  const geometry = inspectObj(await readFile("test/fixtures/assets/recorded-tetrahedron.obj"));
  assert.deepEqual(geometry.topology, {
    basis: "obj_vertex_indices",
    referencedVertexCount: 4,
    unreferencedVertexCount: 0,
    edgeCount: 6,
    boundaryEdgeCount: 0,
    nonManifoldEdgeCount: 0,
    inconsistentWindingEdgeCount: 0,
    edgeConnectedComponentCount: 1,
    duplicateTriangleCount: 0,
    unlabelledTriangleCount: 0,
  });
  assert.deepEqual(geometry.regions, [
    {
      kind: "object",
      name: "Body",
      triangleCount: 4,
      referencedVertexCount: 4,
      bounds: geometry.bounds,
    },
  ]);
  assert.deepEqual(geometry.warnings, []);
  assert.equal("groups" in geometry, false);
});

test("OBJ object and group memberships persist independently, resume, and measure faces rather than declarations", () => {
  const source =
    vertices +
    "v 5 0 0\nv 6 0 0\nv 5 1 0\n" +
    "f 1 2 3\no Body\ng Left\nf 1 2 3\ng Right\nf 5 6 7\n" +
    "o Other\nf 1 2 3\ng Left\nf 5 6 7\no Empty\nv 99 99 99\ng Empty\n";
  const geometry = inspect(source);
  assert.equal(geometry.topology.unlabelledTriangleCount, 1);
  assert.deepEqual(
    geometry.regions.map(({ kind, name, triangleCount }) => ({ kind, name, triangleCount })),
    [
      { kind: "group", name: "Empty", triangleCount: 0 },
      { kind: "group", name: "Left", triangleCount: 2 },
      { kind: "group", name: "Right", triangleCount: 2 },
      { kind: "object", name: "Body", triangleCount: 2 },
      { kind: "object", name: "Empty", triangleCount: 0 },
      { kind: "object", name: "Other", triangleCount: 2 },
    ],
  );
  assert.deepEqual(geometry.regions.find((region) => region.name === "Left")!.bounds, {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 6, y: 1, z: 0 },
  });
  for (const region of geometry.regions.filter((region) => region.name === "Empty")) {
    assert.equal(region.referencedVertexCount, 0);
    assert.equal(region.bounds, null);
  }
  assert.throws(() => fitAssetGeometry(geometry, partSpec("Empty")), /has no faces: Empty/);
  assert.doesNotThrow(() => fitAssetGeometry(geometry, partSpec("Body")));
  assert.equal(geometry.topology.unreferencedVertexCount, 2);
  assert.deepEqual(geometry.bounds.max, { x: 99, y: 99, z: 99 });
  assert.match(
    geometry.warnings.find((warning) => warning.code === "empty_regions")!.detail,
    /^2 /,
  );
  assert.match(
    geometry.warnings.find((warning) => warning.code === "unreferenced_vertices")!.detail,
    /conservative fit bounds/,
  );
});

test("the same object and group label retains distinct overlapping evidence without double-counting mesh triangles", () => {
  const geometry = inspect(vertices + "o Body\ng Body\nf 1 2 3\n");
  assert.equal(geometry.triangleCount, 1);
  assert.deepEqual(
    geometry.regions.map((region) => [region.kind, region.name, region.triangleCount]),
    [
      ["group", "Body", 1],
      ["object", "Body", 1],
    ],
  );
  assert.doesNotThrow(() => fitAssetGeometry(geometry, partSpec("Body")));
});

test("open and fragmented surfaces produce quantitative warnings without welding coincident vertices", () => {
  const geometry = inspect(
    "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 0\nv 1 0 0\nv 0 1 0\n" + "f 1 2 3\nf 4 5 6\n",
  );
  assert.equal(geometry.topology.edgeConnectedComponentCount, 2);
  assert.equal(geometry.topology.boundaryEdgeCount, 6);
  assert.equal(geometry.topology.duplicateTriangleCount, 0);
  assert.deepEqual(
    geometry.warnings.map((warning) => warning.code),
    ["boundary_edges", "disconnected_surfaces"],
  );
  assert.match(geometry.warnings[0]!.detail, /^6 /);
  assert.match(geometry.warnings[1]!.detail, /^2 /);
  assert.match(geometry.warnings[1]!.detail, /intentional separate pieces/);
  assert.equal("watertight" in geometry.topology, false);
  assert.equal("qualityScore" in geometry, false);
});

test("edge connectivity distinguishes point contacts and reports winding, duplicate and non-manifold incidents", () => {
  const pointContact = inspect(vertices + "v 0 -1 0\nf 1 2 3\nf 1 4 5\n");
  assert.equal(pointContact.topology.edgeConnectedComponentCount, 2);
  const winding = inspect(vertices + "f 1 2 3\nf 1 2 4\n");
  assert.equal(winding.topology.inconsistentWindingEdgeCount, 1);
  assert.equal(winding.topology.edgeConnectedComponentCount, 1);
  assert.match(
    winding.warnings.find((warning) => warning.code === "inconsistent_winding")!.detail,
    /^1 /,
  );
  const repeated = inspect(vertices + "f 1 2 3\nf 3 2 1\nf 2 1 4\n");
  assert.equal(repeated.topology.duplicateTriangleCount, 1);
  assert.equal(repeated.topology.nonManifoldEdgeCount, 1);
  assert.equal(repeated.topology.boundaryEdgeCount, 2);
  assert.equal(repeated.topology.inconsistentWindingEdgeCount, 0);
  assert.match(
    repeated.warnings.find((warning) => warning.code === "duplicate_triangles")!.detail,
    /^1 /,
  );
  assert.match(
    repeated.warnings.find((warning) => warning.code === "non_manifold_edges")!.detail,
    /^1 /,
  );
});

test("negative indices and polygon triangulation retain exact region geometry under bounded inspection", () => {
  const quad = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\ng Panel\nf -4 -3 -2 -1\n";
  const geometry = inspect(quad);
  assert.equal(geometry.triangleCount, 2);
  assert.equal(geometry.regions[0]!.triangleCount, 2);
  assert.equal(geometry.regions[0]!.referencedVertexCount, 4);
  assert.equal(geometry.topology.edgeCount, 5);
  assert.equal(geometry.topology.boundaryEdgeCount, 4);
  assert.equal(geometry.topology.edgeConnectedComponentCount, 1);
  assert.throws(
    () =>
      inspectObj(Buffer.from(quad), { ...DEFAULT_ASSET_INSPECTION_POLICY, maximumTriangles: 1 }),
    /triangle budget/,
  );
  const labels = Array.from({ length: 257 }, (_, index) => `o Region${index}\n`).join("");
  assert.throws(() => inspect(vertices + "f 1 2 3\n" + labels), /region budget/);
});

test("face and declaration ordering do not alter canonical topology, regions or warnings", () => {
  const first = inspect(vertices + "g Zebra\nf 1 2 3\ng Alpha\nf 1 4 2\ng Empty\n");
  const second = inspect(vertices + "g Empty\ng Alpha\nf 1 4 2\ng Zebra\nf 1 2 3\n");
  assert.deepEqual(first, second);
});
