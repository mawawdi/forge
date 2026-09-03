import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { createHash } from "node:crypto";
import {
  assertCreatorSourceWriteBlobCapture,
  assertCreatorSourceWriteBlobChunk,
  assertCreatorSourceWriteBlobManifest,
  type CreatorSourceWriteBlobCapture,
} from "../../studio-evidence/src/index.js";

/**
 * Persisted source-write evidence is a leaf graph, never an inline source
 * string.  The operation's compact binding is intentionally insufficient to
 * recover bytes without this graph; every reader must revalidate it.
 */
export interface CreatorSourceWriteArtifactBinding {
  readonly manifest: {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  };
  readonly chunks: readonly {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  }[];
}

export async function writeCreatorSourceWriteArtifacts(
  store: ImmutableJsonArtifactStore,
  capture: CreatorSourceWriteBlobCapture,
): Promise<CreatorSourceWriteArtifactBinding> {
  assertCreatorSourceWriteBlobCapture(capture);
  const [manifest, chunks] = await Promise.all([
    store.write(capture.manifest),
    Promise.all(
      capture.chunks.map(async (chunk) => ({
        id: chunk.id,
        hash: chunk.hash,
        artifact: await store.write(chunk),
      })),
    ),
  ]);
  return {
    manifest: {
      id: capture.manifest.id,
      hash: capture.manifest.hash,
      artifact: manifest,
    },
    chunks,
  };
}

export async function readCreatorSourceWriteArtifacts(
  store: ImmutableJsonArtifactStore,
  binding: CreatorSourceWriteArtifactBinding,
): Promise<CreatorSourceWriteBlobCapture> {
  assertCreatorSourceWriteArtifactBinding(binding);
  const [manifest, chunks] = await Promise.all([
    readBound(store, binding.manifest, assertCreatorSourceWriteBlobManifest),
    Promise.all(
      binding.chunks.map((chunk) => readBound(store, chunk, assertCreatorSourceWriteBlobChunk)),
    ),
  ]);
  const capture: CreatorSourceWriteBlobCapture = {
    kind: "CreatorSourceWriteBlobCapture",
    manifest,
    chunks,
  };
  assertCreatorSourceWriteBlobCapture(capture);
  if (
    manifest.id !== binding.manifest.id ||
    manifest.hash !== binding.manifest.hash ||
    capture.chunks.length !== binding.chunks.length ||
    capture.chunks.some(
      (chunk, index) =>
        chunk.id !== binding.chunks[index]!.id || chunk.hash !== binding.chunks[index]!.hash,
    )
  )
    throw new Error("Creator source-write artifact graph mismatch");
  return capture;
}

/**
 * Read one bounded range from an immutable source-write blob without joining
 * the replacement body. Every chunk is streamed through the bound SHA-256
 * before its selected bytes are returned.
 */
