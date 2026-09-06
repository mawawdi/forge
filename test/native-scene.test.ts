import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  sealSceneBundleReview,
  type SceneBundleManifest,
  type SceneBundleOutput,
} from "../packages/blender-compiler/src/index.js";
import { compileApprovedSceneComponent } from "../packages/native-scene/src/index.js";
import { APPROVED_SCENE_REPLACEMENT_BINDING_SCHEMA } from "../packages/creator-session/src/index.js";
import { compileCreatorTransactionTopology } from "../packages/creator-session/src/transaction-topology.js";
import {
  APPROVED_SCENE_ASSET_INSPECTION_SCHEMA,
  CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA,
  CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA,
  NATIVE_ASSET_RECEIPT_SCHEMA,
  NATIVE_UPLOAD_AUTHORIZATION_SCHEMA,
  approvedSceneAssetContentHash,
  approvedScenePlatformEnvelopeHash,
  blenderSceneSpecHandle,
  createGamePlanVisualBindings,
  sealWorkflowArtifact,
  solveBlenderScene,
} from "../packages/visual-world/src/index.js";
import { robloxAssetCapabilityProfile } from "../packages/roblox-assets/src/index.js";
import { visualWorldIntent } from "./helpers/visual-world-fixture.js";

const NOW = "2026-09-06T12:00:00.000Z";

