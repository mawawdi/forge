import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  canonicalStudioValue,
  compileMutationEvidenceProjectionForManifest,
  createStudioEvidenceEnvelope,
  studioEvidenceFactKey,
  studioObjectIdentityKey,
  type StudioEvidenceEnvelope,
  type StudioEvidenceFact,
  type StudioEvidenceProjection,
  type StudioValue,
} from "../packages/studio-evidence/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  createStudioSourceBlobCapture,
  studioProjectIndexMetadataView,
  type StudioProjectIndexCapture,
} from "../packages/studio-evidence/src/project-index.js";
import {
  adaptCreatorChangeSetMutationOperations,
  compileCreatorChangeSetMutationProjection,
  creatorDeleteSubtreesFromProjectIndex,
  creatorStructuralParentsFromProjectIndex,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  createIncompleteDurableIntentMutationAttempt,
  createMutationFailureFacts,
  reconcileCreatorMutation,
  replayCreatorMutation,
  type CreatorMutationChangeSetLike,
} from "../packages/creator-session/src/mutation-evidence.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import type {
  CreatorChangeSetDeleteSubtree,
  CreatorMutationSealedChangeSet,
  StudioInstanceEvidenceTarget,
} from "../packages/creator-session/src/mutation-evidence.js";
import { compileCreatorTransactionTopology } from "../packages/creator-session/src/transaction-topology.js";

const project = {
  name: "MutationEvidence",
  placeId: 0,
  universeId: 0,
} as const;
const target = {
  kind: "instance" as const,
  identity: { kind: "forge_attribute" as const, stableId: "door-folder" },
  path: "Workspace/Door",
  className: "Folder",
};

type ManifestProperty = (typeof STUDIO_CAPABILITY_MANIFEST.classes)[number]["properties"][number];

function defaultNumber(property: ManifestProperty): number {
  const minimum = "minimum" in property ? property.minimum : undefined;
  const exclusiveMinimum = "minimumExclusive" in property ? property.minimumExclusive : undefined;
  const maximum = "maximum" in property ? property.maximum : undefined;
  let value = exclusiveMinimum === undefined ? (minimum ?? 0) : exclusiveMinimum + 1;
  if (maximum !== undefined && value > maximum) value = maximum;
  return value;
}

/**
 * Index fixtures model Studio's complete manifest property surface. The
 * values are neutral unless a test explicitly overrides one, but their codec
 * and property bounds are intentional evidence obligations.
 */
