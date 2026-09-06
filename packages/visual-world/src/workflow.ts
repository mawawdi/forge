import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertArtifactReference,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import { assertBoundedGameJson, entityId, hashSchema } from "../../game-ir/src/primitives.js";
import {
  BLENDER_SCENE_HANDLE_SCHEMA,
  BLENDER_SCENE_SPEC_SCHEMA,
  DEFAULT_VISUAL_WORLD_ADMISSION_POLICY,
  blenderSceneSpecHandle,
  validateBlenderSceneSpec,
  type BlenderSceneHandle,
  type BlenderSceneSpec,
} from "./contracts.js";

const timestamp = z.string().datetime({ offset: true });
const positiveId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const artifact = z
  .object({ id: entityId, hash: hashSchema, bytes: z.number().int().positive() })
  .strict();
const actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: positiveId }).strict(),
  z.object({ kind: z.literal("group"), id: positiveId }).strict(),
]);

export const RETAINED_BLENDER_SCENE_SCHEMA = z
  .object({
    kind: z.literal("RetainedBlenderScene"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    spec: BLENDER_SCENE_SPEC_SCHEMA,
    retainedAt: timestamp,
  })
  .strict();
export type RetainedBlenderScene = z.infer<typeof RETAINED_BLENDER_SCENE_SCHEMA>;

export interface RetainedBlenderSceneBinding {
  readonly scene: BlenderSceneHandle;
  readonly recordId: string;
  readonly recordHash: string;
  readonly artifact: ArtifactReference;
}

/**
 * Resolves a scene handle only through an exact retained canonical artifact.
 * Current-scene selection remains host authority; this store performs no
 * latest-revision fallback or revision migration.
 */
export class RetainedBlenderSceneStore {
  constructor(private readonly artifacts: ImmutableJsonArtifactStore) {}

  async retain(
    specInput: BlenderSceneSpec,
    retainedAt: string,
  ): Promise<RetainedBlenderSceneBinding> {
    const spec = validateBlenderSceneSpec(specInput);
    const scene = blenderSceneSpecHandle(spec);
    const record = sealWorkflowArtifact(RETAINED_BLENDER_SCENE_SCHEMA, {
      kind: "RetainedBlenderScene",
      scene,
      spec,
      retainedAt,
    });
    return {
      scene,
      recordId: record.id,
      recordHash: record.hash,
      artifact: await this.artifacts.write(record),
    };
  }

  async resolve(
    binding: RetainedBlenderSceneBinding,
    requested: BlenderSceneHandle,
  ): Promise<BlenderSceneSpec> {
    assertBoundedGameJson(binding, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
    const expected = BLENDER_SCENE_HANDLE_SCHEMA.parse(requested);
    const bound = BLENDER_SCENE_HANDLE_SCHEMA.parse(binding.scene);
    assertArtifactReference(binding.artifact);
    if (stableJson(bound) !== stableJson(expected))
      throw new Error("Scene handle is stale or differs from the retained binding");
    const record = await this.artifacts.read<RetainedBlenderScene>(binding.artifact, (value) =>
      assertSealedWorkflowArtifact(RETAINED_BLENDER_SCENE_SCHEMA, value),
    );
    if (
      record.id !== binding.recordId ||
      record.hash !== binding.recordHash ||
      stableJson(record.scene) !== stableJson(expected)
    )
      throw new Error("Retained scene record identity mismatch");
    const spec = validateBlenderSceneSpec(record.spec);
    if (stableJson(blenderSceneSpecHandle(spec)) !== stableJson(expected))
      throw new Error("Retained scene bytes do not match the requested handle");
    return spec;
  }
}

export const CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("CreatorVisualWorldProposal"),
    id: entityId,
    hash: hashSchema,
    projectId: z.string().min(1).max(256),
    projectRevisionHash: hashSchema,
    creatorRequestHash: hashSchema,
    referenceHashes: z.array(hashSchema).max(4),
    agentRunId: entityId,
    agentRunHash: hashSchema,
    semanticDesignHash: hashSchema,
    solvedScene: BLENDER_SCENE_HANDLE_SCHEMA,
    sourceConsultationHash: hashSchema,
    intendedImplementation: z.string().trim().min(1).max(4096),
    proposedAt: timestamp,
  })
  .strict();
