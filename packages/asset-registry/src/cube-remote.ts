import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import type { ArtifactReference } from "../../artifact-store/src/index.js";
import {
  AssetError,
  AssetRegistry,
  assertCubeJobIntent,
  ensureAssetDirectory,
  readPinnedAssetFile,
  inspectObj,
  type CubeJobIntent,
} from "./index.js";
import {
  creatorCubeInstallationFingerprint,
  type CubeExecutionPolicy,
  type CubeJobDiagnostic,
  type CubeJobResult,
} from "./cube-worker.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
/** Credentials stay in the host environment; this reviewable configuration contains only their name. */
export const remoteCubeConfigSchema = z
  .object({
    kind: z.literal("cube_remote"),
    endpoint: z.string().url().max(2048),
    tokenEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
    installationHash: digest,
    codeHash: digest,
    configurationHash: digest,
    checkpointHashes: z.array(digest).min(1).max(16),
    license: z.string().min(1).max(2048),
  })
  .strict();
export interface RemoteCubeInstallation {
  kind: "CreatorCubeInstallation";
  cube: z.infer<typeof remoteCubeConfigSchema>;
  policy: CubeExecutionPolicy;
}
export const DEFAULT_REMOTE_CUBE_POLICY: Readonly<CubeExecutionPolicy> = Object.freeze({
  timeoutMs: 900_000,
  maximumLogBytes: 1024 * 1024,
  maximumInputBytes: 16 * 1024 * 1024,
  maximumOutputBytes: 16 * 1024 * 1024,
});
const outputSchema = z
  .object({ path: z.literal("output.obj"), sha256: digest, bytes: positive.max(16 * 1024 * 1024) })
  .strict();
const metadataSchema = z
  .object({
    coordinateFrame: z.enum(["cube_normalized_aspect_conditioned", "input_obj_common_frame"]),
    normalization: z
      .object({
        center: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
        scale: z.number().finite().positive(),
      })
      .strict()
      .nullable(),
    parts: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
            vertices: positive.max(300_000),
            triangles: positive.max(500_000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    settings: z.record(z.string(), z.unknown()),
    gpu: z.record(z.string(), z.unknown()),
    reproducibility: z.literal("seed_and_settings_recorded_outputs_not_guaranteed_deterministic"),
  })
  .strict();
const logSchema = z
  .object({
    encoding: z.literal("base64"),
    content: z.string().max(4 * Math.ceil((1024 * 1024) / 3)),
    sha256: digest,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024),
  })
  .strict();
export const remoteCubeResultSchema = z
  .object({
    kind: z.literal("CubeRemoteResult"),
    jobId: z.string().uuid(),
    jobHash: digest,
    installationHash: digest,
    status: z.enum(["succeeded", "failed"]),
    execution: z
      .object({
        exitCode: z.number().int().nullable(),
        reason: z.string().max(8192).nullable(),
        stdout: logSchema,
        stderr: logSchema,
      })
      .strict()
      .optional(),
    output: outputSchema.optional(),
    metadata: metadataSchema.optional(),
    failure: z
      .object({ code: z.string().min(1).max(128), detail: z.string().min(1).max(8192) })
      .strict()
      .optional(),
    mayRelaunch: z.literal(false),
  })
  .strict();
const submissionSchema = z
  .object({
    kind: z.literal("CubeRemoteSubmission"),
    jobId: z.string().uuid(),
    jobHash: digest,
    installationHash: digest,
    status: z.enum(["queued", "running", "succeeded", "failed", "recovery_required"]),
    result: remoteCubeResultSchema.optional(),
  })
  .strict();
export type CubeRemoteSubmission = z.infer<typeof submissionSchema>;
export interface CubeRemoteEvidence {
  kind: "CubeRemoteEvidence";
  intentHash: string;
  installationHash: string;
  jobHash: string;
  submission: CubeRemoteSubmission;
}