test("an exact approved visual revision compiles one closed import and explicit native semantics", () => {
  const solve = solveBlenderScene(visualWorldIntent());
  assert.equal(solve.status, "eligible");
  if (solve.status !== "eligible") return;
  const scene = solve.spec;
  const handle = blenderSceneSpecHandle(scene);
  const outputs: SceneBundleOutput[] = scene.expectedOutputs
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        kind: Exclude<typeof entry.kind, "manifest">;
      } => entry.kind !== "manifest",
    )
    .map((entry) => ({
      ...entry,
      artifactHash: contentHash(`synthetic:${entry.id}`),
      bytes: 128,
      mediaType:
        entry.kind === "glb"
          ? "model/gltf-binary"
          : entry.kind === "blend"
            ? "application/x-blender"
            : entry.kind === "review_render"
              ? "image/png"
              : "application/json",
    }));
  const manifestMaterial = {
    kind: "SceneBundleManifest" as const,
    abi: "forge-blender-compiler@2" as const,
    id: `scene_bundle_${handle.hash.slice(0, 24)}`,
    scene: handle,
    compilerInstallationHash: "1".repeat(64),
    invocationHash: "2".repeat(64),
    coordinateProfile: {
      scene: "roblox-y-up-studs" as const,
      blenderMapping: "x,-z,y" as const,
      export: "roblox-glb-y-up@2" as const,
    },
    outputs,
    glbReports: [],
    objectInventory: scene.objects.map((object) => ({
      stableId: object.id,
      exportName: `Forge_${object.id}_${contentHash(object.id).slice(0, 10)}`,
      partitionId: object.partitionId,
    })),
    partitionInventory: scene.partitions.map((partition) => ({
      id: partition.id,
      role: partition.role,
      outputIds: outputs
        .filter((entry) => entry.partitionId === partition.id)
        .map((entry) => entry.id),
    })),
    sourceHashes: [],
    generatedAt: NOW,
  };
  const manifest: SceneBundleManifest = {
    ...manifestMaterial,
    hash: contentHash(stableJson(manifestMaterial)),
  };
  const proposal = sealWorkflowArtifact(CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA, {
    kind: "CreatorVisualWorldProposal",
    projectId: scene.projectId,
    projectRevisionHash: "3".repeat(64),
    creatorRequestHash: scene.creatorRequestHash,
    referenceHashes: scene.referenceHashes,
    agentRunId: "agent-run-fixture",
    agentRunHash: "a".repeat(64),
    semanticDesignHash: "4".repeat(64),
    solvedScene: handle,
    sourceConsultationHash: "5".repeat(64),
    intendedImplementation: "Use the fixed compiler and import only reviewed outputs.",
    proposedAt: NOW,
  });
  const acceptance = sealWorkflowArtifact(CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA, {
    kind: "CreatorVisualWorldAcceptance",
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    decision: "accepted",
    decidedAt: NOW,
  });
  const reviewedHashes = outputs
    .filter((output) => output.kind === "glb" || output.kind === "review_render")
    .map((output) => output.artifactHash);
  const review = sealSceneBundleReview({
    scene: handle,
    manifestHash: manifest.hash,
    decision: "approved",
    reviewedOutputHashes: reviewedHashes,
    note: "Synthetic contract fixture; not Studio or Blender evidence.",
    decidedAt: NOW,
  });
  const glbs = outputs.filter((output) => output.kind === "glb");
  const authorization = sealWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, {
    kind: "NativeUploadAuthorization",
    scene: handle,
    bundleManifestHash: manifest.hash,
    reviewId: review.id,
    reviewHash: review.hash,
    exportArtifacts: glbs.map((glb) => ({
      id: glb.id,
      hash: glb.artifactHash,
      bytes: glb.bytes,
    })),
    creator: { kind: "user", id: "1234" },
    target: { projectId: scene.projectId, universeId: 99 },
    credentialCapability: {
      kind: "api_key",
      scopes: ["asset:read", "asset:write"],
      capabilityHash: "6".repeat(64),
    },
    authorizedAt: NOW,
  });
  const nodes = glbs.map((glb, index) => ({
    assetId: String(987654 + index),
    sourceArtifactHash: glb.artifactHash,
    stableId: `fixture-imported-mesh-${index}`,
    relativePath: `FixtureMesh${index}`,
    name: `FixtureMesh${index}`,
    className: "MeshPart",
    contentIdentity: `{"meshId":"rbxassetid://${987654 + index}","textureId":""}`,
    materialIdentity: "Metal",
    pivotHash: "7".repeat(64),
    transformHash: "7".repeat(64),
    boundsHash: "8".repeat(64),
    executable: false,
  }));
  const receipts = glbs.map((glb, index) =>
    sealWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, {
      kind: "NativeAssetReceipt",
      authorizationHash: authorization.hash,
      sourceArtifactHash: glb.artifactHash,
      operationResponseHash: contentHash(`operation:${glb.id}`),
      declarationAuthority: "open_cloud",
      assetId: nodes[index]!.assetId,
      versionNumber: 1,
      contentHash: approvedSceneAssetContentHash([nodes[index]!]),
      owner: authorization.creator,
      moderation: "approved",
      dependencyAccess: "eligible",
      observedAt: NOW,
    }),
  );
  const capability = robloxAssetCapabilityProfile();
  const inspection = sealWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, {
    kind: "ApprovedSceneAssetInspection",
    scene: handle,
    bundleManifestHash: manifest.hash,
    capabilityProfileHash: capability.hash,
    receipts: receipts.map((receipt) => ({
      assetId: receipt.assetId,
      versionNumber: 1,
      receiptHash: receipt.hash,
    })),
    detached: true,
    platformEnvelope: {
      className: "Model",
      packageLinkRemoved: true,
      envelopeHash: approvedScenePlatformEnvelopeHash(),
    },
    expectedNodes: nodes,
    observedNodes: nodes,
    inspectedAt: NOW,
  });
  const bindings = createGamePlanVisualBindings({
    scene: handle,
    proposal,
    acceptance,
    bundleManifestHash: manifest.hash,
    sceneReviewHash: review.hash,
    authorization,
    receipts,
    capabilityProfileHash: capability.hash,
    inspection,
  });
  const compilation = compileApprovedSceneComponent({
    context: {
      componentId: "fixture-world",
      projectId: scene.projectId,
      project: { name: "Fixture", placeId: 0, universeId: 0 },
      designHash: "a".repeat(64),
      initialTopology: [],
    },
    component: {
      kind: "scene_handle",
      id: "fixture-world",
      scene: handle,
      ports: [],
      obligations: [],
    },
    scene,
    authority: {
      bindings,
      proposal,
      acceptance,
      manifest,
      review,
      authorization,
      receipts,
      inspection,
    },
  });

  const imported = compilation.inventory.find(
    (item) =>
      item.change.kind === "create" &&
      item.change.initialization === "initial_properties" &&
      item.change.approvedSceneImport !== undefined,
  );
  assert.ok(imported);
  if (imported?.change.kind !== "create" || imported.change.initialization !== "initial_properties")
    return;
  const importBinding = imported.change.approvedSceneImport;
  assert.equal(importBinding?.kind, "import_approved_scene");
  assert.ok(receipts.some((receipt) => importBinding?.contentHash === receipt.contentHash));
  assert.equal(importBinding?.descendants.length, 1);
  const interactiveImport = compilation.inventory.find(
    (item) =>
      item.change.kind === "create" &&
      item.change.initialization === "initial_properties" &&
      item.change.approvedSceneImport?.partitionId === "interactive-partition",
  );
  const wrapper = compilation.inventory.find(
    (item) => item.outputId === "interaction/fixture-interaction",
  );
  assert.ok(interactiveImport && wrapper);
  assert.equal(interactiveImport?.change.kind, "create");
  if (
    interactiveImport?.change.kind === "create" &&
    interactiveImport.change.initialization === "initial_properties" &&
    wrapper?.change.kind === "create"
  ) {
    assert.equal(interactiveImport.change.parent.kind, "instance");
    if (interactiveImport.change.parent.kind === "instance")
      assert.equal(interactiveImport.change.parent.path, wrapper.change.path);
  }
  const socket = compilation.inventory.find((item) => item.outputId === "socket/fixture-socket");
  assert.equal(socket?.change.kind, "create");
  if (socket?.change.kind === "create") assert.equal(socket.change.className, "Attachment");
  const collision = compilation.inventory.find(
    (item) => item.outputId === "collision/fixture-collision",
  );
  assert.equal(collision?.change.kind, "create");
  if (
    collision?.change.kind === "create" &&
    collision.change.initialization === "initial_properties"
  )
    assert.deepEqual(collision.lockedProperties.Shape, { kind: "enum_name", value: "Block" });
  assert.ok(compilation.outputs.some((output) => output.id === "collision/fixture-collision"));
  assert.ok(compilation.outputs.some((output) => output.id === "anchor/objective-anchor"));
  assert.ok(compilation.outputs.some((output) => output.id === "interaction/fixture-interaction"));
  assert.ok(compilation.outputs.some((output) => output.id === "effect/fixture-light"));
  assert.equal(
    imported.dependencies.some((dependency) =>
      compilation.inventory.some(
        (item) => item.id === dependency && item.outputId === "partition/collision-partition",
      ),
    ),
    false,
    "semantic-only partition dependencies do not require a GLB operation",
  );
});