export type CreatorVisualWorldProposal = z.infer<typeof CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA>;

export const CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA = z
  .object({
    kind: z.literal("CreatorVisualWorldAcceptance"),
    id: entityId,
    hash: hashSchema,
    proposalId: entityId,
    proposalHash: hashSchema,
    decision: z.enum(["accepted", "rejected"]),
    decidedAt: timestamp,
  })
  .strict();
export type CreatorVisualWorldAcceptance = z.infer<typeof CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA>;

export const NATIVE_UPLOAD_AUTHORIZATION_SCHEMA = z
  .object({
    kind: z.literal("NativeUploadAuthorization"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    bundleManifestHash: hashSchema,
    reviewId: entityId,
    reviewHash: hashSchema,
    exportArtifacts: z.array(artifact).min(1).max(512),
    creator: actor,
    target: z
      .object({
        projectId: z.string().min(1).max(256),
        universeId: z.number().int().nonnegative().safe(),
      })
      .strict(),
    credentialCapability: z
      .object({
        kind: z.enum(["api_key", "oauth2", "manual_studio_import"]),
        scopes: z.array(z.enum(["asset:read", "asset:write"])).max(2),
        capabilityHash: hashSchema,
      })
      .strict(),
    authorizedAt: timestamp,
  })
  .strict();
export type NativeUploadAuthorization = z.infer<typeof NATIVE_UPLOAD_AUTHORIZATION_SCHEMA>;

export const OPEN_CLOUD_UPLOAD_INTENT_SCHEMA = z
  .object({
    kind: z.literal("OpenCloudUploadIntent"),
    id: entityId,
    hash: hashSchema,
    dispatchKey: hashSchema,
    authorizationId: entityId,
    authorizationHash: hashSchema,
    artifact: artifact,
    endpoint: z.literal("https://apis.roblox.com/assets/v1/assets"),
    method: z.literal("POST"),
    assetType: z.literal("Model"),
    displayName: z.string().trim().min(1).max(50),
    description: z.string().trim().max(1000),
    creator: actor,
    createdAt: timestamp,
    dispatchState: z.enum([
      "not_dispatched",
      "dispatching",
      "response_received",
      "outcome_unknown",
    ]),
  })
  .strict();
export type OpenCloudUploadIntent = z.infer<typeof OPEN_CLOUD_UPLOAD_INTENT_SCHEMA>;

export const OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA = z
  .object({
    kind: z.literal("OpenCloudOperationResponse"),
    id: entityId,
    hash: hashSchema,
    intentId: entityId,
    intentHash: hashSchema,
    httpStatus: z.number().int().min(100).max(599),
    operationPath: z
      .string()
      .regex(/^operations\/[A-Za-z0-9._~-]{1,512}$/)
      .optional(),
    body: z.unknown(),
    bodyHash: hashSchema,
    receivedAt: timestamp,
  })
  .strict();
export type OpenCloudOperationResponse = z.infer<typeof OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA>;

export const NATIVE_ASSET_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("NativeAssetReceipt"),
    id: entityId,
    hash: hashSchema,
    authorizationHash: hashSchema,
    sourceArtifactHash: hashSchema,
    operationResponseHash: hashSchema.optional(),
    declarationAuthority: z.enum(["open_cloud", "creator_reported_manual"]),
    assetId: positiveId,
    versionNumber: z.number().int().positive(),
    contentHash: hashSchema.optional(),
    owner: actor,
    moderation: z.enum(["approved", "pending", "rejected", "unknown"]),
    dependencyAccess: z.enum(["eligible", "incomplete", "rejected"]),
    observedAt: timestamp,
  })
  .strict();
export type NativeAssetReceipt = z.infer<typeof NATIVE_ASSET_RECEIPT_SCHEMA>;