export async function readCreatorSourceWriteArtifactRange(
  store: ImmutableJsonArtifactStore,
  binding: CreatorSourceWriteArtifactBinding,
  input: { readonly startByte: number; readonly endByte: number },
): Promise<{
  readonly sourceHash: string;
  readonly totalUtf8Bytes: number;
  readonly range: { readonly startByte: number; readonly endByte: number };
  readonly source: string;
}> {
  assertCreatorSourceWriteArtifactBinding(binding);
  if (
    !Number.isSafeInteger(input.startByte) ||
    !Number.isSafeInteger(input.endByte) ||
    input.startByte < 0 ||
    input.endByte < input.startByte ||
    input.endByte - input.startByte > 32 * 1024
  )
    throw new Error("Creator source-write range must be a bounded byte interval");
  const manifest = await readBound(store, binding.manifest, assertCreatorSourceWriteBlobManifest);
  if (input.endByte > manifest.utf8Bytes)
    throw new Error("Creator source-write range exceeds its immutable source body");
  const chunkBindings = new Map(binding.chunks.map((entry) => [entry.hash, entry] as const));
  if (
    chunkBindings.size !== binding.chunks.length ||
    manifest.chunkHashes.length !== chunkBindings.size
  )
    throw new Error("Creator source-write artifact chunk coverage mismatch");
  const digest = createHash("sha256");
  const pieces: Buffer[] = [];
  let expectedStartByte = 0;
  let selectedEndByte = input.endByte;
  for (const [ordinal, chunkHash] of manifest.chunkHashes.entries()) {
    const chunkBinding = chunkBindings.get(chunkHash);
    if (!chunkBinding) throw new Error("Creator source-write artifact chunk is missing");
    const chunk = await readBound(store, chunkBinding, assertCreatorSourceWriteBlobChunk);
    if (
      chunk.hash !== chunkHash ||
      chunk.sourceHash !== manifest.sourceHash ||
      chunk.ordinal !== ordinal ||
      chunk.startByte !== expectedStartByte ||
      chunk.endByte < chunk.startByte
    )
      throw new Error("Creator source-write artifact chunk sequence mismatch");
    const bytes = Buffer.from(chunk.utf8, "utf8");
    if (bytes.byteLength !== chunk.endByte - chunk.startByte)
      throw new Error("Creator source-write artifact chunk byte mismatch");
    digest.update(bytes);
    if (selectedEndByte >= chunk.startByte && selectedEndByte < chunk.endByte) {
      while (
        selectedEndByte > chunk.startByte &&
        isUtf8ContinuationByte(bytes[selectedEndByte - chunk.startByte]!)
      )
        selectedEndByte -= 1;
    }
    if (chunk.endByte > input.startByte && chunk.startByte < selectedEndByte) {
      pieces.push(
        bytes.subarray(
          Math.max(input.startByte, chunk.startByte) - chunk.startByte,
          Math.min(selectedEndByte, chunk.endByte) - chunk.startByte,
        ),
      );
    }
    expectedStartByte = chunk.endByte;
  }
  if (expectedStartByte !== manifest.utf8Bytes || digest.digest("hex") !== manifest.sourceHash)
    throw new Error("Creator source-write artifact body hash mismatch");
  const source = Buffer.concat(pieces).toString("utf8");
  if (Buffer.byteLength(source, "utf8") !== selectedEndByte - input.startByte)
    throw new Error("Creator source-write artifact range tears a UTF-8 sequence");
  return {
    sourceHash: manifest.sourceHash,
    totalUtf8Bytes: manifest.utf8Bytes,
    range: { startByte: input.startByte, endByte: selectedEndByte },
    source,
  };
}

function isUtf8ContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

export function creatorSourceWriteArtifactReferences(
  binding: CreatorSourceWriteArtifactBinding,
): readonly ArtifactReference[] {
  assertCreatorSourceWriteArtifactBinding(binding);
  return [binding.manifest.artifact, ...binding.chunks.map((chunk) => chunk.artifact)];
}

export function assertCreatorSourceWriteArtifactBinding(
  value: unknown,
): asserts value is CreatorSourceWriteArtifactBinding {
  if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.chunks))
    throw new Error("Invalid Creator source-write artifact binding");
  assertBound(value.manifest);
  if (value.chunks.length === 0)
    throw new Error("Creator source-write artifact graph has no chunks");
  const seen = new Set<string>();
  for (const chunk of value.chunks) {
    if (!isRecord(chunk)) throw new Error("Invalid Creator source-write artifact chunk binding");
    assertBound(chunk);
    const hash = String(chunk.hash);
    if (seen.has(hash)) throw new Error("Creator source-write artifact chunks are duplicated");
    seen.add(hash);
  }
}

async function readBound<T>(
  store: ImmutableJsonArtifactStore,
  binding: {
    readonly id: string;
    readonly hash: string;
    readonly artifact: ArtifactReference;
  },
  assertion: (value: unknown) => asserts value is T,
): Promise<T> {
  const value = await store.read(binding.artifact, assertion);
  if (
    (value as { id: string }).id !== binding.id ||
    (value as { hash: string }).hash !== binding.hash
  )
    throw new Error("Creator source-write artifact leaf binding mismatch");
  return value;
}

function assertBound(value: Record<string, unknown>): void {
  if (
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(value.id) ||
    typeof value.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.hash)
  )
    throw new Error("Invalid Creator source-write artifact leaf identity");
  assertArtifactReference(value.artifact);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
