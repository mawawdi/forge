import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_PROJECT_INDEX_CANONICAL_VECTORS,
  assertStudioObjectIdentity,
  assertStudioCapabilityManifest,
  assertStudioProjectIndexCapture,
  assertStudioObservedPropertyValueForProperty,
  assertStudioEvidenceFact,
  assertStudioValue,
  assertStudioValueForProperty,
  canonicalStudioValue,
  createStudioSourceBlobCapture,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  createStudioConnectorEpoch,
  createStudioProjectEvidenceShard,
  projectIndexHash,
  projectIndexMaterial,
  studioProjectIndexSourceDocuments,
  studioProjectIndexMetadataView,
  studioProjectIndexView,
  studioEvidenceFactKey,
  type StudioObservedPropertyValue,
  type StudioProjectIndexNode,
} from "../packages/studio-evidence/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { assertPluginToBackendMessage } from "../packages/studio-protocol/src/index.js";
import {
  createCreatorProjectDelta,
  createCreatorRestartChangeNotice,
  readCreatorProjectIndexMetadataArtifacts,
  readCreatorProjectIndexArtifacts,
  writeCreatorProjectIndexArtifacts,
} from "../packages/creator-session/src/project-refresh.js";
import { gameTopologyFromCapture } from "../packages/game-compiler/src/checkpoints.js";
import { compileCreatorTransactionTopology } from "../packages/creator-session/src/transaction-topology.js";

const project = { name: "Index fixture", placeId: 9, universeId: 12 };
const manifestHash = STUDIO_CAPABILITY_MANIFEST_HASH;
const connectorEpoch = "connector_epoch_fixture";
const source = "local Protocol = require(script.Parent.Protocol)\nreturn Protocol\n-- 😀";
const stableIdentity = { kind: "forge_attribute" as const, stableId: "existing-protocol" };
const ephemeralIdentity = {
  kind: "studio_ephemeral" as const,
  connectorEpoch,
  opaqueHash: "b".repeat(64),
};

test("connector epochs use the project-index canonical hash domain", () => {
  const input = {
    sessionId: "studio_session_epoch",
    projectId: "studio_project_epoch",
    connectorBuildHash: "c".repeat(64),
  };
  assert.equal(
    createStudioConnectorEpoch(input),
    projectIndexHash({ kind: "StudioConnectorEpoch", ...input }),
  );
  assert.notEqual(
    createStudioConnectorEpoch(input),
    createStudioConnectorEpoch({ ...input, projectId: "studio_project_other" }),
  );
});

test("Studio object identity strings share the generated Luau wire domain", () => {
  const hash = "a".repeat(64);
  for (const identity of [
    { kind: "forge_attribute", stableId: "stable_✓" },
    { kind: "studio_ephemeral", connectorEpoch: "epoch_✓", opaqueHash: hash },
    {
      kind: "rojo_sourcemap",
      authorityMapHash: hash,
      sourcemapHash: "b".repeat(64),
      mappingId: "mapping_✓",
    },
  ]) {
    assert.doesNotThrow(() => assertStudioObjectIdentity(identity));
  }
  for (const identity of [
    { kind: "forge_attribute", stableId: "contains space" },
    { kind: "forge_attribute", stableId: "a".repeat(513) },
    { kind: "forge_attribute", stableId: "\ud800" },
    { kind: "studio_ephemeral", connectorEpoch: "\u00a0", opaqueHash: hash },
    {
      kind: "rojo_sourcemap",
      authorityMapHash: hash,
      sourcemapHash: "b".repeat(64),
      mappingId: "\ufeff",
    },
  ]) {
    assert.throws(() => assertStudioObjectIdentity(identity));
  }
});

function projection(bounds = CREATOR_DEFAULT_RESOURCE_POLICY) {
  return createStudioProjectIndexProjection({
    manifestHash,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["ReplicatedStorage"],
    bounds,
  });
}

