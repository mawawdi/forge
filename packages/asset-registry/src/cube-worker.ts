import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { ArtifactReference } from "../../artifact-store/src/index.js";
import type { RemoteCubeInstallation } from "./cube-remote.js";
import {
  AssetError,
  AssetRegistry,
  assertCubeJobIntent,
  ensureAssetDirectory,
  readPinnedAssetFile,
  type AssetLock,
  type CubeJobIntent,
} from "./index.js";

export interface CubeInputPin {
  path: string;
  sha256: string;
  bytes: number;
}
/** Host installation data, never accepted from recipe/model configuration. */
export interface CubeInstallation {
  kind: "cube_local" | "recorded_fixture";
  executable: string;
  root: string;
  codeFiles: readonly CubeInputPin[];
  configuration: CubeInputPin;
  gptCheckpoint: CubeInputPin;
  shapeCheckpoint: CubeInputPin;
  license: string;
}
export interface CubeExecutionPolicy {
  timeoutMs: number;
  maximumLogBytes: number;
  maximumInputBytes: number;
  maximumOutputBytes: number;
}
/** Complete host configuration; this exact object is fingerprinted in worker evidence. */
export interface LocalCreatorCubeInstallation {
  kind: "CreatorCubeInstallation";
  cube: CubeInstallation;
  executablePin: { sha256: string; bytes: number };
  policy: CubeExecutionPolicy;
}
export type CreatorCubeInstallation = LocalCreatorCubeInstallation | RemoteCubeInstallation;
export function creatorCubeInstallationFingerprint(installation: CreatorCubeInstallation): string {
  return contentHash(stableJson(installation));
}
export const DEFAULT_CUBE_EXECUTION_POLICY: Readonly<CubeExecutionPolicy> = Object.freeze({
  timeoutMs: 120000,
  maximumLogBytes: 1024 * 1024,
  maximumInputBytes: 16 * 1024 * 1024 * 1024,
  maximumOutputBytes: 16 * 1024 * 1024,
});
export interface CubeCapturedLog {
  encoding: "base64";
  content: string;
  sha256: string;
  bytes: number;
}
export interface CubeProcessResult {
  stdout: CubeCapturedLog;
  stderr: CubeCapturedLog;
  logsTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  reason?: string;
}
export interface CubeJobDiagnostic {
  kind: "CubeJobDiagnostic";
  intentHash: string;
  installationKind: CubeInstallation["kind"] | "cube_remote";
  installationHash: string;
  status: "locally_inspected" | "recovery_required";
  failureCode?: string;
  reason?: string;
  execution?: CubeProcessResult;
  remote?: ArtifactReference;
}
export type CubeJobResult =
  | {
      status: "locally_inspected";
      intent: ArtifactReference;
      lock: AssetLock;
      receipt: ArtifactReference;
      diagnostic: ArtifactReference;
      jobDirectory: string;
    }
  | {
      status: "recovery_required";
      intent: ArtifactReference;
      jobDirectory: string;
      reason: string;
      failureCode: "intent_consumed" | "execution_incomplete" | "output_rejected";
      diagnostic: ArtifactReference;
      mayRelaunch: false;
    };

/** Argument order follows Roblox/cube cube3d/generate.py; no shell or model-supplied options. */
export function cubeArgumentVector(
  installation: CubeInstallation,
  intent: CubeJobIntent,
  outputDirectory: string,
): string[] {
  assertCubeJobIntent(intent);
  if (!isAbsolute(outputDirectory))
    throw new AssetError("unsafe_path", "Cube output must be an absolute host-owned directory");
  return [
    join(installation.root, "cube3d/generate.py"),
    "--config-path",
    join(installation.root, installation.configuration.path),
    "--gpt-ckpt-path",
    join(installation.root, installation.gptCheckpoint.path),
    "--shape-ckpt-path",
    join(installation.root, installation.shapeCheckpoint.path),
    "--prompt",
    intent.spec.description,
    "--bounding-box-xyz",
    String(intent.spec.bounds.x),
    String(intent.spec.bounds.y),
    String(intent.spec.bounds.z),
    "--output-dir",
    outputDirectory,
  ];
}

/**
 * Executes only a host-pinned installation. Bounds wall time, captured logs and
 * retained geometry, kills the process group on cancellation/timeout, and never
 * retries a consumed intent. It is not an OS memory/disk/network sandbox.
 */
