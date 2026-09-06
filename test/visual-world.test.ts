import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  blenderSceneSpecHandle,
  blenderToRoblox,
  bindBlenderSceneIntent,
  planSceneRepair,
  robloxToBlender,
  RetainedBlenderSceneStore,
  solveBlenderScene,
  validateBlenderSceneIntent,
  validateBlenderSceneDeclaration,
  validateBlenderSceneSpec,
} from "../packages/visual-world/src/index.js";
import { sceneTransform, visualWorldIntent } from "./helpers/visual-world-fixture.js";

test("the current BlenderSceneSpec ABI is strict, canonical, identity-safe, and partition-complete", () => {
  const intent = visualWorldIntent();
  const admitted = validateBlenderSceneIntent(intent);
  assert.equal(admitted.abi, "blender-scene-spec@2");
  assert.deepEqual(admitted.partitions.map((partition) => partition.role).sort(), [
    "Effects",
    "GameplayAnchors",
    "InteractiveProps",
    "WorldCollision",
    "WorldStatic",
  ]);

  assert.throws(
    () => validateBlenderSceneIntent({ ...intent, arbitraryPython: "import bpy" }),
    /unrecognized|unknown/i,
  );
  assert.throws(
    () =>
      validateBlenderSceneIntent({
        ...intent,
        objects: [...intent.objects, structuredClone(intent.objects[0]!)],
      }),
    /duplicate object/i,
  );
  assert.throws(
    () => validateBlenderSceneIntent({ ...intent, visualBrief: "bad\ud800" }),
    /unicode/i,
  );
  assert.throws(
    () => validateBlenderSceneIntent({ ...intent, partitions: intent.partitions.slice(0, 4) }),
    /partition|too_small/i,
  );
  assert.throws(
    () =>
      validateBlenderSceneIntent({
        ...intent,
        frames: [
          { ...intent.frames[0]!, parentId: "child-frame" },
          { id: "child-frame", parentId: "world-frame", transform: intent.frames[0]!.transform },
        ],
      }),
    /cycle/i,
  );
  assert.throws(
    () =>
      validateBlenderSceneIntent({
        ...intent,
        sources: [
          {
            id: "unqualified-source",
            kind: "creator_glb",
            sha256: "b".repeat(64),
            bytes: 1,
            licenseId: "research",
            rights: "research_only",
            attribution: "Research fixture",
            localHandle: "c".repeat(64),
          },
        ],
      }),
    /research-only/i,
  );
});

test("scene admission rejects invalid geometry authority, references, partitions, and output coverage", () => {
  const negative = visualWorldIntent();
  negative.geometries[0] = {
    ...negative.geometries[0]!,
    kind: "solid",
    shape: "box",
    size: { x: -4, y: 8, z: 4 },
    segments: 8,
  };
  assert.throws(() => validateBlenderSceneIntent(negative), /positive/i);

  const missingTexture = visualWorldIntent();
  missingTexture.materials[0]!.textureIds = ["missing-texture"];
  assert.throws(() => validateBlenderSceneIntent(missingTexture), /material texture/i);

  const wrongPartition = visualWorldIntent();
  wrongPartition.collisionProxies[0]!.partitionId = "static-chunk";
  assert.throws(() => validateBlenderSceneIntent(wrongPartition), /wrong partition role/i);

  const missingGlb = visualWorldIntent();
  missingGlb.expectedOutputs = missingGlb.expectedOutputs.filter((entry) => entry.kind !== "glb");
  assert.throws(() => validateBlenderSceneIntent(missingGlb), /GLB output/i);

  const duplicateGlobalId = visualWorldIntent();
  duplicateGlobalId.materials[0]!.id = "fixture-geometry";
  duplicateGlobalId.objects[0]!.materialIds = ["fixture-geometry"];
  assert.throws(() => validateBlenderSceneIntent(duplicateGlobalId), /duplicate global/i);

  const understated = visualWorldIntent();
  understated.objects[0]!.localBounds.size = { x: 1, y: 1, z: 1 };
  const result = solveBlenderScene(understated);
  assert.equal(result.status, "rejected");
  assert.match(result.diagnostics[0]!.detail, /exceeds its admitted local bounds/i);
});