test("project-index hashes use tagged binary64 material rather than JSON number spelling", () => {
  for (const vector of STUDIO_PROJECT_INDEX_CANONICAL_VECTORS) {
    assert.equal(projectIndexMaterial(vector.value), vector.material, vector.name);
  }
  assert.notEqual(projectIndexMaterial(-0), projectIndexMaterial(0));
  assert.notEqual(projectIndexHash(-0), projectIndexHash(0));
  assert.equal(
    projectIndexMaterial({ é: "forge-✓", a: [true, 7] }),
    projectIndexMaterial({ a: [true, 7], é: "forge-✓" }),
    "UTF-8 key order is independent of construction order",
  );
  assert.throws(() => projectIndexMaterial("\ud800"), /UTF-8/);
  assert.throws(() => projectIndexMaterial(Number.NaN), /number/);
});

const unboundedMaximums = {
  both: { kind: "observed_vector2_f32", x: "positive_infinity", y: "positive_infinity" },
  x: { kind: "observed_vector2_f32", x: "positive_infinity", y: 480 },
  y: { kind: "observed_vector2_f32", x: 640, y: "positive_infinity" },
  zero: { kind: "observed_vector2_f32", x: 0, y: "positive_infinity" },
} as const;

function maximumCapture(maximum: StudioObservedPropertyValue) {
  return createStudioProjectIndexCapture({
    projection: projection(),
    shards: [
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal: 0,
        nodes: [
          {
            identity: stableIdentity,
            displayPath: "ReplicatedStorage/SizeConstraint",
            name: "SizeConstraint",
            className: "UISizeConstraint",
            attributes: {},
            tags: [],
            coveredProperties: {
              MaxSize: maximum,
              MinSize: { kind: "vector2_f32", x: 0, y: 0 },
            },
            coveredPropertyNames: ["MaxSize", "MinSize"],
          },
        ],
      }),
    ],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-06T00:00:00.000Z",
    detectorEpoch: 0,
  });
}

test("unbounded maxima are exact property-bound observations, never authored or final values", () => {
  const property = STUDIO_CAPABILITY_MANIFEST.classes
    .find((entry) => entry.name === "UISizeConstraint")!
    .properties.find((entry) => entry.name === "MaxSize")!;
  for (const value of Object.values(unboundedMaximums)) {
    assert.doesNotThrow(() => assertStudioObservedPropertyValueForProperty(value, property));
    assert.throws(() => assertStudioValue(value));
    // @ts-expect-error Observation-only values cannot enter authored-value APIs.
    assert.throws(() => canonicalStudioValue(value));
    // @ts-expect-error Property setter admission retains the finite StudioValue type.
    assert.throws(() => assertStudioValueForProperty(value, property));
    const target = {
      kind: "instance",
      identity: stableIdentity,
      path: "ReplicatedStorage/SizeConstraint",
      className: "UISizeConstraint",
    } as const;
    assert.throws(() =>
      assertStudioEvidenceFact({
        kind: "property",
        key: studioEvidenceFactKey("property", target, "MaxSize"),
        target,
        propertyName: "MaxSize",
        result: { status: "observed", value },
      }),
    );
  }
  for (const value of [
    { ...unboundedMaximums.x, x: Infinity },
    { ...unboundedMaximums.x, x: "negative_infinity" },
    { ...unboundedMaximums.x, y: -Infinity },
    { ...unboundedMaximums.x, y: NaN },
    { ...unboundedMaximums.x, y: 1 / 3 },
    { ...unboundedMaximums.x, y: 1e100 },
    { ...unboundedMaximums.x, y: undefined },
    { ...unboundedMaximums.x, extra: true },
    { kind: "observed_vector2_f32", x: 640, y: 480 },
  ])
    assert.throws(() => assertStudioObservedPropertyValueForProperty(value, property));
  for (const wrong of [
    { ...property, declaringClass: "Frame" },
    { ...property, name: "MinSize" },
    { ...property, codec: "vector3_f32" as const },
  ])
    assert.throws(() =>
      assertStudioObservedPropertyValueForProperty(unboundedMaximums.both, wrong),
    );
  const node = maximumCapture(unboundedMaximums.both).shards[0]!.nodes[0]!;
  assert.throws(
    () =>
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal: 0,
        nodes: [
          {
            ...node,
            coveredProperties: { MinSize: node.coveredProperties.MinSize },
            coveredPropertyNames: ["MinSize"],
          },
        ],
      }),
    /coverage/,
  );
  assert.throws(() =>
    createStudioProjectEvidenceShard({
      root: "ReplicatedStorage",
      ordinal: 0,
      nodes: [
        {
          ...node,
          attributes: {
            Invalid: unboundedMaximums.both,
          } as unknown as StudioProjectIndexNode["attributes"],
        },
      ],
    }),
  );
});

