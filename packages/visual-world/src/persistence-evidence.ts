import type {
  BinaryArtifactReference,
  ImmutableBinaryArtifactStore,
} from "../../artifact-store/src/index.js";
import { BLENDER_SCENE_HANDLE_SCHEMA, type BlenderSceneHandle } from "./contracts.js";
import {
  SAVE_REOPEN_EVIDENCE_SCHEMA,
  sealWorkflowArtifact,
  type SaveReopenEvidence,
} from "./workflow.js";

export interface DecodedSavedPlaceState {
  readonly decoderIdentityHash: string;
  readonly savedPlaceArtifactHash: string;
  readonly projectId: string;
  readonly revisionHash: string;
  readonly nativeStateHash: string;
  readonly sourceStateHash: string;
}

export interface FreshReopenedStudioCapture {
  readonly connectorBuildHash: string;
  readonly connectorSessionId: string;
  readonly projectId: string;
  readonly revisionHash: string;
  readonly nativeStateHash: string;
  readonly sourceStateHash: string;
  readonly captureHash: string;
  readonly capturedAt: string;
}

export type SaveReopenDerivation =
  | { readonly status: "eligible"; readonly evidence: SaveReopenEvidence }
  | { readonly status: "incomplete" | "rejected"; readonly diagnostics: readonly string[] };

/**
 * Derive persistence evidence from retained place bytes and a fresh connector
 * capture. The decoder is read-only host code; this function never evaluates
 * source from the saved place.
 */
export async function deriveSaveReopenEvidence(input: {
  readonly binaryStore: ImmutableBinaryArtifactStore;
  readonly savedPlace: BinaryArtifactReference;
  readonly projectId: string;
  readonly scene: BlenderSceneHandle;
  readonly creatorDeclarationHash: string;
  readonly matchedMutationHash: string;
  readonly finalizationReceiptHash: string;
  readonly expectedNativeStateHash: string;
  readonly expectedSourceStateHash: string;
  readonly closedAt: string;
  readonly reopenedAt: string;
  readonly decoded?: DecodedSavedPlaceState;
  readonly freshCapture?: FreshReopenedStudioCapture;
  readonly derivedAt: string;
}): Promise<SaveReopenDerivation> {
  const hashPattern = /^[a-f0-9]{64}$/u;
  const requiredHashes = [
    input.creatorDeclarationHash,
    input.matchedMutationHash,
    input.finalizationReceiptHash,
    input.expectedNativeStateHash,
    input.expectedSourceStateHash,
  ];
  if (requiredHashes.some((value) => !hashPattern.test(value)))
    throw new Error("Save/reopen authority contains a malformed hash");
  const closed = Date.parse(input.closedAt);
  const reopened = Date.parse(input.reopenedAt);
  const derived = Date.parse(input.derivedAt);
  if (
    !Number.isFinite(closed) ||
    !Number.isFinite(reopened) ||
    !Number.isFinite(derived) ||
    reopened <= closed ||
    derived < reopened
  )
    throw new Error("Save/reopen creator declarations are not chronologically ordered");
  if (input.savedPlace.mediaType !== "application/octet-stream")
    throw new Error("Saved place evidence requires exact opaque place bytes");
  await input.binaryStore.verify(input.savedPlace);
  if (!input.decoded || !input.freshCapture)
    return {
      status: "incomplete",
      diagnostics: [
        input.decoded ? "Fresh reopened Studio capture is absent" : "Saved place decode is absent",
      ],
    };
  const decoded = input.decoded;
  const capture = input.freshCapture;
  const malformed = [
    decoded.decoderIdentityHash,
    decoded.savedPlaceArtifactHash,
    decoded.revisionHash,
    decoded.nativeStateHash,
    decoded.sourceStateHash,
    capture.connectorBuildHash,
    capture.revisionHash,
    capture.nativeStateHash,
    capture.sourceStateHash,
    capture.captureHash,
  ].some((value) => !hashPattern.test(value));
  if (malformed) throw new Error("Save/reopen observation contains a malformed hash");
  if (
    decoded.savedPlaceArtifactHash !== input.savedPlace.artifactHash ||
    decoded.projectId !== input.projectId ||
    capture.projectId !== input.projectId
  )
    return {
      status: "rejected",
      diagnostics: ["Persistence evidence binds different bytes or project"],
    };
  const captured = Date.parse(capture.capturedAt);
  if (!Number.isFinite(captured) || captured < reopened || captured > derived)
    return {
      status: "rejected",
      diagnostics: ["Studio capture time is outside the declared reopen-to-derivation interval"],
    };
  if (
    decoded.nativeStateHash !== input.expectedNativeStateHash ||
    decoded.sourceStateHash !== input.expectedSourceStateHash ||
    capture.nativeStateHash !== input.expectedNativeStateHash ||
    capture.sourceStateHash !== input.expectedSourceStateHash ||
    capture.revisionHash !== decoded.revisionHash
  )
    return {
      status: "rejected",
      diagnostics: [
        "Saved bytes and reopened authoritative state do not match the finalized build",
      ],
    };
  return {
    status: "eligible",
    evidence: sealWorkflowArtifact(SAVE_REOPEN_EVIDENCE_SCHEMA, {
      kind: "SaveReopenEvidence",
      abi: "forge-save-reopen-evidence@2",
      projectId: input.projectId,
      scene: BLENDER_SCENE_HANDLE_SCHEMA.parse(input.scene),
      creatorDeclarationHash: input.creatorDeclarationHash,
      matchedMutationHash: input.matchedMutationHash,
      finalizationReceiptHash: input.finalizationReceiptHash,
      savedPlace: { ...input.savedPlace, mediaType: "application/octet-stream" },
      decoderIdentityHash: decoded.decoderIdentityHash,
      decodedStateHash: decoded.revisionHash,
      closedAt: input.closedAt,
      reopenedAt: input.reopenedAt,
      reopenedConnectorBuildHash: capture.connectorBuildHash,
      reopenedConnectorSessionId: capture.connectorSessionId,
      freshNativeCaptureHash: capture.captureHash,
      freshSourceCaptureHash: capture.sourceStateHash,
      reopenedRevisionHash: capture.revisionHash,
      status: "matched",
      derivedAt: input.derivedAt,
    }),
  };
}