export async function runCubeJob(input: {
  intent: CubeJobIntent;
  installation: LocalCreatorCubeInstallation;
  registry: AssetRegistry;
  jobRoot: string;
  signal?: AbortSignal;
}): Promise<CubeJobResult> {
  const { intent, registry } = input;
  const hostInstallation = structuredClone(input.installation);
  const { cube: installation, policy } = hostInstallation;
  if (hostInstallation.kind !== "CreatorCubeInstallation")
    throw new AssetError("invalid_installation", "Complete creator installation required");
  const installationHash = creatorCubeInstallationFingerprint(hostInstallation);
  assertCubeJobIntent(intent);
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new AssetError(
        "invalid_policy",
        "Cube execution limits must be positive safe integers",
      );
  if (policy.timeoutMs > 2147483647)
    throw new AssetError("invalid_policy", "Cube timeout exceeds the platform timer range");
  if (process.platform === "win32")
    throw new AssetError("unavailable", "This worker requires POSIX process-group cancellation");
  if (input.signal?.aborted)
    throw new AssetError("cancelled", "Cube job was cancelled before launch");
  await validateCubeInstallation(installation, intent, policy);
  const executablePin = {
    path: basename(installation.executable),
    ...hostInstallation.executablePin,
  };
  await verifyCubeInputPin(dirname(installation.executable), executablePin);
  const root = await ensureAssetDirectory(input.jobRoot);
  const jobDirectory = join(root, intent.jobId);
  // Immutable intent is persisted before the exclusive launch marker and subprocess.
  const intentReference = await registry.store.write(intent);
  const failure = async (
    failureCode: "intent_consumed" | "execution_incomplete" | "output_rejected",
    reason: string,
    execution?: CubeProcessResult,
  ): Promise<CubeJobResult> => ({
    status: "recovery_required",
    failureCode,
    intent: intentReference,
    jobDirectory,
    reason,
    diagnostic: await registry.store.write({
      kind: "CubeJobDiagnostic",
      intentHash: intent.hash,
      installationKind: installation.kind,
      installationHash,
      status: "recovery_required",
      failureCode,
      reason,
      ...(execution ? { execution } : {}),
    } satisfies CubeJobDiagnostic),
    mayRelaunch: false,
  });
  try {
    await mkdir(jobDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return failure(
        "intent_consumed",
        "This intent already has a job directory. Reconcile its recorded output/receipt before any new job; it will not be launched twice.",
      );
    throw error;
  }
  const markerPath = join(jobDirectory, "launch.json");
  try {
    const marker = await open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await marker.writeFile(
        stableJson({
          kind: "CubeLaunchIntent",
          intentHash: intent.hash,
          intent: intentReference,
          installationKind: installation.kind,
          installationHash,
        }) + "\n",
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return failure(
        "intent_consumed",
        "This intent has a persisted launch marker. Reconcile its recorded output/receipt before any new job; it will not be launched twice.",
      );
    throw error;
  }
  const outputDirectory = await ensureAssetDirectory(join(jobDirectory, "output"));
  const argv = cubeArgumentVector(installation, intent, outputDirectory);
  const result = await executeBounded(installation, argv, outputDirectory, policy, input.signal);
  if (result.reason !== undefined) {
    return failure("execution_incomplete", result.reason, result);
  }
  try {
    await validateCubeInstallation(installation, intent, policy);
    await verifyCubeInputPin(dirname(installation.executable), executablePin);
    const bytes = await readPinnedAssetFile(
      outputDirectory,
      "output.obj",
      Math.min(policy.maximumOutputBytes, registry.policy.maximumBytes),
    );
    const lock = await registry.ingestRecordedObj({
      bytes,
      expectedSourceHash: createHash("sha256").update(bytes).digest("hex"),
      spec: intent.spec,
      provenance: {
        kind: installation.kind === "recorded_fixture" ? "recorded_obj" : "cube_local",
        source: intent.hash,
        license: installation.license,
        codeHash: intent.codeHash,
        configurationHash: intent.configurationHash,
        checkpointHashes: intent.checkpointHashes,
      },
    });
    const diagnostic = await registry.store.write({
      kind: "CubeJobDiagnostic",
      intentHash: intent.hash,
      installationKind: installation.kind,
      installationHash,
      status: "locally_inspected",
      execution: result,
    } satisfies CubeJobDiagnostic);
    const receipt = await registry.store.write({
      kind: "CubeJobLocalReceipt",
      intentHash: intent.hash,
      installationKind: installation.kind,
      installationHash,
      assetLock: lock.hash,
      sourceHash: lock.sourceHash,
      exitCode: 0,
      diagnostic,
      claims:
        "Local byte inspection only; no Roblox upload, native import, rendering, permissions or collision evidence.",
    });
    return {
      status: "locally_inspected",
      intent: intentReference,
      lock,
      receipt,
      diagnostic,
      jobDirectory,
    };
  } catch (error) {
    return failure(
      "output_rejected",
      error instanceof Error ? error.message : "Output inspection failed",
      result,
    );
  }
}

export async function validateCubeInstallation(
  installation: CubeInstallation,
  intent: CubeJobIntent,
  policy: CubeExecutionPolicy,
): Promise<void> {
  if (intent.generation.operation !== "cube3d" || intent.checkpointHashes.length !== 2)
    throw new AssetError(
      "invalid_installation",
      "The local Cube3D worker requires a text generation and its two exact checkpoints",
    );
  if (intent.generation.seed !== 0)
    throw new AssetError(
      "unavailable",
      "The upstream local CLI has no seed option; use the remote worker for controlled seeds. Zero denotes unspecified local sampling.",
    );
  if (
    !isAbsolute(installation.executable) ||
    !isAbsolute(installation.root) ||
    !installation.license.trim()
  )
    throw new AssetError(
      "invalid_installation",
      "Cube installation requires absolute host paths and explicit licensing provenance",
    );
  const executable = await lstat(installation.executable);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    (await realpath(installation.executable)) !== installation.executable
  )
    throw new AssetError("unsafe_path", "Cube executable must be a direct regular binary");
  if ((await realpath(installation.root)) !== resolve(installation.root))
    throw new AssetError("unsafe_path", "Cube installation root cannot traverse symlinks");
  const files = [...installation.codeFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (
    files.length < 1 ||
    files.length > 4096 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    !files.some((file) => file.path === "cube3d/generate.py")
  )
    throw new AssetError(
      "invalid_installation",
      "Cube requires a unique pinned code inventory including its fixed entrypoint",
    );
  if (
    contentHash(stableJson(files)) !== intent.codeHash ||
    installation.configuration.sha256 !== intent.configurationHash ||
    installation.gptCheckpoint.sha256 !== intent.checkpointHashes[0] ||
    installation.shapeCheckpoint.sha256 !== intent.checkpointHashes[1]
  )
    throw new AssetError(
      "hash_mismatch",
      "Installed Cube pins differ from the accepted job intent",
    );
  let total = 0;
  for (const pin of [
    ...files,
    installation.configuration,
    installation.gptCheckpoint,
    installation.shapeCheckpoint,
  ]) {
    if (
      !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes < 1 ||
      (total += pin.bytes) > policy.maximumInputBytes
    )
      throw new AssetError("resource_limit", "Cube input inventory exceeds its hash/byte budget");
    await verifyCubeInputPin(installation.root, pin);
  }
}

export async function verifyCubeInputPin(root: string, pin: CubeInputPin): Promise<void> {
  if (
    isAbsolute(pin.path) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(pin.path) ||
    pin.path.split("/").some((part) => part === "." || part === "..")
  )
    throw new AssetError("unsafe_path", "Cube pin must use a regular relative path");
  let current = root;
  for (const segment of pin.path.split("/")) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new AssetError("unsafe_path", "Cube input traverses a symlink");
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pin.bytes)
      throw new AssetError("hash_mismatch", "Cube input byte count differs from its pin");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, pin.bytes - total + 1),
        null,
      );
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > pin.bytes)
        throw new AssetError("file_changed", "Cube input grew during verification");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (
      total !== pin.bytes ||
      hash.digest("hex") !== pin.sha256 ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new AssetError("hash_mismatch", "Cube input content differs from its pin");
  } finally {
    await handle.close();
  }
}