test("unbounded observations survive transport, persisted capture, metadata and topology", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-unbounded-project-index-"));
  try {
    const store = new ImmutableJsonArtifactStore(directory);
    const captures = Object.values(unboundedMaximums).map(maximumCapture);
    assert.equal(new Set(captures.map((capture) => capture.hash)).size, captures.length);
    for (const capture of captures) {
      assertStudioProjectIndexCapture(JSON.parse(JSON.stringify(capture)));
      const binding = await writeCreatorProjectIndexArtifacts(store, capture);
      const loaded = await readCreatorProjectIndexArtifacts(store, binding);
      assert.deepEqual(loaded, capture);
      const metadata = await readCreatorProjectIndexMetadataArtifacts(store, binding);
      const maximum = capture.shards[0]!.nodes[0]!.coveredProperties.MaxSize;
      assert.deepEqual(metadata.view.instances[0]!.properties.MaxSize, maximum);
      assert.deepEqual(
        studioProjectIndexMetadataView(capture).instances[0]!.properties.MaxSize,
        maximum,
      );
      assert.deepEqual(studioProjectIndexView(capture).instances[0]!.properties.MaxSize, maximum);
      const initial = gameTopologyFromCapture(capture);
      const preserved = compileCreatorTransactionTopology({ initial, operations: [] });
      assert.deepEqual(preserved.finalNodes[0]!.properties.MaxSize, maximum);
      const finite = { kind: "vector2_f32", x: 640, y: 480 } as const;
      const changed = compileCreatorTransactionTopology({
        initial,
        operations: [
          {
            id: "bound-maximum",
            kind: "update",
            target: {
              kind: "instance",
              identity: stableIdentity,
              path: "ReplicatedStorage/SizeConstraint",
              className: "UISizeConstraint",
            },
            properties: { MaxSize: finite },
          },
        ],
      });
      assert.deepEqual(changed.finalNodes[0]!.properties, {
        MaxSize: finite,
        MinSize: { kind: "vector2_f32", x: 0, y: 0 },
      });
    }
    assert.equal(createCreatorProjectDelta(captures[0]!, captures[0]!).changed, false);
    for (const next of captures.slice(1))
      assert.equal(createCreatorProjectDelta(captures[0]!, next).changed, true);
    assert.equal(
      createCreatorProjectDelta(
        captures[0]!,
        maximumCapture({ kind: "vector2_f32", x: 640, y: 480 }),
      ).changed,
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript and Luau share unbounded observation hash material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-unbounded-material-"));
  try {
    const path = join(directory, "expected.json");
    await writeFile(
      path,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(unboundedMaximums).map(([id, value]) => [id, projectIndexMaterial(value)]),
        ),
      ),
    );
    const result = spawnSync("lune", ["run", "scripts/test-studio-project-unbounded.luau", path], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /4 canonical vectors/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project indexes accept canonical compound Roblox attribute values", () => {
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Attributed",
        name: "Attributed",
        className: "Folder",
        attributes: {
          Frame: {
            components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1],
            kind: "cframe_f32x12",
          },
          Offset: { kind: "vector3_f32", x: 1, y: 2, z: 3 },
          Tint: { b: 255, g: 128, kind: "color3_rgb8", r: 12 },
        },
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
    ],
  });
  assert.deepEqual(shard.nodes[0]?.attributes.Offset, {
    kind: "vector3_f32",
    x: 1,
    y: 2,
    z: 3,
  });
  const unsupportedNode = {
    identity: stableIdentity,
    displayPath: "ReplicatedStorage/UnsupportedAttribute",
    name: "UnsupportedAttribute",
    className: "Folder",
    attributes: {
      Unsupported: {
        family: "rbxasset://fonts/families/Arial.json",
        kind: "font",
        style: "Normal",
        weight: "Regular",
      },
    },
    tags: [],
    coveredProperties: {},
    coveredPropertyNames: [],
  } as unknown as StudioProjectIndexNode;
  assert.throws(
    () =>
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal: 0,
        nodes: [unsupportedNode],
      }),
    /project index attribute type/,
  );
});

