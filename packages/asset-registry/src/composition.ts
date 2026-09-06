import { z } from "zod";
import type { ArtifactReference } from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import type { AssetFit, AssetGeometry, AssetLock, AssetSpec } from "./index.js";

/** A reference issued by a reviewed host job, not a model-authored asset identity. */
export interface ReviewedAssetCompositionPin {
  jobId: string;
  assetId: string;
  lockHash: string;
  reviewHash: string;
  universeId: number;
}

/** Immutable local source/layout handoff. It grants no native import or editor inventory. */
export interface ReviewedAssetCompositionBinding {
  kind: "ReviewedAssetCompositionBinding";
  hash: string;
  jobId: string;
  assetId: string;
  universeId: number;
  reviewDecisionHash: string;
  preparation: ArtifactReference;
  outcome: ArtifactReference;
  lock: { hash: string; artifact: ArtifactReference };
  source: { sha256: string; utf8Bytes: number; artifact: ArtifactReference };
  spec: AssetSpec;
  geometry: AssetGeometry;
  fit: AssetFit;
  nativeImport: {
    status: "incomplete";
    mayInstantiate: false;
    code: "native_import_unavailable";
    reason: string;
  };
}
export interface ReviewedAssetCompositionResolution {
  binding: ReviewedAssetCompositionBinding;
  bindingArtifact: ArtifactReference;
  review: ArtifactReference;
}
export interface ReviewedAssetCompositionCatalog {
  kind: "ReviewedAssetCompositionCatalog";
  hash: string;
  assets: ReviewedAssetCompositionResolution[];
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z
  .object({
    jobId: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    assetId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    lockHash: sha256,
    reviewHash: sha256,
    universeId: z.number().int().nonnegative().safe(),
  })
  .strict();

export function parseCompositionPin(input: unknown): ReviewedAssetCompositionPin {
  assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
  return pinSchema.parse(input);
}
export function parseCompositionPins(input: unknown): ReviewedAssetCompositionPin[] {
  assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
  return z.array(pinSchema).max(64).parse(input);
}

/** Called only after the job's source/receipt/history closure has been replayed. */
export function createCompositionBinding(input: {
  jobId: string;
  reviewDecision: unknown;
  preparation: ArtifactReference;
  outcome: ArtifactReference;
  lockArtifact: ArtifactReference;
  lock: AssetLock;
}): ReviewedAssetCompositionBinding {
  const value = {
    kind: "ReviewedAssetCompositionBinding" as const,
    jobId: input.jobId,
    assetId: input.lock.assetId,
    universeId: input.lock.spec.universeId,
    reviewDecisionHash: contentHash(stableJson(input.reviewDecision)),
    preparation: input.preparation,
    outcome: input.outcome,
    lock: { hash: input.lock.hash, artifact: input.lockArtifact },
    source: {
      sha256: input.lock.sourceHash,
      utf8Bytes: input.lock.sourceUtf8Bytes,
      artifact: input.lock.sourceArtifact,
    },
    spec: input.lock.spec,
    geometry: input.lock.geometry,
    fit: input.lock.fit,
    nativeImport: {
      status: "incomplete" as const,
      mayInstantiate: false as const,
      code: "native_import_unavailable" as const,
      reason:
        "Only local source bytes, measured geometry and requested fit are reviewed. A separately admitted native importer must establish ownership, moderation, loading permission, actual group/socket mapping, transforms, collision and persistence before any asset instance can enter editor inventory. No placeholder or MeshPart constructor is authorized.",
    },
  };
  return structuredClone({ ...value, hash: contentHash(stableJson(value)) });
}