export async function cubeRemoteJob(
  intent: CubeJobIntent,
  installation: RemoteCubeInstallation,
  registry: AssetRegistry,
): Promise<{ job: Record<string, unknown>; inputBase64?: string }> {
  assertCubeJobIntent(intent);
  const generation = intent.generation;
  const base = {
    kind: "CubeRemoteJob",
    jobId: intent.jobId,
    installationHash: installation.cube.installationHash,
    operation: generation.operation,
    seed: generation.seed,
  };
  if (generation.operation === "cube3d") {
    workerText(intent.spec.description, 4096);
    return { job: { ...base, prompt: intent.spec.description, bounds: intent.spec.bounds } };
  }
  generation.parts.forEach((part) => workerText(part.prompt, 2048));
  const source = await registry.store.read<{
    kind: string;
    sourceHash: string;
    utf8Bytes: number;
    obj: string;
  }>(generation.input.sourceArtifact);
  if (source.kind !== "RecordedObjBytes" || typeof source.obj !== "string")
    throw new AssetError(
      "invalid_record",
      "CubePart requires inspected, immutable input OBJ bytes",
    );
  const bytes = Buffer.from(source.obj, "utf8");
  if (
    bytes.length !== generation.input.bytes ||
    bytes.length > installation.policy.maximumInputBytes ||
    source.utf8Bytes !== bytes.length ||
    source.sourceHash !== generation.input.sha256 ||
    hash(bytes) !== generation.input.sha256
  )
    throw new AssetError("hash_mismatch", "CubePart input differs from its exact source pin");
  validateCubePartInputBytes(bytes);
  return {
    job: {
      ...base,
      input: { path: "input.obj", sha256: generation.input.sha256, bytes: generation.input.bytes },
      parts: generation.parts,
    },
    inputBase64: bytes.toString("base64"),
  };
}
function workerText(value: string, maximum: number): void {
  if (
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new AssetError(
      "invalid_request",
      `Cube prompt must be nonempty UTF-8 text within ${maximum} bytes, without control characters`,
    );
}
/** Fixed backend admission, independent from the general scene/asset IR. No material file loading. */
export function validateCubePartInputBytes(bytes: Uint8Array): void {
  const geometry = inspectObj(bytes);
  if (geometry.topology.unreferencedVertexCount > 0)
    throw new AssetError(
      "unsupported_cube_input",
      "CubePart input must reference every vertex; export a triangulated mesh with unused vertices removed",
    );
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  for (const line of text.split(/\r?\n/)) {
    const row = line.split("#", 1)[0]!.trim().split(/\s+/);
    if (row[0] === "") continue;
    if (row[0] === "v" && row.length === 4) continue;
    if (
      row[0] === "f" &&
      row.length === 4 &&
      row.slice(1).every((index) => /^[1-9][0-9]*$/.test(index))
    )
      continue;
    if (
      (row[0] === "o" || row[0] === "g") &&
      row.slice(1).every((name) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
    )
      continue;
    throw new AssetError(
      "unsupported_cube_input",
      "CubePart currently accepts plain triangulated OBJ with positive vertex indices and simple part names; export without UV/material/normal records",
    );
  }
  if (text.startsWith("\ufeff"))
    throw new AssetError(
      "unsupported_cube_input",
      "CubePart input must be UTF-8 without a BOM; the original asset bytes remain preserved",
    );
}

function endpoint(installation: RemoteCubeInstallation, path: string): string {
  const parsed = new URL(installation.cube.endpoint);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname)))
  )
    throw new AssetError(
      "invalid_installation",
      "Remote Cube requires HTTPS (or loopback for offline tests), without credentials, query or fragment",
    );
  return parsed.href.replace(/\/$/, "") + path;
}