test("project index property coverage is complete for manifest classes and empty for unknown classes", () => {
  const base = {
    identity: stableIdentity,
    displayPath: "ReplicatedStorage/Flag",
    name: "Flag",
    className: "BoolValue",
    attributes: {},
    tags: [],
    coveredProperties: { Value: { kind: "boolean" as const, value: false } },
    coveredPropertyNames: ["Value"],
  };
  assert.doesNotThrow(() =>
    createStudioProjectEvidenceShard({ root: "ReplicatedStorage", ordinal: 0, nodes: [base] }),
  );
  assert.throws(
    () =>
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal: 0,
        nodes: [{ ...base, coveredProperties: {}, coveredPropertyNames: [] }],
      }),
    /manifest property coverage/,
  );
  assert.throws(
    () =>
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal: 0,
        nodes: [
          {
            ...base,
            coveredProperties: { Value: { kind: "number_f32" as const, value: 0 } },
          },
        ],
      }),
    /codec does not match Value/,
  );
  assert.doesNotThrow(() =>
    createStudioProjectEvidenceShard({
      root: "ReplicatedStorage",
      ordinal: 0,
      nodes: [
        {
          ...base,
          className: "UncataloguedFutureClass",
          coveredProperties: {},
          coveredPropertyNames: [],
        },
      ],
    }),
  );
});