function defaultProjectPropertyValue(property: ManifestProperty): StudioValue {
  const number = defaultNumber(property);
  switch (property.codec) {
    case "boolean":
      return { kind: "boolean", value: false };
    case "number_f32":
    case "number_f64":
      return { kind: property.codec, value: number };
    case "int32":
      return { kind: "int32", value: Math.trunc(number) };
    case "int64_decimal":
      return { kind: "int64_decimal", value: "0" };
    case "string_utf8":
      // Studio's default BasePart collision group is the registered group
      // named "Default". More generally, fixtures must satisfy every
      // manifest-declared text minimum rather than constructing a value the
      // engine could never report for that property.
      return {
        kind: "string_utf8",
        value:
          property.declaringClass === "BasePart" && property.name === "CollisionGroup"
            ? "Default"
            : "x".repeat(property.minimumUtf8Bytes ?? 0),
      };
    case "content":
      return { kind: "content", value: "rbxassetid://0" };
    case "color3_rgb8":
      return { kind: "color3_rgb8", r: 0, g: 0, b: 0 };
    case "vector2_f32":
      return { kind: "vector2_f32", x: number, y: number };
    case "vector3_f32":
      return { kind: "vector3_f32", x: number, y: number, z: number };
    case "cframe_f32x12":
      return {
        kind: "cframe_f32x12",
        components: [number, number, number, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      };
    case "udim":
      return { kind: "udim", scale: number, offset: Math.trunc(number) };
    case "udim2":
      return {
        kind: "udim2",
        x: { scale: number, offset: Math.trunc(number) },
        y: { scale: number, offset: Math.trunc(number) },
      };
    case "rect":
      return { kind: "rect", minX: number, minY: number, maxX: number, maxY: number };
    case "number_range":
      return { kind: "number_range", min: number, max: number };
    case "number_sequence":
      return {
        kind: "number_sequence",
        keypoints: [
          { time: 0, value: number, envelope: number },
          { time: 1, value: number, envelope: number },
        ],
      };
    case "color_sequence":
      return {
        kind: "color_sequence",
        keypoints: [
          { time: 0, color: { r: 0, g: 0, b: 0 } },
          { time: 1, color: { r: 0, g: 0, b: 0 } },
        ],
      };
    case "brick_color":
      return { kind: "brick_color", name: property.allowed?.[0] ?? "Medium stone grey" };
    case "font":
      return {
        kind: "font",
        family: "rbxasset://fonts/families/Arial.json",
        weight: "Regular",
        style: "Normal",
      };
    case "physical_properties":
      return {
        kind: "physical_properties",
        density: Math.max(1, number),
        friction: number,
        elasticity: number,
        frictionWeight: number,
        elasticityWeight: number,
      };
    case "axes":
      return { kind: "axes", x: false, y: false, z: false };
    case "faces":
      return {
        kind: "faces",
        top: false,
        bottom: false,
        left: false,
        right: false,
        front: false,
        back: false,
      };
    case "ray":
      return {
        kind: "ray",
        origin: { x: number, y: number, z: number },
        direction: { x: number, y: number, z: number },
      };
    case "instance_ref":
      return {
        kind: "instance_ref",
        state: "nil",
        expectedClass: property.referenceClass ?? "Instance",
      };
    case "enum_name":
      return { kind: "enum_name", value: property.allowed?.[0] ?? "Default" };
  }
}

/**
 * Project-index records are canonical JSON all the way down, including the
 * key order within a tagged Studio value. Keep fixtures on the same wire form
 * as collector output rather than accidentally testing a looser host shape.
 */
function canonicalFixtureStudioValue(value: StudioValue): StudioValue {
  return JSON.parse(stableJson(canonicalStudioValue(value))) as StudioValue;
}

function completeProjectProperties(
  className: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const metadata = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
  if (metadata === undefined) return overrides;
  return Object.fromEntries(
    metadata.properties
      .map((property) => [
        property.name,
        canonicalFixtureStudioValue(
          (Object.hasOwn(overrides, property.name)
            ? overrides[property.name]
            : defaultProjectPropertyValue(property)) as StudioValue,
        ),
      ])
      // `stableJson` orders record keys by their raw JavaScript string order,
      // not the locale-sensitive display collation used by `localeCompare`.
      // Fixture records must model the exact on-wire canonical order.
      .sort(([left], [right]) => {
        const leftName = String(left);
        const rightName = String(right);
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      }),
  );
}
const changeSetHash = "a".repeat(64);
const binding = {
  sessionId: "creator-session-mutation",
  changeSetHash,
  approvalHash: "b".repeat(64),
  revisionHash: "c".repeat(64),
  buildHash: "d".repeat(64),
  dashboardReviewHash: "e".repeat(64),
};
const changeSet: CreatorMutationChangeSetLike = {
  kind: "CreatorChangeSet",
  id: "creator-change-mutation",
  hash: changeSetHash,
  project,
  binding,
  projectionId: "creator-mutation-direct",
  operations: [{ id: "set-open", kind: "update", target, attributes: { Open: false } }],
};

test("created script mutation proof is bound to its immutable source blob hash", () => {
  const sourceHash = "f".repeat(64);
  const operations = adaptCreatorChangeSetMutationOperations(
    {
      id: "creator-change-script-create",
      hash: "1".repeat(64),
      sessionId: "creator-session-script-create",
      expectedRevisionHash: "2".repeat(64),
      buildContractHash: "3".repeat(64),
      operations: [
        {
          id: "create-server-script",
          kind: "create",
          target: {
            kind: "instance",
            identity: {
              kind: "forge_attribute",
              stableId: "created-server-script",
            },
            path: "ServerScriptService/Created",
            className: "Script",
          },
          parent: {
            kind: "engine_container",
            path: "ServerScriptService",
            className: "ServerScriptService",
          },
          className: "Script",
          name: "Created",
          properties: {},
          attributes: {},
          sourceBlob: {
            manifestId: "creator_source_write_blob_manifest_fixture",
            manifestHash: "4".repeat(64),
            sourceHash,
            utf8Bytes: 13,
          },
        },
      ],
    },
    [
      {
        identity: { kind: "forge_attribute", stableId: "server-script-service" },
        path: "ServerScriptService",
        name: "ServerScriptService",
        className: "ServerScriptService",
        engineContainer: {
          path: "ServerScriptService",
          className: "ServerScriptService",
        },
      },
    ],
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.sourceHash, sourceHash);
});

test("mutation evidence rewrites every enrolled post-state edge and instance reference", () => {
  const parent = ephemeralTarget("11", "Workspace/Parent", "Folder");
  const child = ephemeralTarget("12", "Workspace/Parent/Child", "Part");
  const moved = ephemeralTarget("13", "Workspace/Moved", "Part");
  const sealed: CreatorMutationSealedChangeSet = {
    id: "creator-change-transaction-wide-enrollment",
    hash: "1".repeat(64),
    sessionId: "creator-session-transaction-wide-enrollment",
    expectedRevisionHash: "2".repeat(64),
    buildContractHash: "3".repeat(64),
    operations: [
      {
        id: "enroll-parent",
        kind: "update",
        target: parent,
        enrollment: {
          identity: parent.identity as Extract<
            typeof parent.identity,
            { kind: "studio_ephemeral" }
          >,
          stableId: "durable-parent",
        },
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "enroll-child-and-link",
        kind: "update",
        target: child,
        enrollment: {
          identity: child.identity as Extract<typeof child.identity, { kind: "studio_ephemeral" }>,
          stableId: "durable-child",
        },
        properties: {
          ParentLink: {
            kind: "instance_ref",
            state: "reference",
            expectedClass: "Instance",
            identity: parent.identity,
            path: parent.path,
            className: parent.className,
          },
          SelfLink: {
            kind: "instance_ref",
            state: "reference",
            expectedClass: "Instance",
            identity: child.identity,
            path: child.path,
            className: child.className,
          },
        },
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "create-under-enrolled-child",
        kind: "create",
        target: durableTarget("created-under-child", "Workspace/Parent/Child/New", "Folder"),
        parent: child,
        className: "Folder",
        name: "New",
        properties: {},
        attributes: {},
      },
      {
        id: "move-and-enroll-under-child",
        kind: "move",
        target: moved,
        enrollment: {
          identity: moved.identity as Extract<typeof moved.identity, { kind: "studio_ephemeral" }>,
          stableId: "durable-moved",
        },
        parent: child,
        name: "Moved",
        properties: {
          SelfLink: {
            kind: "instance_ref",
            state: "reference",
            expectedClass: "Instance",
            identity: moved.identity,
            path: moved.path,
            className: moved.className,
          },
        },
        attributes: {},
        removedAttributes: [],
      },
    ],
  };

  const operations = adaptCreatorChangeSetMutationOperations(
    sealed,
    topologyFromCapture(
      projectCapture([
        { target: parent },
        { target: child, parentIdentity: parent.identity },
        { target: moved },
      ]),
    ),
  );
  const childUpdate = operations.find((operation) => operation.id === "enroll-child-and-link");
  const create = operations.find((operation) => operation.id === "create-under-enrolled-child");
  const move = operations.find((operation) => operation.id === "move-and-enroll-under-child");
  assert.ok(childUpdate && childUpdate.kind === "update");
  assert.ok(create && create.kind === "create");
  assert.ok(move && move.kind === "move");
  assert.equal(childUpdate.target.kind, "instance");
  assert.equal(move.target.kind, "instance");

  assert.deepEqual(childUpdate.beforeTarget, child);
  assert.deepEqual(childUpdate.target.identity, {
    kind: "forge_attribute",
    stableId: "durable-child",
  });
  assert.deepEqual(childUpdate.properties?.ParentLink, {
    kind: "instance_ref",
    state: "reference",
    expectedClass: "Instance",
    identity: { kind: "forge_attribute", stableId: "durable-parent" },
    path: parent.path,
    className: parent.className,
  });
  assert.deepEqual(childUpdate.properties?.SelfLink, {
    kind: "instance_ref",
    state: "reference",
    expectedClass: "Instance",
    identity: { kind: "forge_attribute", stableId: "durable-child" },
    path: child.path,
    className: child.className,
  });
  assert.deepEqual(create.structure?.parentIdentity, {
    kind: "forge_attribute",
    stableId: "durable-child",
  });
  assert.deepEqual(move.beforeTarget, moved);
  assert.deepEqual(move.target.identity, {
    kind: "forge_attribute",
    stableId: "durable-moved",
  });
  assert.equal(move.target.path, "Workspace/Parent/Child/Moved");
  assert.deepEqual(move.structure?.parentIdentity, {
    kind: "forge_attribute",
    stableId: "durable-child",
  });
  assert.deepEqual(move.properties?.SelfLink, {
    kind: "instance_ref",
    state: "reference",
    expectedClass: "Instance",
    identity: { kind: "forge_attribute", stableId: "durable-moved" },
    path: "Workspace/Parent/Child/Moved",
    className: moved.className,
  });
});

test("mutation evidence takes all final paths from one topology before identity enrollment", () => {
  const parent = ephemeralTarget("31", "Workspace/Legacy", "Folder");
  const descendant = ephemeralTarget("32", "Workspace/Legacy/Child", "Part");
  const before = projectCapture([
    {
      target: parent,
      parentIdentity: {
        kind: "forge_attribute",
        stableId: "project-capture-workspace",
      },
    },
    { target: descendant, parentIdentity: parent.identity },
  ]);
  const unsortedSealed: CreatorMutationSealedChangeSet = {
    id: "creator-change-topology-final-paths",
    hash: "7".repeat(64),
    sessionId: "creator-session-topology-final-paths",
    expectedRevisionHash: before.revision.hash,
    buildContractHash: "8".repeat(64),
    operations: [
      {
        id: "update-descendant-before-ancestor-move",
        kind: "update",
        target: descendant,
        enrollment: {
          identity: descendant.identity as Extract<
            typeof descendant.identity,
            { kind: "studio_ephemeral" }
          >,
          stableId: "durable-descendant",
        },
        properties: {
          SelfLink: {
            kind: "instance_ref",
            state: "reference",
            expectedClass: "Instance",
            identity: descendant.identity,
            path: descendant.path,
            className: descendant.className,
          },
        },
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "create-under-moved-parent",
        kind: "create",
        target: durableTarget("created-after-parent-move", "Workspace/Modern/New", "Folder"),
        // Existing parents remain exact pre-Apply handles even though this
        // create declares its calculated final target path.
        parent,
        className: "Folder",
        name: "New",
        properties: {
          DescendantLink: {
            kind: "instance_ref",
            state: "reference",
            expectedClass: "Instance",
            identity: descendant.identity,
            path: descendant.path,
            className: descendant.className,
          },
        },
        attributes: {},
      },
      {
        id: "move-and-enroll-ancestor",
        kind: "move",
        target: parent,
        enrollment: {
          identity: parent.identity as Extract<
            typeof parent.identity,
            { kind: "studio_ephemeral" }
          >,
          stableId: "durable-parent",
        },
        parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
        name: "Modern",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
    ],
  };

  const sealed: CreatorMutationSealedChangeSet = {
    ...unsortedSealed,
    operations: compileCreatorTransactionTopology({
      initial: topologyFromCapture(before),
      operations: unsortedSealed.operations,
    }).orderedOperations,
  };

  assert.deepEqual(
    creatorDeleteSubtreesFromProjectIndex(sealed, before),
    [],
    "delete-subtree derivation must accept topology-valid creates below a moved parent",
  );
  const operations = adaptCreatorChangeSetMutationOperations(sealed, topologyFromCapture(before));
  const update = operations.find(
    (operation) => operation.id === "update-descendant-before-ancestor-move",
  );
  const create = operations.find((operation) => operation.id === "create-under-moved-parent");
  const move = operations.find((operation) => operation.id === "move-and-enroll-ancestor");
  assert.ok(update && update.kind === "update");
  assert.ok(create && create.kind === "create");
  assert.ok(move && move.kind === "move");
  assert.equal(update.target.kind, "instance");
  assert.equal(create.target.kind, "instance");
  assert.equal(move.target.kind, "instance");

  assert.deepEqual(update.beforeTarget, descendant);
  assert.equal(update.target.path, "Workspace/Modern/Child");
  assert.deepEqual(update.target.identity, {
    kind: "forge_attribute",
    stableId: "durable-descendant",
  });
  assert.deepEqual(update.properties?.SelfLink, {
    kind: "instance_ref",
    state: "reference",
    expectedClass: "Instance",
    identity: { kind: "forge_attribute", stableId: "durable-descendant" },
    path: "Workspace/Modern/Child",
    className: descendant.className,
  });
  assert.equal(create.target.path, "Workspace/Modern/New");
  assert.equal(create.structure?.parentPath, "Workspace/Modern");
  assert.deepEqual(create.structure?.parentIdentity, {
    kind: "forge_attribute",
    stableId: "durable-parent",
  });
  assert.deepEqual(create.properties?.DescendantLink, {
    kind: "instance_ref",
    state: "reference",
    expectedClass: "Instance",
    identity: { kind: "forge_attribute", stableId: "durable-descendant" },
    path: "Workspace/Modern/Child",
    className: descendant.className,
  });
  assert.equal(move.target.path, "Workspace/Modern");
  assert.deepEqual(move.target.identity, {
    kind: "forge_attribute",
    stableId: "durable-parent",
  });
});

test("mutation evidence rejects colliding and contradictory identity enrollments", () => {
  const first = ephemeralTarget("21", "Workspace/First", "Folder");
  const second = ephemeralTarget("22", "Workspace/Second", "Folder");
  const base = {
    id: "creator-change-enrollment-collision",
    hash: "4".repeat(64),
    sessionId: "creator-session-enrollment-collision",
    expectedRevisionHash: "5".repeat(64),
    buildContractHash: "6".repeat(64),
  } as const;
  const update = (id: string, target: StudioInstanceEvidenceTarget, stableId: string) => ({
    id,
    kind: "update" as const,
    target,
    enrollment: {
      identity: target.identity as Extract<typeof target.identity, { kind: "studio_ephemeral" }>,
      stableId,
    },
    properties: {},
    attributes: {},
    removedAttributes: [],
  });

  assert.throws(
    () =>
      adaptCreatorChangeSetMutationOperations(
        {
          ...base,
          operations: [
            update("first", first, "shared-durable"),
            update("second", second, "shared-durable"),
          ],
        },
        topologyFromCapture(projectCapture([{ target: first }, { target: second }])),
      ),
    /colliding post-state identity enrollment/,
  );
  assert.throws(
    () =>
      adaptCreatorChangeSetMutationOperations(
        {
          ...base,
          operations: [
            update("first", first, "first-durable"),
            update("second", first, "other-durable"),
          ],
        },
        topologyFromCapture(projectCapture([{ target: first }])),
      ),
    /permits only one operation per identity/,
  );
});

test("mutation projection rejects implicit or malformed before/post target semantics", () => {
  const prior = ephemeralTarget("9", "Workspace/Before", "Folder");
  const moved = durableTarget("after-folder", "Workspace/After", "Folder");
  const projectionInput = {
    id: "creator-mutation-transition-validation",
    project,
    binding,
    purpose: "mutation_direct_readback" as const,
  };
  assert.throws(
    () =>
      compileMutationEvidenceProjectionForManifest(
        {
          ...projectionInput,
          operations: [
            {
              id: "move-without-before",
              kind: "move",
              target: moved,
              structure: {
                identity: moved.identity,
                path: moved.path,
                className: moved.className,
                parentPath: "Workspace",
              },
            },
          ],
        },
        STUDIO_CAPABILITY_MANIFEST,
        STUDIO_CAPABILITY_MANIFEST_HASH,
      ),
    /mutation move before target/,
  );
  assert.throws(
    () =>
      compileMutationEvidenceProjectionForManifest(
        {
          ...projectionInput,
          operations: [
            {
              id: "update-with-nontransition",
              kind: "update",
              beforeTarget: moved,
              target: moved,
              attributes: { Open: false },
            },
          ],
        },
        STUDIO_CAPABILITY_MANIFEST,
        STUDIO_CAPABILITY_MANIFEST_HASH,
      ),
    /mutation identity transition/,
  );
  assert.doesNotThrow(() =>
    compileMutationEvidenceProjectionForManifest(
      {
        ...projectionInput,
        operations: [
          {
            id: "move-with-exact-before",
            kind: "move",
            beforeTarget: prior,
            target: moved,
            structure: {
              identity: moved.identity,
              path: moved.path,
              className: moved.className,
              parentPath: "Workspace",
            },
          },
        ],
      },
      STUDIO_CAPABILITY_MANIFEST,
      STUDIO_CAPABILITY_MANIFEST_HASH,
    ),
  );
});

test("delete proof follows opaque identity edges without inventing a project-delta authority", () => {
  const rootIdentity = { kind: "forge_attribute" as const, stableId: "selected-root" };
  const otherRootIdentity = { kind: "forge_attribute" as const, stableId: "other-root" };
  const opaqueIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: "creator-connector-epoch",
    opaqueHash: "1".repeat(64),
  };
  const otherOpaqueIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: "creator-connector-epoch",
    opaqueHash: "2".repeat(64),
  };
  const nestedIdentity = { kind: "forge_attribute" as const, stableId: "nested-part" };
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "creator-connector-epoch",
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "Workspace",
    ordinal: 0,
    nodes: [
      {
        identity: rootIdentity,
        displayPath: "Workspace/Duplicate",
        name: "Duplicate",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: otherRootIdentity,
        displayPath: "Workspace/Duplicate",
        name: "Duplicate",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: opaqueIdentity,
        parentIdentity: rootIdentity,
        displayPath: "Workspace/Duplicate/Snap",
        name: "Snap",
        className: "Snap",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: otherOpaqueIdentity,
        parentIdentity: otherRootIdentity,
        displayPath: "Workspace/Duplicate/Snap",
        name: "Snap",
        className: "Snap",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
      {
        identity: nestedIdentity,
        parentIdentity: opaqueIdentity,
        displayPath: "Workspace/Duplicate/Snap/Nested",
        name: "Nested",
        className: "Part",
        attributes: {},
        tags: [],
        coveredProperties: completeProjectProperties("Part"),
        coveredPropertyNames: Object.keys(completeProjectProperties("Part")).sort(),
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection,
    shards: [shard],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-02T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const sealed = {
    id: "creator-change-delete-opaque",
    hash: "3".repeat(64),
    sessionId: "creator-session-delete-opaque",
    expectedRevisionHash: capture.revision.hash,
    buildContractHash: "4".repeat(64),
    operations: [
      {
        id: "delete-selected-root",
        kind: "delete" as const,
        target: {
          kind: "instance" as const,
          identity: rootIdentity,
          path: "Workspace/Duplicate",
          className: "Folder",
        },
      },
    ],
  };
  const subtrees = creatorDeleteSubtreesFromProjectIndex(sealed, capture);
  assert.deepEqual(
    subtrees[0]?.descendants.map((entry) => studioObjectIdentityKey(entry.identity)).sort(),
    [studioObjectIdentityKey(opaqueIdentity), studioObjectIdentityKey(nestedIdentity)].sort(),
    "same-path siblings outside the selected opaque identity subtree stay untouched",
  );
  const extractedNestedSealed = {
    ...sealed,
    id: "creator-change-delete-opaque-with-extraction",
    hash: "7".repeat(64),
    operations: [
      {
        id: "a-extract-nested-part",
        kind: "move" as const,
        target: {
          kind: "instance" as const,
          identity: nestedIdentity,
          path: "Workspace/Duplicate/Snap/Nested",
          className: "Part",
        },
        // This parent has the same display path as the delete root, but a
        // distinct opaque identity. The transaction must preserve the move
        // and exclude the extracted Part from delete-absence obligations.
        parent: {
          kind: "instance" as const,
          identity: otherRootIdentity,
          path: "Workspace/Duplicate",
          className: "Folder",
        },
        name: "Nested",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
      sealed.operations[0]!,
    ],
  };
  assert.deepEqual(
    creatorDeleteSubtreesFromProjectIndex(extractedNestedSealed, capture)[0]?.descendants.map(
      (entry) => studioObjectIdentityKey(entry.identity),
    ),
    [studioObjectIdentityKey(opaqueIdentity)],
    "only identities in the final delete closure receive consequential absence obligations",
  );
  const evidence = compileCreatorChangeSetMutationProjection(sealed, {
    project,
    binding: {
      sessionId: sealed.sessionId,
      changeSetHash: sealed.hash,
      approvalHash: "5".repeat(64),
      revisionHash: sealed.expectedRevisionHash,
      buildHash: sealed.buildContractHash,
      dashboardReviewHash: "6".repeat(64),
    },
    initialTopology: topologyFromCapture(capture),
    deletedSubtrees: subtrees,
  });
  assert.equal("allowedProjectDelta" in evidence, false);
  assert.deepEqual(
    evidence.requirements
      .map((requirement) => ({
        className: requirement.target.kind === "instance" ? requirement.target.className : "",
        status: requirement.expectedStatus,
      }))
      .sort((left, right) => left.className.localeCompare(right.className)),
    [
      { className: "Folder", status: "absent" },
      { className: "Part", status: "absent" },
      { className: "Snap", status: "absent" },
    ],
  );
});

function directProjection(): StudioEvidenceProjection {
  return compileMutationEvidenceProjectionForManifest(
    {
      id: changeSet.projectionId,
      project,
      binding,
      operations: changeSet.operations,
      purpose: "mutation_direct_readback",
    },
    STUDIO_CAPABILITY_MANIFEST,
    STUDIO_CAPABILITY_MANIFEST_HASH,
  );
}
function preflightProjection(): StudioEvidenceProjection {
  return compileMutationEvidenceProjectionForManifest(
    {
      id: "creator-mutation-preflight",
      project,
      binding,
      operations: changeSet.operations,
      purpose: "mutation_preflight",
    },
    STUDIO_CAPABILITY_MANIFEST,
    STUDIO_CAPABILITY_MANIFEST_HASH,
  );
}
function exactAttributeEnvelope(
  projection: StudioEvidenceProjection,
  value: boolean | "unavailable",
): StudioEvidenceEnvelope {
  const facts: StudioEvidenceFact[] = projection.requirements.map((requirement) => {
    assert.equal(requirement.kind, "attribute");
    assert.equal(requirement.attributeName, "Open");
    return {
      kind: "attribute" as const,
      key: studioEvidenceFactKey("attribute", target, "Open"),
      target,
      attributeName: "Open",
      result:
        value === "unavailable"
          ? { status: "unavailable" as const, code: "not_read" }
          : { status: "observed" as const, value },
    };
  });
  return createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts,
    },
    value === false ? projection : undefined,
  );
}

function indexCapture(
  open: boolean,
  options: { readonly tags?: readonly string[]; readonly source?: string } = {},
): StudioProjectIndexCapture {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "creator-connector-epoch",
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const source =
    options.source === undefined
      ? undefined
      : createStudioSourceBlobCapture({
          identity: target.identity,
          source: options.source,
          editorSource: false,
        });
  const node = {
    identity: target.identity,
    displayPath: target.path,
    name: target.path.slice(target.path.lastIndexOf("/") + 1),
    className: target.className,
    attributes: { Open: open },
    tags: [...(options.tags ?? [])].sort(),
    coveredProperties: {},
    coveredPropertyNames: [],
    ...(source === undefined ? {} : { sourceManifestHash: source.manifest.hash }),
  };
  const shard = createStudioProjectEvidenceShard({
    root: "Workspace",
    ordinal: 0,
    nodes: [node],
  });
  return createStudioProjectIndexCapture({
    projection,
    shards: [shard],
    sourceManifests: source === undefined ? [] : [source.manifest],
    sourceChunks: source === undefined ? [] : source.chunks,
    completedAt: "2026-09-01T00:00:02.000Z",
    detectorEpoch: 0,
  });
}

function reconciliationInput(
  options: {
    readonly direct?: StudioEvidenceEnvelope;
    readonly before?: StudioProjectIndexCapture;
    readonly after?: StudioProjectIndexCapture;
  } = {},
) {
  const projection = directProjection();
  const preflight = preflightProjection();
  return {
    sessionId: binding.sessionId,
    attemptId: "mutation-attempt",
    manifest: STUDIO_CAPABILITY_MANIFEST,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    changeSet,
    projection,
    preflight: {
      projection: preflight,
      envelope: exactAttributeEnvelope(preflight, false),
    },
    directReadback: options.direct ?? exactAttributeEnvelope(projection, false),
    beforeIndexCapture: options.before ?? indexCapture(true),
    afterIndexCapture: options.after ?? indexCapture(false),
  };
}

const enrollmentEpoch = "creator-enrollment-epoch";
function ephemeralTarget(
  suffix: string,
  path: string,
  className: string,
): StudioInstanceEvidenceTarget {
  return {
    kind: "instance",
    identity: {
      kind: "studio_ephemeral",
      connectorEpoch: enrollmentEpoch,
      opaqueHash: suffix.padStart(64, "0"),
    },
    path,
    className,
  };
}

function durableTarget(
  stableId: string,
  path: string,
  className: string,
): StudioInstanceEvidenceTarget {
  return {
    kind: "instance",
    identity: { kind: "forge_attribute", stableId },
    path,
    className,
  };
}

function projectCapture(
  nodes: readonly {
    readonly target: StudioInstanceEvidenceTarget;
    readonly parentIdentity?: StudioInstanceEvidenceTarget["identity"];
    readonly engineContainer?: { readonly path: string; readonly className: string };
    readonly attributes?: Readonly<Record<string, string | number | boolean>>;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly tags?: readonly string[];
    readonly source?: string;
  }[],
): StudioProjectIndexCapture {
  const workspace = durableTarget("project-capture-workspace", "Workspace", "Workspace");
  const indexedNodes = [
    {
      target: workspace,
      engineContainer: { path: "Workspace", className: "Workspace" },
    },
    ...nodes,
  ];
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: enrollmentEpoch,
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const sources = indexedNodes.flatMap((entry) =>
    entry.source === undefined
      ? []
      : [
          createStudioSourceBlobCapture({
            identity: entry.target.identity,
            source: entry.source,
            editorSource: false,
          }),
        ],
  );
  const sourceByIdentity = new Map(
    sources.map((source) => [studioObjectIdentityKey(source.manifest.identity), source] as const),
  );
  const shard = createStudioProjectEvidenceShard({
    root: "Workspace",
    ordinal: 0,
    nodes: indexedNodes.map((entry) => {
      const source = sourceByIdentity.get(studioObjectIdentityKey(entry.target.identity));
      const properties = completeProjectProperties(entry.target.className, entry.properties);
      return {
        identity: entry.target.identity,
        ...(entry.parentIdentity === undefined ? {} : { parentIdentity: entry.parentIdentity }),
        ...(entry.engineContainer === undefined ? {} : { engineContainer: entry.engineContainer }),
        displayPath: entry.target.path,
        name: entry.target.path.slice(entry.target.path.lastIndexOf("/") + 1),
        className: entry.target.className,
        attributes: entry.attributes ?? {},
        tags: [...(entry.tags ?? [])].sort(),
        coveredProperties: properties,
        coveredPropertyNames: Object.keys(properties).sort(),
        ...(source === undefined ? {} : { sourceManifestHash: source.manifest.hash }),
      };
    }),
  });
  return createStudioProjectIndexCapture({
    projection,
    shards: [shard],
    sourceManifests: sources.map((source) => source.manifest),
    sourceChunks: sources.flatMap((source) => source.chunks),
    completedAt: "2026-09-03T00:00:00.000Z",
    detectorEpoch: 0,
  });
}

function topologyFromCapture(capture: StudioProjectIndexCapture) {
  return studioProjectIndexMetadataView(capture).instances;
}

function exactMutationEnvelope(projection: StudioEvidenceProjection): StudioEvidenceEnvelope {
  const facts = projection.requirements.map((requirement) => {
    const status = requirement.expectedStatus ?? "observed";
    const result =
      status === "absent"
        ? ({ status: "absent" } as const)
        : ({ status: "observed", value: requirement.expected } as const);
    return {
      kind: requirement.kind,
      key: requirement.key,
      target: requirement.target,
      ...(requirement.propertyName === undefined ? {} : { propertyName: requirement.propertyName }),
      ...(requirement.attributeName === undefined
        ? {}
        : { attributeName: requirement.attributeName }),
      result,
    } as StudioEvidenceFact;
  });
  return createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-03T00:00:01.000Z",
      endedAt: "2026-09-03T00:00:02.000Z",
      completion: "complete",
      facts,
    },
    projection,
  );
}