function executeBounded(
  installation: CubeInstallation,
  args: string[],
  outputDirectory: string,
  policy: CubeExecutionPolicy,
  signal?: AbortSignal,
): Promise<CubeProcessResult> {
  return new Promise((complete) => {
    const child = spawn(installation.executable, args, {
      cwd: installation.root,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: dirname(installation.executable) + ":/usr/bin:/bin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let count = 0;
    let reason: string | undefined;
    const stop = (why: string) => {
      reason ??= why;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, policy.maximumLogBytes - count);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      count += chunk.length;
      if (count > policy.maximumLogBytes)
        stop("Cube stdout/stderr exceeded the combined byte allowance");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const cancel = () =>
      stop("Cube job cancelled; preserve the launch intent and inspect partial outputs");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(
      () => stop("Cube job exceeded its wall-clock deadline"),
      policy.timeoutMs,
    );
    const monitor = setInterval(() => {
      void lstat(join(outputDirectory, "output.obj"))
        .then((stat) => {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > policy.maximumOutputBytes)
            stop("Cube output exceeded its regular-file allowance");
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") stop("Cube output inspection failed");
        });
    }, 25);
    child.on("error", (error) => {
      reason ??= "Cube process could not complete: " + error.message;
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      clearInterval(monitor);
      signal?.removeEventListener("abort", cancel);
      if (reason === undefined && (code !== 0 || exitSignal !== null))
        reason = `Cube process exited without success (${String(code)}, ${String(exitSignal)})`;
      complete({
        stdout: captureLog(Buffer.concat(stdout)),
        stderr: captureLog(Buffer.concat(stderr)),
        logsTruncated: count > policy.maximumLogBytes,
        exitCode: code,
        signal: exitSignal,
        ...(reason === undefined ? {} : { reason }),
      });
    });
  });
}

function captureLog(bytes: Buffer): CubeCapturedLog {
  return {
    encoding: "base64",
    content: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