test("project-index replay remains bound to its stored manifest after capability growth", () => {
  const recordedManifest = structuredClone(STUDIO_CAPABILITY_MANIFEST);
  assertStudioCapabilityManifest(recordedManifest);
  const recordedManifestHash = contentHash(stableJson(recordedManifest));
  const recordedProjection = createStudioProjectIndexProjection({
    manifestHash: recordedManifestHash,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["ReplicatedStorage"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const recordedNode = {
    identity: stableIdentity,
    displayPath: "ReplicatedStorage/RecordedFlag",
    name: "RecordedFlag",
    className: "BoolValue",
    attributes: {},
    tags: [],
    coveredProperties: { Value: { kind: "boolean" as const, value: false } },
    coveredPropertyNames: ["Value"],
  };
  const recordedShard = createStudioProjectEvidenceShard(
    { root: "ReplicatedStorage", ordinal: 0, nodes: [recordedNode] },
    recordedManifest,
  );
  const capture = createStudioProjectIndexCapture(
    {
      projection: recordedProjection,
      shards: [recordedShard],
      sourceManifests: [],
      sourceChunks: [],
      completedAt: "2026-09-03T00:00:00.000Z",
      detectorEpoch: 0,
    },
    recordedManifest,
  );
  assert.doesNotThrow(() => assertStudioProjectIndexCapture(capture, recordedManifest));

  const recordedBoolValue = recordedManifest.classes.find((entry) => entry.name === "BoolValue");
  assert(recordedBoolValue);
  const valueProperty = recordedBoolValue.properties.find((entry) => entry.name === "Value");
  assert(valueProperty);
  const newerManifest = {
    ...recordedManifest,
    classes: recordedManifest.classes.map((entry) =>
      entry.name !== "BoolValue"
        ? entry
        : {
            ...entry,
            properties: [...entry.properties, { ...valueProperty, name: "Enabled" }].sort(
              (left, right) => left.name.localeCompare(right.name),
            ),
          },
    ),
  };
  assertStudioCapabilityManifest(newerManifest);

  // New live policy does not retroactively reinterpret an immutable capture.
  // Its own manifest binding is required for provider-free replay.
  assert.throws(
    () => assertStudioProjectIndexCapture(capture, newerManifest),
    /capability manifest binding/,
  );
  assert.throws(
    () =>
      createStudioProjectEvidenceShard(
        {
          root: "ReplicatedStorage",
          ordinal: 0,
          nodes: [{ ...recordedNode, coveredProperties: {}, coveredPropertyNames: [] }],
        },
        recordedManifest,
      ),
    /manifest property coverage/,
  );
});

test("complete Studio project indexes bind a projection, chunked source, and a semantic revision", () => {
  const sourceCapture = createStudioSourceBlobCapture({
    identity: stableIdentity,
    source,
    editorSource: true,
    transportChunkBytes: 7,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: ephemeralIdentity,
        displayPath: "ReplicatedStorage/Airlock",
        name: "Airlock",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Airlock/Protocol",
        name: "Protocol",
        parentIdentity: ephemeralIdentity,
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
        sourceManifestHash: sourceCapture.manifest.hash,
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection: projection(),
    shards: [shard],
    sourceManifests: [sourceCapture.manifest],
    sourceChunks: sourceCapture.chunks,
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch: 0,
  });
  assertStudioProjectIndexCapture(capture);
  assert.throws(
    () => assertStudioProjectIndexCapture({ ...capture, detectorEpoch: capture.detectorEpoch + 1 }),
    /project index capture identity/,
    "the detector ordering fence is part of a capture's immutable identity",
  );
  assert.equal(capture.indexManifest.instanceCount, 2);
  assert.equal(capture.revision.merkleRoot.length, 64);
  assert.equal(
    capture.sourceChunks.length > 1,
    true,
    "chunks stay below a multibyte-safe transport leaf",
  );
  assert.deepEqual(studioProjectIndexSourceDocuments(capture), [
    {
      documentId: "forge_attribute:existing-protocol",
      path: "ReplicatedStorage/Airlock/Protocol",
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: sourceCapture.manifest.sourceHash,
      source,
    },
  ]);
});

test("metadata project-index reads keep source chunks lazy and hash-verify the requested body", async () => {
  const sourceCapture = createStudioSourceBlobCapture({
    identity: stableIdentity,
    source,
    editorSource: true,
    transportChunkBytes: 7,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Airlock/Protocol",
        name: "Protocol",
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
        sourceManifestHash: sourceCapture.manifest.hash,
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection: projection(),
    shards: [shard],
    sourceManifests: [sourceCapture.manifest],
    sourceChunks: sourceCapture.chunks,
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const directory = await mkdtemp(`${tmpdir()}/forge-project-index-metadata-`);
  try {
    const store = new ImmutableJsonArtifactStore(directory);
    const binding = await writeCreatorProjectIndexArtifacts(store, capture);
    const metadata = await readCreatorProjectIndexMetadataArtifacts(store, binding);
    assert.deepEqual(metadata.view.scripts, [
      {
        documentId: "forge_attribute:existing-protocol",
        path: "ReplicatedStorage/Airlock/Protocol",
        className: "ModuleScript",
        executionContext: "shared",
        sourceHash: sourceCapture.manifest.sourceHash,
        utf8Bytes: Buffer.byteLength(source, "utf8"),
      },
    ]);
    const document = metadata.sourceDocuments[0]!;
    const page = await metadata.sourceResolver.readRange(document, {
      startByte: 0,
      endByte: document.utf8Bytes,
    });
    assert.deepEqual(page, { startByte: 0, endByte: document.utf8Bytes, source });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("index capture rejects missing leaves, source tampering, and resource overflow", () => {
  const sourceCapture = createStudioSourceBlobCapture({
    identity: stableIdentity,
    source,
    editorSource: false,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Protocol",
        name: "Protocol",
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
        sourceManifestHash: sourceCapture.manifest.hash,
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection: projection(),
    shards: [shard],
    sourceManifests: [sourceCapture.manifest],
    sourceChunks: sourceCapture.chunks,
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch: 0,
  });
  assert.throws(
    () => assertStudioProjectIndexCapture({ ...capture, sourceManifests: [] }),
    /missing source manifest/,
  );
  assert.throws(
    () =>
      assertStudioProjectIndexCapture({
        ...capture,
        sourceChunks: [{ ...sourceCapture.chunks[0]!, utf8: "tampered" }],
      }),
    /source blob chunk/,
  );
  const small = { ...CREATOR_DEFAULT_RESOURCE_POLICY, maximumNodesPerShard: 1 };
  const twoNodes = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/A",
        name: "A",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: ephemeralIdentity,
        displayPath: "ReplicatedStorage/B",
        name: "B",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
    ],
  });
  assert.throws(
    () =>
      createStudioProjectIndexCapture({
        projection: projection(small),
        shards: [twoNodes],
        sourceManifests: [],
        sourceChunks: [],
        completedAt: "2026-09-01T00:00:00.000Z",
        detectorEpoch: 0,
      }),
    /shard resource bound/,
  );
});

test("new index policy admits former snapshot ceilings while preserving source deduplication", () => {
  const source = `${"-- generated source\n".repeat(500_000)}return true\n`;
  assert.ok(
    Buffer.byteLength(source, "utf8") > 8 * 1024 * 1024,
    "fixture crosses the old aggregate evidence ceiling",
  );
  assert.ok(
    Buffer.byteLength(source, "utf8") > 48_000,
    "fixture crosses the old per-script ceiling",
  );
  const sourceCapture = createStudioSourceBlobCapture({
    identity: stableIdentity,
    source,
    editorSource: false,
  });
  assert.ok(
    sourceCapture.manifest.utf8Bytes < CREATOR_DEFAULT_RESOURCE_POLICY.maximumSourceBlobBytes,
  );
  const nodes: StudioProjectIndexNode[] = Array.from({ length: 2_049 }, (_, index) => ({
    identity: {
      kind: "forge_attribute" as const,
      stableId: `node-${index.toString().padStart(4, "0")}`,
    },
    displayPath: `ReplicatedStorage/Node${index.toString().padStart(4, "0")}`,
    name: `Node${index.toString().padStart(4, "0")}`,
    className: "Folder",
    attributes: {},
    tags: [],
    coveredProperties: {},
    coveredPropertyNames: [],
  }));
  nodes[0] = {
    ...nodes[0]!,
    identity: stableIdentity,
    displayPath: "ReplicatedStorage/SharedA",
    name: "SharedA",
    className: "ModuleScript",
    sourceManifestHash: sourceCapture.manifest.hash,
  };
  nodes[1] = {
    ...nodes[1]!,
    identity: { kind: "forge_attribute", stableId: "shared-source-b" },
    displayPath: "ReplicatedStorage/SharedB",
    name: "SharedB",
    className: "ModuleScript",
    sourceManifestHash: createStudioSourceBlobCapture({
      identity: { kind: "forge_attribute", stableId: "shared-source-b" },
      source,
      editorSource: false,
    }).manifest.hash,
  };
  const sourceCaptureB = createStudioSourceBlobCapture({
    identity: nodes[1]!.identity,
    source,
    editorSource: false,
  });
  const shards = Array.from(
    { length: Math.ceil(nodes.length / CREATOR_DEFAULT_RESOURCE_POLICY.maximumNodesPerShard) },
    (_, ordinal) =>
      createStudioProjectEvidenceShard({
        root: "ReplicatedStorage",
        ordinal,
        nodes: nodes.slice(
          ordinal * CREATOR_DEFAULT_RESOURCE_POLICY.maximumNodesPerShard,
          (ordinal + 1) * CREATOR_DEFAULT_RESOURCE_POLICY.maximumNodesPerShard,
        ),
      }),
  );
  const capture = createStudioProjectIndexCapture({
    projection: projection(),
    shards,
    sourceManifests: [sourceCapture.manifest, sourceCaptureB.manifest],
    // A shared source body is one content-addressed chunk sequence even when
    // distinct script manifests reference it.
    sourceChunks: sourceCapture.chunks,
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch: 0,
  });
  assertStudioProjectIndexCapture(capture);
  assert.equal(capture.indexManifest.instanceCount, 2_049);
  assert.ok(capture.indexManifest.canonicalBytes > 8 * 1024 * 1024);
  assert.equal(capture.sourceChunks.length, sourceCapture.chunks.length);
});

test("index start counts fragments rather than logical artifacts", () => {
  const sourceCapture = createStudioSourceBlobCapture({
    identity: stableIdentity,
    source,
    editorSource: false,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Protocol",
        name: "Protocol",
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
        sourceManifestHash: sourceCapture.manifest.hash,
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection: projection(),
    shards: [shard],
    sourceManifests: [sourceCapture.manifest],
    sourceChunks: sourceCapture.chunks,
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const artifactCount = 1 + 1 + sourceCapture.chunks.length;
  const message = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    type: "StudioProjectIndexStarted" as const,
    messageId: "studio_index_start_fragment_vector",
    sessionId: "studio_session_fragment_vector",
    sentAt: "2026-09-01T00:00:00.000Z",
    payload: {
      project,
      captureId: capture.indexManifest.id,
      projection: capture.projection,
      pieceCount: artifactCount + 1,
      expectedShardCount: 1,
      expectedSourceManifestCount: 1,
      expectedSourceChunkCount: sourceCapture.chunks.length,
      expectedCanonicalBytes: capture.indexManifest.canonicalBytes,
      detectorEpoch: 0,
    },
  };
  assert.doesNotThrow(() => assertPluginToBackendMessage(message));
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...message,
        payload: { ...message.payload, pieceCount: artifactCount - 1 },
      }),
    /StudioProjectIndexStarted/,
  );
});

test("connector epoch changes invalidate an otherwise identical project revision", () => {
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Protocol",
        name: "Protocol",
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
    ],
  });
  const captureAt = (epoch: string) =>
    createStudioProjectIndexCapture({
      projection: createStudioProjectIndexProjection({
        manifestHash,
        project,
        connectorEpoch: epoch,
        purpose: "creator_project_index",
        roots: ["ReplicatedStorage"],
        bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
      }),
      shards: [shard],
      sourceManifests: [],
      sourceChunks: [],
      completedAt: "2026-09-01T00:00:00.000Z",
      detectorEpoch: 0,
    });
  const before = captureAt("connector_epoch_before");
  const after = captureAt("connector_epoch_after");
  const delta = createCreatorProjectDelta(before, after);
  assert.equal(delta.changed, true);
  assert.deepEqual(delta.addedShardHashes, []);
  assert.deepEqual(delta.removedShardHashes, []);
  assert.notEqual(before.revision.hash, after.revision.hash);
  const changedPolicy = {
    ...before,
    revision: { ...before.revision, manifestHash: contentHash("new capability policy") },
  };
  assert.equal(createCreatorProjectDelta(before, changedPolicy).changed, true);
});