function enrolledReconciliationInput(
  sealed: CreatorMutationSealedChangeSet,
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
  deletedSubtrees: readonly CreatorChangeSetDeleteSubtree[] = [],
) {
  const structuralParents = creatorStructuralParentsFromProjectIndex(sealed, before);
  const enrollmentBinding = {
    sessionId: sealed.sessionId,
    changeSetHash: sealed.hash,
    approvalHash: "5".repeat(64),
    revisionHash: sealed.expectedRevisionHash,
    buildHash: sealed.buildContractHash,
    dashboardReviewHash: "6".repeat(64),
  };
  const projection = compileCreatorChangeSetMutationProjection(sealed, {
    project,
    binding: enrollmentBinding,
    initialTopology: topologyFromCapture(before),
    deletedSubtrees,
    structuralParents,
  });
  const preflightProjection = compileCreatorChangeSetMutationProjection(sealed, {
    project,
    binding: enrollmentBinding,
    initialTopology: topologyFromCapture(before),
    deletedSubtrees,
    structuralParents,
    purpose: "mutation_preflight",
  });
  const evidenceChangeSet: CreatorMutationChangeSetLike = {
    kind: "CreatorChangeSet",
    id: sealed.id,
    hash: sealed.hash,
    project,
    binding: enrollmentBinding,
    projectionId: projection.id,
    operations: adaptCreatorChangeSetMutationOperations(
      sealed,
      topologyFromCapture(before),
      deletedSubtrees,
      structuralParents,
    ),
  };
  return {
    sessionId: sealed.sessionId,
    attemptId: `${sealed.id}-attempt`,
    manifest: STUDIO_CAPABILITY_MANIFEST,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    changeSet: evidenceChangeSet,
    projection,
    preflight: {
      projection: preflightProjection,
      envelope: exactMutationEnvelope(preflightProjection),
    },
    directReadback: exactMutationEnvelope(projection),
    beforeIndexCapture: before,
    afterIndexCapture: after,
  };
}