/** No redirect following, automatic retries, or credential-bearing error bodies. */
async function request(
  installation: RemoteCubeInstallation,
  path: string,
  options: { method?: "POST"; body?: unknown; signal?: AbortSignal; maximumBytes?: number } = {},
): Promise<Buffer> {
  const url = endpoint(installation, path);
  const token = process.env[installation.cube.tokenEnvironment];
  if (!token || token.length < 32 || token.length > 4096 || /[\r\n]/.test(token))
    throw new AssetError(
      "credentials_unavailable",
      `Set ${installation.cube.tokenEnvironment} to the remote worker bearer token`,
    );
  const timeout = AbortSignal.timeout(Math.min(30_000, installation.policy.timeoutMs));
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: stableJson(options.body) } : {}),
    });
  } catch {
    throw new AssetError(
      "remote_uncertain",
      "Remote connection did not complete. Preserve this job ID and use fetch; no automatic resubmission is permitted.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AssetError(
      "remote_response",
      `Remote Cube returned HTTP ${response.status}; the request will not be repeated automatically`,
    );
  }
  const maximum = options.maximumBytes ?? 3 * 1024 * 1024;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new AssetError("resource_limit", "Remote response exceeds its byte allowance");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AssetError("remote_response", "Remote response has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximum)
        throw new AssetError(
          "resource_limit",
          "Remote response exceeded its streamed byte allowance",
        );
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, bytes);
}
function json(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: 3 * 1024 * 1024,
    maximumStringUtf8Bytes: 2 * 1024 * 1024,
  });
  return value;
}
export async function probeRemoteCube(installation: RemoteCubeInstallation): Promise<unknown> {
  remoteCubeConfigSchema.parse(installation.cube);
  const health = z
    .object({
      kind: z.literal("CubeRemoteHealth"),
      installationHash: digest,
      operations: z
        .array(z.enum(["cube3d", "cubepart"]))
        .min(1)
        .max(2),
    })
    .strict()
    .parse(json(await request(installation, "/health")));
  if (
    health.installationHash !== installation.cube.installationHash ||
    !health.operations.includes("cube3d") ||
    !health.operations.includes("cubepart")
  )
    throw new AssetError(
      "hash_mismatch",
      "Remote installation or operation inventory differs from the configured worker",
    );
  return health;
}
export function validateRemoteIntent(
  installation: RemoteCubeInstallation,
  intent: CubeJobIntent,
): void {
  assertCubeJobIntent(intent);
  remoteCubeConfigSchema.parse(installation.cube);
  endpoint(installation, "/health");
  if (
    intent.codeHash !== installation.cube.codeHash ||
    intent.configurationHash !== installation.cube.configurationHash ||
    stableJson(intent.checkpointHashes) !== stableJson(installation.cube.checkpointHashes)
  )
    throw new AssetError("hash_mismatch", "Remote input pins differ from the sealed job intent");
  if (
    intent.generation.operation === "cubepart" &&
    stableJson([...intent.spec.namedParts].sort()) !==
      stableJson(intent.generation.parts.map((p) => p.id).sort())
  )
    throw new AssetError(
      "invalid_request",
      "CubePart part IDs must exactly cover the asset's declared named parts",
    );
}