test("project deltas retain distinct complete captures when their semantic revision is unchanged", () => {
  const shard = createStudioProjectEvidenceShard({
    root: "ReplicatedStorage",
    ordinal: 0,
    nodes: [
      {
        identity: stableIdentity,
        displayPath: "ReplicatedStorage/Protocol",
        name: "Protocol",
        className: "ModuleScript",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
    ],
  });
  const captureAt = (detectorEpoch: number) =>
    createStudioProjectIndexCapture({
      projection: projection(),
      shards: [shard],
      sourceManifests: [],
      sourceChunks: [],
      completedAt: "2026-09-01T00:00:00.000Z",
      detectorEpoch,
    });
  const before = captureAt(4);
  const after = captureAt(5);
  const delta = createCreatorProjectDelta(before, after);

  assert.equal(before.revision.hash, after.revision.hash);
  assert.notEqual(before.hash, after.hash);
  assert.equal(delta.changed, false);
  assert.equal(delta.beforeCaptureHash, before.hash);
  assert.equal(delta.afterCaptureHash, after.hash);
});

test("control-process restart notices are explicit local refresh evidence", () => {
  const notice = createCreatorRestartChangeNotice({
    projectId: "studio_project_fixture",
    connectorEpoch,
    detectedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(notice.origin, "control_process_restart");
  assert.deepEqual(notice.reasons, ["control_process_restart"]);
  assert.equal(notice.detectorEpoch, 0);
});