test("model scene declarations exclude host authority and bind through one exact host envelope", () => {
  const intent = visualWorldIntent();
  const {
    kind: _kind,
    revision,
    parent,
    projectId,
    creatorRequestHash,
    visualBriefHash,
    referenceHashes,
    compiler,
    sources,
    textures,
    provenance,
    budgets,
    expectedOutputs,
    ...semantic
  } = intent;
  const declaration = validateBlenderSceneDeclaration({
    ...semantic,
    kind: "BlenderSceneDeclaration",
  });
  assert.throws(
    () => validateBlenderSceneDeclaration({ ...declaration, compiler }),
    /unrecognized|unknown/i,
  );
  const authority = {
    revision,
    ...(parent ? { parent } : {}),
    projectId,
    creatorRequestHash,
    visualBriefHash,
    referenceHashes,
    compiler,
    sources,
    textures,
    provenance,
    budgets,
    expectedOutputs,
  };
  assert.deepEqual(
    bindBlenderSceneIntent(declaration, authority),
    validateBlenderSceneIntent(intent),
  );
});

test("the deterministic solver preserves fixed transforms and reports search exhaustion separately", () => {
  const first = solveBlenderScene(visualWorldIntent());
  const second = solveBlenderScene(visualWorldIntent());
  assert.equal(first.status, "eligible");
  assert.deepEqual(second, first);
  if (first.status !== "eligible") return;
  assert.deepEqual(first.spec.objects[0]!.transform.position, { x: 0, y: 4, z: 8 });
  assert.deepEqual(blenderToRoblox(robloxToBlender({ x: 3, y: 7, z: -11 })), {
    x: 3,
    y: 7,
    z: -11,
  });
  assert.deepEqual(validateBlenderSceneSpec(first.spec), first.spec);
  assert.equal(blenderSceneSpecHandle(first.spec).hash, first.hash);

  const exhausted = visualWorldIntent();
  exhausted.objects[0]!.placement = {
    kind: "solve",
    frameId: "world-frame",
    zoneIds: ["main-zone"],
    positionBounds: {
      minimum: { x: 100, y: 0, z: 100 },
      maximum: { x: 101, y: 0, z: 100 },
    },
    yawCandidatesDegrees: [0],
  };
  exhausted.budgets.maximumSolverCandidates = 1;
  const result = solveBlenderScene(exhausted);
  assert.equal(result.status, "incomplete");
  assert.equal(result.diagnostics[0]?.code, "solver_resource_exhausted");
});

