import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CreatorAssetJobs,
  AssetRegistry,
  DEFAULT_CUBE_EXECUTION_POLICY,
  creatorCubeInstallationFingerprint,
  runCubeJob,
  type CubeJobIntent,
  type CubeJobDiagnostic,
  type LocalCreatorCubeInstallation,
  type CreatorAssetJobStatus,
  type ReviewedAssetCompositionPin,
} from "../packages/asset-registry/src/index.js";
import type { ArtifactReference } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const request = (description = "An abstract creator prop") => ({
  description,
  bounds: { x: 10, y: 12, z: 14 },
  clearance: 1,
  collision: "box",
  namedParts: ["Body"],
  sockets: [{ id: "top", position: { x: 0, y: 4, z: 0 } }],
  universeId: 0,
});
const fixtureObj = resolve("test/fixtures/assets/recorded-tetrahedron.obj");
async function setup(recordedObj?: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "forge-creator-assets-"));
  const installationRoot = join(root, "installation");
  await mkdir(join(installationRoot, "cube3d"), { recursive: true });
  const files: Record<string, Uint8Array | string> = {
    "cube3d/generate.py":
      'process.stdout.write(Buffer.from([0, 255, 65, 10])); process.stderr.write("recorded worker diagnostic\\n");\n' +
      (await readFile(resolve("test/fixtures/assets/recorded-cube-worker.cjs"), "utf8")),
    "recorded.obj": recordedObj ?? (await readFile(fixtureObj)),
    "configuration.yaml": "recorded configuration\n",
    "gpt.ckpt": "recorded GPT\n",
    "shape.ckpt": "recorded shape\n",
  };
  for (const [name, bytes] of Object.entries(files))
    await writeFile(join(installationRoot, name), bytes);
  const pin = (name: string) => ({
    path: name,
    sha256: hash(files[name]!),
    bytes: Buffer.byteLength(files[name]!),
  });
  const executable = await realpath(process.execPath);
  const executableBytes = await readFile(executable);
  const installation: LocalCreatorCubeInstallation = {
    kind: "CreatorCubeInstallation",
    cube: {
      kind: "recorded_fixture",
      root: installationRoot,
      executable,
      codeFiles: [pin("cube3d/generate.py"), pin("recorded.obj")],
      configuration: pin("configuration.yaml"),
      gptCheckpoint: pin("gpt.ckpt"),
      shapeCheckpoint: pin("shape.ckpt"),
      license: "Repository offline regression fixture",
    },
    executablePin: { sha256: hash(executableBytes), bytes: executableBytes.length },
    policy: { ...DEFAULT_CUBE_EXECUTION_POLICY, timeoutMs: 2000 },
  };
  const store = join(root, "jobs");
  return { root, store, installation, jobs: new CreatorAssetJobs(store) };
}

function compositionPin(status: CreatorAssetJobStatus): ReviewedAssetCompositionPin {
  assert.ok(status.lock && status.review);
  return {
    jobId: status.jobId,
    assetId: status.assetId,
    lockHash: status.lock.hash,
    reviewHash: status.review.artifactHash,
    universeId: status.lock.spec.universeId,
  };
}