function bindSubmission(
  value: unknown,
  job: Record<string, unknown>,
  installation: RemoteCubeInstallation,
): CubeRemoteSubmission {
  const receipt = submissionSchema.parse(value);
  if (
    receipt.jobId !== job.jobId ||
    receipt.jobHash !== contentHash(stableJson(job)) ||
    receipt.installationHash !== installation.cube.installationHash
  )
    throw new AssetError(
      "hash_mismatch",
      "Remote receipt does not bind this exact job and installation",
    );
  const result = receipt.result;
  if (result) {
    let logBytes = 0;
    for (const log of result.execution ? [result.execution.stdout, result.execution.stderr] : []) {
      const bytes = Buffer.from(log.content, "base64");
      logBytes += bytes.length;
      if (
        bytes.length !== log.bytes ||
        bytes.toString("base64") !== log.content ||
        hash(bytes) !== log.sha256
      )
        throw new AssetError("hash_mismatch", "Remote execution log does not match its byte pin");
    }
    if (logBytes > installation.policy.maximumLogBytes)
      throw new AssetError(
        "resource_limit",
        "Remote execution logs exceed their combined byte allowance",
      );
    if (
      result.jobId !== receipt.jobId ||
      result.jobHash !== receipt.jobHash ||
      result.installationHash !== receipt.installationHash ||
      result.status !== receipt.status
    )
      throw new AssetError("hash_mismatch", "Remote result contradicts its submission");
    if (
      result.status === "succeeded"
        ? !result.output || !result.metadata || !!result.failure
        : !!result.output || !!result.metadata || !result.failure
    )
      throw new AssetError(
        "invalid_record",
        "Remote result has contradictory success/failure evidence",
      );
    if (
      result.status === "succeeded" &&
      (!result.execution || result.execution.exitCode !== 0 || result.execution.reason !== null)
    )
      throw new AssetError("invalid_record", "Remote success lacks completed execution");
    if (result.metadata) {
      const expected =
        job.operation === "cube3d"
          ? ["mesh"]
          : (job.parts as { id: string }[]).map((part) => part.id);
      if (
        stableJson(result.metadata.parts.map((part) => part.id)) !== stableJson(expected) ||
        result.metadata.coordinateFrame !==
          (job.operation === "cube3d"
            ? "cube_normalized_aspect_conditioned"
            : "input_obj_common_frame") ||
        (job.operation === "cube3d"
          ? result.metadata.normalization !== null
          : result.metadata.normalization === null)
      )
        throw new AssetError(
          "invalid_record",
          "Remote coordinate frame or parts differ from the requested operation",
        );
    }
  } else if (receipt.status === "succeeded" || receipt.status === "failed")
    throw new AssetError("invalid_record", "Terminal remote status lacks its immutable result");
  return receipt;
}

export async function validateRemoteEvidence(
  reference: ArtifactReference,
  intent: CubeJobIntent,
  installation: RemoteCubeInstallation,
  registry: AssetRegistry,
): Promise<CubeRemoteSubmission> {
  const evidence = await registry.store.read<CubeRemoteEvidence>(reference);
  const { job } = await cubeRemoteJob(intent, installation, registry);
  if (
    Object.keys(evidence).sort().join(",") !==
      "installationHash,intentHash,jobHash,kind,submission" ||
    evidence.kind !== "CubeRemoteEvidence" ||
    evidence.intentHash !== intent.hash ||
    evidence.installationHash !== creatorCubeInstallationFingerprint(installation) ||
    evidence.jobHash !== contentHash(stableJson(job))
  )
    throw new AssetError("invalid_record", "Stored remote evidence does not bind its job");
  const receipt = bindSubmission(evidence.submission, job, installation);
  await validateNormalization(receipt, intent, registry);
  return receipt;
}
async function validateNormalization(
  receipt: CubeRemoteSubmission,
  intent: CubeJobIntent,
  registry: AssetRegistry,
): Promise<void> {
  if (receipt.status !== "succeeded" || intent.generation.operation !== "cubepart") return;
  const source = await registry.store.read<{ obj: string }>(intent.generation.input.sourceArtifact);
  const geometry = inspectObj(Buffer.from(source.obj, "utf8"));
  const axes = ["x", "y", "z"] as const;
  const expectedCenter = axes.map(
    (axis) => (geometry.bounds.min[axis] + geometry.bounds.max[axis]) / 2,
  );
  const expectedScale =
    1.92 / Math.max(...axes.map((axis) => geometry.bounds.max[axis] - geometry.bounds.min[axis]));
  const normalization = receipt.result!.metadata!.normalization!;
  const near = (actual: number, expected: number) =>
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
  if (
    !near(normalization.scale, expectedScale) ||
    normalization.center.some((value, index) => !near(value, expectedCenter[index]!))
  )
    throw new AssetError(
      "hash_mismatch",
      "CubePart normalization differs from its exact input coordinate frame",
    );
}

