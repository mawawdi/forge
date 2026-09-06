import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { stableJson } from "../../contracts/src/index.js";
import {
  assertCreatorRecordingRecoveryPayload,
  type CreatorRecordingRecoveryPayload,
} from "../../studio-protocol/src/index.js";
import {
  readCreatorProjectIndexArtifacts,
  type CreatorProjectIndexArtifactBinding,
} from "./project-refresh.js";
import type { CreatorActiveMutation } from "./index.js";

/** The existing immutable native inventory record, retained as cancellation provenance. */
export interface CreatorRecordingRecoveryRecord {
  kind: "CreatorRecordingRecoveryRecord";
  studioSessionId: string;
  projectId: string;
  payload: Exclude<CreatorRecordingRecoveryPayload, { recordingState: "none" }>;
  projectIndex: CreatorProjectIndexArtifactBinding;
  receivedAt: string;
}

export function assertCreatorRecordingRecoveryRecord(
  value: unknown,
): asserts value is CreatorRecordingRecoveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Recording recovery record is malformed");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "kind,payload,projectId,projectIndex,receivedAt,studioSessionId" ||
    record.kind !== "CreatorRecordingRecoveryRecord" ||
    typeof record.studioSessionId !== "string" ||
    !record.studioSessionId ||
    typeof record.projectId !== "string" ||
    !record.projectId ||
    typeof record.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(record.receivedAt))
  )
    throw new Error("Recording recovery record is malformed");
  assertCreatorRecordingRecoveryPayload(record.payload);
  if (record.payload.recordingState !== "open" || record.payload.cancellation === undefined)
    throw new Error("Recording recovery record grants no cancellation authority");
}

/** Read only retained host evidence; a receipt cannot supply its own expected gate. */
export async function readCreatorRecordingRecoveryAuthority(input: {
  store: ImmutableJsonArtifactStore;
  reference: ArtifactReference;
  sessionId: string;
  projectId: string;
  active: CreatorActiveMutation;
}) {
  const record = await input.store.read(input.reference, assertCreatorRecordingRecoveryRecord);
  const { payload } = record;
  const active = input.active;
  if (
    record.projectId !== input.projectId ||
    payload.creatorSessionId !== input.sessionId ||
    payload.changeSetId !== active.changeSetId ||
    payload.changeSetHash !== active.changeSetHash ||
    payload.projectionId !== active.projectionId ||
    payload.projectionHash !== active.projectionHash ||
    payload.recordingId !== active.recordingId ||
    payload.manifestHash !== active.manifest.hash ||
    payload.beforeProjectIndexManifestId !== active.beforeIndexCapture.manifest.id ||
    payload.beforeProjectRevisionHash !== active.beforeIndexRevisionHash ||
    payload.beforeProjectDetectorEpoch !== active.beforeProjectDetectorEpoch
  )
    throw new Error("Recording recovery authority does not bind the active transaction");
  const [capture, before] = await Promise.all([
    readCreatorProjectIndexArtifacts(input.store, record.projectIndex),
    readCreatorProjectIndexArtifacts(input.store, active.beforeIndexCapture),
  ]);
  if (
    capture.indexManifest.id !== payload.recoveryProjectIndexManifestId ||
    capture.revision.hash !== payload.recoveryProjectRevisionHash ||
    capture.detectorEpoch !== payload.recoveryProjectDetectorEpoch ||
    stableJson(capture.projection.project) !== stableJson(before.projection.project)
  )
    throw new Error("Recording recovery authority has an inconsistent project capture");
  return { record, capture };
}