function sealedEnrollmentChange(
  id: string,
  operation: CreatorMutationSealedChangeSet["operations"][number],
  before: StudioProjectIndexCapture,
): CreatorMutationSealedChangeSet {
  return {
    id,
    hash: contentHash(id),
    sessionId: `${id}-session`,
    expectedRevisionHash: before.revision.hash,
    buildContractHash: "7".repeat(64),
    operations: [operation],
  };
}

test("enrolled update reconciles one logical object without masking collateral drift", () => {
  const prior = ephemeralTarget("1", "Workspace/Existing", "Folder");
  const next = durableTarget("existing-folder", prior.path, prior.className);
  const before = projectCapture([{ target: prior, attributes: { Open: true } }]);
  const after = projectCapture([{ target: next, attributes: { Open: false } }]);
  const sealed = sealedEnrollmentChange(
    "creator-change-enrolled-update",
    {
      id: "update-existing",
      kind: "update",
      target: prior,
      enrollment: {
        identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
        stableId: "existing-folder",
      },
      properties: {},
      attributes: { Open: false },
      removedAttributes: [],
    },
    before,
  );
  const input = enrolledReconciliationInput(sealed, before, after);
  const matched = reconcileCreatorMutation(input);
  assert.equal(matched.status, "matched", JSON.stringify(matched.failureFacts));

  const drifted = reconcileCreatorMutation({
    ...input,
    afterIndexCapture: projectCapture([
      { target: next, attributes: { Open: false }, tags: ["Unapproved"] },
    ]),
  });
  assert.equal(drifted.status, "mismatched");
  assert.equal(
    drifted.failureFacts.some(
      (fact) => fact.code === "unapproved_index_delta" && fact.detail.includes(":tags"),
    ),
    true,
  );
});