export const APPROVED_SCENE_INSPECTED_NODE_SCHEMA = z
  .object({
    assetId: positiveId,
    sourceArtifactHash: hashSchema,
    stableId: entityId,
    relativePath: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+)*$/u),
    name: z.string().min(1).max(100),
    className: z.string().min(1).max(100),
    parentStableId: entityId.optional(),
    contentIdentity: z.string().min(1).max(512).optional(),
    materialIdentity: z.string().min(1).max(512).optional(),
    pivotHash: hashSchema,
    transformHash: hashSchema,
    boundsHash: hashSchema,
    executable: z.boolean(),
  })
  .strict();

export const APPROVED_SCENE_ASSET_INSPECTION_SCHEMA = z
  .object({
    kind: z.literal("ApprovedSceneAssetInspection"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    bundleManifestHash: hashSchema,
    capabilityProfileHash: hashSchema,
    receipts: z
      .array(
        z
          .object({
            assetId: positiveId,
            versionNumber: z.number().int().positive(),
            receiptHash: hashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(512),
    detached: z.literal(true),
    platformEnvelope: z
      .object({
        className: z.literal("Model"),
        packageLinkRemoved: z.literal(true),
        envelopeHash: hashSchema,
      })
      .strict(),
    expectedNodes: z.array(APPROVED_SCENE_INSPECTED_NODE_SCHEMA).max(65_536),
    observedNodes: z.array(APPROVED_SCENE_INSPECTED_NODE_SCHEMA).max(65_536),
    inspectedAt: timestamp,
  })
  .strict();
export type ApprovedSceneAssetInspection = z.infer<typeof APPROVED_SCENE_ASSET_INSPECTION_SCHEMA>;

export const NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA = z
  .object({
    kind: z.literal("NativeAssetConversionExpectation"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    bundleManifestHash: hashSchema,
    uploadAuthorizationHash: hashSchema,
    capabilityProfileHash: hashSchema,
    receiptHash: hashSchema,
    assetId: positiveId,
    versionNumber: z.number().int().positive().safe(),
    sourceArtifactHash: hashSchema,
    partitionId: entityId,
    partitionRole: z.enum([
      "WorldStatic",
      "WorldCollision",
      "GameplayAnchors",
      "InteractiveProps",
      "Effects",
    ]),
    exactVersionArtifact: z
      .object({
        locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/),
        artifactHash: hashSchema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(256 * 1024 * 1024),
        mediaType: z.enum(["application/octet-stream", "application/xml", "model/gltf-binary"]),
      })
      .strict(),
    sourceGlbReportHash: hashSchema,
    decoderIdentityHash: hashSchema,
    expectedNodes: z.array(APPROVED_SCENE_INSPECTED_NODE_SCHEMA).min(1).max(65_536),
    derivedAt: timestamp,
  })
  .strict();
export type NativeAssetConversionExpectation = z.infer<
  typeof NATIVE_ASSET_CONVERSION_EXPECTATION_SCHEMA
>;

export const GAME_PLAN_VISUAL_BINDINGS_SCHEMA = z
  .object({
    kind: z.literal("GamePlanVisualBindings"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    proposalHash: hashSchema,
    proposalAcceptanceHash: hashSchema,
    bundleManifestHash: hashSchema,
    sceneReviewHash: hashSchema,
    uploadAuthorizationHash: hashSchema,
    assetReceiptHashes: z.array(hashSchema).min(1).max(512),
    capabilityProfileHash: hashSchema,
    inspectionHash: hashSchema,
  })
  .strict();
export type GamePlanVisualBindings = z.infer<typeof GAME_PLAN_VISUAL_BINDINGS_SCHEMA>;

export function createGamePlanVisualBindings(input: {
  scene: z.infer<typeof BLENDER_SCENE_HANDLE_SCHEMA>;
  proposal: CreatorVisualWorldProposal;
  acceptance: CreatorVisualWorldAcceptance;
  bundleManifestHash: string;
  sceneReviewHash: string;
  authorization: NativeUploadAuthorization;
  receipts: readonly NativeAssetReceipt[];
  capabilityProfileHash: string;
  inspection: ApprovedSceneAssetInspection;
}): GamePlanVisualBindings {
  assertSealedWorkflowArtifact(CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA, input.proposal);
  assertSealedWorkflowArtifact(CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA, input.acceptance);
  assertSealedWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, input.authorization);
  assertSealedWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, input.inspection);
  for (const receipt of input.receipts)
    assertSealedWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, receipt);
  if (
    stableJson(input.scene) !== stableJson(input.proposal.solvedScene) ||
    input.acceptance.proposalId !== input.proposal.id ||
    input.acceptance.proposalHash !== input.proposal.hash ||
    input.acceptance.decision !== "accepted" ||
    input.authorization.scene.hash !== input.scene.hash ||
    input.authorization.bundleManifestHash !== input.bundleManifestHash ||
    input.authorization.reviewHash !== input.sceneReviewHash ||
    input.inspection.scene.hash !== input.scene.hash ||
    input.inspection.bundleManifestHash !== input.bundleManifestHash ||
    input.inspection.capabilityProfileHash !== input.capabilityProfileHash
  )
    throw new Error("Visual plan authorities do not bind one accepted, reviewed scene revision");
  const eligibility = evaluateNativeSceneEligibility({
    authorization: input.authorization,
    receipts: input.receipts,
    inspection: input.inspection,
  });
  if (eligibility.status !== "eligible")
    throw new Error(
      `Visual scene is not eligible for native planning: ${eligibility.diagnostics.join("; ")}`,
    );
  return sealWorkflowArtifact(GAME_PLAN_VISUAL_BINDINGS_SCHEMA, {
    kind: "GamePlanVisualBindings",
    scene: input.scene,
    proposalHash: input.proposal.hash,
    proposalAcceptanceHash: input.acceptance.hash,
    bundleManifestHash: input.bundleManifestHash,
    sceneReviewHash: input.sceneReviewHash,
    uploadAuthorizationHash: input.authorization.hash,
    assetReceiptHashes: input.receipts.map((receipt) => receipt.hash).sort(),
    capabilityProfileHash: input.capabilityProfileHash,
    inspectionHash: input.inspection.hash,
  });
}

export const SAVE_REOPEN_EVIDENCE_SCHEMA = z
  .object({
    kind: z.literal("SaveReopenEvidence"),
    abi: z.literal("forge-save-reopen-evidence@2"),
    id: entityId,
    hash: hashSchema,
    projectId: z.string().min(1).max(256),
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    creatorDeclarationHash: hashSchema,
    matchedMutationHash: hashSchema,
    finalizationReceiptHash: hashSchema,
    savedPlace: z
      .object({
        locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/),
        artifactHash: hashSchema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024 * 1024),
        mediaType: z.literal("application/octet-stream"),
      })
      .strict(),
    decoderIdentityHash: hashSchema,
    decodedStateHash: hashSchema,
    closedAt: timestamp,
    reopenedAt: timestamp,
    reopenedConnectorBuildHash: hashSchema,
    reopenedConnectorSessionId: entityId,
    freshNativeCaptureHash: hashSchema,
    freshSourceCaptureHash: hashSchema,
    reopenedRevisionHash: hashSchema,
    status: z.literal("matched"),
    derivedAt: timestamp,
  })
  .strict();
