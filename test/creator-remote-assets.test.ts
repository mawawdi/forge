import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CreatorAssetJobs,
  AssetRegistry,
  createCubeJobIntent,
  type CreatorAssetJobStatus,
  type CubeJobIntent,
} from "../packages/asset-registry/src/index.js";
import {
  DEFAULT_REMOTE_CUBE_POLICY,
  runRemoteCubeJob,
  type RemoteCubeInstallation,
} from "../packages/asset-registry/src/cube-remote.js";

type Mode =
  | "success"
  | "lost_post"
  | "output_hash"
  | "job_hash"
  | "log_hash"
  | "part_ids"
  | "frame"
  | "near_log_limit"
  | "excess_logs"
  | "part_vertices"
  | "normalization";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const inputObj = "o Body\nv 1 2 3\nv 3 2 3\nv 1 4 3\nv 1 2 5\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n";
const request = () => ({
  description: "An offline abstract mesh fixture",
  bounds: { x: 20, y: 12, z: 16 },
  clearance: 1,
  collision: "none",
  namedParts: ["mesh"],
  sockets: [],
  universeId: 0,
});
function pin(status: CreatorAssetJobStatus) {
  assert.ok(status.lock && status.review);
  return {
    jobId: status.jobId,
    assetId: status.assetId,
    lockHash: status.lock.hash,
    reviewHash: status.review.artifactHash,
    universeId: status.lock.spec.universeId,
  };
}
async function fixture(context: TestContext, mode: Mode = "success") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "forge-remote-assets-"));
  const tokenEnvironment = `FORGE_TEST_REMOTE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const token = randomUUID();
  process.env[tokenEnvironment] = token;
  const calls: { method: string; path: string }[] = [];
  const serverErrors: string[] = [];
  let submitted: { job: Record<string, unknown>; inputBase64?: string } | undefined;
  const installationHash = "a".repeat(64);
  const outputFor = (job: Record<string, unknown>) =>
    job.operation === "cube3d"
      ? inputObj.replace("o Body", "o mesh")
      : inputObj +
        "o Top\nv 11 2 3\nv 13 2 3\nv 11 4 3\nv 11 2 5\nf 5 7 6\nf 5 6 8\nf 5 8 7\nf 6 7 8\n";
  const resultFor = (job: Record<string, unknown>) => {
    const jobHash = contentHash(stableJson(job));
    const bytes = Buffer.from(outputFor(job));
    const log = { encoding: "base64", content: "", bytes: 0, sha256: hash("") };
    const logBytes = Buffer.alloc(
      mode === "near_log_limit" ? 1024 * 1024 - 1 : mode === "excess_logs" ? 1024 * 1024 + 1 : 0,
      65,
    );
    const stdout =
      mode === "near_log_limit" || mode === "excess_logs"
        ? {
            encoding: "base64",
            content: logBytes.toString("base64"),
            bytes: logBytes.length,
            sha256: hash(logBytes),
          }
        : mode === "log_hash"
          ? { ...log, sha256: "0".repeat(64) }
          : log;
    const cubePart = job.operation === "cubepart";
    return {
      kind: "CubeRemoteSubmission",
      jobId: job.jobId,
      jobHash: mode === "job_hash" ? "f".repeat(64) : jobHash,
      installationHash,
      status: "succeeded",
      result: {
        kind: "CubeRemoteResult",
        jobId: job.jobId,
        jobHash,
        installationHash,
        status: "succeeded",
        mayRelaunch: false,
        output: { path: "output.obj", sha256: hash(bytes), bytes: bytes.length },
        execution: {
          exitCode: 0,
          reason: null,
          stdout,
          stderr: log,
        },
        metadata: {
          coordinateFrame:
            mode === "frame"
              ? "independent_per_part_frame"
              : cubePart
                ? "input_obj_common_frame"
                : "cube_normalized_aspect_conditioned",
          normalization: cubePart
            ? { center: [2, 3, 4], scale: mode === "normalization" ? 1 : 0.96 }
            : null,
          parts: cubePart
            ? [
                {
                  id: mode === "part_ids" ? "Foreign" : "Body",
                  vertices: mode === "part_vertices" ? 1 : 4,
                  triangles: 4,
                },
                { id: "Top", vertices: mode === "part_vertices" ? 7 : 4, triangles: 4 },
              ]
            : [{ id: mode === "part_ids" ? "Foreign" : "mesh", vertices: 4, triangles: 4 }],
          settings: cubePart
            ? {
                resolutionBase: 8.5,
                guidanceScale: 7.5,
                steps: 50,
                scheduler: "dpm_solver",
                timeshift: 4,
                samples: 128000,
              }
            : { engine: "Engine", resolutionBase: 8, topP: 0.95, useKvCache: true },
          gpu: {
            name: "Offline HTTP fixture",
            freeBytes: 44 * 1024 ** 3,
            totalBytes: 48 * 1024 ** 3,
            computeCapability: [8, 0],
            torchVersion: "fixture",
            cudaVersion: "fixture",
            requiredFreeBytes: (cubePart ? 40 : 16) * 1024 ** 3,
            policyScope: "unmeasured_qualification_headroom",
          },
          reproducibility: "seed_and_settings_recorded_outputs_not_guaranteed_deterministic",
        },
      },
    };
  };
  const json = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const handle = async (incoming: IncomingMessage, response: ServerResponse) => {
    assert.equal(incoming.headers.authorization, `Bearer ${token}`);
    const path = incoming.url!;
    calls.push({ method: incoming.method!, path });
    if (path === "/health") {
      json(response, {
        kind: "CubeRemoteHealth",
        installationHash,
        operations: ["cube3d", "cubepart"],
      });
      return;
    }
    if (path === "/jobs" && incoming.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NonNullable<
        typeof submitted
      >;
      assert.ok(submitted.job);
      if (mode === "lost_post") {
        incoming.socket.destroy();
        return;
      }
      json(response, resultFor(submitted.job));
      return;
    }
    assert.ok(submitted);
    if (path === `/jobs/${String(submitted.job.jobId)}`) {
      json(response, resultFor(submitted.job));
      return;
    }
    assert.equal(path, `/jobs/${String(submitted.job.jobId)}/output`);
    const output = outputFor(submitted.job);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(mode === "output_hash" ? output.replace("v 1 2 3", "v 9 2 3") : output);
  };
  const server = createServer((incoming, response) => {
    void handle(incoming, response).catch((error: unknown) => {
      serverErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500);
      response.end("Offline fixture request failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    delete process.env[tokenEnvironment];
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(serverErrors, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const installation: RemoteCubeInstallation = {
    kind: "CreatorCubeInstallation",
    cube: {
      kind: "cube_remote",
      endpoint: `http://127.0.0.1:${address.port}`,
      tokenEnvironment,
      installationHash,
      codeHash: "b".repeat(64),
      configurationHash: "c".repeat(64),
      checkpointHashes: ["d".repeat(64), "e".repeat(64), "f".repeat(64)],
      license: "Offline fixture only",
    },
    policy: { ...DEFAULT_REMOTE_CUBE_POLICY, timeoutMs: 2000 },
  };
  const directory = join(root, "jobs");
  return {
    root,
    directory,
    installation,
    calls,
    jobs: new CreatorAssetJobs(directory),
    submitted: () => submitted,
    setMode: (next: Mode) => {
      mode = next;
    },
  };
}