async function preserveOutput(
  installation: RemoteCubeInstallation,
  receipt: CubeRemoteSubmission,
  directory: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const output = receipt.result?.output;
  if (receipt.status !== "succeeded" || !output)
    throw new AssetError(
      "remote_incomplete",
      `Remote job is ${receipt.status}; no completed mesh is available`,
    );
  const bytes = await request(installation, `/jobs/${receipt.jobId}/output`, {
    ...(signal ? { signal } : {}),
    maximumBytes: installation.policy.maximumOutputBytes,
  });
  if (bytes.length !== output.bytes || hash(bytes) !== output.sha256)
    throw new AssetError(
      "hash_mismatch",
      "Downloaded geometry differs from the remote output receipt",
    );
  const geometry = inspectObj(bytes);
  const parts = receipt.result!.metadata!.parts;
  const objects = geometry.regions.filter((region) => region.kind === "object");
  if (
    stableJson(objects.map((region) => region.name).sort()) !==
      stableJson(parts.map((part) => part.id).sort()) ||
    parts.reduce((total, part) => total + part.vertices, 0) !== geometry.vertexCount ||
    geometry.topology.unreferencedVertexCount > 0 ||
    parts.some((part) => {
      const region = objects.find((entry) => entry.name === part.id);
      return (
        part.triangles !== region?.triangleCount || part.vertices !== region?.referencedVertexCount
      );
    })
  )
    throw new AssetError(
      "hash_mismatch",
      "Remote part manifest differs from the inspected output geometry",
    );
  const outputDirectory = await ensureAssetDirectory(join(directory, "output"));
  const temporary = join(outputDirectory, ".download-" + randomUUID());
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // A failed/partial download never occupies the final path. Publishing cannot replace it.
    await link(temporary, join(outputDirectory, "output.obj"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readPinnedAssetFile(
      outputDirectory,
      "output.obj",
      installation.policy.maximumOutputBytes,
    );
    if (!existing.equals(bytes))
      throw new AssetError("hash_mismatch", "Preserved output already exists with different bytes");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  // Also finish durability when recovering a link published just before a host interruption.
  const directoryHandle = await open(outputDirectory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return bytes;
}

/** Read-only remote recovery never submits a job. Original local failure evidence remains immutable. */
export async function fetchRemoteCubeOutput(input: {
  intent: CubeJobIntent;
  installation: RemoteCubeInstallation;
  registry: AssetRegistry;
  jobRoot: string;
  signal?: AbortSignal;
}): Promise<{ receipt: CubeRemoteSubmission; evidence: ArtifactReference; sourceHash?: string }> {
  validateRemoteIntent(input.installation, input.intent);
  const { job } = await cubeRemoteJob(input.intent, input.installation, input.registry);
  const receipt = bindSubmission(
    json(
      await request(
        input.installation,
        `/jobs/${input.intent.jobId}`,
        input.signal ? { signal: input.signal } : {},
      ),
    ),
    job,
    input.installation,
  );
  const evidence = await storeRemoteEvidence(input, job, receipt);
  if (receipt.status !== "succeeded") return { receipt, evidence };
  const root = await ensureAssetDirectory(input.jobRoot);
  const directory = await ensureAssetDirectory(join(root, input.intent.jobId));
  const bytes = await preserveOutput(input.installation, receipt, directory, input.signal);
  return { receipt, evidence, sourceHash: hash(bytes) };
}
async function storeRemoteEvidence(
  input: { intent: CubeJobIntent; installation: RemoteCubeInstallation; registry: AssetRegistry },
  job: Record<string, unknown>,
  submission: CubeRemoteSubmission,
): Promise<ArtifactReference> {
  await validateNormalization(submission, input.intent, input.registry);
  return input.registry.store.write({
    kind: "CubeRemoteEvidence",
    intentHash: input.intent.hash,
    installationHash: creatorCubeInstallationFingerprint(input.installation),
    jobHash: contentHash(stableJson(job)),
    submission,
  } satisfies CubeRemoteEvidence);
}
export async function runRemoteCubeJob(input: {
  intent: CubeJobIntent;
  installation: RemoteCubeInstallation;
  registry: AssetRegistry;
  jobRoot: string;
  signal?: AbortSignal;
}): Promise<CubeJobResult> {
  input = {
    ...input,
    intent: structuredClone(input.intent),
    installation: structuredClone(input.installation),
  };
  const { intent, installation, registry } = input;
  validateRemoteIntent(installation, intent);
  const root = await ensureAssetDirectory(input.jobRoot);
  const jobDirectory = join(root, intent.jobId);
  const intentReference = await registry.store.write(intent);
  const installationHash = creatorCubeInstallationFingerprint(installation);
  let remote: ArtifactReference | undefined;
  let completed = false;
  const fail = async (
    failureCode: "intent_consumed" | "execution_incomplete" | "output_rejected",
    reason: string,
  ): Promise<CubeJobResult> => ({
    status: "recovery_required",
    intent: intentReference,
    jobDirectory,
    reason,
    failureCode,
    mayRelaunch: false,
    diagnostic: await registry.store.write({
      kind: "CubeJobDiagnostic",
      intentHash: intent.hash,
      installationKind: "cube_remote",
      installationHash,
      status: "recovery_required",
      failureCode,
      reason,
      ...(remote ? { remote } : {}),
    } satisfies CubeJobDiagnostic),
  });
  try {
    await mkdir(jobDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return fail(
        "intent_consumed",
        "This job is already consumed; fetch its remote status/output without submitting again",
      );
    throw error;
  }
  try {
    const payload = await cubeRemoteJob(intent, installation, registry);
    const marker = await open(join(jobDirectory, "launch.json"), "wx", 0o600);
    try {
      await marker.writeFile(
        stableJson({
          kind: "CubeRemoteLaunch",
          intentHash: intent.hash,
          installationHash,
          job: payload.job,
        }) + "\n",
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
    const deadline = AbortSignal.timeout(installation.policy.timeoutMs);
    const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline;
    let receipt = bindSubmission(
      json(await request(installation, "/jobs", { method: "POST", body: payload, signal })),
      payload.job,
      installation,
    );
    remote = await storeRemoteEvidence(input, payload.job, receipt);
    while (receipt.status === "queued" || receipt.status === "running") {
      await pause(2000, undefined, { signal });
      receipt = bindSubmission(
        json(await request(installation, `/jobs/${intent.jobId}`, { signal })),
        payload.job,
        installation,
      );
      remote = await storeRemoteEvidence(input, payload.job, receipt);
    }
    if (receipt.status !== "succeeded")
      return fail(
        "execution_incomplete",
        receipt.result?.failure?.detail ??
          "Remote attempt needs explicit recovery; it will not be resubmitted",
      );
    completed = true;
    const bytes = await preserveOutput(installation, receipt, jobDirectory, signal);
    const lock = await registry.ingestRecordedObj({
      bytes,
      expectedSourceHash: receipt.result!.output!.sha256,
      spec: intent.spec,
      provenance: {
        kind: "cube_remote",
        source: intent.hash,
        license: installation.cube.license,
        codeHash: intent.codeHash,
        configurationHash: intent.configurationHash,
        checkpointHashes: intent.checkpointHashes,
      },
    });
    const diagnostic = await registry.store.write({
      kind: "CubeJobDiagnostic",
      intentHash: intent.hash,
      installationKind: "cube_remote",
      installationHash,
      status: "locally_inspected",
      remote,
    } satisfies CubeJobDiagnostic);
    const receiptReference = await registry.store.write({
      kind: "CubeJobLocalReceipt",
      intentHash: intent.hash,
      installationKind: "cube_remote",
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
      receipt: receiptReference,
      diagnostic,
      jobDirectory,
    };
  } catch (error) {
    return fail(
      completed ? "output_rejected" : "execution_incomplete",
      error instanceof Error ? error.message.slice(0, 8192) : "Remote generation did not complete",
    );
  }
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