test("instance distributions expand deterministically before the Blender ABI boundary", () => {
  const intent = visualWorldIntent();
  intent.geometries.push({
    kind: "curve",
    id: "fixture-instance-curve",
    interpolation: "polyline",
    points: [
      { x: -8, y: 4, z: -8 },
      { x: 0, y: 4, z: -4 },
      { x: 8, y: 4, z: -8 },
    ],
    samplesPerSegment: 4,
    closed: false,
  });
  intent.instances = [
    {
      id: "along",
      sourceObjectId: "fixture-object",
      partitionId: "static-chunk",
      distribution: {
        kind: "along_curve",
        curveId: "fixture-instance-curve",
        count: 3,
        scale: { x: 1, y: 1, z: 1 },
      },
    },
    {
      id: "linear",
      sourceObjectId: "fixture-object",
      partitionId: "static-chunk",
      distribution: {
        kind: "linear",
        origin: {
          position: { x: -12, y: 4, z: 8 },
          rotation: { xDegrees: 0, yDegrees: 0, zDegrees: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        step: { x: 4, y: 0, z: 0 },
        count: 3,
      },
    },
    {
      id: "radial",
      sourceObjectId: "fixture-object",
      partitionId: "static-chunk",
      distribution: {
        kind: "radial",
        center: { x: 0, y: 0, z: 0 },
        radius: 12,
        startAngleDegrees: 0,
        sweepAngleDegrees: 180,
        count: 3,
        y: 4,
        scale: { x: 1, y: 1, z: 1 },
      },
    },
    {
      id: "seeded",
      sourceObjectId: "fixture-object",
      partitionId: "static-chunk",
      distribution: {
        kind: "seeded_spatial",
        zoneId: "main-zone",
        positionBounds: {
          minimum: { x: -2, y: 4, z: -2 },
          maximum: { x: 2, y: 4, z: 2 },
        },
        yawCandidatesDegrees: [],
        count: 3,
        minimumSeparation: 1,
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  ];
  intent.collections = [
    {
      id: "distributed",
      name: "Distributed props",
      objectIds: ["fixture-object"],
      instanceIds: ["along", "linear", "radial", "seeded"],
    },
  ];
  const first = solveBlenderScene(intent);
  const second = solveBlenderScene(intent);
  assert.equal(first.status, "eligible", JSON.stringify(first));
  assert.deepEqual(second, first);
  if (first.status !== "eligible") return;
  assert.deepEqual(
    first.spec.instances.map((instance) => [instance.id, instance.transforms.length]),
    [
      ["along", 3],
      ["linear", 3],
      ["radial", 3],
      ["seeded", 3],
    ],
  );
  assert.equal(
    first.spec.instances.some((instance) => "distribution" in instance),
    false,
  );
});

test("expanded instances and route headroom participate in spatial constraints", () => {
  const overlappingInstance = visualWorldIntent();
  overlappingInstance.instances[0]!.distribution = {
    kind: "explicit",
    transforms: [sceneTransform(0, 4, 8)],
  };
  overlappingInstance.constraints.push({
    id: "instance-self-separation",
    kind: "separation",
    firstObjectId: "fixture-object",
    secondObjectId: "fixture-object",
    clearance: 0,
  });
  assert.equal(solveBlenderScene(overlappingInstance).status, "rejected");

  const overhead = visualWorldIntent();
  overhead.objects.push({
    ...structuredClone(overhead.objects[0]!),
    id: "overhead-object",
    name: "Overhead obstruction",
    localBounds: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 2, z: 4 } },
    placement: { kind: "fixed", frameId: "world-frame", transform: sceneTransform(0, 6, 0) },
  });
  overhead.geometries.push({
    kind: "solid",
    id: "overhead-geometry",
    shape: "box",
    size: { x: 4, y: 2, z: 4 },
    segments: 8,
  });
  overhead.objects.at(-1)!.geometryId = "overhead-geometry";
  overhead.partitions
    .find((entry) => entry.id === "static-chunk")!
    .objectIds.push("overhead-object");
  overhead.constraints.push({
    id: "route-headroom",
    kind: "clearance",
    routeId: "main-route",
    objectIds: ["overhead-object"],
    clearance: 0,
  });
  assert.equal(solveBlenderScene(overhead).status, "rejected");
});

test("minimum density is evaluated only when a partial assignment can no longer improve", () => {
  const intent = visualWorldIntent();
  intent.instances = [];
  intent.collections[0]!.instanceIds = [];
  intent.objects.push({
    ...structuredClone(intent.objects[0]!),
    id: "second-object",
    name: "Second object",
    partitionId: "static-chunk",
    placement: { kind: "fixed", frameId: "world-frame", transform: sceneTransform(8, 4, 8) },
  });
  intent.partitions.find((entry) => entry.id === "static-chunk")!.objectIds.push("second-object");
  intent.constraints.push({
    id: "minimum-density",
    kind: "density",
    zoneId: "main-zone",
    minimum: 0.019,
    maximum: 0.1,
  });
  assert.equal(solveBlenderScene(intent).status, "eligible");
});

test("targeted repair rejects stale parents and computes the smallest affected partition closure", () => {
  const solved = solveBlenderScene(visualWorldIntent());
  assert.equal(solved.status, "eligible");
  if (solved.status !== "eligible") return;
  const nextIntent = visualWorldIntent();
  nextIntent.revision = 2;
  const parentHandle = blenderSceneSpecHandle(solved.spec);
  nextIntent.parent = { revision: parentHandle.revision, hash: parentHandle.hash };
  nextIntent.materials[0]!.roughness = 0.6;
  const proposal = {
    kind: "SceneRepairProposal" as const,
    id: "fixture-repair",
    parent: parentHandle,
    observationHashes: ["d".repeat(64)],
    changedIds: ["fixture-material"],
    affectedInterfaceIds: ["fixture-containment", "fixture-socket"],
    intendedResult: "Make the landmark material read less glossy.",
    nextIntent,
  };
  const result = planSceneRepair(solved.spec, proposal);
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.deepEqual(result.plan.affectedPartitionIds, [
    "collision-partition",
    "interactive-partition",
    "static-chunk",
  ]);
  assert.ok(result.plan.reusedPartitionIds.includes("effects-partition"));
  assert.deepEqual(result.plan.affectedObjectIds, ["fixture-object"]);

  const stale = planSceneRepair(solved.spec, {
    ...proposal,
    parent: { ...proposal.parent, hash: "e".repeat(64) },
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.diagnostics[0]?.code, "repair_parent_stale");
});

test("a compiler identity repair conservatively invalidates every compiled partition and view", () => {
  const solved = solveBlenderScene(visualWorldIntent());
  assert.equal(solved.status, "eligible");
  if (solved.status !== "eligible") return;
  const nextIntent = visualWorldIntent();
  nextIntent.revision = 2;
  const parent = blenderSceneSpecHandle(solved.spec);
  nextIntent.parent = { revision: parent.revision, hash: parent.hash };
  nextIntent.compiler.workerSha256 = "9".repeat(64);
  const affectedInterfaceIds = [
    ...nextIntent.constraints.map((entry) => entry.id),
    ...nextIntent.sockets.map((entry) => entry.id),
  ];
  const result = planSceneRepair(solved.spec, {
    kind: "SceneRepairProposal",
    id: "fixture-compiler-repair",
    parent,
    observationHashes: ["d".repeat(64)],
    changedIds: ["scene-compiler"],
    affectedInterfaceIds,
    intendedResult: "Bind a changed fixed compiler identity.",
    nextIntent,
  });
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.deepEqual(
    result.plan.affectedPartitionIds,
    nextIntent.partitions.map(({ id }) => id).sort(),
  );
  assert.deepEqual(result.plan.affectedViewIds, nextIntent.reviewViews.map(({ id }) => id).sort());
  assert.deepEqual(result.plan.reusedPartitionIds, []);
});

test("a repair cannot mutate shared geometry in place", () => {
  const solved = solveBlenderScene(visualWorldIntent());
  assert.equal(solved.status, "eligible");
  if (solved.status !== "eligible") return;
  const parent = blenderSceneSpecHandle(solved.spec);
  const nextIntent = visualWorldIntent();
  nextIntent.revision = 2;
  nextIntent.parent = { revision: parent.revision, hash: parent.hash };
  const geometry = nextIntent.geometries[0]!;
  assert.equal(geometry.kind, "solid");
  if (geometry.kind !== "solid") return;
  geometry.size.x = 5;
  nextIntent.objects[0]!.localBounds.size.x = 5;
  const result = planSceneRepair(solved.spec, {
    kind: "SceneRepairProposal",
    id: "shared-geometry-repair",
    parent,
    observationHashes: ["d".repeat(64)],
    changedIds: ["fixture-geometry", "fixture-object"],
    affectedInterfaceIds: [],
    intendedResult: "Change one instance without changing the other consumers.",
    nextIntent,
  });
  assert.equal(result.status, "rejected");
  if ("diagnostics" in result)
    assert.equal(result.diagnostics[0]?.code, "repair_shared_geometry_requires_fork");
});

test("scene handles resolve only through exact retained canonical scene bytes", async () => {
  const solved = solveBlenderScene(visualWorldIntent());
  assert.equal(solved.status, "eligible");
  if (solved.status !== "eligible") return;
  const directory = await mkdtemp(join(tmpdir(), "forge-retained-scene-"));
  try {
    const retained = new RetainedBlenderSceneStore(new ImmutableJsonArtifactStore(directory));
    const binding = await retained.retain(solved.spec, "2026-09-06T00:00:00.000Z");
    assert.deepEqual(await retained.resolve(binding, binding.scene), solved.spec);
    await assert.rejects(
      retained.resolve(binding, { ...binding.scene, revision: binding.scene.revision + 1 }),
      /stale|differs/i,
    );
    await assert.rejects(
      retained.resolve({ ...binding, recordHash: "f".repeat(64) }, binding.scene),
      /identity mismatch/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
