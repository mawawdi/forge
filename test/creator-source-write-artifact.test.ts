import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  readCreatorSourceWriteArtifacts,
  readCreatorSourceWriteArtifactRange,
  writeCreatorSourceWriteArtifacts,
} from "../packages/creator-session/src/source-write.js";
import { createCreatorSourceWriteBlobCapture } from "../packages/studio-evidence/src/index.js";

async function withStore(
  run: (root: string, store: ImmutableJsonArtifactStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forge-source-write-artifact-"));
  try {
    await run(root, new ImmutableJsonArtifactStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("source-write artifact graph reloads a >48 KiB multi-chunk body without process memory", async () => {
  await withStore(async (root, store) => {
    const source = `-- persisted large source\n${"🚀".repeat(80 * 1024)}`;
    const capture = createCreatorSourceWriteBlobCapture({ source });
    assert.ok(capture.manifest.utf8Bytes > 48 * 1024);
    assert.ok(capture.chunks.length >= 2);

    const binding = await writeCreatorSourceWriteArtifacts(store, capture);
    // A new store object models coordinator restart/relocation lookup: only
    // artifact references, not the original capture, remain in scope.
    const reloaded = await readCreatorSourceWriteArtifacts(
      new ImmutableJsonArtifactStore(root),
      binding,
    );
    assert.deepEqual(reloaded, capture);
    const range = await readCreatorSourceWriteArtifactRange(
      new ImmutableJsonArtifactStore(root),
      binding,
      { startByte: 0, endByte: 32 * 1024 },
    );
    assert.equal(range.sourceHash, capture.manifest.sourceHash);
    assert.equal(Buffer.byteLength(range.source, "utf8"), range.range.endByte);
  });
});

test("source-write artifact graph fails closed for missing, reordered, duplicate, and tampered leaves", async () => {
  await withStore(async (root, store) => {
    const capture = createCreatorSourceWriteBlobCapture({
      source: "-- integrity\n" + "q".repeat(320 * 1024),
    });
    const binding = await writeCreatorSourceWriteArtifacts(store, capture);
    assert.ok(binding.chunks.length >= 2);

    await assert.rejects(
      () =>
        readCreatorSourceWriteArtifacts(store, {
          ...binding,
          chunks: binding.chunks.slice(1),
        }),
      /coverage|missing/i,
    );
    await assert.rejects(
      () =>
        readCreatorSourceWriteArtifacts(store, {
          ...binding,
          chunks: [...binding.chunks].reverse(),
        }),
      /sequence|coverage|ordering/i,
    );
    await assert.rejects(
      () =>
        readCreatorSourceWriteArtifacts(store, {
          ...binding,
          chunks: [binding.chunks[0]!, binding.chunks[0]!],
        }),
      /duplicated|coverage/i,
    );
    await assert.rejects(
      () =>
        readCreatorSourceWriteArtifacts(store, {
          ...binding,
          manifest: { ...binding.manifest, hash: "0".repeat(64) },
        }),
      /binding mismatch/i,
    );

    const tampered = binding.chunks[0]!;
    await writeFile(join(root, tampered.artifact.locator), '{"tampered":true}\n', "utf8");
    await assert.rejects(
      () => readCreatorSourceWriteArtifacts(store, binding),
      /byte count|SHA-256|canonical/i,
    );
  });
});
