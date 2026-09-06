import { z } from "zod";
import type {
  BinaryArtifactReference,
  ImmutableBinaryArtifactStore,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type {
  ApprovedSceneAssetsInspectedPayload,
  BackendToPluginMessage,
  PluginToBackendMessage,
} from "../../studio-protocol/src/index.js";
import {
  assertBackendToPluginMessage,
  assertPluginToBackendMessage,
} from "../../studio-protocol/src/index.js";
import {
  APPROVED_SCENE_ASSET_INSPECTION_SCHEMA,
  APPROVED_SCENE_INSPECTED_NODE_SCHEMA,
  NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA,
  NATIVE_ASSET_RECEIPT_SCHEMA,
  approvedSceneAssetContentHash,
  approvedScenePlatformEnvelopeHash,
  assertSealedWorkflowArtifact,
  sealWorkflowArtifact,
  type ApprovedSceneAssetInspection,
  type NativeAssetConversionExpectation,
  type NativeAssetReceipt,
} from "./workflow.js";
import { BLENDER_SCENE_HANDLE_SCHEMA, type BlenderSceneHandle } from "./contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const importedDescendant = APPROVED_SCENE_INSPECTED_NODE_SCHEMA.omit({
  assetId: true,
  sourceArtifactHash: true,
  executable: true,
});
const inspectionBinding = z
  .object({
    kind: z.literal("inspect_approved_scene_asset"),
    abi: z.literal("inspect_approved_scene_asset@2"),
    challengeHash: hash,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    bundleManifestHash: hash,
    sceneReviewHash: hash,
    uploadAuthorizationHash: hash,
    capabilityProfileHash: hash,
    partitionId: z.string().min(1).max(512),
    partitionRole: z.enum([
      "WorldStatic",
      "WorldCollision",
      "GameplayAnchors",
      "InteractiveProps",
      "Effects",
    ]),
    sourceArtifactHash: hash,
    receiptHash: hash,
    assetId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    versionNumber: z.number().int().positive().safe(),
    contentHash: hash,
    platformEnvelopeHash: hash,
    descendants: z.array(importedDescendant).min(1).max(65_536),
  })
  .strict();

export const APPROVED_SCENE_INSPECTION_DOCUMENT_SCHEMA = z
  .object({
    kind: z.literal("InspectApprovedSceneAsset"),
    abi: z.literal("inspect-approved-scene-asset@2"),
    challengeId: z.string().min(1).max(256),
    challengeHash: hash,
    targetProjectId: z.string().min(1).max(512),
    sceneHash: hash,
    bundleManifestHash: hash,
    uploadAuthorizationHash: hash,
    capabilityProfileHash: hash,
    conversionExpectationHash: hash,
    binding: inspectionBinding,
  })
  .strict();

const eligibleResult = z
  .object({
    status: z.literal("eligible"),
    partitionId: z.string().min(1).max(512),
    assetId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    versionNumber: z.number().int().positive().safe(),
    receiptHash: hash,
    sourceArtifactHash: hash,
    contentHash: hash,
    platformEnvelopeHash: hash,
    observedNodes: z.array(APPROVED_SCENE_INSPECTED_NODE_SCHEMA).min(1).max(65_536),
  })
  .strict();
const failedResult = z
  .object({
    status: z.enum(["rejected", "incomplete"]),
    diagnostic: z.string().min(1).max(4096),
  })
  .strict();
export const APPROVED_SCENE_ASSET_OBSERVATION_SCHEMA = z
  .object({
    kind: z.literal("ApprovedSceneAssetObservation"),
    abi: z.literal("approved-scene-asset-observation@2"),
    challengeId: z.string().min(1).max(256),
    challengeHash: hash,
    sceneHash: hash,
    bundleManifestHash: hash,
    uploadAuthorizationHash: hash,
    capabilityProfileHash: hash,
    result: z.union([eligibleResult, failedResult]),
  })
  .strict();