test("approved scene replacement preserves its wrapper and orders exact deletion before insertion", () => {
  const hash = "a".repeat(64);
  const imported = {
    kind: "import_approved_scene" as const,
    abi: "import_approved_scene@2" as const,
    scene: { sceneId: "repair-scene", revision: 1, hash },
    bundleManifestHash: hash,
    sceneReviewHash: hash,
    uploadAuthorizationHash: hash,
    capabilityProfileHash: hash,
    inspectionHash: hash,
    partitionId: "reactor-visual",
    partitionRole: "InteractiveProps" as const,
    sourceArtifactHash: hash,
    receiptHash: hash,
    assetId: "1234",
    versionNumber: 1,
    contentHash: hash,
    platformEnvelopeHash: hash,
    descendants: [
      {
        stableId: "old-mesh",
        relativePath: "Mesh",
        name: "Mesh",
        className: "MeshPart",
        pivotHash: hash,
        transformHash: hash,
        boundsHash: hash,
      },
    ],
  };
  const oldTarget = {
    kind: "instance" as const,
    identity: { kind: "forge_attribute" as const, stableId: "old-reactor-visual" },
    path: "Workspace/ReactorWrapper/reactor-visual",
    className: "Model" as const,
  };
  const replacement = APPROVED_SCENE_REPLACEMENT_BINDING_SCHEMA.parse({
    kind: "replace_approved_scene",
    abi: "replace_approved_scene@2",
    previous: imported,
    next: {
      ...imported,
      scene: { sceneId: "repair-scene", revision: 2, hash: "b".repeat(64) },
      sourceArtifactHash: "b".repeat(64),
      receiptHash: "b".repeat(64),
      assetId: "5678",
      versionNumber: 1,
      contentHash: "b".repeat(64),
      descendants: [
        {
          ...imported.descendants[0]!,
          stableId: "new-mesh",
          transformHash: "b".repeat(64),
        },
      ],
    },
    previousTarget: oldTarget,
    previousBeforeHash: hash,
    repairDeltaHash: "c".repeat(64),
  });
  const wrapperIdentity = { kind: "forge_attribute" as const, stableId: "reactor-wrapper" };
  const topology = compileCreatorTransactionTopology({
    initial: [
      {
        identity: wrapperIdentity,
        path: "Workspace/ReactorWrapper",
        name: "ReactorWrapper",
        className: "Model",
      },
      {
        identity: oldTarget.identity,
        parentIdentity: wrapperIdentity,
        path: oldTarget.path,
        name: "reactor-visual",
        className: "Model",
      },
      {
        identity: { kind: "forge_attribute", stableId: "old-mesh" },
        parentIdentity: oldTarget.identity,
        path: `${oldTarget.path}/Mesh`,
        name: "Mesh",
        className: "MeshPart",
      },
    ],
    operations: [
      { id: "delete-old", kind: "delete", target: oldTarget },
      {
        id: "insert-new",
        kind: "create",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "new-reactor-visual" },
          path: oldTarget.path,
          className: "Model",
        },
        parent: {
          kind: "instance",
          identity: wrapperIdentity,
          path: "Workspace/ReactorWrapper",
          className: "Model",
        },
        name: "reactor-visual",
        properties: {},
        approvedSceneReplacement: replacement,
      },
    ],
  });
  assert.deepEqual(topology.orderedOperationIds, ["delete-old", "insert-new"]);
  assert.ok(topology.deletedIdentityKeys.includes("forge_attribute:old-mesh"));
  assert.ok(
    topology.finalNodes.some(
      (node) => node.identity.kind === "forge_attribute" && node.identity.stableId === "new-mesh",
    ),
  );
  assert.ok(
    topology.finalNodes.some(
      (node) =>
        node.identity.kind === "forge_attribute" && node.identity.stableId === "reactor-wrapper",
    ),
  );
});
