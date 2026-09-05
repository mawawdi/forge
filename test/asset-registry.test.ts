import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AssetRegistry,
  DEFAULT_CUBE_EXECUTION_POLICY,
  connectedAssetProviderStatus,
  createCubeJobIntent,
  cubeArgumentVector,
  externalAssetJobRecovery,
  fitAssetGeometry,
  inspectObj,
  runCubeJob,
  type AssetSpec,
  type CubeInstallation,
} from "../packages/asset-registry/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const fixturePath = resolve("test/fixtures/assets/recorded-tetrahedron.obj");
const hash = (value: Uint8Array | string) =>
  contentHash(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
const spec = (): AssetSpec => ({
  id: "sculpture",
  description: "An independent abstract sculpture",
  bounds: { x: 10, y: 12, z: 14 },
  clearance: 1,
  collision: "box",
  namedParts: ["Body"],
  sockets: [{ id: "top", position: { x: 0, y: 4, z: 0 } }],
  universeId: 0,
});
const provenance = {
  kind: "recorded_obj",
  source: "test/fixtures/assets/recorded-tetrahedron.obj",
  license: "Repository test fixture",
  codeHash: "a".repeat(64),
  configurationHash: "b".repeat(64),
  checkpointHashes: [],
};
async function temporary(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), "forge-asset-test-"));
}
async function installation(root: string): Promise<CubeInstallation> {
  await mkdir(join(root, "cube3d"), { recursive: true });
  const code = await readFile(resolve("test/fixtures/assets/recorded-cube-worker.cjs"));
  const obj = await readFile(fixturePath);
  await writeFile(join(root, "cube3d/generate.py"), code);
  await writeFile(join(root, "recorded.obj"), obj);
  await writeFile(join(root, "configuration.yaml"), "offline fixture\n");
  await writeFile(join(root, "gpt.ckpt"), "offline GPT fixture\n");
  await writeFile(join(root, "shape.ckpt"), "offline shape fixture\n");
  const pin = async (path: string) => {
    const bytes = await readFile(join(root, path));
    return { path, sha256: hash(bytes), bytes: bytes.length };
  };
  return {
    kind: "recorded_fixture",
    root,
    executable: await realpath(process.execPath),
    codeFiles: [await pin("cube3d/generate.py")],
    configuration: await pin("configuration.yaml"),
    gptCheckpoint: await pin("gpt.ckpt"),
    shapeCheckpoint: await pin("shape.ckpt"),
    license: "Offline worker regression fixture",
  };
}

test("recorded OBJ inspection measures geometry and computes a centered uniform fit without modifying bytes", async () => {
  const bytes = await readFile(fixturePath);
  const geometry = inspectObj(bytes);
  assert.equal(geometry.vertexCount, 4);
  assert.equal(geometry.triangleCount, 4);
  assert.deepEqual(geometry.bounds, { min: { x: 1, y: 2, z: 3 }, max: { x: 3, y: 4, z: 5 } });
  const fit = fitAssetGeometry(geometry, spec());
  assert.equal(fit.scale, 4);
  assert.deepEqual(fit.bounds, { min: { x: -4, y: -4, z: -4 }, max: { x: 4, y: 4, z: 4 } });
  assert.equal(hash(bytes), hash(await readFile(fixturePath)));
  assert.throws(
    () => fitAssetGeometry(geometry, { ...spec(), namedParts: ["Missing"] }),
    /Requested OBJ group/,
  );
});

test("OBJ ingestion rejects external dependencies, malformed indices, non-finite values and resource excess", async () => {
  const bytes = await readFile(fixturePath);
  assert.throws(
    () => inspectObj(Buffer.concat([bytes, Buffer.from("mtllib remote.mtl\n")])),
    /separately admitted/,
  );
  assert.throws(
    () => inspectObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n")),
    /absent element/,
  );
  assert.throws(() => inspectObj(Buffer.from("v NaN 0 0\n")), /Malformed numeric/);
  assert.throws(
    () => inspectObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 2 0 0\nf 1 2 3\n")),
    /degenerate/,
  );
  assert.throws(
    () =>
      inspectObj(bytes, {
        maximumBytes: 8,
        maximumVertices: 10,
        maximumTriangles: 10,
        maximumAbsoluteCoordinate: 100,
      }),
    /byte/,
  );
});