export async function retainNativeAssetConversionExpectation(input: {
  readonly binaryStore: ImmutableBinaryArtifactStore;
  readonly exactVersionArtifact: BinaryArtifactReference;
  readonly scene: BlenderSceneHandle;
  readonly bundleManifestHash: string;
  readonly uploadAuthorizationHash: string;
  readonly capabilityProfileHash: string;
  readonly receipt: NativeAssetReceipt;
  readonly partitionId: string;
  readonly partitionRole: NativeAssetConversionExpectation["partitionRole"];
  readonly sourceGlbReportHash: string;
  readonly decoderIdentityHash: string;
  readonly expectedNodes: NativeAssetConversionExpectation["expectedNodes"];
  readonly derivedAt: string;
}): Promise<NativeAssetConversionExpectation> {
  assertSealedWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, input.receipt);
  if (input.receipt.declarationAuthority !== "open_cloud")
    throw new Error("Native conversion expectation requires authenticated platform evidence");
  await input.binaryStore.verify(input.exactVersionArtifact);
  const exactVersionMediaType = z
    .enum(["application/octet-stream", "application/xml", "model/gltf-binary"])
    .parse(input.exactVersionArtifact.mediaType);
  const expectedNodes = input.expectedNodes.map((node) =>
    APPROVED_SCENE_INSPECTED_NODE_SCHEMA.parse(node),
  );
  if (
    input.receipt.contentHash === undefined ||
    input.receipt.authorizationHash !== input.uploadAuthorizationHash ||
    expectedNodes.some(
      (node) =>
        node.assetId !== input.receipt.assetId ||
        node.sourceArtifactHash !== input.receipt.sourceArtifactHash ||
        node.executable,
    ) ||
    approvedSceneAssetContentHash(expectedNodes) !== input.receipt.contentHash
  )
    throw new Error("Decoded exact-version inventory differs from its authenticated receipt");
  return sealWorkflowArtifact(NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA, {
    kind: "NativeAssetConversionExpectation",
    scene: BLENDER_SCENE_HANDLE_SCHEMA.parse(input.scene),
    bundleManifestHash: input.bundleManifestHash,
    uploadAuthorizationHash: input.uploadAuthorizationHash,
    capabilityProfileHash: input.capabilityProfileHash,
    receiptHash: input.receipt.hash,
    assetId: input.receipt.assetId,
    versionNumber: input.receipt.versionNumber,
    sourceArtifactHash: input.receipt.sourceArtifactHash,
    partitionId: input.partitionId,
    partitionRole: input.partitionRole,
    exactVersionArtifact: { ...input.exactVersionArtifact, mediaType: exactVersionMediaType },
    sourceGlbReportHash: input.sourceGlbReportHash,
    decoderIdentityHash: input.decoderIdentityHash,
    expectedNodes,
    derivedAt: input.derivedAt,
  });
}