test("enrolled property update requires and accepts complete manifest property coverage", () => {
  const prior = ephemeralTarget("6", "Workspace/ExistingPart", "Part");
  const next = durableTarget("existing-part", prior.path, prior.className);
  const before = projectCapture([
    {
      target: prior,
      properties: { Anchored: { kind: "boolean", value: false } },
    },
  ]);
  const after = projectCapture([
    {
      target: next,
      properties: { Anchored: { kind: "boolean", value: true } },
    },
  ]);
  const sealed = sealedEnrollmentChange(
    "creator-change-enrolled-property-update",
    {
      id: "update-existing-part",
      kind: "update",
      target: prior,
      enrollment: {
        identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
        stableId: "existing-part",
      },
      properties: { Anchored: { kind: "boolean", value: true } },
      attributes: {},
      removedAttributes: [],
    },
    before,
  );
  const input = enrolledReconciliationInput(sealed, before, after);
  const matched = reconcileCreatorMutation(input);
  assert.equal(matched.status, "matched", JSON.stringify(matched.failureFacts));

  const missingCoverage = reconcileCreatorMutation({
    ...input,
    afterIndexCapture: projectCapture([{ target: next }]),
  });
  assert.equal(missingCoverage.status, "mismatched");
  assert.equal(
    missingCoverage.failureFacts.some(
      (fact) => fact.code === "approved_property_not_reflected" && fact.detail.includes("Anchored"),
    ),
    true,
  );
});

