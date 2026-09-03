import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  serializeStudioEvidenceProjection,
} from "../packages/studio-evidence/src/index.js";
import {
  createCreatorChangePrepareTransfer,
  type CreatorChangePrepareDocument,
} from "../packages/studio-protocol/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  createCreatorSourceWriteBlobCapture,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  createStudioSourceBlobCapture,
  studioProjectIndexMetadataView,
  studioObjectIdentityKey,
} from "../packages/studio-evidence/src/project-index.js";
import { createChangeReviewPresentation } from "../packages/creator-session/src/coordinator.js";
import type { CreatorChangeSet } from "../packages/creator-session/src/index.js";
import {
  compileCreatorChangeSetMutationProjection,
  creatorDeleteSubtreesFromProjectIndex,
  creatorStructuralParentsFromProjectIndex,
  type CreatorMutationSealedChangeSet,
  type CreatorMutationStudioOperation,
} from "../packages/creator-session/src/mutation-evidence.js";
import { compileCreatorTransactionTopology } from "../packages/creator-session/src/transaction-topology.js";
import {
  completeProjectProperties,
  completeProjectPropertyNames,
} from "./helpers/studio-project-fixtures.js";

test("TypeScript Prepare projections are accepted by the production generated Luau recompiler", async () => {
  const project = { name: "CreatorPrepareConformance", placeId: 0, universeId: 0 };
  const indexProjection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "creator_prepare_conformance_epoch",
    purpose: "creator_project_index",
    roots: STUDIO_CAPABILITY_MANIFEST.roots,
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const consoleIdentity = { kind: "forge_attribute" as const, stableId: "prepare-fixture-console" };
  const engineContainerIdentity = (path: string) => ({
    kind: "forge_attribute" as const,
    stableId: `prepare-fixture-engine-${path.replaceAll("/", "-").toLowerCase()}`,
  });
  const ephemeralPromptIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: indexProjection.connectorEpoch,
    opaqueHash: "e".repeat(64),
  };
  const moveIdentity = { kind: "forge_attribute" as const, stableId: "prepare-fixture-move" };
  const existingReferenceValueIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-existing-reference-value",
  };
  const moveToStructuralParentIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-move-to-structural-parent",
  };
  const deleteRootIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-delete-root",
  };
  const duplicateDeleteAIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-delete-duplicate-a",
  };
  const duplicateDeleteBIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-delete-duplicate-b",
  };
  const opaqueDeleteDescendantIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: indexProjection.connectorEpoch,
    opaqueHash: "f".repeat(64),
  };
  const deleteDescendantNodes = Array.from({ length: 128 }, (_, index) => {
    if (index === 0)
      return {
        identity: duplicateDeleteAIdentity,
        parentIdentity: deleteRootIdentity,
        displayPath: "Workspace/PrepareFixtureConsole/DeleteRoot/Duplicate",
        name: "Duplicate",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      };
    if (index === 1)
      return {
        identity: duplicateDeleteBIdentity,
        parentIdentity: deleteRootIdentity,
        displayPath: "Workspace/PrepareFixtureConsole/DeleteRoot/Duplicate",
        name: "Duplicate",
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      };
    if (index === 2)
      return {
        identity: opaqueDeleteDescendantIdentity,
        parentIdentity: duplicateDeleteAIdentity,
        displayPath: "Workspace/PrepareFixtureConsole/DeleteRoot/Duplicate/Opaque",
        name: "Opaque",
        className: "Camera",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      };
    return {
      identity: {
        kind: "forge_attribute" as const,
        stableId: `prepare-fixture-delete-descendant-${index}`,
      },
      parentIdentity: deleteRootIdentity,
      displayPath: `Workspace/PrepareFixtureConsole/DeleteRoot/Descendant-${index}`,
      name: `Descendant-${index}`,
      className: "Folder",
      attributes: {},
      tags: [],
      coveredProperties: {},
      coveredPropertyNames: [],
    };
  });
  const moduleIdentity = {
    kind: "forge_attribute" as const,
    stableId: "prepare-fixture-existing-module",
  };
  const starterPlayerScriptsIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: indexProjection.connectorEpoch,
    opaqueHash: "a".repeat(64),
  };
  const opaqueStructuralParentIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: indexProjection.connectorEpoch,
    opaqueHash: "b".repeat(64),
  };
  const beforeModuleSource = "return { state = 'before' }\n";
  const finalModuleSource = "return { state = 'after', replay = true }\n";
  const indexedModuleSource = createStudioSourceBlobCapture({
    identity: moduleIdentity,
    source: beforeModuleSource,
    editorSource: false,
  });
  const beforeCapture = createStudioProjectIndexCapture({
    projection: indexProjection,
    shards: indexProjection.roots.map((root) =>
      createStudioProjectEvidenceShard({
        root,
        ordinal: 0,
        nodes: [
          ...STUDIO_CAPABILITY_MANIFEST.authoringContainers
            .filter((container) => container.path === root)
            .map((container) => ({
              identity: engineContainerIdentity(container.path),
              displayPath: container.path,
              name: container.path.slice(container.path.lastIndexOf("/") + 1),
              className: container.className,
              engineContainer: { path: container.path, className: container.className },
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            })),
          ...(root === "Workspace"
            ? [
                {
                  identity: consoleIdentity,
                  parentIdentity: engineContainerIdentity("Workspace"),
                  displayPath: "Workspace/PrepareFixtureConsole",
                  name: "PrepareFixtureConsole",
                  className: "Part",
                  attributes: {},
                  tags: [],
                  coveredProperties: completeProjectProperties("Part"),
                  coveredPropertyNames: completeProjectPropertyNames("Part"),
                },
                {
                  // Project indexes deliberately retain opaque engine and
                  // unsupported classes. This is containment authority only:
                  // it can anchor an authorable child, but never becomes an
                  // authorable target itself.
                  identity: opaqueStructuralParentIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/OpaqueStructuralParent",
                  name: "OpaqueStructuralParent",
                  className: "Camera",
                  attributes: {},
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                },
                {
                  identity: ephemeralPromptIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/ExistingPrompt",
                  name: "ExistingPrompt",
                  className: "ProximityPrompt",
                  attributes: { LegacyAttribute: "remove-me" },
                  tags: [],
                  coveredProperties: completeProjectProperties("ProximityPrompt"),
                  coveredPropertyNames: completeProjectPropertyNames("ProximityPrompt"),
                },
                {
                  // This existing target points to a new object in the same
                  // transaction. Its operation must wait for that create;
                  // create-to-create references deliberately do not impose
                  // the same ordering because both handles are preallocated.
                  identity: existingReferenceValueIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/ExistingReferenceValue",
                  name: "ExistingReferenceValue",
                  className: "ObjectValue",
                  attributes: {},
                  tags: [],
                  coveredProperties: completeProjectProperties("ObjectValue"),
                  coveredPropertyNames: completeProjectPropertyNames("ObjectValue"),
                },
                {
                  identity: moveIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/MoveMe",
                  name: "MoveMe",
                  className: "Folder",
                  attributes: { LegacyMoveAttribute: true },
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                },
                {
                  identity: moveToStructuralParentIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/MoveToStructuralParent",
                  name: "MoveToStructuralParent",
                  className: "Folder",
                  attributes: {},
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                },
                {
                  identity: deleteRootIdentity,
                  parentIdentity: consoleIdentity,
                  displayPath: "Workspace/PrepareFixtureConsole/DeleteRoot",
                  name: "DeleteRoot",
                  className: "Folder",
                  attributes: {},
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                },
                // The delete closure reaches its exact 128-object boundary,
                // including same-named siblings and an opaque grandchild.
                ...deleteDescendantNodes,
              ]
            : []),
          ...(root === "ReplicatedStorage"
            ? [
                {
                  identity: moduleIdentity,
                  parentIdentity: engineContainerIdentity("ReplicatedStorage"),
                  displayPath: "ReplicatedStorage/PrepareFixtureModule",
                  name: "PrepareFixtureModule",
                  className: "ModuleScript",
                  attributes: {},
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                  sourceManifestHash: indexedModuleSource.manifest.hash,
                },
              ]
            : []),
          ...(root === "StarterPlayer"
            ? [
                {
                  identity: starterPlayerScriptsIdentity,
                  parentIdentity: engineContainerIdentity("StarterPlayer"),
                  displayPath: "StarterPlayer/StarterPlayerScripts",
                  name: "StarterPlayerScripts",
                  className: "StarterPlayerScripts",
                  engineContainer: {
                    path: "StarterPlayer/StarterPlayerScripts",
                    className: "StarterPlayerScripts",
                  },
                  attributes: {},
                  tags: [],
                  coveredProperties: {},
                  coveredPropertyNames: [],
                },
              ]
            : []),
        ],
      }),
    ),
    sourceManifests: [indexedModuleSource.manifest],
    sourceChunks: indexedModuleSource.chunks,
    completedAt: "2026-09-03T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const scriptSourceCapture = createCreatorSourceWriteBlobCapture({
    source: "return { status = 'ready' }\n",
  });
  const moduleSourceCapture = createCreatorSourceWriteBlobCapture({
    source: "return { mode = 'portable-replay' }\n",
  });
  const localScriptSourceCapture = createCreatorSourceWriteBlobCapture({
    source: "print('structurally anchored local script')\n",
  });
  const editedModuleSource = createCreatorSourceWriteBlobCapture({ source: finalModuleSource });
  const sourceWriteBlobs = [
    scriptSourceCapture,
    moduleSourceCapture,
    localScriptSourceCapture,
    editedModuleSource,
  ]
    .map(({ manifest }) => ({
      manifestId: manifest.id,
      manifestHash: manifest.hash,
      sourceHash: manifest.sourceHash,
      utf8Bytes: manifest.utf8Bytes,
    }))
    .sort((left, right) => left.manifestHash.localeCompare(right.manifestHash));
  const editSourceOperation = {
    id: "edit_existing_module_source",
    planChangeId: "plan_change_edit_existing_module_source",
    kind: "edit_source" as const,
    target: {
      kind: "instance" as const,
      identity: moduleIdentity,
      path: "ReplicatedStorage/PrepareFixtureModule",
      className: "ModuleScript",
    },
    beforeSourceHash: indexedModuleSource.manifest.sourceHash,
    edits: [
      {
        startByte: 0,
        endByte: Buffer.byteLength(beforeModuleSource, "utf8"),
        replacementBlob: {
          manifestId: editedModuleSource.manifest.id,
          manifestHash: editedModuleSource.manifest.hash,
          sourceHash: editedModuleSource.manifest.sourceHash,
          utf8Bytes: editedModuleSource.manifest.utf8Bytes,
        },
      },
    ],
    finalSourceHash: editedModuleSource.manifest.sourceHash,
    finalByteCount: editedModuleSource.manifest.utf8Bytes,
  };
  const unsortedChangeSet = {
    id: "creator_change_set_prepare_conformance",
    hash: "a".repeat(64),
    sessionId: "creator_session_prepare_conformance",
    expectedRevisionHash: beforeCapture.revision.hash,
    buildContractHash: "b".repeat(64),
    sourceWriteBlobs,
    localGate: { status: "eligible" as const, issueHashes: [] },
    operations: [
      {
        id: "create_prepare_prompt",
        planChangeId: "plan_change_create_prepare_prompt",
        kind: "create",
        tempId: "temp_create_prepare_prompt",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "prepare-fixture-prompt" },
          path: "Workspace/PrepareFixtureConsole/PreparePrompt",
          className: "ProximityPrompt",
        },
        parent: {
          kind: "instance",
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ProximityPrompt",
        name: "PreparePrompt",
        properties: {
          ActionText: { kind: "string_utf8", value: "Run prepare replay" },
          Enabled: { kind: "boolean", value: true },
          HoldDuration: { kind: "number_f32", value: 0.5 },
        },
        attributes: { FixtureEnabled: true },
      },
      {
        id: "create_prepare_script",
        planChangeId: "plan_change_create_prepare_script",
        kind: "create",
        tempId: "temp_create_prepare_script",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "prepare-fixture-script" },
          path: "ServerScriptService/PrepareFixtureScript",
          className: "Script",
        },
        parent: {
          kind: "engine_container",
          path: "ServerScriptService",
          className: "ServerScriptService",
        },
        className: "Script",
        name: "PrepareFixtureScript",
        properties: {},
        attributes: { FixtureMode: "green" },
        sourceBlob: {
          manifestId: scriptSourceCapture.manifest.id,
          manifestHash: scriptSourceCapture.manifest.hash,
          sourceHash: scriptSourceCapture.manifest.sourceHash,
          utf8Bytes: scriptSourceCapture.manifest.utf8Bytes,
        },
      },
      {
        id: "create_prepare_module",
        planChangeId: "plan_change_create_prepare_module",
        kind: "create",
        tempId: "temp_create_prepare_module",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "prepare-fixture-created-module" },
          path: "ReplicatedStorage/PrepareFixtureCreatedModule",
          className: "ModuleScript",
        },
        parent: {
          kind: "engine_container",
          path: "ReplicatedStorage",
          className: "ReplicatedStorage",
        },
        className: "ModuleScript",
        name: "PrepareFixtureCreatedModule",
        properties: {},
        attributes: { FixtureMode: "source-backed" },
        sourceBlob: {
          manifestId: moduleSourceCapture.manifest.id,
          manifestHash: moduleSourceCapture.manifest.hash,
          sourceHash: moduleSourceCapture.manifest.sourceHash,
          utf8Bytes: moduleSourceCapture.manifest.utf8Bytes,
        },
      },
      {
        id: "create_prepare_local_script_under_indexed_engine_parent",
        planChangeId: "plan_change_create_prepare_local_script_under_indexed_engine_parent",
        kind: "create",
        tempId: "temp_create_prepare_local_script_under_indexed_engine_parent",
        target: {
          kind: "instance",
          identity: {
            kind: "forge_attribute",
            stableId: "prepare-fixture-local-script",
          },
          path: "StarterPlayer/StarterPlayerScripts/PrepareFixtureLocalScript",
          className: "LocalScript",
        },
        // The exact historical sixth-failure shape: this is an observed,
        // ephemeral instance parent, not a writable target or an inferred
        // engine-container alias. Its identity must survive the full Prepare
        // transfer and generated Luau recompilation.
        parent: {
          kind: "instance",
          identity: starterPlayerScriptsIdentity,
          path: "StarterPlayer/StarterPlayerScripts",
          className: "StarterPlayerScripts",
        },
        className: "LocalScript",
        name: "PrepareFixtureLocalScript",
        properties: {},
        attributes: { FixtureMode: "indexed-engine-parent" },
        sourceBlob: {
          manifestId: localScriptSourceCapture.manifest.id,
          manifestHash: localScriptSourceCapture.manifest.hash,
          sourceHash: localScriptSourceCapture.manifest.sourceHash,
          utf8Bytes: localScriptSourceCapture.manifest.utf8Bytes,
        },
      },
      {
        id: "create_prepare_source_under_authorable_instance",
        planChangeId: "plan_change_create_prepare_source_under_authorable_instance",
        kind: "create",
        tempId: "temp_create_prepare_source_under_authorable_instance",
        target: {
          kind: "instance",
          identity: {
            kind: "forge_attribute",
            stableId: "prepare-fixture-source-under-authorable-instance",
          },
          path: "Workspace/PrepareFixtureConsole/PrepareFixtureModule",
          className: "ModuleScript",
        },
        parent: {
          kind: "instance",
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ModuleScript",
        name: "PrepareFixtureModule",
        properties: {},
        attributes: { FixtureMode: "authorable-instance-parent" },
        sourceBlob: {
          manifestId: moduleSourceCapture.manifest.id,
          manifestHash: moduleSourceCapture.manifest.hash,
          sourceHash: moduleSourceCapture.manifest.sourceHash,
          utf8Bytes: moduleSourceCapture.manifest.utf8Bytes,
        },
      },
      {
        id: "create_prepare_source_under_opaque_instance",
        planChangeId: "plan_change_create_prepare_source_under_opaque_instance",
        kind: "create",
        tempId: "temp_create_prepare_source_under_opaque_instance",
        target: {
          kind: "instance",
          identity: {
            kind: "forge_attribute",
            stableId: "prepare-fixture-source-under-opaque-instance",
          },
          path: "Workspace/PrepareFixtureConsole/OpaqueStructuralParent/OpaqueFixtureModule",
          className: "ModuleScript",
        },
        parent: {
          kind: "instance",
          identity: opaqueStructuralParentIdentity,
          path: "Workspace/PrepareFixtureConsole/OpaqueStructuralParent",
          className: "Camera",
        },
        className: "ModuleScript",
        name: "OpaqueFixtureModule",
        properties: {},
        attributes: { FixtureMode: "opaque-instance-parent" },
        sourceBlob: {
          manifestId: moduleSourceCapture.manifest.id,
          manifestHash: moduleSourceCapture.manifest.hash,
          sourceHash: moduleSourceCapture.manifest.sourceHash,
          utf8Bytes: moduleSourceCapture.manifest.utf8Bytes,
        },
      },
      {
        id: "create_prepare_particles",
        planChangeId: "plan_change_create_prepare_particles",
        kind: "create",
        tempId: "temp_create_prepare_particles",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "prepare-fixture-particles" },
          path: "Workspace/PrepareFixtureConsole/PrepareParticles",
          className: "ParticleEmitter",
        },
        parent: {
          kind: "instance",
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ParticleEmitter",
        name: "PrepareParticles",
        properties: {
          Color: {
            kind: "color_sequence",
            keypoints: [
              { time: 0, color: { r: 255, g: 64, b: 0 } },
              { time: 0.5, color: { r: 64, g: 128, b: 255 } },
              { time: 1, color: { r: 0, g: 255, b: 128 } },
            ],
          },
          Lifetime: { kind: "number_range", min: 0.5, max: 2 },
        },
        attributes: { FixtureCodec: "historical-shape" },
      },
      {
        id: "create_prepare_folder",
        planChangeId: "plan_change_create_prepare_folder",
        kind: "create",
        tempId: "temp_create_prepare_folder",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "prepare-fixture-folder" },
          path: "Workspace/PrepareFixtureConsole/PrepareFixtureFolder",
          className: "Folder",
        },
        parent: {
          kind: "instance",
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "Folder",
        name: "PrepareFixtureFolder",
        properties: {},
        attributes: { FixtureTier: 3 },
      },
      {
        id: "update_ephemeral_prompt",
        planChangeId: "plan_change_update_ephemeral_prompt",
        kind: "update",
        beforeHash: "1".repeat(64),
        target: {
          kind: "instance",
          identity: ephemeralPromptIdentity,
          path: "Workspace/PrepareFixtureConsole/ExistingPrompt",
          className: "ProximityPrompt",
        },
        enrollment: {
          identity: ephemeralPromptIdentity,
          stableId: "prepare-fixture-enrolled-prompt",
        },
        properties: { Enabled: { kind: "boolean", value: false } },
        attributes: { Reconciled: true },
        removedAttributes: ["LegacyAttribute"],
      },
      {
        id: "move_existing_folder",
        planChangeId: "plan_change_move_existing_folder",
        kind: "move",
        beforeHash: "2".repeat(64),
        target: {
          kind: "instance",
          identity: moveIdentity,
          path: "Workspace/PrepareFixtureConsole/MoveMe",
          className: "Folder",
        },
        parent: {
          kind: "instance",
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        name: "MovedFixtureFolder",
        properties: {},
        attributes: { Moved: true },
        removedAttributes: ["LegacyMoveAttribute"],
      },
      {
        id: "move_existing_folder_under_indexed_engine_parent",
        planChangeId: "plan_change_move_existing_folder_under_indexed_engine_parent",
        kind: "move",
        beforeHash: "4".repeat(64),
        target: {
          kind: "instance",
          identity: moveToStructuralParentIdentity,
          path: "Workspace/PrepareFixtureConsole/MoveToStructuralParent",
          className: "Folder",
        },
        parent: {
          kind: "instance",
          identity: starterPlayerScriptsIdentity,
          path: "StarterPlayer/StarterPlayerScripts",
          className: "StarterPlayerScripts",
        },
        name: "MovedUnderStructuralParent",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "delete_duplicate_subtree",
        planChangeId: "plan_change_delete_duplicate_subtree",
        kind: "delete",
        beforeHash: "3".repeat(64),
        target: {
          kind: "instance",
          identity: deleteRootIdentity,
          path: "Workspace/PrepareFixtureConsole/DeleteRoot",
          className: "Folder",
        },
      },
      editSourceOperation,
    ],
  } satisfies Omit<CreatorMutationSealedChangeSet, "operations"> & {
    readonly sourceWriteBlobs: typeof sourceWriteBlobs;
    readonly localGate: { readonly status: "eligible"; readonly issueHashes: readonly string[] };
    readonly operations: readonly (CreatorMutationStudioOperation & {
      readonly planChangeId: string;
      readonly tempId?: string;
      readonly beforeHash?: string;
    })[];
  };
  const changeSetTopology = compileCreatorTransactionTopology({
    initial: studioProjectIndexMetadataView(beforeCapture).instances,
    operations: unsortedChangeSet.operations,
  });
  assert.notDeepEqual(
    changeSetTopology.orderedOperationIds,
    unsortedChangeSet.operations.map((operation) => operation.id),
    "the fixture must exercise the producer-side canonicalization boundary",
  );
  const changeSet = {
    ...unsortedChangeSet,
    operations: changeSetTopology.orderedOperations,
  };
  const binding = {
    sessionId: changeSet.sessionId,
    changeSetHash: changeSet.hash,
    approvalHash: "c".repeat(64),
    revisionHash: beforeCapture.revision.hash,
    buildHash: changeSet.buildContractHash,
    dashboardReviewHash: "d".repeat(64),
  };
  const deletedSubtrees = creatorDeleteSubtreesFromProjectIndex(changeSet, beforeCapture);
  const structuralParents = creatorStructuralParentsFromProjectIndex(changeSet, beforeCapture);
  assert.throws(
    () =>
      compileCreatorChangeSetMutationProjection(unsortedChangeSet, {
        project,
        binding,
        initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
        deletedSubtrees: creatorDeleteSubtreesFromProjectIndex(unsortedChangeSet, beforeCapture),
        structuralParents: creatorStructuralParentsFromProjectIndex(
          unsortedChangeSet,
          beforeCapture,
        ),
      }),
    /canonical safe topology order/,
    "a handcrafted change set must fail host-side before it can diverge at Prepare",
  );
  assert.equal(deletedSubtrees[0]?.descendants.length, 128);
  assert.deepEqual(
    deletedSubtrees[0]?.descendants
      .map((target) => studioObjectIdentityKey(target.identity))
      .sort(),
    [
      studioObjectIdentityKey(duplicateDeleteAIdentity),
      studioObjectIdentityKey(duplicateDeleteBIdentity),
      studioObjectIdentityKey(opaqueDeleteDescendantIdentity),
      ...Array.from({ length: 125 }, (_, offset) =>
        studioObjectIdentityKey({
          kind: "forge_attribute",
          stableId: `prepare-fixture-delete-descendant-${offset + 3}`,
        }),
      ),
    ].sort(),
    "the host compiler must derive deletion by identity edges even with duplicate display paths",
  );
  const directProjection = compileCreatorChangeSetMutationProjection(changeSet, {
    project,
    binding,
    initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
    deletedSubtrees,
    structuralParents,
  });
  const preflightProjection = compileCreatorChangeSetMutationProjection(changeSet, {
    project,
    binding,
    initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
    purpose: "mutation_preflight",
    deletedSubtrees,
    structuralParents,
  });
  const requirementForStableIdentity = (stableId: string) =>
    directProjection.requirements.filter(
      (requirement) =>
        requirement.target.kind === "instance" &&
        requirement.target.identity.kind === "forge_attribute" &&
        requirement.target.identity.stableId === stableId,
    );
  // Parent role is a closed mutation contract. A source-backed child may be
  // created under each exact parent category, but only its own class must be
  // authorable. These assertions deliberately cover the source path because
  // that is where the historical LocalScript prepare failed.
  const sourceBackedParentMatrix = [
    {
      stableId: "prepare-fixture-script",
      sourceHash: scriptSourceCapture.manifest.sourceHash,
      parentIdentity: engineContainerIdentity("ServerScriptService"),
      label: "engine container",
    },
    {
      stableId: "prepare-fixture-source-under-authorable-instance",
      sourceHash: moduleSourceCapture.manifest.sourceHash,
      parentIdentity: consoleIdentity,
      label: "indexed authorable instance",
    },
    {
      stableId: "prepare-fixture-local-script",
      sourceHash: localScriptSourceCapture.manifest.sourceHash,
      parentIdentity: starterPlayerScriptsIdentity,
      label: "indexed non-authorable structural engine class",
    },
    {
      stableId: "prepare-fixture-source-under-opaque-instance",
      sourceHash: moduleSourceCapture.manifest.sourceHash,
      parentIdentity: opaqueStructuralParentIdentity,
      label: "indexed opaque class",
    },
  ] as const;
  for (const { stableId, sourceHash, parentIdentity, label } of sourceBackedParentMatrix) {
    const requirements = requirementForStableIdentity(stableId);
    assert.equal(
      requirements.some(
        (requirement) => requirement.kind === "source_hash" && requirement.expected === sourceHash,
      ),
      true,
      `${label} child must retain its immutable source proof`,
    );
    assert.equal(
      requirements.some(
        (requirement) =>
          requirement.kind === "structure" &&
          requirement.expectedStatus === "observed" &&
          typeof requirement.expected === "object" &&
          requirement.expected !== null &&
          "parentIdentity" in requirement.expected &&
          requirement.expected.parentIdentity !== undefined &&
          studioObjectIdentityKey(requirement.expected.parentIdentity) ===
            studioObjectIdentityKey(parentIdentity),
      ),
      true,
      `${label} must retain its exact captured parent identity without authoring the parent`,
    );
  }
  const reviewPresentation = createChangeReviewPresentation(
    changeSet as unknown as CreatorChangeSet,
    studioProjectIndexMetadataView(beforeCapture),
  ) as {
    readonly proofObligations: readonly { readonly fact: string; readonly expected: string }[];
  };
  for (const stableId of ["prepare-fixture-script", "prepare-fixture-local-script"]) {
    const expected = requirementForStableIdentity(stableId).find(
      (requirement) =>
        requirement.kind === "structure" && requirement.expectedStatus === "observed",
    )?.expected;
    assert.notEqual(expected, undefined, `direct projection must retain ${stableId} structure`);
    assert.equal(
      reviewPresentation.proofObligations.some(
        (obligation) => obligation.expected === stableJson(expected),
      ),
      true,
      `review proof obligations must retain ${stableId}'s exact engine-parent identity`,
    );
  }
  assert.equal(
    requirementForStableIdentity("prepare-fixture-particles").some(
      (requirement) => requirement.kind === "property" && requirement.propertyName === "Color",
    ),
    true,
    "the historical color-sequence shape must be a ParticleEmitter property proof",
  );
  assert.equal(
    requirementForStableIdentity("prepare-fixture-particles").some(
      (requirement) => requirement.kind === "property" && requirement.propertyName === "Lifetime",
    ),
    true,
    "the historical number-range shape must be a ParticleEmitter property proof",
  );
  assert.equal(
    requirementForStableIdentity("prepare-fixture-enrolled-prompt").some(
      (requirement) =>
        requirement.kind === "attribute" &&
        requirement.attributeName === "LegacyAttribute" &&
        requirement.expectedStatus === "absent",
    ),
    true,
    "an ephemeral update must project its enrolled Forge identity and removed attribute",
  );
  assert.equal(
    requirementForStableIdentity("prepare-fixture-move").some(
      (requirement) =>
        requirement.kind === "structure" &&
        requirement.target.kind === "instance" &&
        requirement.target.path === "Workspace/PrepareFixtureConsole/MovedFixtureFolder",
    ),
    true,
    "moves must prove the destination structure",
  );
  assert.equal(
    requirementForStableIdentity("prepare-fixture-move-to-structural-parent").some(
      (requirement) =>
        requirement.kind === "structure" &&
        requirement.target.kind === "instance" &&
        requirement.target.path ===
          "StarterPlayer/StarterPlayerScripts/MovedUnderStructuralParent" &&
        requirement.expectedStatus === "observed" &&
        typeof requirement.expected === "object" &&
        requirement.expected !== null &&
        "parentIdentity" in requirement.expected &&
        requirement.expected.parentIdentity !== undefined &&
        studioObjectIdentityKey(requirement.expected.parentIdentity) ===
          studioObjectIdentityKey(starterPlayerScriptsIdentity),
    ),
    true,
    "an indexed non-authorable parent must be valid containment authority for moves too",
  );
  assert.equal(
    requirementForStableIdentity("prepare-fixture-existing-module").some(
      (requirement) =>
        requirement.kind === "source_hash" &&
        requirement.expected === editedModuleSource.manifest.sourceHash,
    ),
    true,
    "edit_source must prove the final materialized source hash",
  );
  const deletedStructureRequirements = directProjection.requirements.filter(
    (requirement) => requirement.kind === "structure" && requirement.expectedStatus === "absent",
  );
  assert.equal(
    deletedStructureRequirements.length,
    129,
    "the delete root plus every one of its 128 indexed descendants must be absent",
  );
  assert.equal(
    deletedStructureRequirements.some(
      (requirement) =>
        requirement.target.kind === "instance" &&
        requirement.target.identity.kind === "studio_ephemeral" &&
        requirement.target.identity.opaqueHash === opaqueDeleteDescendantIdentity.opaqueHash,
    ),
    true,
    "opaque delete descendants must retain structural-only absence proofs",
  );
  assert.deepEqual(
    preflightProjection.requirements,
    directProjection.requirements,
    "direct and preflight host compilers must declare the same mutation facts",
  );
  const temporary = await mkdtemp(join(tmpdir(), "forge-creator-prepare-replay-"));
  try {
    const fixturePath = join(temporary, "prepare-replay.json");
    await writeFile(
      fixturePath,
      JSON.stringify({
        kind: "CreatorPrepareReplayFixture",
        id: "creator_prepare_conformance",
        changeSet: { kind: "CreatorChangeSet", ...changeSet },
        directProjection,
        preflightProjection,
        beforeCapture,
      }),
      "utf8",
    );
    const replay = spawnSync(
      "lune",
      ["run", "scripts/replay-creator-prepare.luau", "--payload", fixturePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(
      replay.status,
      0,
      `generated Luau Prepare replay failed:\n${replay.stdout}\n${replay.stderr}`,
    );
    assert.match(
      replay.stdout,
      /creator prepare artifact replay passed: creator_prepare_conformance/,
    );

    // Replay the same source-backed parent-role matrix through production
    // StudioAuthoring source acceptance plus begin/chunk/complete Prepare.
    // This closes the gap between host-side projection equality and the actual
    // plugin boundary that rejected the historical LocalScript operation.
    const parentRoleOperationIds = new Set([
      "create_prepare_script",
      "create_prepare_local_script_under_indexed_engine_parent",
      "create_prepare_source_under_authorable_instance",
      "create_prepare_source_under_opaque_instance",
    ]);
    const parentRoleSourceManifestHashes = new Set([
      scriptSourceCapture.manifest.hash,
      moduleSourceCapture.manifest.hash,
      localScriptSourceCapture.manifest.hash,
    ]);
    const parentRoleChangeSet = {
      kind: "CreatorChangeSet" as const,
      ...changeSet,
      hash: "9".repeat(64),
      mutationAuthority: "studio_document" as const,
      sourceWriteBlobs: sourceWriteBlobs.filter((binding) =>
        parentRoleSourceManifestHashes.has(binding.manifestHash),
      ),
      operations: changeSet.operations.filter((operation) =>
        parentRoleOperationIds.has(operation.id),
      ),
    };
    const parentRoleBinding = { ...binding, changeSetHash: parentRoleChangeSet.hash };
    const parentRoleStructuralParents = creatorStructuralParentsFromProjectIndex(
      parentRoleChangeSet,
      beforeCapture,
    );
    const parentRoleProjection = compileCreatorChangeSetMutationProjection(parentRoleChangeSet, {
      project,
      binding: parentRoleBinding,
      initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
      deletedSubtrees: creatorDeleteSubtreesFromProjectIndex(parentRoleChangeSet, beforeCapture),
      structuralParents: parentRoleStructuralParents,
    });
    const parentRolePreflightProjection = compileCreatorChangeSetMutationProjection(
      parentRoleChangeSet,
      {
        project,
        binding: parentRoleBinding,
        initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
        purpose: "mutation_preflight",
        deletedSubtrees: creatorDeleteSubtreesFromProjectIndex(parentRoleChangeSet, beforeCapture),
        structuralParents: parentRoleStructuralParents,
      },
    );
    const parentRoleChangeSetJson = stableJson(parentRoleChangeSet);
    const parentRoleProjectionJson = serializeStudioEvidenceProjection(parentRoleProjection);
    const parentRolePreflightProjectionJson = serializeStudioEvidenceProjection(
      parentRolePreflightProjection,
    );
    const parentRoleDocument: CreatorChangePrepareDocument = {
      requestId: "creator_prepare_parent_role_matrix_request",
      creatorSessionId: parentRoleChangeSet.sessionId,
      expectedProjectRevisionHash: beforeCapture.revision.hash,
      changeSetJson: parentRoleChangeSetJson,
      changeSetJsonHash: contentHash(parentRoleChangeSetJson),
      changeSetId: parentRoleChangeSet.id,
      changeSetHash: parentRoleChangeSet.hash,
      approvalHash: parentRoleBinding.approvalHash,
      dashboardReviewHash: parentRoleBinding.dashboardReviewHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionJson: parentRoleProjectionJson,
      projectionJsonHash: contentHash(parentRoleProjectionJson),
      projectionHash: parentRoleProjection.contentHash,
      preflightProjectionJson: parentRolePreflightProjectionJson,
      preflightProjectionJsonHash: contentHash(parentRolePreflightProjectionJson),
      preflightProjectionHash: parentRolePreflightProjection.contentHash,
      beforeProjectIndexManifestId: beforeCapture.indexManifest.id,
      beforeProjectRevisionHash: beforeCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeCapture.detectorEpoch,
    };
    const parentRoleTransfer = createCreatorChangePrepareTransfer(parentRoleDocument);
    const parentRoleFixturePath = join(temporary, "prepare-parent-role-transfer-replay.json");
    await writeFile(
      parentRoleFixturePath,
      JSON.stringify({
        kind: "CreatorPrepareTransferReplayFixture",
        project,
        boundary: {
          requestId: parentRoleDocument.requestId,
          transferId: parentRoleTransfer.transferId,
          documentHash: parentRoleTransfer.documentHash,
          utf8Bytes: parentRoleTransfer.utf8Bytes,
          pieceCount: parentRoleTransfer.fragments.length,
        },
        fragments: parentRoleTransfer.fragments.map((fragment) => ({
          requestId: parentRoleDocument.requestId,
          transferId: parentRoleTransfer.transferId,
          documentHash: parentRoleTransfer.documentHash,
          sequence: fragment.sequence,
          encoding: "json",
          payload: fragment.payload,
          payloadHash: fragment.payloadHash,
        })),
        sourceWriteCaptures: [scriptSourceCapture, moduleSourceCapture, localScriptSourceCapture],
        beforeCapture,
      }),
      "utf8",
    );
    const parentRoleTransferReplay = spawnSync(
      "lune",
      ["run", "scripts/replay-creator-prepare-transfer.luau", parentRoleFixturePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(
      parentRoleTransferReplay.status,
      0,
      `source-backed parent-role Prepare replay failed:\n${parentRoleTransferReplay.stdout}\n${parentRoleTransferReplay.stderr}`,
    );
    assert.match(parentRoleTransferReplay.stdout, /creator Prepare transfer replay passed/);

    // The topology compiler is deliberately more expressive than a sequence
    // of independently valid Studio operations.  Replay the complete wire
    // transfer for every relationship which is only valid *as a transaction*:
    // a child of a parent created in this recording, a child below a moved
    // existing parent, references to created objects (including self and a
    // mutual pair), and a sibling slot freed by an earlier delete or move. This must reach the
    // production StudioAuthoring Prepare receipt; a host-only topology test
    // cannot catch a later plugin regression back to eager live resolution.
    const virtualTransactionOperations = [
      {
        id: "a-create-virtual-parent",
        planChangeId: "plan-a-create-virtual-parent",
        tempId: "temp-a-create-virtual-parent",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-virtual-parent" },
          path: "Workspace/PrepareFixtureConsole/VirtualParent",
          className: "Folder",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "Folder",
        name: "VirtualParent",
        properties: {},
        attributes: {},
      },
      {
        // The lexically earlier existing update must not be allowed to point
        // at an unmaterialized create. This is intentionally distinct from
        // create-to-create references, whose detached handles make forward
        // and mutual references closed before live placement begins.
        id: "b-update-existing-created-reference",
        planChangeId: "plan-b-update-existing-created-reference",
        kind: "update" as const,
        target: {
          kind: "instance" as const,
          identity: existingReferenceValueIdentity,
          path: "Workspace/PrepareFixtureConsole/ExistingReferenceValue",
          className: "ObjectValue",
        },
        properties: {
          Value: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-reference-left" },
            path: "Workspace/PrepareFixtureConsole/ReferenceLeft",
            className: "Part",
            expectedClass: "Instance",
          },
        },
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "b-create-virtual-child",
        planChangeId: "plan-b-create-virtual-child",
        tempId: "temp-b-create-virtual-child",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-virtual-child" },
          path: "Workspace/PrepareFixtureConsole/VirtualParent/VirtualChild",
          className: "Folder",
        },
        parent: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-virtual-parent" },
          path: "Workspace/PrepareFixtureConsole/VirtualParent",
          className: "Folder",
        },
        className: "Folder",
        name: "VirtualChild",
        properties: {},
        attributes: {},
      },
      {
        id: "c-create-reference-left",
        planChangeId: "plan-c-create-reference-left",
        tempId: "temp-c-create-reference-left",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-reference-left" },
          path: "Workspace/PrepareFixtureConsole/ReferenceLeft",
          className: "Part",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "Part",
        name: "ReferenceLeft",
        properties: { Anchored: { kind: "boolean" as const, value: true } },
        attributes: {},
      },
      {
        id: "d-create-reference-right",
        planChangeId: "plan-d-create-reference-right",
        tempId: "temp-d-create-reference-right",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-reference-right" },
          path: "Workspace/PrepareFixtureConsole/ReferenceRight",
          className: "Part",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "Part",
        name: "ReferenceRight",
        properties: { Anchored: { kind: "boolean" as const, value: true } },
        attributes: {},
      },
      {
        id: "e-create-self-reference",
        planChangeId: "plan-e-create-self-reference",
        tempId: "temp-e-create-self-reference",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-self-reference" },
          path: "Workspace/PrepareFixtureConsole/SelfReference",
          className: "ObjectValue",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ObjectValue",
        name: "SelfReference",
        properties: {
          Value: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-self-reference" },
            path: "Workspace/PrepareFixtureConsole/SelfReference",
            className: "ObjectValue",
            expectedClass: "Instance",
          },
        },
        attributes: {},
      },
      {
        id: "f-create-created-reference-weld",
        planChangeId: "plan-f-create-created-reference-weld",
        tempId: "temp-f-create-created-reference-weld",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: {
            kind: "forge_attribute" as const,
            stableId: "prepare-created-reference-weld",
          },
          path: "Workspace/PrepareFixtureConsole/CreatedReferenceWeld",
          className: "WeldConstraint",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "WeldConstraint",
        name: "CreatedReferenceWeld",
        properties: {
          Part0: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-reference-left" },
            path: "Workspace/PrepareFixtureConsole/ReferenceLeft",
            className: "Part",
            expectedClass: "BasePart",
          },
          Part1: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-reference-right" },
            path: "Workspace/PrepareFixtureConsole/ReferenceRight",
            className: "Part",
            expectedClass: "BasePart",
          },
        },
        attributes: {},
      },
      {
        id: "m-create-mutual-left",
        planChangeId: "plan-m-create-mutual-left",
        tempId: "temp-m-create-mutual-left",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-mutual-left" },
          path: "Workspace/PrepareFixtureConsole/MutualLeft",
          className: "ObjectValue",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ObjectValue",
        name: "MutualLeft",
        properties: {
          Value: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-mutual-right" },
            path: "Workspace/PrepareFixtureConsole/MutualRight",
            className: "ObjectValue",
            expectedClass: "Instance",
          },
        },
        attributes: {},
      },
      {
        id: "n-create-mutual-right",
        planChangeId: "plan-n-create-mutual-right",
        tempId: "temp-n-create-mutual-right",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "prepare-mutual-right" },
          path: "Workspace/PrepareFixtureConsole/MutualRight",
          className: "ObjectValue",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ObjectValue",
        name: "MutualRight",
        properties: {
          Value: {
            kind: "instance_ref" as const,
            state: "reference" as const,
            identity: { kind: "forge_attribute" as const, stableId: "prepare-mutual-left" },
            path: "Workspace/PrepareFixtureConsole/MutualLeft",
            className: "ObjectValue",
            expectedClass: "Instance",
          },
        },
        attributes: {},
      },
      {
        id: "g-delete-freed-root",
        planChangeId: "plan-g-delete-freed-root",
        beforeHash: "5".repeat(64),
        kind: "delete" as const,
        target: {
          kind: "instance" as const,
          identity: deleteRootIdentity,
          path: "Workspace/PrepareFixtureConsole/DeleteRoot",
          className: "Folder",
        },
      },
      {
        id: "h-create-delete-replacement",
        planChangeId: "plan-h-create-delete-replacement",
        tempId: "temp-h-create-delete-replacement",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: {
            kind: "forge_attribute" as const,
            stableId: "prepare-delete-replacement",
          },
          path: "Workspace/PrepareFixtureConsole/DeleteRoot",
          className: "Folder",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "Folder",
        name: "DeleteRoot",
        properties: {},
        attributes: {},
      },
      {
        id: "i-move-freed-prompt",
        planChangeId: "plan-i-move-freed-prompt",
        beforeHash: "6".repeat(64),
        kind: "move" as const,
        target: {
          kind: "instance" as const,
          identity: ephemeralPromptIdentity,
          path: "Workspace/PrepareFixtureConsole/ExistingPrompt",
          className: "ProximityPrompt",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        name: "DisplacedExistingPrompt",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
      {
        id: "j-create-move-replacement",
        planChangeId: "plan-j-create-move-replacement",
        tempId: "temp-j-create-move-replacement",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: {
            kind: "forge_attribute" as const,
            stableId: "prepare-move-replacement",
          },
          path: "Workspace/PrepareFixtureConsole/ExistingPrompt",
          className: "ProximityPrompt",
        },
        parent: {
          kind: "instance" as const,
          identity: consoleIdentity,
          path: "Workspace/PrepareFixtureConsole",
          className: "Part",
        },
        className: "ProximityPrompt",
        name: "ExistingPrompt",
        properties: {},
        attributes: {},
      },
      {
        id: "k-create-under-moved-parent",
        planChangeId: "plan-k-create-under-moved-parent",
        tempId: "temp-k-create-under-moved-parent",
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: {
            kind: "forge_attribute" as const,
            stableId: "prepare-child-under-moved-parent",
          },
          path: "StarterPlayer/StarterPlayerScripts/MovedFixtureFolder/ChildUnderMovedParent",
          className: "Folder",
        },
        // The parent is an exact pre-Apply handle; the child target has the
        // final path after this parent moves. Both values are intentional.
        parent: {
          kind: "instance" as const,
          identity: moveIdentity,
          path: "Workspace/PrepareFixtureConsole/MoveMe",
          className: "Folder",
        },
        className: "Folder",
        name: "ChildUnderMovedParent",
        properties: {},
        attributes: {},
      },
      {
        id: "l-move-parent-after-child",
        planChangeId: "plan-l-move-parent-after-child",
        beforeHash: "7".repeat(64),
        kind: "move" as const,
        target: {
          kind: "instance" as const,
          identity: moveIdentity,
          path: "Workspace/PrepareFixtureConsole/MoveMe",
          className: "Folder",
        },
        parent: {
          kind: "instance" as const,
          identity: starterPlayerScriptsIdentity,
          path: "StarterPlayer/StarterPlayerScripts",
          className: "StarterPlayerScripts",
        },
        name: "MovedFixtureFolder",
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
    ] satisfies readonly (CreatorMutationStudioOperation & {
      readonly planChangeId: string;
      readonly tempId?: string;
      readonly beforeHash?: string;
    })[];
    const virtualTopology = compileCreatorTransactionTopology({
      initial: studioProjectIndexMetadataView(beforeCapture).instances,
      operations: virtualTransactionOperations,
    });
    assert.deepEqual(virtualTopology.orderedOperationIds, [
      "a-create-virtual-parent",
      "c-create-reference-left",
      "d-create-reference-right",
      "e-create-self-reference",
      "f-create-created-reference-weld",
      "g-delete-freed-root",
      "i-move-freed-prompt",
      "k-create-under-moved-parent",
      "m-create-mutual-left",
      "n-create-mutual-right",
      "b-create-virtual-child",
      "b-update-existing-created-reference",
      "h-create-delete-replacement",
      "j-create-move-replacement",
      "l-move-parent-after-child",
    ]);
    const virtualTransactionChangeSet = {
      kind: "CreatorChangeSet" as const,
      id: "creator_change_set_prepare_virtual_topology",
      hash: contentHash(stableJson(virtualTopology.orderedOperations)),
      sessionId: "creator_session_prepare_virtual_topology",
      expectedRevisionHash: beforeCapture.revision.hash,
      buildContractHash: "8".repeat(64),
      mutationAuthority: "studio_document" as const,
      sourceWriteBlobs: [],
      localGate: { status: "eligible" as const, issueHashes: [] },
      operations: virtualTopology.orderedOperations,
    };
    const virtualTransactionBinding = {
      sessionId: virtualTransactionChangeSet.sessionId,
      changeSetHash: virtualTransactionChangeSet.hash,
      approvalHash: "9".repeat(64),
      revisionHash: beforeCapture.revision.hash,
      buildHash: virtualTransactionChangeSet.buildContractHash,
      dashboardReviewHash: "a".repeat(64),
    };
    const virtualTransactionDeletedSubtrees = creatorDeleteSubtreesFromProjectIndex(
      virtualTransactionChangeSet,
      beforeCapture,
    );
    const virtualTransactionStructuralParents = creatorStructuralParentsFromProjectIndex(
      virtualTransactionChangeSet,
      beforeCapture,
    );
    assert.equal(virtualTransactionDeletedSubtrees[0]?.descendants.length, 128);
    const virtualTransactionProjection = compileCreatorChangeSetMutationProjection(
      virtualTransactionChangeSet,
      {
        project,
        binding: virtualTransactionBinding,
        initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
        deletedSubtrees: virtualTransactionDeletedSubtrees,
        structuralParents: virtualTransactionStructuralParents,
      },
    );
    const virtualTransactionPreflightProjection = compileCreatorChangeSetMutationProjection(
      virtualTransactionChangeSet,
      {
        project,
        binding: virtualTransactionBinding,
        initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
        purpose: "mutation_preflight",
        deletedSubtrees: virtualTransactionDeletedSubtrees,
        structuralParents: virtualTransactionStructuralParents,
      },
    );
    const virtualTransactionDocument: CreatorChangePrepareDocument = {
      requestId: "creator_prepare_virtual_topology_request",
      creatorSessionId: virtualTransactionChangeSet.sessionId,
      expectedProjectRevisionHash: beforeCapture.revision.hash,
      changeSetJson: stableJson(virtualTransactionChangeSet),
      changeSetJsonHash: contentHash(stableJson(virtualTransactionChangeSet)),
      changeSetId: virtualTransactionChangeSet.id,
      changeSetHash: virtualTransactionChangeSet.hash,
      approvalHash: virtualTransactionBinding.approvalHash,
      dashboardReviewHash: virtualTransactionBinding.dashboardReviewHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionJson: serializeStudioEvidenceProjection(virtualTransactionProjection),
      projectionJsonHash: contentHash(
        serializeStudioEvidenceProjection(virtualTransactionProjection),
      ),
      projectionHash: virtualTransactionProjection.contentHash,
      preflightProjectionJson: serializeStudioEvidenceProjection(
        virtualTransactionPreflightProjection,
      ),
      preflightProjectionJsonHash: contentHash(
        serializeStudioEvidenceProjection(virtualTransactionPreflightProjection),
      ),
      preflightProjectionHash: virtualTransactionPreflightProjection.contentHash,
      beforeProjectIndexManifestId: beforeCapture.indexManifest.id,
      beforeProjectRevisionHash: beforeCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeCapture.detectorEpoch,
    };
    const virtualTransactionTransfer = createCreatorChangePrepareTransfer(
      virtualTransactionDocument,
    );
    const virtualTransactionFixturePath = join(
      temporary,
      "prepare-virtual-topology-transfer-replay.json",
    );
    await writeFile(
      virtualTransactionFixturePath,
      JSON.stringify({
        kind: "CreatorPrepareTransferReplayFixture",
        project,
        boundary: {
          requestId: virtualTransactionDocument.requestId,
          transferId: virtualTransactionTransfer.transferId,
          documentHash: virtualTransactionTransfer.documentHash,
          utf8Bytes: virtualTransactionTransfer.utf8Bytes,
          pieceCount: virtualTransactionTransfer.fragments.length,
        },
        fragments: virtualTransactionTransfer.fragments.map((fragment) => ({
          requestId: virtualTransactionDocument.requestId,
          transferId: virtualTransactionTransfer.transferId,
          documentHash: virtualTransactionTransfer.documentHash,
          sequence: fragment.sequence,
          encoding: "json",
          payload: fragment.payload,
          payloadHash: fragment.payloadHash,
        })),
        beforeCapture,
      }),
      "utf8",
    );
    const virtualTransactionReplay = spawnSync(
      "lune",
      ["run", "scripts/replay-creator-prepare-transfer.luau", virtualTransactionFixturePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(
      virtualTransactionReplay.status,
      0,
      `transactional topology Prepare replay failed:\n${virtualTransactionReplay.stdout}\n${virtualTransactionReplay.stderr}`,
    );
    assert.match(virtualTransactionReplay.stdout, /creator Prepare transfer replay passed/);

    // Exercise production bytes, rather than only semantic recompile inputs:
    // the document embeds escaped JSON, an actual NUL, Unicode, and is large
    // enough to cross several 192KiB Prepare command leaves. These operations
    // are create-only, so the Luau replay reaches StudioAuthoring:prepare but
    // never opens a recording or mutates a Studio instance.
    const transportPrefix = 'quoted " value \\ newline\n nul:\0 unicode:✓ ';
    const transportValue =
      transportPrefix + "x".repeat(4_096 - Buffer.byteLength(transportPrefix, "utf8"));
    assert.equal(Buffer.byteLength(transportValue, "utf8"), 4_096);
    const transportOperations = Array.from({ length: 48 }, (_, index) => ({
      id: `prepare_transport_create_${index}`,
      planChangeId: `prepare_transport_plan_${index}`,
      tempId: `prepare_transport_temp_${index}`,
      kind: "create" as const,
      target: {
        kind: "instance" as const,
        identity: {
          kind: "forge_attribute" as const,
          stableId: `prepare-transport-folder-${index}`,
        },
        path: `Workspace/PrepareTransportFolder${index}`,
        className: "Folder",
      },
      parent: {
        kind: "engine_container" as const,
        path: "Workspace",
        className: "Workspace",
      },
      className: "Folder",
      name: `PrepareTransportFolder${index}`,
      properties: {},
      attributes: { TransportPayload: transportValue },
    }));
    const transportTopology = compileCreatorTransactionTopology({
      initial: studioProjectIndexMetadataView(beforeCapture).instances,
      operations: transportOperations,
    });
    const transportChangeSetHash = contentHash(stableJson(transportTopology.orderedOperations));
    const transportChangeSet = {
      kind: "CreatorChangeSet" as const,
      id: "creator_change_set_prepare_transport",
      hash: transportChangeSetHash,
      sessionId: "creator_session_prepare_transport",
      expectedRevisionHash: beforeCapture.revision.hash,
      buildContractHash: "e".repeat(64),
      mutationAuthority: "studio_document" as const,
      sourceWriteBlobs: [],
      localGate: { status: "eligible" as const, issueHashes: [] },
      operations: transportTopology.orderedOperations,
    };
    const transportBinding = {
      sessionId: transportChangeSet.sessionId,
      changeSetHash: transportChangeSet.hash,
      approvalHash: "f".repeat(64),
      revisionHash: beforeCapture.revision.hash,
      buildHash: transportChangeSet.buildContractHash,
      dashboardReviewHash: "a".repeat(64),
    };
    const transportStructuralParents = creatorStructuralParentsFromProjectIndex(
      transportChangeSet,
      beforeCapture,
    );
    const transportProjection = compileCreatorChangeSetMutationProjection(transportChangeSet, {
      project,
      binding: transportBinding,
      initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
      structuralParents: transportStructuralParents,
    });
    const transportPreflightProjection = compileCreatorChangeSetMutationProjection(
      transportChangeSet,
      {
        project,
        binding: transportBinding,
        initialTopology: studioProjectIndexMetadataView(beforeCapture).instances,
        purpose: "mutation_preflight",
        structuralParents: transportStructuralParents,
      },
    );
    const transportChangeSetJson = stableJson(transportChangeSet);
    const transportProjectionJson = serializeStudioEvidenceProjection(transportProjection);
    const transportPreflightProjectionJson = serializeStudioEvidenceProjection(
      transportPreflightProjection,
    );
    const transportDocument: CreatorChangePrepareDocument = {
      requestId: "creator_prepare_transport_request",
      creatorSessionId: transportChangeSet.sessionId,
      expectedProjectRevisionHash: beforeCapture.revision.hash,
      changeSetJson: transportChangeSetJson,
      changeSetJsonHash: contentHash(transportChangeSetJson),
      changeSetId: transportChangeSet.id,
      changeSetHash: transportChangeSet.hash,
      approvalHash: transportBinding.approvalHash,
      dashboardReviewHash: transportBinding.dashboardReviewHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionJson: transportProjectionJson,
      projectionJsonHash: contentHash(transportProjectionJson),
      projectionHash: transportProjection.contentHash,
      preflightProjectionJson: transportPreflightProjectionJson,
      preflightProjectionJsonHash: contentHash(transportPreflightProjectionJson),
      preflightProjectionHash: transportPreflightProjection.contentHash,
      beforeProjectIndexManifestId: beforeCapture.indexManifest.id,
      beforeProjectRevisionHash: beforeCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeCapture.detectorEpoch,
    };
    const transport = createCreatorChangePrepareTransfer(transportDocument);
    const serializedTransportDocument = stableJson(transportDocument);
    assert.match(serializedTransportDocument, /\\u0000/);
    assert.match(serializedTransportDocument, /quoted \\+\" value/);
    assert.ok(serializedTransportDocument.includes("✓"));
    assert.ok(transport.fragments.length > 1);
    assert.equal(
      Buffer.concat(
        transport.fragments.map((fragment) => Buffer.from(fragment.payload, "utf8")),
      ).toString("utf8"),
      serializedTransportDocument,
      "host fragmentation must preserve every serialized Prepare byte",
    );
    const transferFixturePath = join(temporary, "prepare-transfer-replay.json");
    await writeFile(
      transferFixturePath,
      JSON.stringify({
        kind: "CreatorPrepareTransferReplayFixture",
        project,
        boundary: {
          requestId: transportDocument.requestId,
          transferId: transport.transferId,
          documentHash: transport.documentHash,
          utf8Bytes: transport.utf8Bytes,
          pieceCount: transport.fragments.length,
        },
        fragments: transport.fragments.map((fragment) => ({
          requestId: transportDocument.requestId,
          transferId: transport.transferId,
          documentHash: transport.documentHash,
          sequence: fragment.sequence,
          encoding: "json",
          payload: fragment.payload,
          payloadHash: fragment.payloadHash,
        })),
        beforeCapture,
      }),
      "utf8",
    );
    const transferReplay = spawnSync(
      "lune",
      ["run", "scripts/replay-creator-prepare-transfer.luau", transferFixturePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(
      transferReplay.status,
      0,
      `serialized Prepare transfer replay failed:\n${transferReplay.stdout}\n${transferReplay.stderr}`,
    );
    assert.match(transferReplay.stdout, /creator Prepare transfer replay passed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("host Prepare parent/collision validation is keyed by captured parent identity and name", () => {
  const project = { name: "CreatorCollisionContract", placeId: 0, universeId: 0 };
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "creator_collision_contract_epoch",
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const workspace = { kind: "forge_attribute" as const, stableId: "collision-workspace" };
  const parentA = { kind: "forge_attribute" as const, stableId: "collision-parent-a" };
  const parentB = { kind: "forge_attribute" as const, stableId: "collision-parent-b" };
  const opaqueParent = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: projection.connectorEpoch,
    opaqueHash: "c".repeat(64),
  };
  const capture = (selectedParentHasChild: boolean, engineHasChild: boolean) =>
    createStudioProjectIndexCapture({
      projection,
      shards: [
        createStudioProjectEvidenceShard({
          root: "Workspace",
          ordinal: 0,
          nodes: [
            {
              identity: workspace,
              displayPath: "Workspace",
              name: "Workspace",
              className: "Workspace",
              engineContainer: { path: "Workspace", className: "Workspace" },
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
            {
              identity: parentA,
              parentIdentity: workspace,
              displayPath: "Workspace/Duplicate",
              name: "Duplicate",
              className: "Folder",
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
            {
              identity: parentB,
              parentIdentity: workspace,
              displayPath: "Workspace/Duplicate",
              name: "Duplicate",
              className: "Folder",
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
            {
              identity: { kind: "forge_attribute", stableId: "collision-other-parent-snap" },
              parentIdentity: parentB,
              displayPath: "Workspace/Duplicate/Snap",
              name: "Snap",
              className: "Folder",
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
            {
              identity: opaqueParent,
              parentIdentity: workspace,
              displayPath: "Workspace/OpaqueParent",
              name: "OpaqueParent",
              className: "Camera",
              attributes: {},
              tags: [],
              coveredProperties: {},
              coveredPropertyNames: [],
            },
            ...(selectedParentHasChild
              ? [
                  {
                    identity: {
                      kind: "forge_attribute" as const,
                      stableId: "collision-selected-parent-snap",
                    },
                    parentIdentity: parentA,
                    displayPath: "Workspace/Duplicate/Snap",
                    name: "Snap",
                    className: "Folder",
                    attributes: {},
                    tags: [],
                    coveredProperties: {},
                    coveredPropertyNames: [],
                  },
                ]
              : []),
            ...(engineHasChild
              ? [
                  {
                    identity: {
                      kind: "forge_attribute" as const,
                      stableId: "collision-engine-child",
                    },
                    parentIdentity: workspace,
                    displayPath: "Workspace/EngineTaken",
                    name: "EngineTaken",
                    className: "Folder",
                    attributes: {},
                    tags: [],
                    coveredProperties: {},
                    coveredPropertyNames: [],
                  },
                ]
              : []),
          ],
        }),
      ],
      sourceManifests: [],
      sourceChunks: [],
      completedAt: "2026-09-03T00:00:00.000Z",
      detectorEpoch: 0,
    });
  const create = (
    id: string,
    parent:
      | {
          readonly kind: "instance";
          readonly identity: typeof parentA;
          readonly path: string;
          readonly className: string;
        }
      | {
          readonly kind: "instance";
          readonly identity: typeof opaqueParent;
          readonly path: string;
          readonly className: string;
        }
      | { readonly kind: "engine_container"; readonly path: string; readonly className: string },
    name: string,
  ) => ({
    id,
    hash: "a".repeat(64),
    sessionId: "creator-collision-contract-session",
    expectedRevisionHash: "b".repeat(64),
    buildContractHash: "d".repeat(64),
    operations: [
      {
        id: `${id}-operation`,
        kind: "create" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: `${id}-target` },
          path: `${parent.path}/${name}`,
          className: "Folder",
        },
        parent,
        className: "Folder",
        name,
        properties: {},
        attributes: {},
      },
    ],
  });
  const exactParentA = {
    kind: "instance" as const,
    identity: parentA,
    path: "Workspace/Duplicate",
    className: "Folder",
  };
  const exactOpaqueParent = {
    kind: "instance" as const,
    identity: opaqueParent,
    path: "Workspace/OpaqueParent",
    className: "Camera",
  };
  const workspaceParent = {
    kind: "engine_container" as const,
    path: "Workspace",
    className: "Workspace",
  };
  assert.doesNotThrow(() =>
    creatorDeleteSubtreesFromProjectIndex(
      create("other-parent-accept", exactParentA, "Snap"),
      capture(false, false),
    ),
  );
  assert.doesNotThrow(() =>
    creatorDeleteSubtreesFromProjectIndex(
      create("opaque-parent-accept", exactOpaqueParent, "Snap"),
      capture(false, false),
    ),
  );
  assert.throws(
    () =>
      creatorDeleteSubtreesFromProjectIndex(
        create("selected-parent-reject", exactParentA, "Snap"),
        capture(true, false),
      ),
    /(selected parent|sibling name collision)/i,
  );
  assert.doesNotThrow(() =>
    creatorDeleteSubtreesFromProjectIndex(
      create("engine-parent-accept", workspaceParent, "EngineFree"),
      capture(false, false),
    ),
  );
  assert.throws(
    () =>
      creatorDeleteSubtreesFromProjectIndex(
        create("engine-parent-reject", workspaceParent, "EngineTaken"),
        capture(false, true),
      ),
    /(selected parent|sibling name collision)/i,
  );
});
