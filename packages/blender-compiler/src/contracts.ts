import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { type BinaryArtifactReference } from "../../artifact-store/src/index.js";
import {
  BLENDER_COMPILER_PROFILE,
  BLENDER_MACOS_ARM64_DMG_SHA256,
  BLENDER_SCENE_HANDLE_SCHEMA,
  BLENDER_VERSION,
  SCENE_PARTITION_ROLES,
  type BlenderSceneHandle,
} from "../../visual-world/src/index.js";
import { entityId, hashSchema } from "../../game-ir/src/primitives.js";
import type { GlbInspectionReport } from "./glb.js";

export const BLENDER_COMPILER_ABI = "forge-blender-compiler@2";
export const BLENDER_EXPORT_PROFILE = "roblox-glb-y-up@2";
export const BLENDER_INSTALLATION_QUALIFICATION_ABI = "forge-blender-installation-qualification@2";

export const BLENDER_COMPILER_INSTALLATION_SCHEMA = z
  .object({
    kind: z.literal("BlenderInstallationQualification"),
    qualificationAbi: z.literal(BLENDER_INSTALLATION_QUALIFICATION_ABI),
    abi: z.literal(BLENDER_COMPILER_ABI),
    profile: z.literal(BLENDER_COMPILER_PROFILE),
    platform: z.literal("darwin-arm64"),
    blenderVersion: z.literal(BLENDER_VERSION),
    distributionPath: z.string().min(1).max(4096),
    distributionBytes: z.number().int().positive(),
    distributionImageVerified: z.literal(true),
    executablePath: z.string().min(1).max(4096),
    executableSha256: hashSchema,
    distributionSha256: z.literal(BLENDER_MACOS_ARM64_DMG_SHA256),
    applicationPath: z.string().min(1).max(4096),
    applicationInventorySha256: hashSchema,
    applicationFileCount: z.number().int().positive(),
    applicationBytes: z.number().int().positive(),
    executableArchitecture: z.literal("arm64"),
    bundleIdentifier: z.literal("org.blenderfoundation.blender"),
    teamIdentifier: z.literal("68UA947AUU"),
    designatedRequirementSha256: hashSchema,
    codeSignatureValidated: z.literal(true),
    bundledPythonRelativePath: z.literal("Contents/Resources/5.2/python/bin/python3.13"),
    bundledPythonSha256: hashSchema,
    bundledLibraryCount: z.number().int().positive(),
    bundledLibraryInventorySha256: hashSchema,
    seatbeltPolicySha256: hashSchema,
    workerSha256: hashSchema,
    inspectorSha256: hashSchema,
    operationSetSha256: hashSchema,
    exportProfileSha256: hashSchema,
    qualifiedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BlenderCompilerInstallation = z.infer<typeof BLENDER_COMPILER_INSTALLATION_SCHEMA>;

export const SCENE_BUNDLE_OUTPUT_SCHEMA = z
  .object({
    id: entityId,
    kind: z.enum([
      "blend",
      "glb",
      "native_semantics",
      "geometry_report",
      "material_report",
      "budget_report",
      "review_render",
    ]),
    relativePath: z.string(),
    partitionId: entityId.optional(),
    viewId: entityId.optional(),
    artifactHash: hashSchema,
    bytes: z.number().int().positive(),
    mediaType: z.string(),
  })
  .strict();
export type SceneBundleOutput = z.infer<typeof SCENE_BUNDLE_OUTPUT_SCHEMA>;

export interface SceneBundleManifest {
  kind: "SceneBundleManifest";
  abi: typeof BLENDER_COMPILER_ABI;
  id: string;
  hash: string;
  scene: BlenderSceneHandle;
  compilerInstallationHash: string;
  invocationHash: string;
  coordinateProfile: {
    scene: "roblox-y-up-studs";
    blenderMapping: "x,-z,y";
    export: typeof BLENDER_EXPORT_PROFILE;
  };
  outputs: SceneBundleOutput[];
  glbReports: GlbInspectionReport[];
  objectInventory: Array<{
    stableId: string;
    exportName: string;
    partitionId: string;
    sourceObjectId?: string;
    instanceIndex?: number;
  }>;
  partitionInventory: Array<{
    id: string;
    role: (typeof SCENE_PARTITION_ROLES)[number];
    outputIds: string[];
  }>;
  sourceHashes: Array<{ id: string; sha256: string }>;
  repairDeltaHash?: string;
  generatedAt: string;
}

export interface SceneRepairDelta {
  kind: "SceneRepairDelta";
  abi: typeof BLENDER_COMPILER_ABI;
  id: string;
  hash: string;
  parentScene: BlenderSceneHandle;
  nextScene: BlenderSceneHandle;
  repairPlanHash: string;
  changedVisualStableIds: string[];
  changedNativeStableIds: string[];
  changedPartitionIds: string[];
  changedViewIds: string[];
  preservedNativeStableIds: string[];
  neighboringInterfaceIds: string[];
  reusedArtifacts: Array<{
    outputId: string;
    artifactHash: string;
    bytes: number;
    mediaType: string;
  }>;
}

export interface CompiledSceneBundle {
  kind: "CompiledSceneBundle";
  manifest: SceneBundleManifest;
  manifestArtifact: BinaryArtifactReference;
  artifacts: Array<{ output: SceneBundleOutput; artifact: BinaryArtifactReference }>;
  repairDelta?: { delta: SceneRepairDelta; artifact: BinaryArtifactReference };
}

export const BLENDER_COMPILER_FAILURE_CODES = [
  "missing_blender",
  "unqualified_blender",
  "invalid_source_asset",
  "unsupported_material",
  "budget_failure",
  "compiler_timeout",
  "compiler_failure",
  "malformed_output",
] as const;
export type BlenderCompilerFailureCode = (typeof BLENDER_COMPILER_FAILURE_CODES)[number];

export type BlenderCompileResult =
  | { status: "eligible"; bundle: CompiledSceneBundle }
  | {
      status: "rejected" | "incomplete";
      code: BlenderCompilerFailureCode;
      detail: string;
      invocationHash?: string;
    };

export interface SceneBundleReview {
  kind: "SceneBundleReview";
  id: string;
  hash: string;
  scene: BlenderSceneHandle;
  manifestHash: string;
  decision: "approved" | "rejected";
  reviewedOutputHashes: string[];
  note: string;
  decidedAt: string;
}

export function sealSceneBundleReview(
  input: Omit<SceneBundleReview, "kind" | "id" | "hash">,
): SceneBundleReview {
  BLENDER_SCENE_HANDLE_SCHEMA.parse(input.scene);
  if (
    !input.reviewedOutputHashes.length ||
    new Set(input.reviewedOutputHashes).size !== input.reviewedOutputHashes.length
  )
    throw new Error("Scene bundle review requires distinct reviewed outputs");
  const material = {
    kind: "SceneBundleReview" as const,
    id: `scene_bundle_review_${contentHash(stableJson(input)).slice(0, 24)}`,
    ...structuredClone(input),
    reviewedOutputHashes: [...input.reviewedOutputHashes].sort(),
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

export function assertSceneBundleReview(value: unknown): asserts value is SceneBundleReview {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Scene bundle review must be an object");
  const review = value as SceneBundleReview;
  BLENDER_SCENE_HANDLE_SCHEMA.parse(review.scene);
  if (
    review.kind !== "SceneBundleReview" ||
    !review.id.startsWith("scene_bundle_review_") ||
    !/^[0-9a-f]{64}$/.test(review.hash) ||
    !/^[0-9a-f]{64}$/.test(review.manifestHash) ||
    !["approved", "rejected"].includes(review.decision) ||
    !Array.isArray(review.reviewedOutputHashes) ||
    review.reviewedOutputHashes.length === 0 ||
    new Set(review.reviewedOutputHashes).size !== review.reviewedOutputHashes.length ||
    !review.reviewedOutputHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)) ||
    typeof review.note !== "string" ||
    review.note.length > 4096 ||
    Number.isNaN(Date.parse(review.decidedAt))
  )
    throw new Error("Scene bundle review is malformed");
  const { hash, ...material } = review;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Scene bundle review identity mismatch");
}