test("remote preparation, execution, exact output and creator review replay through the public asset job path", async (context) => {
  const f = await fixture(context);
  const prepared = await f.jobs.prepare(request(), f.installation);
  assert.equal(prepared.status, "prepared");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  const inspected = await f.jobs.run(prepared.jobId);
  assert.equal(inspected.status, "locally_inspected", inspected.reason);
  assert.ok(inspected.lock);
  assert.equal(inspected.lock.provenance.kind, "cube_remote");
  assert.equal(inspected.lock.sourceHash, hash(inputObj.replace("o Body", "o mesh")));
  assert.equal(inspected.lock.geometry.triangleCount, 4);
  const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
  assert.equal(reviewed.status, "reviewed");
  const offline = new CreatorAssetJobs(f.directory);
  const callsBeforeReplay = f.calls.length;
  const resolution = await offline.resolveCompositionAsset(pin(reviewed));
  assert.equal(
    f.calls.length,
    callsBeforeReplay,
    "stored evidence replay must not query the worker",
  );
  assert.equal(resolution.binding.source.sha256, inspected.lock.sourceHash);
  assert.equal(resolution.binding.nativeImport.mayInstantiate, false);
  assert.equal(reviewed.nativeReadiness, "unavailable");
  await offline.run(prepared.jobId);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("CubePart submits retained source bytes and preserves all output parts in one measured frame", async (context) => {
  const f = await fixture(context);
  const path = join(f.root, "input.obj");
  await writeFile(path, inputObj);
  const prepared = await f.jobs.prepare(
    {
      ...request(),
      namedParts: ["Body", "Top"],
      generation: {
        operation: "cubepart",
        seed: 23,
        input: { path, sha256: hash(inputObj), bytes: Buffer.byteLength(inputObj) },
        parts: [
          { id: "Body", prompt: "Main body" },
          { id: "Top", prompt: "Separate upper part" },
        ],
      },
    },
    f.installation,
  );
  const retained = await f.jobs.store.read<{ intent: CubeJobIntent }>(prepared.preparation);
  assert.equal(retained.intent.generation.operation, "cubepart");
  await writeFile(path, "The host path changed after preparation.\n");
  const inspected = await f.jobs.run(prepared.jobId);
  assert.equal(inspected.status, "locally_inspected", inspected.reason);
  assert.equal(f.submitted()?.inputBase64, Buffer.from(inputObj).toString("base64"));
  assert.equal(f.submitted()?.job.seed, 23);
  assert.ok(inspected.lock);
  assert.deepEqual(
    inspected.lock.geometry.regions.map((region) => [region.name, region.bounds?.min.x]),
    [
      ["Body", 1],
      ["Top", 11],
    ],
  );
  assert.deepEqual(inspected.lock.geometry.bounds, {
    min: { x: 1, y: 2, z: 3 },
    max: { x: 13, y: 4, z: 5 },
  });
  const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
  assert.deepEqual(reviewed.composition?.binding.fit, inspected.lock.fit);
  assert.equal(reviewed.composition?.binding.nativeImport.mayInstantiate, false);
});

for (const [mode, expected] of [
  ["output_hash", /geometry differs|output receipt/i],
  ["job_hash", /exact job|bind/i],
  ["log_hash", /log.*byte pin/i],
  ["excess_logs", /log|allowance|stdout/i],
  ["part_ids", /part|metadata/i],
  ["frame", /frame|metadata/i],
] as const) {
  test(`remote ${mode} mismatch cannot receive a reviewed source lock`, async (context) => {
    const f = await fixture(context, mode);
    const prepared = await f.jobs.prepare(request(), f.installation);
    const stopped = await f.jobs.run(prepared.jobId);
    assert.equal(stopped.status, "recovery_required");
    assert.equal(stopped.lock, undefined);
    assert.match(stopped.reason ?? "", expected);
    assert.equal(stopped.mayRun, false);
    await assert.rejects(() => f.jobs.review(prepared.jobId, "0".repeat(64)));
    await f.jobs.run(prepared.jobId);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  });
}

test("lost POST response preserves consumed identity and fetch then reconciliation never resubmits", async (context) => {
  const f = await fixture(context, "lost_post");
  const prepared = await f.jobs.prepare(request(), f.installation);
  const stopped = await f.jobs.run(prepared.jobId);
  assert.equal(stopped.status, "recovery_required");
  assert.equal(stopped.mayRun, false);
  const originalOutcome = stopped.executionOutcome;
  const fetched = await f.jobs.fetch(prepared.jobId);
  assert.equal(fetched.status, "succeeded");
  assert.equal(fetched.sourceHash, hash(inputObj.replace("o Body", "o mesh")));
  assert.equal((await f.jobs.status(prepared.jobId)).status, "recovery_required");
  const reconciled = await f.jobs.reconcile(prepared.jobId, fetched.sourceHash!);
  assert.equal(reconciled.status, "locally_inspected");
  assert.deepEqual(reconciled.executionOutcome, originalOutcome);
  assert.ok(reconciled.reconciliation && reconciled.lock);
  const reviewed = await f.jobs.review(prepared.jobId, reconciled.lock.hash);
  assert.equal(reviewed.status, "reviewed");
  const replayed = await new CreatorAssetJobs(f.directory).resolveCompositionAsset(pin(reviewed));
  assert.equal(replayed.binding.nativeImport.mayInstantiate, false);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(
    f.calls.some((call) => call.path === `/jobs/${prepared.jobId}` && call.method === "GET"),
  );
});

test("an orphan partial download does not block fetch and published output cannot be replaced", async (context) => {
  const f = await fixture(context, "lost_post");
  const prepared = await f.jobs.prepare(request(), f.installation);
  const stopped = await f.jobs.run(prepared.jobId);
  assert.equal(stopped.status, "recovery_required");
  const outputDirectory = join(stopped.executionDirectory, "output");
  await mkdir(outputDirectory);
  const orphan = ".download-" + randomUUID();
  const partial = "o mesh\nv 1 2";
  await writeFile(join(outputDirectory, orphan), partial);
  const expected = inputObj.replace("o Body", "o mesh");
  const fetched = await f.jobs.fetch(prepared.jobId);
  assert.equal(fetched.sourceHash, hash(expected));
  assert.equal(await readFile(join(outputDirectory, "output.obj"), "utf8"), expected);
  assert.equal(await readFile(join(outputDirectory, orphan), "utf8"), partial);
  assert.deepEqual((await readdir(outputDirectory)).sort(), [orphan, "output.obj"].sort());
  assert.equal((await f.jobs.fetch(prepared.jobId)).sourceHash, hash(expected));
  const changed = expected.replace("v 1 2 3", "v 9 2 3");
  await writeFile(join(outputDirectory, "output.obj"), changed);
  await assert.rejects(() => f.jobs.fetch(prepared.jobId), {
    code: "hash_mismatch",
    message: /already exists with different bytes/,
  });
  assert.equal(await readFile(join(outputDirectory, "output.obj"), "utf8"), changed);
  assert.deepEqual((await readdir(outputDirectory)).sort(), [orphan, "output.obj"].sort());
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal((await f.jobs.status(prepared.jobId)).status, "recovery_required");
});

test("near-limit remote logs remain inspectable and replayable within the encoded response envelope", async (context) => {
  const f = await fixture(context, "near_log_limit");
  const prepared = await f.jobs.prepare(request(), f.installation);
  const inspected = await f.jobs.run(prepared.jobId);
  assert.equal(inspected.status, "locally_inspected", inspected.reason);
  assert.ok(inspected.lock);
  const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
  assert.equal((await new CreatorAssetJobs(f.directory).status(prepared.jobId)).status, "reviewed");
  assert.equal(reviewed.composition?.binding.source.sha256, inspected.lock.sourceHash);
});

for (const mode of ["normalization", "part_vertices"] as const) {
  test(`CubePart rejects ${mode} evidence that contradicts its pinned input or output`, async (context) => {
    const f = await fixture(context, mode);
    const path = join(f.root, "input.obj");
    await writeFile(path, inputObj);
    const prepared = await f.jobs.prepare(
      {
        ...request(),
        namedParts: ["Body", "Top"],
        generation: {
          operation: "cubepart",
          seed: 23,
          input: { path, sha256: hash(inputObj), bytes: Buffer.byteLength(inputObj) },
          parts: [
            { id: "Body", prompt: "Main body" },
            { id: "Top", prompt: "Upper part" },
          ],
        },
      },
      f.installation,
    );
    const stopped = await f.jobs.run(prepared.jobId);
    assert.equal(stopped.status, "recovery_required");
    assert.equal(stopped.lock, undefined);
    assert.match(
      stopped.reason ?? "",
      mode === "normalization" ? /normalization|coordinate frame/i : /part manifest|geometry/i,
    );
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  });
}

test("malformed backend intent is rejected before filesystem claims or HTTP submission", async (context) => {
  const f = await fixture(context);
  const intent = createCubeJobIntent({
    spec: { ...request(), id: "malformed-intent" },
    codeHash: f.installation.cube.codeHash,
    configurationHash: f.installation.cube.configurationHash,
    checkpointHashes: f.installation.cube.checkpointHashes,
  });
  const { hash: _hash, ...body } = intent;
  const malformed = { ...body, jobId: "../outside" };
  const jobRoot = join(f.root, "launches");
  await assert.rejects(() =>
    runRemoteCubeJob({
      intent: { ...malformed, hash: contentHash(stableJson(malformed)) },
      installation: f.installation,
      registry: new AssetRegistry(f.jobs.store),
      jobRoot,
    }),
  );
  await assert.rejects(() => access(jobRoot), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("reviewed remote source replay rejects tampered preserved artifact bytes", async (context) => {
  const f = await fixture(context);
  const prepared = await f.jobs.prepare(request(), f.installation);
  const inspected = await f.jobs.run(prepared.jobId);
  assert.ok(inspected.lock);
  const reviewed = await f.jobs.review(prepared.jobId, inspected.lock.hash);
  const path = join(f.jobs.store.root, inspected.lock.sourceArtifact.locator);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace("o mesh", "o fake"));
  await assert.rejects(
    () => new CreatorAssetJobs(f.directory).resolveCompositionAsset(pin(reviewed)),
    /SHA-256 mismatch/,
  );
});
