import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertCubeJobIntent,
  createCubeJobIntent,
  parseCubeGeneration,
  type CubeGeneration,
} from "../packages/asset-registry/src/index.js";

const spec = {
  id: "remote-multipart",
  description: "Independent multipart fixture",
  bounds: { x: 20, y: 12, z: 16 },
  clearance: 1,
  collision: "none",
  namedParts: ["Body"],
  sockets: [],
  universeId: 0,
};
const inputs = {
  spec,
  codeHash: "a".repeat(64),
  configurationHash: "b".repeat(64),
  checkpointHashes: ["c".repeat(64)],
};
function partGeneration(): Extract<CubeGeneration, { operation: "cubepart" }> {
  return {
    operation: "cubepart",
    seed: 2147483647,
    input: {
      sourceArtifact: {
        locator: `artifacts/${"d".repeat(64)}.json`,
        artifactHash: "d".repeat(64),
        bytes: 120,
      },
      sha256: "e".repeat(64),
      bytes: 100,
    },
    parts: [{ id: "Body", prompt: "Main structural body" }],
  };
}
function rehash(value: Record<string, unknown>) {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: contentHash(stableJson(body)) };
}

test("new Cube jobs default explicit cube3d generation while persisted jobs require its current contract", () => {
  const intent = createCubeJobIntent(inputs);
  assert.deepEqual(intent.generation, { operation: "cube3d", seed: 0 });
  assertCubeJobIntent(intent);
  const { generation: _generation, ...missingGeneration } = intent;
  assert.throws(() => assertCubeJobIntent(rehash(missingGeneration)));
  assert.throws(() => assertCubeJobIntent(rehash({ ...intent, providerCallback: "untrusted" })));
  assert.throws(() => assertCubeJobIntent(rehash({ ...intent, jobId: "-".repeat(36) })));
  assert.throws(() =>
    createCubeJobIntent({ ...inputs, generation: null as unknown as CubeGeneration }),
  );
});

test("CubePart locks bind exact declared input, seed and ordered part prompts without claiming byte verification", () => {
  const generation = partGeneration();
  const intent = createCubeJobIntent({ ...inputs, generation });
  assertCubeJobIntent(intent);
  assert.deepEqual(intent.generation, generation);
  generation.parts[0]!.prompt = "A later request must not mutate this lock";
  generation.input.sourceArtifact.bytes++;
  assert.equal(intent.generation.operation, "cubepart");
  if (intent.generation.operation !== "cubepart") throw new Error("Expected CubePart fixture");
  assert.equal(intent.generation.parts[0]!.prompt, "Main structural body");
  assert.equal(intent.generation.input.sourceArtifact.bytes, 120);
  assert.throws(() => assertCubeJobIntent({ ...intent, generation }), /hash mismatch/);
  // The input artifact is deliberately not present. Contract admission must not
  // be mistaken for the host's later integrity-checked artifact read.
  assert.deepEqual(parseCubeGeneration(partGeneration()), intent.generation);
});

test("Cube generation rejects unsupported operations, malformed seeds and undeclared fields", () => {
  for (const seed of [-1, 0.5, 2147483648, Infinity, NaN])
    assert.throws(() => parseCubeGeneration({ operation: "cube3d", seed }));
  for (const input of [
    { operation: "cube3d" },
    { operation: "custom", seed: 0 },
    { operation: "cube3d", seed: 0, command: "untrusted" },
    { ...partGeneration(), callback: "untrusted" },
  ])
    assert.throws(() => parseCubeGeneration(input));
});

test("CubePart input pins are bounded canonical artifact references rather than remote URLs or paths", () => {
  const generation = partGeneration();
  assert.doesNotThrow(() =>
    parseCubeGeneration({
      ...generation,
      input: { ...generation.input, bytes: 16 * 1024 * 1024 },
    }),
  );
  for (const input of [
    { ...generation.input, bytes: 16 * 1024 * 1024 + 1 },
    { ...generation.input, bytes: 0 },
    { ...generation.input, sha256: "missing" },
    { ...generation.input, path: "/host/file.obj" },
    {
      ...generation.input,
      sourceArtifact: {
        ...generation.input.sourceArtifact,
        locator: "https://example.invalid/input",
      },
    },
    {
      ...generation.input,
      sourceArtifact: { ...generation.input.sourceArtifact, artifactHash: "f".repeat(64) },
    },
    { ...generation.input, sourceArtifact: { ...generation.input.sourceArtifact, bytes: 1.5 } },
  ])
    assert.throws(() => parseCubeGeneration({ ...generation, input }));
});

test("CubePart permits eight distinct parts and rejects duplicate or excess declarations", () => {
  const generation = partGeneration();
  const parts = Array.from({ length: 8 }, (_, index) => ({
    id: `Part_${index}`,
    prompt: "x".repeat(512),
  }));
  assert.doesNotThrow(() => parseCubeGeneration({ ...generation, parts }));
  for (const invalid of [
    [],
    [...parts, { id: "Ninth", prompt: "extra" }],
    [parts[0], parts[0]],
    [{ id: "Body", prompt: "" }],
    [{ id: "Body", prompt: "x".repeat(513) }],
    [{ id: "../Body", prompt: "unsafe identifier" }],
    [{ id: "Body", prompt: "part", source: "extra" }],
  ])
    assert.throws(() => parseCubeGeneration({ ...generation, parts: invalid }));
});

test("generic Cube checkpoint inventories allow one through sixteen exact hashes", () => {
  for (const count of [1, 2, 16]) {
    const checkpointHashes = Array.from({ length: count }, (_, index) =>
      contentHash(String(index)),
    );
    const intent = createCubeJobIntent({ ...inputs, checkpointHashes });
    assert.deepEqual(intent.checkpointHashes, checkpointHashes);
    assertCubeJobIntent(intent);
  }
  for (const checkpointHashes of [
    [],
    Array.from({ length: 17 }, () => "c".repeat(64)),
    ["invalid"],
  ]) {
    assert.throws(() => createCubeJobIntent({ ...inputs, checkpointHashes }));
    assert.throws(() =>
      assertCubeJobIntent(rehash({ ...createCubeJobIntent(inputs), checkpointHashes })),
    );
  }
});