test("created instance reconciliation accepts complete observed defaults while proving approved properties", () => {
  const created = durableTarget("created-part", "Workspace/CreatedPart", "Part");
  const workspaceIdentity = {
    kind: "forge_attribute" as const,
    stableId: "project-capture-workspace",
  };
  const before = projectCapture([]);
  const after = projectCapture([
    {
      target: created,
      parentIdentity: workspaceIdentity,
      properties: {
        Anchored: { kind: "boolean", value: true },
        CanCollide: { kind: "boolean", value: true },
      },
    },
  ]);
  const id = "creator-change-created-property-proof";
  const sealed: CreatorMutationSealedChangeSet = {
    id,
    hash: contentHash(id),
    sessionId: `${id}-session`,
    expectedRevisionHash: before.revision.hash,
    buildContractHash: "8".repeat(64),
    operations: [
      {
        id: "create-part",
        kind: "create",
        target: created,
        parent: {
          kind: "engine_container",
          path: "Workspace",
          className: "Workspace",
        },
        className: "Part",
        name: "CreatedPart",
        properties: { Anchored: { kind: "boolean", value: true } },
        attributes: {},
      },
    ],
  };
  const reconciliation = reconcileCreatorMutation(
    enrolledReconciliationInput(sealed, before, after),
  );
  assert.equal(reconciliation.status, "matched", JSON.stringify(reconciliation.failureFacts));
});

