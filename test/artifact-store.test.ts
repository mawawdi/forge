import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../packages/artifact-store/src/index.js";
import { stableJson } from "../packages/contracts/src/index.js";

const temporaryPrefix = resolve(import.meta.dirname, "../.artifact-store-test-");

test("writes canonical private content-addressed JSON and deduplicates exact bytes", async () => {
  await withStore(async (root, store) => {
    const first = await store.write({ z: "last", nested: { z: true, a: 1 }, a: "first" });
    const second = await store.write({ a: "first", nested: { a: 1, z: true }, z: "last" });
    assert.deepEqual(second, first);
    assert.match(first.locator, /^artifacts\/[a-f0-9]{64}\.json$/);
    assert.equal(first.locator.includes(root), false);
    assert.equal(
      first.artifactHash,
      createHash("sha256")
        .update(`${stableJson({ a: "first", nested: { a: 1, z: true }, z: "last" })}\n`)
        .digest("hex"),
    );
    assert.equal(
      first.bytes,
      Buffer.byteLength(
        `${stableJson({ a: "first", nested: { a: 1, z: true }, z: "last" })}\n`,
        "utf8",
      ),
    );
    assert.equal((await lstat(join(root, first.locator))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(root, first.locator), "utf8"),
      `${stableJson({ a: "first", nested: { a: 1, z: true }, z: "last" })}\n`,
    );
    assert.deepEqual(await store.read(first), { a: "first", nested: { a: 1, z: true }, z: "last" });
  });
});

test("reads relative references after the complete store is relocated", async () => {
  const source = await temporaryDirectory();
  const destination = await temporaryDirectory();
  try {
    const sourceStore = new ImmutableJsonArtifactStore(source);
    const reference = await sourceStore.write({ artifact: "portable", values: [1, 2, 3] });
    await copyFileTree(source, destination, reference);
    const relocated = new ImmutableJsonArtifactStore(destination);
    assert.deepEqual(await relocated.read(reference), { artifact: "portable", values: [1, 2, 3] });
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("fails closed for missing, tampered, noncanonical, and oversized artifacts", async () => {
  await withStore(async (root, store) => {
    const reference = await store.write({ safe: true });
    await assert.rejects(
      store.read({
        ...reference,
        locator: `artifacts/${"0".repeat(64)}.json`,
        artifactHash: "0".repeat(64),
      }),
      /missing/i,
    );

    await writeFile(join(root, reference.locator), '{"safe":false}\n', "utf8");
    await assert.rejects(store.read(reference), /byte count|SHA-256/i);

    const noncanonical = '{"z":1,"a":2}\n';
    const noncanonicalHash = createHash("sha256").update(noncanonical).digest("hex");
    const noncanonicalReference = referenceFor(`artifacts/${noncanonicalHash}.json`, noncanonical);
    await writeFile(join(root, noncanonicalReference.locator), noncanonical, {
      encoding: "utf8",
      mode: 0o600,
    });
    await assert.rejects(store.read(noncanonicalReference), /canonical/i);

    await writeFile(join(root, reference.locator), "x".repeat(1024), "utf8");
    await assert.rejects(store.read(reference), /byte count/i);

    const tiny = new ImmutableJsonArtifactStore(root, { maxBytes: 8 });
    await assert.rejects(tiny.write({ too: "large" }), /byte limit/i);
  });
});

test("rejects unsafe locators and all symlink path components", async () => {
  await withStore(async (root, store) => {
    const reference = await store.write({ safe: true });
    for (const locator of [
      "../outside.json",
      "/absolute.json",
      "C:\\drive.json",
      "artifacts\\backslash.json",
      "artifacts//double.json",
      "./artifact.json",
    ]) {
      assert.throws(() => assertArtifactReference({ ...reference, locator }), /ArtifactReference/);
    }
    assert.throws(
      () =>
        assertArtifactReference({
          ...reference,
          locator: `artifacts/${"0".repeat(64)}.json`,
        }),
      /ArtifactReference/,
    );

    const target = join(root, reference.locator);
    await rm(join(root, "artifacts"), { recursive: true, force: true });
    await symlink(root, join(root, "artifacts"));
    await assert.rejects(store.read(reference), /symbolic link/i);
    await rm(join(root, "artifacts"), { recursive: true, force: true });
    await mkdir(join(root, "artifacts"), { mode: 0o700 });
    await writeFile(join(root, "outside.json"), "{}\n", "utf8");
    await symlink(join(root, "outside.json"), target);
    await assert.rejects(store.read(reference), /symbolic link/i);
    assert.equal(target.startsWith(root), true);
  });
});

test("rejects a creator-controlled symlinked store ancestor for reads and writes", async () => {
  const root = await temporaryDirectory();
  try {
    const actualRoot = join(root, "actual-store", "creator");
    const store = new ImmutableJsonArtifactStore(actualRoot);
    const reference = await store.write({ safe: true });
    const relocatedAncestor = join(root, "relocated-store");
    await rename(join(root, "actual-store"), relocatedAncestor);
    await symlink(relocatedAncestor, join(root, "actual-store"));

    await assert.rejects(store.read(reference), /unsafe artifact store directory/i);
    await assert.rejects(store.write({ redirected: true }), /unsafe artifact store directory/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never overwrites a content-addressed conflict and supports typed read assertions", async () => {
  await withStore(async (root, store) => {
    const serialized = `${stableJson({ answer: 42 })}\n`;
    const reference = referenceFor(
      `artifacts/${createHash("sha256").update(serialized).digest("hex")}.json`,
      serialized,
    );
    await mkdir(join(root, "artifacts"), { mode: 0o700 });
    await writeFile(
      join(root, "artifacts", `${reference.artifactHash}.json`),
      '{"conflict":true}\n',
      { encoding: "utf8", mode: 0o600 },
    );
    await assert.rejects(store.write({ answer: 42 }), /byte count|SHA-256/i);
    assert.equal(await readFile(join(root, reference.locator), "utf8"), '{"conflict":true}\n');

    const valid = await store.write({ answer: 42, type: "answer" });
    const read = await store.read(
      valid,
      (value): asserts value is { answer: number; type: string } => {
        assert.equal(typeof value, "object");
        assert.notEqual(value, null);
        assert.equal((value as { type?: unknown }).type, "answer");
      },
    );
    assert.equal(read.answer, 42);
    await chmod(join(root, valid.locator), 0o644);
    assert.deepEqual(await store.read(valid), { answer: 42, type: "answer" });
  });
});

async function withStore(
  run: (root: string, store: ImmutableJsonArtifactStore) => Promise<void>,
): Promise<void> {
  const root = await temporaryDirectory();
  try {
    await run(root, new ImmutableJsonArtifactStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(temporaryPrefix);
}

async function copyFileTree(
  source: string,
  destination: string,
  reference: ArtifactReference,
): Promise<void> {
  const targetDirectory = join(destination, "artifacts");
  await writeFile(join(destination, ".keep"), "", "utf8");
  await rm(join(destination, ".keep"));
  const content = await readFile(join(source, reference.locator), "utf8");
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(destination, reference.locator), content, { encoding: "utf8", mode: 0o600 });
}

function referenceFor(locator: string, serialized: string): ArtifactReference {
  return {
    locator,
    artifactHash: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}