test("preview replays the recorded mesh without approving it or dispatching generation again", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    await assert.rejects(
      f.jobs.preview(prepared.jobId, join(f.root, "premature.html")),
      /locally inspected/,
    );
    const inspected = await f.jobs.run(prepared.jobId);
    assert.ok(inspected.lock);
    const output = join(f.root, "preview.html");
    const command = spawnSync(
      process.execPath,
      [
        resolve("bin/forge.js"),
        "creator",
        "asset",
        "preview",
        prepared.jobId,
        "--store",
        f.store,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(command.status, 0, command.stderr);
    const receipt = JSON.parse(command.stdout);
    assert.equal(receipt.kind, "CreatorAssetPreview");
    assert.equal(receipt.lockHash, inspected.lock.hash);
    assert.equal(receipt.nativeReadiness, "unavailable");
    assert.equal(receipt.artifact.sha256, hash(await readFile(output)));
    assert.match(await readFile(output, "utf8"), /Geometry inspector/);
    const current = await f.jobs.status(prepared.jobId);
    assert.equal(current.status, "locally_inspected");
    assert.equal(current.review, undefined);
    assert.deepEqual(current.dispatch, inspected.dispatch);
    assert.deepEqual(current.lock, inspected.lock);
    await assert.rejects(f.jobs.preview(prepared.jobId, output), /EEXIST/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review and status persist an exact composition handoff with a native import blocker", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    assert.equal(prepared.composition, undefined);
    const inspected = await f.jobs.run(prepared.jobId);
    assert.ok(inspected.lock);
    assert.equal(inspected.composition, undefined);
    await assert.rejects(
      () =>
        f.jobs.resolveCompositionAsset({
          jobId: inspected.jobId,
          assetId: inspected.assetId,
          lockHash: inspected.lock!.hash,
          reviewHash: "0".repeat(64),
          universeId: 0,
        }),
      /requires an explicit review/,
    );
    const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
    assert.ok(reviewed.composition);
    const reopened = new CreatorAssetJobs(f.store);
    const resolution = await reopened.resolveCompositionAsset(compositionPin(reviewed));
    assert.deepEqual(resolution, reviewed.composition);
    assert.deepEqual((await reopened.status(prepared.jobId)).composition, resolution);
    assert.deepEqual(await f.jobs.store.read(resolution.bindingArtifact), resolution.binding);
    const { hash: bindingHash, ...binding } = resolution.binding;
    assert.equal(bindingHash, contentHash(stableJson(binding)));
    assert.deepEqual(binding.source, {
      artifact: inspected.lock.sourceArtifact,
      sha256: inspected.lock.sourceHash,
      utf8Bytes: inspected.lock.sourceUtf8Bytes,
    });
    assert.deepEqual(binding.geometry, inspected.lock.geometry);
    assert.equal(binding.geometry.regions[0]!.triangleCount, 4);
    assert.equal(binding.geometry.topology.edgeConnectedComponentCount, 1);
    assert.deepEqual(binding.geometry.warnings, []);
    assert.deepEqual(binding.fit, inspected.lock.fit);
    assert.deepEqual(binding.spec.sockets, inspected.lock.spec.sockets);
    assert.equal(binding.nativeImport.status, "incomplete");
    assert.equal(binding.nativeImport.mayInstantiate, false);
    assert.equal(binding.nativeImport.code, "native_import_unavailable");
    assert.match(binding.nativeImport.reason, /No placeholder or MeshPart constructor/);
    assert.equal("inventory" in binding, false);
    assert.equal(reviewed.nativeReadiness, "unavailable");
    // Caller mutation cannot poison the next resolution or the immutable review artifact.
    resolution.binding.fit.scale = 999;
    assert.equal(
      (await reopened.resolveCompositionAsset(compositionPin(reviewed))).binding.fit.scale,
      inspected.lock.fit.scale,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("composition catalogs reject stale, foreign, duplicate and hostile pins and use canonical ordering", async () => {
  const f = await setup();
  try {
    const reviewed: CreatorAssetJobStatus[] = [];
    for (const description of ["First reviewed source", "Second reviewed source"]) {
      const prepared = await f.jobs.prepare(request(description), f.installation);
      const inspected = await f.jobs.run(prepared.jobId);
      reviewed.push(await f.jobs.review(prepared.jobId, inspected.lock!.hash));
    }
    const pins = reviewed.map(compositionPin);
    const first = await f.jobs.catalogCompositionAssets(pins);
    assert.deepEqual(
      await new CreatorAssetJobs(f.store).catalogCompositionAssets([...pins].reverse()),
      first,
    );
    assert.deepEqual(
      first.assets.map((asset) => asset.binding.assetId),
      pins.map((pin) => pin.assetId).sort(),
    );
    const { hash: catalogHash, ...catalog } = first;
    assert.equal(catalogHash, contentHash(stableJson(catalog)));
    for (const changed of [
      { ...pins[0]!, assetId: pins[1]!.assetId },
      { ...pins[0]!, lockHash: pins[1]!.lockHash },
      { ...pins[0]!, reviewHash: pins[1]!.reviewHash },
      { ...pins[0]!, universeId: 42 },
      { ...pins[0]!, sourceUrl: "https://untrusted.invalid/model.obj" },
    ])
      await assert.rejects(() => f.jobs.resolveCompositionAsset(changed));
    await assert.rejects(
      () => f.jobs.catalogCompositionAssets([pins[0], pins[0]]),
      /distinct exact asset jobs/,
    );
    await assert.rejects(() =>
      f.jobs.catalogCompositionAssets(Array.from({ length: 65 }, () => pins[0])),
    );
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "jobId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return pins[0]!.jobId;
      },
    });
    await assert.rejects(() => f.jobs.resolveCompositionAsset(hostile));
    assert.equal(getterCalls, 0);
    const missing = { ...pins[0]!, jobId: "00000000-0000-4000-8000-000000000000" };
    await assert.rejects(() => f.jobs.resolveCompositionAsset(missing), /host-issued job ID/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker inspection warnings reach reopened status and reviewed composition, while empty requested parts fail", async () => {
  const source =
    "o Body\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 1 2 3\nf 4 5 6\no Empty\n";
  const f = await setup(source);
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    const inspected = await f.jobs.run(prepared.jobId);
    assert.equal(inspected.status, "locally_inspected");
    assert.ok(inspected.lock);
    assert.deepEqual(
      inspected.lock.geometry.warnings.map((warning) => warning.code),
      ["boundary_edges", "disconnected_surfaces", "empty_regions"],
    );
    const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
    const reopened = new CreatorAssetJobs(f.store);
    const resolution = await reopened.resolveCompositionAsset(compositionPin(reviewed));
    assert.deepEqual(resolution.binding.geometry, inspected.lock.geometry);
    assert.equal(resolution.binding.source.sha256, hash(source));
    assert.equal(resolution.binding.nativeImport.mayInstantiate, false);
    assert.deepEqual(
      (await reopened.status(prepared.jobId)).lock!.geometry.warnings,
      inspected.lock.geometry.warnings,
    );
    const missing = await f.jobs.prepare({ ...request(), namedParts: ["Empty"] }, f.installation);
    const rejected = await f.jobs.run(missing.jobId);
    assert.equal(rejected.status, "recovery_required");
    assert.equal(rejected.failureCode, "output_rejected");
    assert.equal(rejected.mayRun, false);
    assert.equal(rejected.lock, undefined);
    assert.match(rejected.reason!, /has no faces: Empty/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("composition resolution rejects substituted bindings and replays source evidence after review", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    const inspected = await f.jobs.run(prepared.jobId);
    const reviewed = await f.jobs.review(prepared.jobId, inspected.lock!.hash);
    const pin = compositionPin(reviewed);
    const originalReview = await f.jobs.store.read<Record<string, unknown>>(reviewed.review!);
    const originalBinding = reviewed.composition!.binding;
    const { hash: _hash, ...bindingBody } = originalBinding;
    const changedBody = {
      ...bindingBody,
      fit: { ...bindingBody.fit, scale: bindingBody.fit.scale + 1 },
    };
    const changedBinding = await f.jobs.store.write({
      ...changedBody,
      hash: contentHash(stableJson(changedBody)),
    });
    const changedReview = await f.jobs.store.write({
      ...originalReview,
      composition: changedBinding,
    });
    const stage = join(f.store, "records", reviewed.jobId, "review.json");
    await writeFile(stage, stableJson(changedReview) + "\n");
    await assert.rejects(() => f.jobs.status(reviewed.jobId), /composition binding differs/);
    await writeFile(stage, stableJson(reviewed.review!) + "\n");
    assert.deepEqual(await f.jobs.resolveCompositionAsset(pin), reviewed.composition);
    await writeFile(join(f.store, "evidence", inspected.lock!.sourceArtifact.locator), "{}\n");
    await assert.rejects(() => f.jobs.resolveCompositionAsset(pin), /mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("creator assets persist host identity, inspected bytes and exact local review across restarts", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.mayRun, true);
    assert.match(prepared.assetId, /^asset-[a-f0-9]{32}$/);
    const result = await new CreatorAssetJobs(f.store).run(prepared.jobId);
    assert.equal(result.status, "locally_inspected", JSON.stringify(result));
    assert.equal(result.lock?.provenance.kind, "recorded_obj");
    assert.equal(result.lock?.permissions.status, "unverified");
    assert.equal(result.nativeReadiness, "unavailable");
    assert.ok(result.lock);
    assert.ok(result.diagnostic);
    assert.ok(result.workerReceipt);
    const diagnostic = await f.jobs.store.read<CubeJobDiagnostic>(result.diagnostic);
    assert.equal(diagnostic.status, "locally_inspected");
    assert.equal(diagnostic.installationHash, creatorCubeInstallationFingerprint(f.installation));
    assert.equal(diagnostic.execution?.exitCode, 0);
    assert.equal(diagnostic.execution?.signal, null);
    assert.equal(diagnostic.execution?.logsTruncated, false);
    assert.deepEqual(
      Buffer.from(diagnostic.execution!.stdout.content, "base64"),
      Buffer.from([0, 255, 65, 10]),
    );
    assert.equal(
      Buffer.from(diagnostic.execution!.stderr.content, "base64").toString(),
      "recorded worker diagnostic\n",
    );
    await assert.rejects(
      () => f.jobs.review(prepared.jobId, "0".repeat(64)),
      /exact inspected lock/,
    );
    const reviewed = await new CreatorAssetJobs(f.store).review(prepared.jobId, result.lock.hash);
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.mayRun, false);
    assert.deepEqual(await new CreatorAssetJobs(f.store).run(prepared.jobId), reviewed);
    assert.deepEqual(await new CreatorAssetJobs(f.store).status(prepared.jobId), reviewed);
    assert.equal(reviewed.lock!.sourceHash, hash(await readFile(fixtureObj)));
    await writeFile(join(f.store, "evidence", reviewed.lock!.sourceArtifact.locator), "{}\n");
    await assert.rejects(() => new CreatorAssetJobs(f.store).status(prepared.jobId), /mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a valid worker receipt from the same intent under another host policy cannot authorize review", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    const result = await f.jobs.run(prepared.jobId);
    assert.ok(result.lock);
    const preparation = await f.jobs.store.read<{ intent: CubeJobIntent }>(prepared.preparation);
    const otherInstallation: LocalCreatorCubeInstallation = {
      ...f.installation,
      policy: { ...f.installation.policy, timeoutMs: f.installation.policy.timeoutMs + 1 },
    };
    const other = await runCubeJob({
      intent: preparation.intent,
      installation: otherInstallation,
      registry: new AssetRegistry(f.jobs.store),
      jobRoot: join(f.root, "recorded-other-installation"),
    });
    assert.ok(other.status === "locally_inspected");
    assert.equal(other.lock.hash, result.lock.hash);
    const otherReceipt = await f.jobs.store.read<{
      intentHash: string;
      installationKind: string;
      installationHash: string;
    }>(other.receipt);
    assert.equal(otherReceipt.intentHash, preparation.intent.hash);
    assert.equal(otherReceipt.installationKind, f.installation.cube.kind);
    assert.equal(
      otherReceipt.installationHash,
      creatorCubeInstallationFingerprint(otherInstallation),
    );
    assert.notEqual(
      otherReceipt.installationHash,
      creatorCubeInstallationFingerprint(f.installation),
    );
    const original = await f.jobs.store.read<Record<string, unknown>>(result.outcome!);
    const substituted = await f.jobs.store.write({
      ...original,
      diagnostic: other.diagnostic,
      workerReceipt: other.receipt,
    });
    const stage = join(f.store, "records", prepared.jobId, "result.json");
    await writeFile(stage, stableJson(substituted) + "\n");
    await assert.rejects(
      () => f.jobs.review(prepared.jobId, result.lock!.hash),
      /does not bind this job intent and installation/,
    );
    await writeFile(stage, stableJson(result.outcome!) + "\n");
    assert.equal((await f.jobs.review(prepared.jobId, result.lock.hash)).status, "reviewed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed creator asset jobs retain the consumed attempt and require explicit exact-byte reconciliation", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request("hang"), {
      ...f.installation,
      policy: { ...f.installation.policy, timeoutMs: 60 },
    });
    const failed = await f.jobs.run(prepared.jobId);
    assert.equal(failed.status, "recovery_required");
    assert.equal(failed.mayRun, false);
    assert.match(failed.reason!, /deadline/);
    assert.deepEqual(await new CreatorAssetJobs(f.store).run(prepared.jobId), failed);
    const output = join(f.store, "executions", prepared.jobId, "output", "output.obj");
    const bytes = await readFile(fixtureObj);
    await writeFile(output, bytes);
    await assert.rejects(() => f.jobs.reconcile(prepared.jobId, "0".repeat(64)), /hash/);
    const recovered = await new CreatorAssetJobs(f.store).reconcile(prepared.jobId, hash(bytes));
    assert.equal(recovered.status, "locally_inspected");
    assert.ok(recovered.lock);
    assert.equal(recovered.nativeReadiness, "unavailable");
    const evidence = await f.jobs.store.read<{ origin: string; workerReceipt?: unknown }>(
      recovered.outcome!,
    );
    assert.equal(evidence.origin, "explicit_output_reconciliation");
    assert.equal(evidence.workerReceipt, undefined);
    assert.equal((await f.jobs.review(prepared.jobId, recovered.lock.hash)).status, "reviewed");
    assert.notDeepEqual(failed.outcome, recovered.outcome);
    assert.equal(
      (await f.jobs.store.read<{ status: string }>(failed.outcome!)).status,
      "recovery_required",
    );
    assert.deepEqual(recovered.diagnostic, failed.diagnostic);
    const resultStage = join(f.store, "records", prepared.jobId, "result.json");
    await unlink(resultStage);
    await assert.rejects(
      () => f.jobs.status(prepared.jobId),
      /lost its original execution outcome/,
    );
    await writeFile(resultStage, stableJson(failed.outcome!) + "\n");
    // A valid reconciled output cannot hide damage to the original attempt.
    await writeFile(join(f.store, "evidence", failed.outcome!.locator), "{}\n");
    await assert.rejects(() => new CreatorAssetJobs(f.store).status(prepared.jobId), /mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker review rejects omitted or substituted receipts and mismatched lock identities", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    const result = await f.jobs.run(prepared.jobId);
    assert.ok(result.lock);
    assert.ok(result.workerReceipt);
    const outcome = await f.jobs.store.read<Record<string, unknown>>(result.outcome!);
    const receipt = await f.jobs.store.read<Record<string, unknown>>(result.workerReceipt);
    const stage = join(f.store, "records", prepared.jobId, "result.json");
    const substitute = async (value: unknown) =>
      writeFile(stage, stableJson(await f.jobs.store.write(value)) + "\n");
    const { workerReceipt: _removedReceipt, ...withoutReceipt } = outcome;
    await substitute(withoutReceipt);
    await assert.rejects(() => f.jobs.review(prepared.jobId, result.lock!.hash), /success receipt/);
    const { diagnostic: _removedDiagnostic, ...withoutDiagnostic } = outcome;
    await substitute(withoutDiagnostic);
    await assert.rejects(() => f.jobs.status(prepared.jobId), /diagnostic artifact/);
    const unrelated = await f.jobs.store.write({ kind: "UnrelatedEvidence" });
    for (const receiptReference of [
      unrelated,
      ...(await Promise.all(
        [
          { ...receipt, intentHash: "0".repeat(64) },
          { ...receipt, installationKind: "cube_local" },
          { ...receipt, assetLock: "0".repeat(64) },
          { ...receipt, sourceHash: "0".repeat(64) },
          { ...receipt, exitCode: 1 },
          { ...receipt, diagnostic: unrelated },
        ].map((value) => f.jobs.store.write(value)),
      )),
    ]) {
      await substitute({ ...outcome, workerReceipt: receiptReference });
      await assert.rejects(() => f.jobs.review(prepared.jobId, result.lock!.hash));
    }
    await substitute({ ...outcome, origin: "explicit_output_reconciliation" });
    await assert.rejects(() => f.jobs.status(prepared.jobId), /stage origin/);
    const { hash: _oldHash, ...lockBody } = result.lock;
    const changedBody = { ...lockBody, assetId: "different-asset" };
    const changedLock = { ...changedBody, hash: contentHash(stableJson(changedBody)) };
    await substitute({
      ...outcome,
      lock: await f.jobs.store.write(changedLock),
      workerReceipt: await f.jobs.store.write({ ...receipt, assetLock: changedLock.hash }),
    });
    await assert.rejects(() => f.jobs.status(prepared.jobId), /local-only authority/);
    // Rehashed facts still must reproduce the retained source bytes, including warnings.
    const { topology: _removedTopology, ...withoutTopology } = lockBody.geometry;
    for (const geometry of [
      { ...lockBody.geometry, topology: { ...lockBody.geometry.topology, boundaryEdgeCount: 99 } },
      {
        ...lockBody.geometry,
        regions: lockBody.geometry.regions.map((region) => ({ ...region, triangleCount: 0 })),
      },
      { ...lockBody.geometry, warnings: [{ code: "boundary_edges", detail: "Invented warning" }] },
      withoutTopology,
    ]) {
      const body = { ...lockBody, geometry };
      const lock = { ...body, hash: contentHash(stableJson(body)) };
      await substitute({
        ...outcome,
        lock: await f.jobs.store.write(lock),
        workerReceipt: await f.jobs.store.write({ ...receipt, assetLock: lock.hash }),
      });
      await assert.rejects(
        () => f.jobs.review(prepared.jobId, lock.hash),
        /inspection or fit mismatch/,
      );
    }
    await writeFile(stage, stableJson(result.outcome!) + "\n");
    assert.equal((await f.jobs.status(prepared.jobId)).status, "locally_inspected");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed worker diagnostics retain bounded exact log bytes and reject hash or classification substitutions", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request("overflow"), {
      ...f.installation,
      policy: { ...f.installation.policy, maximumLogBytes: 32 },
    });
    const failed = await f.jobs.run(prepared.jobId);
    assert.equal(failed.status, "recovery_required");
    assert.equal(failed.failureCode, "execution_incomplete");
    assert.ok(failed.diagnostic);
    const diagnostic = await f.jobs.store.read<CubeJobDiagnostic>(failed.diagnostic);
    assert.equal(diagnostic.failureCode, "execution_incomplete");
    assert.equal(diagnostic.execution?.logsTruncated, true);
    assert.equal(diagnostic.execution!.stdout.bytes + diagnostic.execution!.stderr.bytes, 32);
    for (const log of [diagnostic.execution!.stdout, diagnostic.execution!.stderr]) {
      const bytes = Buffer.from(log.content, "base64");
      assert.equal(bytes.length, log.bytes);
      assert.equal(hash(bytes), log.sha256);
    }
    const outcome = await f.jobs.store.read<Record<string, unknown>>(failed.outcome!);
    for (const changed of [
      { ...diagnostic, intentHash: "0".repeat(64) },
      { ...diagnostic, failureCode: "output_rejected" },
      {
        ...diagnostic,
        execution: {
          ...diagnostic.execution!,
          stdout: { ...diagnostic.execution!.stdout, sha256: "0".repeat(64) },
        },
      },
    ]) {
      const reference = await f.jobs.store.write({
        ...outcome,
        diagnostic: await f.jobs.store.write(changed),
      });
      await writeFile(
        join(f.store, "records", prepared.jobId, "result.json"),
        stableJson(reference) + "\n",
      );
      await assert.rejects(() => f.jobs.status(prepared.jobId));
    }
    await writeFile(
      join(f.store, "records", prepared.jobId, "result.json"),
      stableJson(failed.outcome!) + "\n",
    );
    const output = join(f.store, "executions", prepared.jobId, "output", "output.obj");
    const bytes = await readFile(fixtureObj);
    await writeFile(output, bytes);
    const reconciled = await f.jobs.reconcile(prepared.jobId, hash(bytes));
    const reconciliation = await f.jobs.store.read<Record<string, unknown>>(
      reconciled.reconciliation!,
    );
    const restore = async (reference: ArtifactReference) =>
      writeFile(
        join(f.store, "records", prepared.jobId, "reconciliation.json"),
        stableJson(reference) + "\n",
      );
    await restore(
      await f.jobs.store.write({ ...reconciliation, workerReceipt: failed.diagnostic }),
    );
    await assert.rejects(() => f.jobs.status(prepared.jobId), /cannot assert worker/);
    await restore(reconciled.reconciliation!);
    // The selected reconciliation still replays the original reachable diagnostic.
    await writeFile(join(f.store, "evidence", failed.diagnostic.locator), "{}\n");
    await assert.rejects(() => f.jobs.status(prepared.jobId), /mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an orphaned dispatch and racing callers cannot authorize a second worker launch", async () => {
  const f = await setup();
  try {
    const prepared = await f.jobs.prepare(request(), f.installation);
    await Promise.all([
      f.jobs.run(prepared.jobId),
      new CreatorAssetJobs(f.store).run(prepared.jobId),
    ]);
    const complete = await f.jobs.status(prepared.jobId);
    assert.equal(complete.status, "locally_inspected");
    const orphan = await f.jobs.prepare(request(), f.installation);
    const dispatch = await f.jobs.store.write({
      kind: "CreatorAssetDispatch",
      jobId: orphan.jobId,
      preparation: orphan.preparation,
      dispatchedAt: new Date().toISOString(),
    });
    await writeFile(
      join(f.store, "records", orphan.jobId, "dispatch.json"),
      stableJson(dispatch) + "\n",
    );
    const status = await new CreatorAssetJobs(f.store).run(orphan.jobId);
    assert.equal(status.status, "dispatched");
    assert.equal(status.mayRun, false);
    assert.match(status.reason!, /running or interrupted/);
    await assert.rejects(() => readFile(join(f.store, "executions", orphan.jobId, "launch.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("host asset preparation rejects candidate identities, executable tampering, and unsafe store references", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      () => f.jobs.prepare({ ...request(), id: "candidate-id" }, f.installation),
      /cannot supply/,
    );
    await assert.rejects(
      () => f.jobs.prepare({ ...request(), provenance: {} }, f.installation),
      /cannot supply/,
    );
    await assert.rejects(
      () =>
        f.jobs.prepare(request(), {
          ...f.installation,
          executablePin: { ...f.installation.executablePin, sha256: "0".repeat(64) },
        }),
      /pin/,
    );
    const prepared = await f.jobs.prepare(request(), f.installation);
    await assert.rejects(() => f.jobs.status("../" + prepared.jobId), /host-issued/);
    const linkRoot = join(f.root, "linked-store");
    await symlink(f.store, linkRoot);
    await assert.rejects(() => new CreatorAssetJobs(linkRoot).status(prepared.jobId), /symlink/);
    await writeFile(join(f.installation.cube.root, "configuration.yaml"), "changed\n");
    const failed = await f.jobs.run(prepared.jobId);
    assert.equal(failed.status, "recovery_required");
    assert.equal(failed.mayRun, false);
    assert.match(failed.reason!, /pin/);
    assert.ok(failed.diagnostic);
    const diagnostic = await f.jobs.store.read<{
      kind: string;
      installationHash: string;
      workerDiagnostic?: unknown;
    }>(failed.diagnostic);
    assert.equal(diagnostic.kind, "CreatorAssetHostDiagnostic");
    assert.equal(diagnostic.installationHash, creatorCubeInstallationFingerprint(f.installation));
    assert.equal(diagnostic.workerDiagnostic, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("creator asset CLI prepares, executes recorded output, reopens status and reviews exact local bytes", async () => {
  const f = await setup();
  try {
    const requestFile = join(f.root, "request.json"),
      installationFile = join(f.root, "installation.json");
    await writeFile(requestFile, JSON.stringify(request()));
    await writeFile(installationFile, JSON.stringify(f.installation));
    // Resolves the matching emitted CLI for both the standard build and isolated test outDirs.
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/cli/src/index.js");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli, "creator", "asset", ...args, "--store", f.store], {
        encoding: "utf8",
        timeout: 15000,
      });
    const preparation = run([
      "prepare",
      "--request-file",
      requestFile,
      "--installation",
      installationFile,
    ]);
    assert.equal(preparation.status, 0, preparation.stderr);
    const id = JSON.parse(preparation.stdout).jobId as string;
    const executed = run(["run", id]);
    assert.equal(executed.status, 0, executed.stderr);
    const result = JSON.parse(executed.stdout);
    assert.equal(result.status, "locally_inspected");
    const reviewed = run(["review", id, "--lock-hash", result.lock.hash]);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(JSON.parse(reviewed.stdout).status, "reviewed");
    const reopened = run(["status", id]);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.equal(
      JSON.parse(reopened.stdout).review.artifactHash,
      JSON.parse(reviewed.stdout).review.artifactHash,
    );
    assert.equal(run(["run", id, "--unknown", "bad"]).status, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