export function createApprovedSceneInspectionCommand(input: {
  readonly sessionId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly sentAt: string;
  readonly connectorBuildHash: string;
  readonly targetProjectId: string;
  readonly expectedProjectRevisionHash: string;
  readonly sceneReviewHash: string;
  readonly expectation: NativeAssetConversionExpectation;
  readonly receipt: NativeAssetReceipt;
}): Extract<BackendToPluginMessage, { type: "InspectApprovedSceneAssets" }> {
  assertSealedWorkflowArtifact(NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA, input.expectation);
  assertSealedWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, input.receipt);
  if (
    input.expectation.receiptHash !== input.receipt.hash ||
    input.expectation.assetId !== input.receipt.assetId ||
    input.expectation.versionNumber !== input.receipt.versionNumber ||
    input.expectation.sourceArtifactHash !== input.receipt.sourceArtifactHash
  )
    throw new Error("Inspection expectation and asset receipt differ");
  const challengeMaterial = {
    requestId: input.requestId,
    connectorBuildHash: input.connectorBuildHash,
    targetProjectId: input.targetProjectId,
    expectedProjectRevisionHash: input.expectedProjectRevisionHash,
    sceneHash: input.expectation.scene.hash,
    conversionExpectationHash: input.expectation.hash,
  };
  const challengeHash = contentHash(stableJson(challengeMaterial));
  const challengeId = `approved_scene_inspection_${challengeHash.slice(0, 24)}`;
  const descendants = input.expectation.expectedNodes
    .map(
      ({ assetId: _assetId, sourceArtifactHash: _source, executable: _executable, ...node }) =>
        node,
    )
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const document = APPROVED_SCENE_INSPECTION_DOCUMENT_SCHEMA.parse({
    kind: "InspectApprovedSceneAsset",
    abi: "inspect-approved-scene-asset@2",
    challengeId,
    challengeHash,
    targetProjectId: input.targetProjectId,
    sceneHash: input.expectation.scene.hash,
    bundleManifestHash: input.expectation.bundleManifestHash,
    uploadAuthorizationHash: input.expectation.uploadAuthorizationHash,
    capabilityProfileHash: input.expectation.capabilityProfileHash,
    conversionExpectationHash: input.expectation.hash,
    binding: {
      kind: "inspect_approved_scene_asset",
      abi: "inspect_approved_scene_asset@2",
      challengeHash,
      scene: input.expectation.scene,
      bundleManifestHash: input.expectation.bundleManifestHash,
      sceneReviewHash: input.sceneReviewHash,
      uploadAuthorizationHash: input.expectation.uploadAuthorizationHash,
      capabilityProfileHash: input.expectation.capabilityProfileHash,
      partitionId: input.expectation.partitionId,
      partitionRole: input.expectation.partitionRole,
      sourceArtifactHash: input.expectation.sourceArtifactHash,
      receiptHash: input.expectation.receiptHash,
      assetId: input.expectation.assetId,
      versionNumber: input.expectation.versionNumber,
      contentHash: input.receipt.contentHash,
      platformEnvelopeHash: approvedScenePlatformEnvelopeHash(),
      descendants,
    },
  });
  const inspectionDocumentJson = stableJson(document);
  const message: Extract<BackendToPluginMessage, { type: "InspectApprovedSceneAssets" }> = {
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "InspectApprovedSceneAssets",
    messageId: input.messageId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    sentAt: input.sentAt,
    payload: {
      requestId: input.requestId,
      challengeId,
      challengeHash,
      connectorBuildHash: input.connectorBuildHash,
      targetProjectId: input.targetProjectId,
      expectedProjectRevisionHash: input.expectedProjectRevisionHash,
      sceneHash: input.expectation.scene.hash,
      bundleManifestHash: input.expectation.bundleManifestHash,
      uploadAuthorizationHash: input.expectation.uploadAuthorizationHash,
      capabilityProfileHash: input.expectation.capabilityProfileHash,
      inspectionDocumentJson,
      inspectionDocumentJsonHash: contentHash(inspectionDocumentJson),
    },
  };
  assertBackendToPluginMessage(message);
  return message;
}

interface CompletedInspection {
  readonly expectation: NativeAssetConversionExpectation;
  readonly receipt: NativeAssetReceipt;
  readonly command: Extract<BackendToPluginMessage, { type: "InspectApprovedSceneAssets" }>;
  readonly response: Extract<PluginToBackendMessage, { type: "ApprovedSceneAssetsInspected" }>;
}