test("enrolled move reconciles the root identity and complete descendant structure", () => {
  const prior = ephemeralTarget("2", "Workspace/Old", "Folder");
  const next = durableTarget("moved-folder", "Workspace/New", "Folder");
  const child = durableTarget("moved-child", "Workspace/Old/Child", "Part");
  const movedChild = { ...child, path: "Workspace/New/Child" };
  const before = projectCapture([
    { target: prior },
    { target: child, parentIdentity: prior.identity },
  ]);
  const after = projectCapture([
    { target: next },
    { target: movedChild, parentIdentity: next.identity },
  ]);
  const sealed = sealedEnrollmentChange(
    "creator-change-enrolled-move",
    {
      id: "move-existing",
      kind: "move",
      target: prior,
      enrollment: {
        identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
        stableId: "moved-folder",
      },
      parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
      name: "New",
      properties: {},
      attributes: {},
      removedAttributes: [],
    },
    before,
  );
  const reconciliation = reconcileCreatorMutation(
    enrolledReconciliationInput(sealed, before, after),
  );
  assert.equal(reconciliation.status, "matched", JSON.stringify(reconciliation.failureFacts));
});

test("enrolled delete reconciles the pre-identity and its indexed descendants", () => {
  const prior = ephemeralTarget("3", "Workspace/DeleteMe", "Folder");
  const child = durableTarget("deleted-child", "Workspace/DeleteMe/Child", "Part");
  const before = projectCapture([
    { target: prior },
    { target: child, parentIdentity: prior.identity },
  ]);
  const after = projectCapture([]);
  const sealed = sealedEnrollmentChange(
    "creator-change-enrolled-delete",
    {
      id: "delete-existing",
      kind: "delete",
      target: prior,
      enrollment: {
        identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
        stableId: "deleted-folder",
      },
    },
    before,
  );
  const deletedSubtrees = creatorDeleteSubtreesFromProjectIndex(sealed, before);
  const reconciliation = reconcileCreatorMutation(
    enrolledReconciliationInput(sealed, before, after, deletedSubtrees),
  );
  assert.equal(reconciliation.status, "matched", JSON.stringify(reconciliation.failureFacts));
});

test("enrolled source edit reconciles the editor body under its durable identity", () => {
  const priorSource = "return 1\n";
  const nextSource = "return 2\n";
  const prior = ephemeralTarget("4", "Workspace/ExistingModule", "ModuleScript");
  const next = durableTarget("existing-module", prior.path, prior.className);
  const before = projectCapture([{ target: prior, source: priorSource }]);
  const after = projectCapture([{ target: next, source: nextSource }]);
  const sealed = sealedEnrollmentChange(
    "creator-change-enrolled-source-edit",
    {
      id: "edit-existing-source",
      kind: "edit_source",
      target: { ...prior, className: "ModuleScript" },
      enrollment: {
        identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
        stableId: "existing-module",
      },
      beforeSourceHash: contentHash(priorSource),
      edits: [],
      finalSourceHash: contentHash(nextSource),
      finalByteCount: Buffer.byteLength(nextSource),
    },
    before,
  );
  const reconciliation = reconcileCreatorMutation(
    enrolledReconciliationInput(sealed, before, after),
  );
  assert.equal(reconciliation.status, "matched", JSON.stringify(reconciliation.failureFacts));
});

test("reconciliation retains exact direct readback and accepts its approved index delta", () => {
  const reconciliation = reconcileCreatorMutation(reconciliationInput());
  assert.equal(reconciliation.status, "matched", JSON.stringify(reconciliation.failureFacts));
  assert.equal(reconciliation.failureFacts.length, 0);
});

test("reconciliation classifies unavailable capture evidence as incomplete and unapproved index changes as mismatched", () => {
  const projection = directProjection();
  const unavailable = reconcileCreatorMutation(
    reconciliationInput({
      direct: exactAttributeEnvelope(projection, "unavailable"),
    }),
  );
  assert.equal(unavailable.status, "incomplete");
  assert.equal(
    unavailable.failureFacts.some((fact) => fact.code === "direct_readback_fact_unavailable"),
    true,
  );
  const invalidAfter = {
    ...indexCapture(false),
    hash: "0".repeat(64),
  } as StudioProjectIndexCapture;
  const incomplete = reconcileCreatorMutation(reconciliationInput({ after: invalidAfter }));
  assert.equal(incomplete.status, "incomplete");
  assert.equal(
    incomplete.failureFacts.some((fact) => fact.code === "after_index_incomplete"),
    true,
  );
  const absentBefore = reconcileCreatorMutation({
    ...reconciliationInput(),
    beforeIndexCapture: undefined as unknown as StudioProjectIndexCapture,
  });
  assert.equal(absentBefore.status, "incomplete");
  assert.equal(
    absentBefore.failureFacts.some((fact) => fact.code === "before_index_incomplete"),
    true,
  );
  const tags = reconcileCreatorMutation(
    reconciliationInput({
      after: indexCapture(false, { tags: ["Unapproved"] }),
    }),
  );
  assert.equal(tags.status, "mismatched", JSON.stringify(tags.failureFacts));
  assert.equal(
    tags.failureFacts.some(
      (fact) => fact.code === "unapproved_index_delta" && fact.detail.includes(":tags"),
    ),
    true,
  );
});

test("reconciliation detects a source Merkle leaf change outside the approved mutation", () => {
  const changed = reconcileCreatorMutation(
    reconciliationInput({
      before: indexCapture(true, { source: "return 1" }),
      after: indexCapture(false, { source: "return 2" }),
    }),
  );
  assert.equal(changed.status, "mismatched", JSON.stringify(changed.failureFacts));
  assert.equal(
    changed.failureFacts.some(
      (fact) =>
        fact.code === "unapproved_index_delta" &&
        fact.detail.includes("source:forge_attribute:door-folder"),
    ),
    true,
  );
});