test("asset locks bind exact bytes, fit, dependencies and universe while preserving unverified native status", async () => {
  const root = await temporary();
  try {
    const bytes = await readFile(fixturePath);
    const registry = new AssetRegistry(new ImmutableJsonArtifactStore(root));
    const lock = await registry.ingestRecordedObj({
      bytes,
      expectedSourceHash: hash(bytes),
      spec: spec(),
      provenance,
    });
    assert.equal(lock.readiness, "locally_inspected");
    assert.equal(lock.permissions.status, "unverified");
    assert.match(lock.limitations.join(" "), /moderation/);
    assert.deepEqual(registry.get({ assetId: lock.assetId, lockHash: lock.hash }), lock);
    await assert.rejects(
      () =>
        registry.ingestRecordedObj({
          bytes,
          expectedSourceHash: "0".repeat(64),
          spec: spec(),
          provenance,
        }),
      /content hash/,
    );
    await assert.rejects(
      () =>
        registry.ingestRecordedObj({
          bytes,
          expectedSourceHash: hash(bytes),
          spec: { ...spec(), id: "dependent", universeId: 2 },
          provenance,
          dependencies: [{ assetId: lock.assetId, lockHash: lock.hash }],
        }),
      /same universe/,
    );
    await assert.rejects(
      () =>
        registry.ingestRecordedObj({
          bytes,
          expectedSourceHash: hash(bytes),
          spec: { ...spec(), description: "Different accepted intent" },
          provenance,
        }),
      /different immutable lock/,
    );
    const dependent = await registry.ingestRecordedObj({
      bytes,
      expectedSourceHash: hash(bytes),
      spec: { ...spec(), id: "dependent" },
      provenance,
      dependencies: [{ assetId: lock.assetId, lockHash: lock.hash }],
    });
    assert.equal(dependent.dependencies[0]!.lockHash, lock.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recorded Cube worker journals intent, uses fixed argv, verifies pinned inputs and cannot launch an intent twice", async () => {
  const root = await temporary();
  try {
    const installed = await installation(join(root, "installation"));
    const requested = { ...spec(), description: 'A prop; $(touch should-not-exist) "quoted"' };
    const intent = createCubeJobIntent({
      spec: requested,
      codeHash: contentHash(stableJson(installed.codeFiles)),
      configurationHash: installed.configuration.sha256,
      checkpointHashes: [installed.gptCheckpoint.sha256, installed.shapeCheckpoint.sha256],
    });
    const args = cubeArgumentVector(installed, intent, join(root, "output"));
    assert.equal(args[args.indexOf("--prompt") + 1], requested.description);
    assert.equal(args[0], join(installed.root, "cube3d/generate.py"));
    const registry = new AssetRegistry(new ImmutableJsonArtifactStore(join(root, "store")));
    const result = await runCubeJob({
      intent,
      installation: installed,
      registry,
      jobRoot: join(root, "jobs"),
    });
    assert.equal(result.status, "locally_inspected", JSON.stringify(result));
    assert.ok(result.status === "locally_inspected");
    assert.equal(result.lock.provenance.kind, "recorded_obj");
    const repeat = await runCubeJob({
      intent,
      installation: installed,
      registry,
      jobRoot: join(root, "jobs"),
    });
    assert.equal(repeat.status, "recovery_required");
    assert.ok(repeat.status === "recovery_required");
    assert.equal(repeat.mayRelaunch, false);
    await writeFile(join(installed.root, "gpt.ckpt"), "tampered input\n");
    await assert.rejects(
      () =>
        runCubeJob({
          intent,
          installation: installed,
          registry,
          jobRoot: join(root, "fresh-jobs"),
        }),
      /pin/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cube worker timeout/output failures preserve a recovery obligation without claiming asset success", async () => {
  const root = await temporary();
  try {
    const installed = await installation(join(root, "installation"));
    const registry = new AssetRegistry(new ImmutableJsonArtifactStore(join(root, "store")));
    for (const description of ["hang", "overflow"]) {
      const intent = createCubeJobIntent({
        spec: { ...spec(), description },
        codeHash: contentHash(stableJson(installed.codeFiles)),
        configurationHash: installed.configuration.sha256,
        checkpointHashes: [installed.gptCheckpoint.sha256, installed.shapeCheckpoint.sha256],
      });
      const result = await runCubeJob({
        intent,
        installation: installed,
        registry,
        jobRoot: join(root, "jobs"),
        policy: { ...DEFAULT_CUBE_EXECUTION_POLICY, timeoutMs: 300, maximumLogBytes: 1024 },
      });
      assert.equal(result.status, "recovery_required");
      assert.ok(result.status === "recovery_required");
      assert.equal(result.mayRelaunch, false);
      assert.match(result.reason, /deadline|byte allowance/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cube refuses symlinked inputs and connected adapters report unavailable rather than fake jobs", async () => {
  const root = await temporary();
  try {
    const installed = await installation(join(root, "installation"));
    await rm(join(installed.root, "gpt.ckpt"));
    await symlink(join(installed.root, "shape.ckpt"), join(installed.root, "gpt.ckpt"));
    const intent = createCubeJobIntent({
      spec: spec(),
      codeHash: contentHash(stableJson(installed.codeFiles)),
      configurationHash: installed.configuration.sha256,
      checkpointHashes: [installed.gptCheckpoint.sha256, installed.shapeCheckpoint.sha256],
    });
    await assert.rejects(
      () =>
        runCubeJob({
          intent,
          installation: installed,
          registry: new AssetRegistry(new ImmutableJsonArtifactStore(join(root, "store"))),
          jobRoot: join(root, "jobs"),
        }),
      /symlink/,
    );
    assert.equal(connectedAssetProviderStatus("generation_service").status, "unavailable");
    assert.equal(connectedAssetProviderStatus("open_cloud").status, "unavailable");
    assert.deepEqual(
      externalAssetJobRecovery({ submittedIntentHash: intent.hash, receiptState: "unknown" })
        .mayResubmit,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