export function deriveApprovedSceneAssetInspection(input: {
  readonly scene: BlenderSceneHandle;
  readonly bundleManifestHash: string;
  readonly capabilityProfileHash: string;
  readonly completed: readonly CompletedInspection[];
}): ApprovedSceneAssetInspection {
  if (input.completed.length < 1 || input.completed.length > 512)
    throw new Error("Detached inspection must cover one to 512 visual exports");
  const expectedNodes: NativeAssetConversionExpectation["expectedNodes"][number][] = [];
  const observedNodes: NativeAssetConversionExpectation["expectedNodes"][number][] = [];
  const receipts: ApprovedSceneAssetInspection["receipts"][number][] = [];
  let inspectedAt = "";
  for (const completed of input.completed) {
    assertSealedWorkflowArtifact(NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA, completed.expectation);
    assertSealedWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, completed.receipt);
    assertBackendToPluginMessage(completed.command);
    assertPluginToBackendMessage(completed.response);
    const request = completed.command.payload;
    const response: ApprovedSceneAssetsInspectedPayload = completed.response.payload;
    if (
      completed.response.requestId !== completed.command.requestId ||
      response.requestId !== request.requestId ||
      response.challengeId !== request.challengeId ||
      response.challengeHash !== request.challengeHash ||
      response.connectorBuildHash !== request.connectorBuildHash ||
      response.targetProjectId !== request.targetProjectId ||
      response.projectRevisionHash !== request.expectedProjectRevisionHash ||
      response.sceneHash !== request.sceneHash ||
      response.bundleManifestHash !== request.bundleManifestHash ||
      response.uploadAuthorizationHash !== request.uploadAuthorizationHash ||
      response.capabilityProfileHash !== request.capabilityProfileHash ||
      response.inspectionDocumentJsonHash !== request.inspectionDocumentJsonHash
    )
      throw new Error("Detached inspection response does not bind its exact challenge");
    const observation = APPROVED_SCENE_ASSET_OBSERVATION_SCHEMA.parse(
      JSON.parse(response.observationJson),
    );
    if (stableJson(observation) !== response.observationJson)
      throw new Error("Detached inspection observation is not canonical");
    if (response.status !== observation.result.status || observation.result.status !== "eligible")
      throw new Error(
        observation.result.status === "eligible"
          ? "Detached inspection status differs from its observation"
          : `Detached inspection is ${observation.result.status}: ${observation.result.diagnostic}`,
      );
    if (
      observation.challengeHash !== request.challengeHash ||
      observation.sceneHash !== input.scene.hash ||
      observation.bundleManifestHash !== input.bundleManifestHash ||
      observation.capabilityProfileHash !== input.capabilityProfileHash ||
      observation.result.receiptHash !== completed.receipt.hash ||
      observation.result.platformEnvelopeHash !== approvedScenePlatformEnvelopeHash()
    )
      throw new Error("Detached inspection observation authority differs");
    expectedNodes.push(...completed.expectation.expectedNodes);
    observedNodes.push(...observation.result.observedNodes);
    receipts.push({
      assetId: completed.receipt.assetId,
      versionNumber: completed.receipt.versionNumber,
      receiptHash: completed.receipt.hash,
    });
    if (response.inspectedAt > inspectedAt) inspectedAt = response.inspectedAt;
  }
  const stableIds = new Set(expectedNodes.map((node) => node.stableId));
  if (stableIds.size !== expectedNodes.length)
    throw new Error("Detached inspection stable identities are ambiguous across assets");
  return sealWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, {
    kind: "ApprovedSceneAssetInspection",
    scene: BLENDER_SCENE_HANDLE_SCHEMA.parse(input.scene),
    bundleManifestHash: input.bundleManifestHash,
    capabilityProfileHash: input.capabilityProfileHash,
    receipts: receipts.sort((left, right) => left.receiptHash.localeCompare(right.receiptHash)),
    detached: true,
    platformEnvelope: {
      className: "Model",
      packageLinkRemoved: true,
      envelopeHash: approvedScenePlatformEnvelopeHash(),
    },
    expectedNodes: expectedNodes.sort((left, right) => left.stableId.localeCompare(right.stableId)),
    observedNodes: observedNodes.sort((left, right) => left.stableId.localeCompare(right.stableId)),
    inspectedAt,
  });
}