test("provider-free replay reproduces an enrolled-identity mutation verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-mutation-evidence-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const prior = ephemeralTarget("5", "Workspace/ReplayExisting", "Folder");
    const next = durableTarget("replay-existing", prior.path, prior.className);
    const beforeCapture = projectCapture([{ target: prior, attributes: { Open: true } }]);
    const afterCapture = projectCapture([{ target: next, attributes: { Open: false } }]);
    const sealed = sealedEnrollmentChange(
      "creator-change-enrolled-replay",
      {
        id: "update-replay-existing",
        kind: "update",
        target: prior,
        enrollment: {
          identity: prior.identity as Extract<typeof prior.identity, { kind: "studio_ephemeral" }>,
          stableId: "replay-existing",
        },
        properties: {},
        attributes: { Open: false },
        removedAttributes: [],
      },
      beforeCapture,
    );
    const input = enrolledReconciliationInput(sealed, beforeCapture, afterCapture);
    const replayChangeSet = input.changeSet;
    const reconciliation = reconcileCreatorMutation(input);
    const before = input.beforeIndexCapture;
    const after = input.afterIndexCapture;
    const finalization = createCreatorMutationFinalization({
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      changeSetId: replayChangeSet.id,
      changeSetHash: replayChangeSet.hash,
      projectionId: input.projection.id,
      projectionHash: input.projection.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeIndexCaptureHash: before.hash,
      beforeIndexRevisionHash: before.revision.hash,
      afterIndexCaptureHash: after.hash,
      afterIndexRevisionHash: after.revision.hash,
      finalIndexCaptureHash: after.hash,
      finalIndexRevisionHash: after.revision.hash,
      recordingId: "creator-recording-test",
      reconciliationHash: reconciliation.hash,
      action: "commit",
      status: "committed",
    });
    const [
      manifestRef,
      changeSetRef,
      projectionRef,
      preflightProjectionRef,
      preflightEnvelopeRef,
      directRef,
      reconciliationRef,
      finalizationRef,
    ] = await Promise.all([
      store.write(STUDIO_CAPABILITY_MANIFEST),
      store.write(replayChangeSet),
      store.write(input.projection),
      store.write(input.preflight.projection),
      store.write(input.preflight.envelope),
      store.write(input.directReadback),
      store.write(reconciliation),
      store.write(finalization),
    ]);
    const [beforeIndexCapture, afterIndexCapture] = await Promise.all([
      writeCreatorProjectIndexArtifacts(store, before),
      writeCreatorProjectIndexArtifacts(store, after),
    ]);
    const attempt = createCreatorMutationAttempt(input.attemptId, {
      sessionId: input.sessionId,
      manifest: {
        artifact: manifestRef,
        hash: STUDIO_CAPABILITY_MANIFEST_HASH,
      },
      attestation: {
        projection: {
          artifact: preflightProjectionRef,
          hash: input.preflight.projection.contentHash,
        },
        envelope: {
          artifact: preflightEnvelopeRef,
          hash: input.preflight.envelope.contentHash,
        },
      },
      changeSet: { artifact: changeSetRef, hash: replayChangeSet.hash },
      projection: {
        artifact: projectionRef,
        hash: input.projection.contentHash,
      },
      preflight: {
        projection: {
          artifact: preflightProjectionRef,
          hash: input.preflight.projection.contentHash,
        },
        envelope: {
          artifact: preflightEnvelopeRef,
          hash: input.preflight.envelope.contentHash,
        },
      },
      directReadback: {
        artifact: directRef,
        hash: input.directReadback.contentHash,
      },
      beforeIndexCapture,
      afterIndexCapture,
      finalIndexCapture: afterIndexCapture,
      reconciliation: {
        artifact: reconciliationRef,
        hash: reconciliation.hash,
      },
      finalization: { artifact: finalizationRef, hash: finalization.hash },
    });
    const replay = await replayCreatorMutation(attempt, store);
    assert.equal(replay.result, "exact_match");
    assert.equal(replay.replayedStatus, "matched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture revisions remain content-bound rather than clock-bound", () => {
  const before = indexCapture(true);
  const again = indexCapture(true);
  assert.equal(before.revision.hash, again.revision.hash);
  assert.equal(before.revision.merkleRoot, again.revision.merkleRoot);
});

test("a pre-recording durable-intent failure is replayable without invented finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-durable-intent-replay-"));
  const store = new ImmutableJsonArtifactStore(root);
  try {
    const input = reconciliationInput();
    const [
      manifestArtifact,
      changeSetArtifact,
      projectionArtifact,
      preflightArtifact,
      envelopeArtifact,
    ] = await Promise.all([
      store.write(STUDIO_CAPABILITY_MANIFEST),
      store.write(changeSet),
      store.write(input.projection),
      store.write(input.preflight.projection),
      store.write(input.preflight.envelope),
    ]);
    const beforeIndexCapture = await writeCreatorProjectIndexArtifacts(
      store,
      input.beforeIndexCapture,
    );
    const attempt = createIncompleteDurableIntentMutationAttempt("durable-intent-attempt", {
      sessionId: input.sessionId,
      manifest: { artifact: manifestArtifact, hash: STUDIO_CAPABILITY_MANIFEST_HASH },
      attestation: {
        projection: {
          artifact: preflightArtifact,
          hash: input.preflight.projection.contentHash,
        },
        envelope: { artifact: envelopeArtifact, hash: input.preflight.envelope.contentHash },
      },
      changeSet: { artifact: changeSetArtifact, hash: changeSet.hash },
      projection: { artifact: projectionArtifact, hash: input.projection.contentHash },
      preflightProjection: {
        artifact: preflightArtifact,
        hash: input.preflight.projection.contentHash,
      },
      preflight: {
        projection: {
          artifact: preflightArtifact,
          hash: input.preflight.projection.contentHash,
        },
        envelope: { artifact: envelopeArtifact, hash: input.preflight.envelope.contentHash },
      },
      beforeIndexCapture,
      failureFacts: createMutationFailureFacts([
        {
          code: "recording_intent_persistence_failed",
          detail: "recording_intent_persistence_failed",
        },
      ]),
    });
    assert.equal(attempt.phase, "durable_intent");
    assert.equal("finalization" in attempt, false);
    assert.equal("finalIndexCapture" in attempt, false);
    const replay = await replayCreatorMutation(attempt, store);
    assert.equal(replay.result, "missing_or_incomplete");
    assert.match(replay.detail, /before opening a recording/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