export type SaveReopenEvidence = z.infer<typeof SAVE_REOPEN_EVIDENCE_SCHEMA>;

export const MANUAL_SCENE_IMPORT_PACKET_SCHEMA = z
  .object({
    kind: z.literal("ManualSceneImportPacket"),
    id: entityId,
    hash: hashSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    reviewHash: hashSchema,
    glbs: z
      .array(
        z
          .object({
            partitionId: entityId,
            absolutePath: z.string().min(1).max(4096),
            artifactHash: hashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(512),
    importer: z
      .object({
        units: z.literal("studs"),
        anchored: z.literal(true),
        importAsModel: z.literal(true),
        useWorldOrigin: z.literal(false),
        collision: z.literal("off"),
      })
      .strict(),
  })
  .strict();
export type ManualSceneImportPacket = z.infer<typeof MANUAL_SCENE_IMPORT_PACKET_SCHEMA>;

export type NativeSceneEligibility =
  { status: "eligible" } | { status: "incomplete" | "rejected"; diagnostics: string[] };

export function approvedSceneAssetContentHash(
  nodes: readonly z.infer<typeof APPROVED_SCENE_INSPECTED_NODE_SCHEMA>[],
): string {
  return contentHash(
    stableJson(
      nodes
        .map(({ assetId: _assetId, sourceArtifactHash: _sourceArtifactHash, ...node }) => node)
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
  );
}

export function approvedScenePlatformEnvelopeHash(): string {
  return contentHash(
    stableJson({
      className: "Model",
      packageLinks: [{ className: "PackageLink", placement: "direct_child" }],
      packageLinkRemoved: true,
    }),
  );
}

export function evaluateNativeSceneEligibility(input: {
  authorization: NativeUploadAuthorization;
  receipts: readonly NativeAssetReceipt[];
  inspection?: ApprovedSceneAssetInspection;
}): NativeSceneEligibility {
  const authorization = NATIVE_UPLOAD_AUTHORIZATION_SCHEMA.parse(input.authorization);
  const receipts = input.receipts.map((receipt) => NATIVE_ASSET_RECEIPT_SCHEMA.parse(receipt));
  const diagnostics: string[] = [];
  if (
    new Set(authorization.exportArtifacts.map((entry) => entry.hash)).size !==
      authorization.exportArtifacts.length ||
    new Set(authorization.exportArtifacts.map((entry) => entry.id)).size !==
      authorization.exportArtifacts.length
  )
    return { status: "rejected", diagnostics: ["Authorized export inventory is ambiguous"] };
  if (
    receipts.length !== authorization.exportArtifacts.length ||
    new Set(receipts.map((entry) => entry.sourceArtifactHash)).size !==
      authorization.exportArtifacts.length ||
    receipts.some(
      (entry) =>
        !authorization.exportArtifacts.some(
          (artifactValue) => artifactValue.hash === entry.sourceArtifactHash,
        ),
    )
  )
    diagnostics.push("Asset receipts do not cover the exact reviewed export inventory");
  for (const artifactValue of authorization.exportArtifacts) {
    const receipt = receipts.find((entry) => entry.sourceArtifactHash === artifactValue.hash);
    if (!receipt) continue;
    if (receipt.authorizationHash !== authorization.hash)
      return {
        status: "rejected",
        diagnostics: [`Asset receipt authorization differs: ${receipt.assetId}`],
      };
    if (stableJson(receipt.owner) !== stableJson(authorization.creator))
      diagnostics.push(`Asset ownership differs: ${receipt.assetId}`);
    if (receipt.moderation === "rejected" || receipt.dependencyAccess === "rejected")
      return {
        status: "rejected",
        diagnostics: [`Asset is rejected by moderation or access policy: ${receipt.assetId}`],
      };
    if (
      receipt.moderation !== "approved" ||
      receipt.dependencyAccess !== "eligible" ||
      receipt.contentHash === undefined
    )
      diagnostics.push(
        `Asset lacks approved moderation, dependency access, or content identity: ${receipt.assetId}`,
      );
    if (receipt.declarationAuthority === "creator_reported_manual")
      diagnostics.push(`Creator-reported asset remains a declaration: ${receipt.assetId}`);
  }
  if (!input.inspection) diagnostics.push("Detached native inspection is absent");
  else {
    const inspection = APPROVED_SCENE_ASSET_INSPECTION_SCHEMA.parse(input.inspection);
    if (
      inspection.scene.hash !== authorization.scene.hash ||
      inspection.bundleManifestHash !== authorization.bundleManifestHash
    )
      return { status: "rejected", diagnostics: ["Inspection binds a different scene bundle"] };
    if (inspection.platformEnvelope.envelopeHash !== approvedScenePlatformEnvelopeHash())
      return {
        status: "rejected",
        diagnostics: ["Inspection has an unknown platform package envelope"],
      };
    const inspectionReceipts = inspection.receipts
      .map((entry) => `${entry.assetId}:${entry.versionNumber}:${entry.receiptHash}`)
      .sort();
    const expectedReceipts = receipts
      .map((entry) => `${entry.assetId}:${entry.versionNumber}:${entry.hash}`)
      .sort();
    if (stableJson(inspectionReceipts) !== stableJson(expectedReceipts))
      return { status: "rejected", diagnostics: ["Inspection receipt/version inventory differs"] };
    if (inspection.observedNodes.some((node) => node.executable))
      return {
        status: "rejected",
        diagnostics: ["Imported hierarchy contains an executable descendant"],
      };
    if (inspection.expectedNodes.some((node) => node.executable))
      return {
        status: "rejected",
        diagnostics: ["Expected hierarchy admits an executable descendant"],
      };
    for (const [label, nodes] of [
      ["expected", inspection.expectedNodes],
      ["observed", inspection.observedNodes],
    ] as const) {
      const stableIds = new Set<string>();
      const paths = new Set<string>();
      for (const node of nodes) {
        const key = stableJson([node.assetId, node.sourceArtifactHash, node.relativePath]);
        if (stableIds.has(node.stableId) || paths.has(key))
          return {
            status: "rejected",
            diagnostics: [`Inspection ${label} hierarchy is ambiguous`],
          };
        stableIds.add(node.stableId);
        paths.add(key);
        const receipt = receipts.find(
          (entry) =>
            entry.assetId === node.assetId && entry.sourceArtifactHash === node.sourceArtifactHash,
        );
        if (!receipt)
          return {
            status: "rejected",
            diagnostics: [`Inspection ${label} node has no asset receipt`],
          };
      }
    }
    if (stableJson(inspection.observedNodes) !== stableJson(inspection.expectedNodes))
      return {
        status: "rejected",
        diagnostics: [
          "Imported hierarchy, names, content, transforms, pivots, materials, or bounds differ",
        ],
      };
    for (const receipt of receipts) {
      const nodes = inspection.expectedNodes.filter(
        (node) =>
          node.assetId === receipt.assetId &&
          node.sourceArtifactHash === receipt.sourceArtifactHash,
      );
      if (
        nodes.length === 0 ||
        receipt.contentHash === undefined ||
        approvedSceneAssetContentHash(nodes) !== receipt.contentHash
      )
        diagnostics.push(
          `Detached hierarchy content differs from the retained asset version: ${receipt.assetId}`,
        );
    }
  }
  return diagnostics.length ? { status: "incomplete", diagnostics } : { status: "eligible" };
}

export function sealWorkflowArtifact<T extends { kind: string; id: string; hash: string }>(
  schema: z.ZodType<T>,
  input: Omit<T, "id" | "hash">,
): T {
  assertBoundedGameJson(input, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const material = structuredClone(input) as T;
  const hash = contentHash(stableJson(material));
  const value = {
    ...material,
    id: `${input.kind.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}_${hash.slice(0, 24)}`,
    hash,
  } as T;
  return schema.parse(value);
}

export function assertSealedWorkflowArtifact<T extends { kind: string; id: string; hash: string }>(
  schema: z.ZodType<T>,
  value: unknown,
): asserts value is T {
  assertBoundedGameJson(value, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const parsed = schema.parse(value);
  const { id, hash, ...material } = parsed;
  const expectedHash = contentHash(stableJson(material));
  const expectedId = `${parsed.kind.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}_${expectedHash.slice(0, 24)}`;
  if (hash !== expectedHash || id !== expectedId)
    throw new Error(`${parsed.kind} identity mismatch`);
}

export function sealOpenCloudResponse(
  input: Omit<OpenCloudOperationResponse, "kind" | "id" | "hash" | "bodyHash">,
): OpenCloudOperationResponse {
  assertBoundedGameJson(input.body, {
    ...DEFAULT_VISUAL_WORLD_ADMISSION_POLICY,
    maximumJsonBytes: 1024 * 1024,
  });
  return sealWorkflowArtifact(OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA, {
    ...input,
    kind: "OpenCloudOperationResponse",
    bodyHash: contentHash(stableJson(input.body)),
  });
}
