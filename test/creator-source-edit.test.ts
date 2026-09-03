import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  applyCreatorSourceEdits,
  creatorSourceWriteBlobBinding,
} from "../packages/creator-session/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  assertCreatorSourceWriteBlobCapture,
  createCreatorSourceWriteBlobCapture,
} from "../packages/studio-evidence/src/index.js";

function edit(startByte: number, endByte: number, replacement: string) {
  const capture = createCreatorSourceWriteBlobCapture({ source: replacement });
  return {
    startByte,
    endByte,
    replacementBlob: creatorSourceWriteBlobBinding(capture),
    capture,
  };
}

test("source edits are sorted UTF-8 byte patches with reproducible final identity", () => {
  const before = "local icon = '🚀'\nreturn icon\n";
  const start = Buffer.byteLength("local icon = '", "utf8");
  const end = start + Buffer.byteLength("🚀", "utf8");
  const first = edit(start, end, "🛰️");
  const second = edit(
    Buffer.byteLength("local icon = '🚀'\n", "utf8"),
    Buffer.byteLength("local icon = '🚀'\n", "utf8"),
    "-- indexed edit\n",
  );
  const captures = new Map(
    [first, second].map((value) => [value.capture.manifest.hash, value.capture]),
  );
  const result = applyCreatorSourceEdits(before, [first, second], (binding) => {
    const capture = captures.get(binding.manifestHash);
    assert.ok(capture);
    return capture.chunks.map((chunk) => chunk.utf8).join("");
  });
  assert.equal(result.source, "local icon = '🛰️'\n-- indexed edit\nreturn icon\n");
  assert.equal(result.hash, contentHash(result.source));
  assert.equal(result.byteCount, Buffer.byteLength(result.source, "utf8"));
});

test("source edits reject overlap, reordering, out-of-bounds, and split code points", () => {
  assert.throws(() => {
    const first = edit(2, 4, "x");
    const second = edit(3, 5, "y");
    return applyCreatorSourceEdits("abcdef", [first, second], (binding) =>
      binding === first.replacementBlob ? "x" : "y",
    );
  }, /sorted, non-overlapping/);
  assert.throws(() => {
    const value = edit(1, 2, "x");
    return applyCreatorSourceEdits("🚀", [value], () => "x");
  }, /UTF-8 aligned/);
  assert.throws(() => {
    const value = edit(0, 4, "x");
    return applyCreatorSourceEdits("abc", [value], () => "x");
  }, /in bounds/);
});

test("source edits reject a materialized candidate outside the generated required-source contract", () => {
  const whitespace = edit(0, Buffer.byteLength("return true\n", "utf8"), " \t\n");
  assert.throws(
    () => applyCreatorSourceEdits("return true\n", [whitespace], () => " \t\n"),
    /generated source contract/i,
  );

  const maximum = STUDIO_CAPABILITY_MANIFEST.source.maximumUtf8Bytes;
  const first = edit(0, 0, "x".repeat(maximum));
  const second = edit(0, 0, "y");
  assert.throws(
    () =>
      applyCreatorSourceEdits("", [first, second], (binding) =>
        binding.manifestHash === first.replacementBlob.manifestHash ? "x".repeat(maximum) : "y",
      ),
    /generated source contract/i,
  );
});

test("creation and edit blobs exceed the retired 48 KiB ceiling with exact multi-chunk bindings", () => {
  const createSource = `-- large created module\n${"x".repeat(300 * 1024)}`;
  const replacement = `-- large replacement\n${"y".repeat(300 * 1024)}`;
  const createCapture = createCreatorSourceWriteBlobCapture({
    source: createSource,
  });
  const replacementCapture = createCreatorSourceWriteBlobCapture({
    source: replacement,
  });
  const createBinding = creatorSourceWriteBlobBinding(createCapture);
  const replacementBinding = creatorSourceWriteBlobBinding(replacementCapture);

  for (const capture of [createCapture, replacementCapture]) {
    assert.ok(capture.manifest.utf8Bytes > 48 * 1024);
    assert.ok(capture.chunks.length >= 2);
    assert.deepEqual(
      capture.manifest.chunkHashes,
      capture.chunks.map((chunk) => chunk.hash),
    );
    assert.ok(capture.chunks.every((chunk) => Buffer.byteLength(chunk.utf8, "utf8") <= 256 * 1024));
    assertCreatorSourceWriteBlobCapture(capture);
  }
  assert.equal(createBinding.sourceHash, contentHash(createSource));
  assert.equal(replacementBinding.sourceHash, contentHash(replacement));

  const before = "x".repeat(64 * 1024);
  const edited = applyCreatorSourceEdits(
    before,
    [
      {
        startByte: 0,
        endByte: Buffer.byteLength(before, "utf8"),
        replacementBlob: replacementBinding,
      },
    ],
    (binding) => {
      assert.equal(binding.manifestHash, replacementBinding.manifestHash);
      return replacementCapture.chunks.map((chunk) => chunk.utf8).join("");
    },
  );
  assert.equal(edited.source, replacement);
  assert.equal(edited.hash, replacementBinding.sourceHash);
  assert.equal(edited.byteCount, replacementBinding.utf8Bytes);
});

test("source-write captures reject tampered chunks and bindings before source materializes", () => {
  const capture = createCreatorSourceWriteBlobCapture({
    source: "-- source write integrity\n" + "z".repeat(300 * 1024),
  });
  const binding = creatorSourceWriteBlobBinding(capture);
  assert.throws(
    () =>
      assertCreatorSourceWriteBlobCapture({
        ...capture,
        chunks: [{ ...capture.chunks[0]!, utf8: "tampered" }, ...capture.chunks.slice(1)],
      }),
    /chunk|body/i,
  );
  assert.throws(
    () =>
      applyCreatorSourceEdits(
        "before",
        [
          {
            startByte: 0,
            endByte: 6,
            replacementBlob: binding,
          },
        ],
        () => "not the declared source",
      ),
    /does not match its binding/i,
  );
});
