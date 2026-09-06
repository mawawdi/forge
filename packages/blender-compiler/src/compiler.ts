import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  ImmutableBinaryArtifactStore,
  type BinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import { inspectVisualPng } from "../../visual-evidence/src/index.js";
import {
  BLENDER_COMPILER_PROFILE,
  blenderSceneSpecHandle,
  validateMeasuredScene,
  validateResolvedScene,
  validateBlenderSceneSpec,
  type BlenderSceneSpec,
  type SceneRepairPlan,
  type SceneBounds,
  type SceneTransform,
} from "../../visual-world/src/index.js";
import {
  sceneEulerXyz,
  sceneHalfExtents,
  sceneTransformVector,
} from "../../game-composition/src/scene-geometry.js";
import {
  BLENDER_COMPILER_ABI,
  BLENDER_COMPILER_INSTALLATION_SCHEMA,
  BLENDER_EXPORT_PROFILE,
  type BlenderCompileResult,
  type BlenderCompilerInstallation,
  type CompiledSceneBundle,
  type SceneBundleManifest,
  type SceneBundleOutput,
  type SceneRepairDelta,
} from "./contracts.js";
import { inspectGlb, inspectTextureImage, type GlbInspectionReport } from "./glb.js";
import {
  blenderSeatbeltPolicySha256,
  inspectApplicationInventory,
  qualifiedRegularFileIdentity,
} from "./qualification.js";

export interface BlenderCompilerPolicy {
  timeoutMs: number;
  maximumLogBytes: number;
  maximumOutputBytes: number;
  maximumOutputFiles: number;
}

export const DEFAULT_BLENDER_COMPILER_POLICY: Readonly<BlenderCompilerPolicy> = Object.freeze({
  timeoutMs: 20 * 60 * 1000,
  maximumLogBytes: 2 * 1024 * 1024,
  maximumOutputBytes: 256 * 1024 * 1024,
  maximumOutputFiles: 1024,
});

const reportVector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const geometryReportSchema = z
  .object({
    kind: z.literal("ForgeGeometryReport"),
    sceneId: z.string(),
    revision: z.number().int().positive(),
    objects: z.array(
      z
        .object({
          stableId: z.string(),
          exportName: z.string(),
          triangles: z.number().int().nonnegative(),
          blenderBounds: z.object({ minimum: reportVector, maximum: reportVector }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
const materialReportSchema = z
  .object({
    kind: z.literal("ForgeMaterialReport"),
    sceneId: z.string(),
    revision: z.number().int().positive(),
    materials: z.array(
      z
        .object({
          id: z.string(),
          textureIds: z.array(z.string()),
          alphaMode: z.enum(["opaque", "mask", "blend"]),
        })
        .strict(),
    ),
  })
  .strict();
const budgetReportSchema = z
  .object({
    kind: z.literal("ForgeBudgetReport"),
    sceneId: z.string(),
    revision: z.number().int().positive(),
    objects: z.number().int().nonnegative(),
    expandedInstances: z.number().int().nonnegative(),
    triangles: z.number().int().nonnegative(),
    limits: z.record(z.string(), z.number().finite()),
  })
  .strict();
const blendInspectionSchema = z
  .object({
    kind: z.literal("ForgeBlendInspection"),
    abi: z.literal("forge-blend-inspection@2"),
    sceneId: z.string(),
    revision: z.number().int().positive(),
    objects: z.array(
      z
        .object({
          stableId: z.string(),
          name: z.string(),
          partitionId: z.string(),
          meshVertices: z.number().int().positive(),
          meshPolygons: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export interface BlenderSourceInput {
  sourceId: string;
  path: string;
}

export interface CompileBlenderSceneInput {
  spec: BlenderSceneSpec;
  installation: BlenderCompilerInstallation;
  binaryStore: ImmutableBinaryArtifactStore;
  allowedSourceRoots: readonly string[];
  sources: readonly BlenderSourceInput[];
  repair?: {
    plan: SceneRepairPlan;
    parentBundle: CompiledSceneBundle;
  };
  policy?: BlenderCompilerPolicy;
  /** Fixed host-test seam. Production coordinators never expose this to model-authored data. */
  installationVerifier?: (
    installation: BlenderCompilerInstallation,
  ) => Promise<{ status: "eligible"; installationHash: string }>;
  /** Test-only process seam. Production callers always use the fixed Seatbelt runner. */
  isolatedRunner?: (
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    maximumLogBytes: number,
    cwd: string,
    additionalReadFiles?: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface RepairCompilationContext {
  plan: SceneRepairPlan;
  parentBundle: CompiledSceneBundle;
  reusedPartitionIds: string[];
  reusedViewIds: string[];
}

export async function compileBlenderScene(
  input: CompileBlenderSceneInput,
): Promise<BlenderCompileResult> {
  return compileOne(input);
}

export async function inspectBlenderInstallation(installationInput: unknown): Promise<
  | { status: "eligible"; installationHash: string }
  | {
      status: "incomplete" | "rejected";
      code: "missing_blender" | "unqualified_blender";
      detail: string;
    }
> {
  let installation: BlenderCompilerInstallation;
  try {
    installation = BLENDER_COMPILER_INSTALLATION_SCHEMA.parse(installationInput);
  } catch (error: unknown) {
    return { status: "rejected", code: "unqualified_blender", detail: detail(error) };
  }
  try {
    if (
      !isAbsolute(installation.distributionPath) ||
      !isAbsolute(installation.applicationPath) ||
      !isAbsolute(installation.executablePath)
    )
      throw new Error("Blender qualification paths must be absolute");
    if (
      installation.executablePath !== join(installation.applicationPath, "Contents/MacOS/Blender")
    )
      throw new Error("Blender executable is outside the qualified application bundle");
    const distributionInfo = await lstat(installation.distributionPath);
    if (
      distributionInfo.isSymbolicLink() ||
      !distributionInfo.isFile() ||
      distributionInfo.size !== installation.distributionBytes
    )
      throw new Error("Blender distribution differs from its qualification record");
    const distribution = await qualifiedRegularFileIdentity(
      installation.distributionPath,
      2 * 1024 * 1024 * 1024,
    );
    if (distribution.hash !== installation.distributionSha256)
      throw new Error("Blender distribution checksum differs from its qualification record");
    const info = await lstat(installation.executablePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Blender executable is not a regular file");
    const bytes = await readBoundedFile(installation.executablePath, 1024 * 1024 * 1024);
    if (sha256(bytes) !== installation.executableSha256)
      throw new Error("Blender executable hash does not match its installation record");
    const application = await inspectApplicationInventory(installation.applicationPath);
    if (
      application.hash !== installation.applicationInventorySha256 ||
      application.fileCount !== installation.applicationFileCount ||
      application.bytes !== installation.applicationBytes
    )
      throw new Error("Blender application inventory differs from its qualification record");
    const pythonPath = join(installation.applicationPath, installation.bundledPythonRelativePath);
    if (
      sha256(await readBoundedFile(pythonPath, 256 * 1024 * 1024)) !==
      installation.bundledPythonSha256
    )
      throw new Error("Blender bundled Python differs from its qualification record");
    const libraries = application.entries.filter(
      (entry) =>
        entry.kind === "file" &&
        entry.path.startsWith("Contents/Resources/lib/") &&
        entry.path.endsWith(".dylib"),
    );
    if (
      libraries.length !== installation.bundledLibraryCount ||
      contentHash(stableJson(libraries)) !== installation.bundledLibraryInventorySha256
    )
      throw new Error("Blender bundled libraries differ from their qualification record");
    if (installation.seatbeltPolicySha256 !== blenderSeatbeltPolicySha256())
      throw new Error("Blender Seatbelt policy differs from its qualification record");
    const worker = await workerIdentity();
    if (worker.hash !== installation.workerSha256)
      throw new Error("Blender worker hash does not match its installation record");
    const inspector = await blendInspectorIdentity();
    if (inspector.hash !== installation.inspectorSha256)
      throw new Error("Blend inspector hash does not match its installation record");
    const sandbox = await lstat("/usr/bin/sandbox-exec");
    if (!sandbox.isFile()) throw new Error("Qualified macOS Seatbelt runner is unavailable");
    const qualificationWorkspace = await mkdtemp(
      join(await realpath(tmpdir()), "forge-blender-qualification-"),
    );
    try {
      const version = await runIsolatedBlender(
        installation.executablePath,
        ["--version"],
        10_000,
        64 * 1024,
        qualificationWorkspace,
      );
      if (
        version.exitCode !== 0 ||
        !version.stdout.startsWith(`Blender ${installation.blenderVersion}`)
      )
        throw new Error(
          `Blender failed its qualified Seatbelt launch: ${boundedDetail(
            version.stderr || version.stdout,
          )}`,
        );
      const startup = await runIsolatedBlender(
        installation.executablePath,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "73",
          "--python-expr",
          'print("FORGE_QUALIFIED_BACKGROUND_STARTUP")',
        ],
        30_000,
        256 * 1024,
        qualificationWorkspace,
      );
      if (startup.exitCode !== 0 || !startup.stdout.includes("FORGE_QUALIFIED_BACKGROUND_STARTUP"))
        throw new Error(
          `Blender failed its qualified background startup: ${boundedDetail(
            startup.stderr || startup.stdout,
          )}`,
        );
    } finally {
      await rm(qualificationWorkspace, { recursive: true, force: true, maxRetries: 3 });
    }
    return { status: "eligible", installationHash: contentHash(stableJson(installation)) };
  } catch (error: unknown) {
    const missing = isNodeError(error, "ENOENT");
    return {
      status: missing ? "incomplete" : "rejected",
      code: missing ? "missing_blender" : "unqualified_blender",
      detail: detail(error),
    };
  }
}

export async function currentBlenderWorkerIdentity(): Promise<{
  workerSha256: string;
  inspectorSha256: string;
  operationSetSha256: string;
  exportProfileSha256: string;
}> {
  const worker = await workerIdentity();
  const inspector = await blendInspectorIdentity();
  return {
    workerSha256: worker.hash,
    inspectorSha256: inspector.hash,
    operationSetSha256: contentHash(
      stableJson({
        abi: BLENDER_COMPILER_ABI,
        hostArtifactValidationProfile: "forge-host-artifact-validation@2.1",
        operations: [
          "indexed_mesh",
          "solid",
          "profile",
          "curve",
          "external_glb",
          "extrude",
          "revolve",
          "loft",
          "sweep",
          "join",
          "bevel",
          "solidify",
          "mirror",
          "subdivide",
          "boolean",
          "transform_geometry",
          "deform",
        ],
      }),
    ),
    exportProfileSha256: contentHash(
      stableJson({
        id: BLENDER_EXPORT_PROFILE,
        sceneCoordinates: "roblox-y-up-studs",
        blenderMapping: "x,-z,y",
        format: "GLB",
        applyModifiers: true,
        animations: false,
        cameras: false,
        lights: false,
        extras: true,
        renderEngine: "CYCLES",
        renderDevice: "CPU",
        renderThreads: 4,
        renderSamples: 64,
        renderDenoising: false,
        renderSeed: "scene-seed",
        colorManagement: "AgX - Medium High Contrast",
        reviewExposureStops: 1.25,
        reviewLightWattsPerIntensity: 1000,
        reviewPointLightShadows: false,
        reviewSpotSizeDegrees: 70,
        reviewSpotBlend: 0.4,
      }),
    ),
  };
}

async function compileOne(input: CompileBlenderSceneInput): Promise<BlenderCompileResult> {
  const policy = input.policy ?? DEFAULT_BLENDER_COMPILER_POLICY;
  const installation = BLENDER_COMPILER_INSTALLATION_SCHEMA.parse(input.installation);
  const installationStatus = input.installationVerifier
    ? await input.installationVerifier(installation)
    : await inspectBlenderInstallation(installation);
  if (installationStatus.status !== "eligible") return installationStatus;
  let spec: BlenderSceneSpec;
  let repair: RepairCompilationContext | undefined;
  try {
    spec = validateBlenderSceneSpec(input.spec);
    const expectedIdentity = await currentBlenderWorkerIdentity();
    if (
      spec.compiler.profile !== BLENDER_COMPILER_PROFILE ||
      spec.compiler.blenderVersion !== input.installation.blenderVersion ||
      spec.compiler.blenderBinarySha256 !== input.installation.executableSha256 ||
      spec.compiler.workerSha256 !== expectedIdentity.workerSha256 ||
      spec.compiler.inspectorSha256 !== expectedIdentity.inspectorSha256 ||
      spec.compiler.operationSetSha256 !== expectedIdentity.operationSetSha256 ||
      spec.compiler.exportProfileSha256 !== expectedIdentity.exportProfileSha256
    )
      throw new Error("Scene compiler identity does not match the installed fixed compiler");
    repair = validateRepairCompilation(spec, input.repair);
  } catch (error: unknown) {
    return { status: "rejected", code: "compiler_failure", detail: detail(error) };
  }
  const invocationMaterial = {
    abi: BLENDER_COMPILER_ABI,
    scene: blenderSceneSpecHandle(spec),
    installationHash: installationStatus.installationHash,
    sourceHashes: [...spec.sources]
      .map(({ id, sha256: hash }) => ({ id, hash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    policy,
    repair: repair
      ? {
          planHash: repair.plan.hash,
          parentManifestHash: repair.parentBundle.manifest.hash,
          reusedPartitionIds: repair.reusedPartitionIds,
          reusedViewIds: repair.reusedViewIds,
        }
      : undefined,
  };
  const invocationHash = contentHash(stableJson(invocationMaterial));
  const dispatch = await beginCompilationDispatch(input.binaryStore.root, invocationHash).catch(
    (error: unknown) => ({ error }),
  );
  if ("error" in dispatch)
    return {
      status: "incomplete",
      code: "compiler_failure",
      detail: detail(dispatch.error),
      invocationHash,
    };
  let workspace: string | undefined;
  try {
    await dispatch.record("qualified_environment", {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      blenderVersion: installation.blenderVersion,
      executableSha256: installation.executableSha256,
      installationHash: installationStatus.installationHash,
      seatbeltPolicySha256: installation.seatbeltPolicySha256,
      policy,
    });
    workspace = await mkdtemp(join(await realpath(tmpdir()), "forge-blender-"));
    const inputDirectory = join(workspace, "inputs");
    const outputDirectory = join(workspace, "outputs");
    await mkdir(inputDirectory, { mode: 0o700 });
    await mkdir(outputDirectory, { mode: 0o700 });
    const sourceResult = await stageSources(
      spec,
      input.sources,
      input.allowedSourceRoots,
      inputDirectory,
    );
    if (sourceResult.status !== "eligible") {
      await dispatch.record("source_rejected", sourceResult);
      return { ...sourceResult, invocationHash };
    }
    const specPath = join(workspace, "scene-spec.json");
    await writeFile(specPath, `${stableJson(spec)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const directivePath = join(workspace, "compile-directive.json");
    await writeFile(
      directivePath,
      `${stableJson({
        kind: "ForgeBlenderCompileDirective",
        reusedPartitionIds: repair?.reusedPartitionIds ?? [],
        reusedViewIds: repair?.reusedViewIds ?? [],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const worker = await workerIdentity();
    const invocation = await (input.isolatedRunner ?? runIsolatedBlender)(
      input.installation.executablePath,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--offline-mode",
        "--python-exit-code",
        "73",
        "--python",
        worker.path,
        "--",
        "--spec",
        specPath,
        "--directive",
        directivePath,
        "--inputs",
        inputDirectory,
        "--outputs",
        outputDirectory,
      ],
      policy.timeoutMs,
      policy.maximumLogBytes,
      workspace,
      [worker.path],
    ).catch((error: unknown) => ({ error }));
    if ("error" in invocation) {
      const timeout =
        invocation.error instanceof ProcessFailure && invocation.error.code === "timeout";
      const failure = {
        status: "incomplete" as const,
        code: timeout ? "compiler_timeout" : "compiler_failure",
        detail: detail(invocation.error),
        invocationHash,
      } as const;
      await dispatch.record("worker_failed", failure);
      return failure;
    }
    await dispatch.record("worker_terminated", {
      exitCode: invocation.exitCode,
      stdout: invocation.stdout,
      stderr: invocation.stderr,
    });
    if (invocation.exitCode !== 0) {
      const failure = {
        status: "incomplete" as const,
        code: "compiler_failure" as const,
        detail: `Blender compiler exited ${invocation.exitCode}: ${boundedDetail(
          invocation.stderr || invocation.stdout,
        )}`,
        invocationHash,
      };
      await dispatch.record("worker_rejected", failure);
      return failure;
    }
    const blendDeclaration = spec.expectedOutputs.find((entry) => entry.kind === "blend")!;
    const inspectionPath = join(workspace, "blend-inspection.json");
    const inspector = await blendInspectorIdentity();
    const inspection = await (input.isolatedRunner ?? runIsolatedBlender)(
      input.installation.executablePath,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        join(outputDirectory, blendDeclaration.relativePath),
        "--python-exit-code",
        "73",
        "--python",
        inspector.path,
        "--",
        "--report",
        inspectionPath,
        "--scene-id",
        spec.sceneId,
        "--revision",
        String(spec.revision),
        "--blend-inspection",
        "--binding-spec",
        specPath,
      ],
      Math.min(policy.timeoutMs, 120_000),
      policy.maximumLogBytes,
      workspace,
      [inspector.path],
    ).catch((error: unknown) => ({ error }));
    if (!("error" in inspection))
      await dispatch.record("inspection_terminated", {
        exitCode: inspection.exitCode,
        stdout: inspection.stdout,
        stderr: inspection.stderr,
      });
    if ("error" in inspection || inspection.exitCode !== 0) {
      const failure = {
        status: "incomplete" as const,
        code: "malformed_output" as const,
        detail:
          "error" in inspection
            ? detail(inspection.error)
            : boundedDetail(inspection.stderr || inspection.stdout),
        invocationHash,
      };
      await dispatch.record("inspection_failed", failure);
      return failure;
    }
    const blendReport = blendInspectionSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedFile(inspectionPath, 4 * 1024 * 1024),
        ),
      ),
    );
    assertBlendInspection(spec, blendReport);
    const retained = await retainOutputs({
      spec,
      installationHash: installationStatus.installationHash,
      invocationHash,
      outputDirectory,
      binaryStore: input.binaryStore,
      policy,
      ...(repair ? { repair } : {}),
    });
    await dispatch.record(
      retained.status === "eligible" ? "published" : "publication_failed",
      retained.status === "eligible"
        ? {
            manifestHash: retained.bundle.manifest.hash,
            manifestArtifactHash: retained.bundle.manifestArtifact.artifactHash,
            outputCount: retained.bundle.artifacts.length,
          }
        : retained,
    );
    return retained;
  } catch (error: unknown) {
    const failure = {
      status: "incomplete" as const,
      code: "compiler_failure" as const,
      detail: detail(error),
      invocationHash,
    };
    await dispatch.record("host_failed", failure).catch(() => undefined);
    return failure;
  } finally {
    if (workspace !== undefined)
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
    await dispatch.record("lease_releasing", { processId: process.pid }).catch(() => undefined);
    await dispatch.release();
  }
}

async function beginCompilationDispatch(
  artifactRoot: string,
  invocationHash: string,
): Promise<{
  record: (state: string, data: unknown) => Promise<void>;
  release: () => Promise<void>;
}> {
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const jobs = join(artifactRoot, "blender-compiler-jobs-v2");
  await mkdir(jobs, { mode: 0o700 }).catch((error: unknown) => {
    if (!isNodeError(error, "EEXIST")) throw error;
  });
  const job = join(jobs, invocationHash);
  try {
    await mkdir(job, { mode: 0o700 });
  } catch (error: unknown) {
    if (isNodeError(error, "EEXIST"))
      throw new Error(
        "This exact compilation intent was already dispatched; inspect its retained job record",
      );
    throw error;
  }
  await writeFile(
    join(job, "intent.json"),
    `${stableJson({
      kind: "BlenderCompilationDispatch",
      abi: BLENDER_COMPILER_ABI,
      invocationHash,
      state: "dispatching",
      processId: process.pid,
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const leasePath = join(jobs, ".active-lease");
  let lease;
  try {
    lease = await open(leasePath, "wx", 0o600);
    await lease.writeFile(`${invocationHash}\n`, "utf8");
  } catch (error: unknown) {
    await rm(job, { recursive: true, force: true });
    if (isNodeError(error, "EEXIST"))
      throw new Error("Another Blender compilation holds the durable job lease");
    throw error;
  }
  let sequence = 0;
  return {
    record: async (state: string, data: unknown) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(state))
        throw new Error("Blender job event state is invalid");
      const event = {
        kind: "BlenderCompilationJobEvent",
        abi: BLENDER_COMPILER_ABI,
        invocationHash,
        sequence,
        state,
        data,
        processId: process.pid,
        occurredAt: new Date().toISOString(),
      };
      const path = join(job, `${String(sequence).padStart(4, "0")}-${state}.json`);
      sequence += 1;
      await writeFile(path, `${stableJson(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    },
    release: async () => {
      await lease.close();
      await unlink(leasePath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    },
  };
}

async function stageSources(
  spec: BlenderSceneSpec,
  supplied: readonly BlenderSourceInput[],
  allowedRoots: readonly string[],
  destination: string,
): Promise<
  { status: "eligible" } | { status: "rejected"; code: "invalid_source_asset"; detail: string }
> {
  try {
    const suppliedById = new Map(supplied.map((entry) => [entry.sourceId, entry]));
    if (suppliedById.size !== supplied.length) throw new Error("Duplicate supplied source ID");
    const required = spec.sources;
    if (required.length !== supplied.length)
      throw new Error("Supplied source inventory does not match scene sources");
    const canonicalRoots = await Promise.all(
      allowedRoots.map(async (root) => {
        if (!isAbsolute(root)) throw new Error("Allowed source root must be absolute");
        const info = await lstat(root);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Allowed source root is unsafe");
        return realpath(root);
      }),
    );
    for (const source of required) {
      const suppliedSource = suppliedById.get(source.id);
      if (!suppliedSource) throw new Error(`Missing source bytes: ${source.id}`);
      const canonicalPath = await assertSafeSourcePath(suppliedSource.path, canonicalRoots);
      const bytes = await readBoundedFile(canonicalPath, source.bytes);
      if (bytes.byteLength !== source.bytes || sha256(bytes) !== source.sha256)
        throw new Error(`Source hash or byte length mismatch: ${source.id}`);
      const geometryUse = spec.geometries.some(
        (entry) => entry.kind === "external_glb" && entry.sourceId === source.id,
      );
      const textureUses = spec.textures.filter((entry) => entry.sourceId === source.id);
      if (geometryUse && textureUses.length)
        throw new Error(`Source cannot be both GLB geometry and a texture: ${source.id}`);
      if (geometryUse) {
        inspectGlb(bytes, { maximumBytes: source.bytes });
        await writeFile(join(destination, `${source.id}.glb`), bytes, {
          mode: 0o600,
          flag: "wx",
        });
      } else if (textureUses.length) {
        const mediaTypes = new Set(textureUses.map((entry) => entry.mediaType));
        if (mediaTypes.size !== 1)
          throw new Error(`Texture source has conflicting media types: ${source.id}`);
        const texture = textureUses[0]!;
        const inspected = inspectTextureImage(
          bytes,
          texture.mediaType,
          spec.budgets.maximumTexturePixels,
        );
        if (
          inspected.sha256 !== texture.sha256 ||
          inspected.width !== texture.width ||
          inspected.height !== texture.height
        )
          throw new Error(`Texture inspection differs from its declaration: ${texture.id}`);
        const extension = texture.mediaType === "image/png" ? "png" : "jpg";
        await writeFile(join(destination, `${source.id}.${extension}`), bytes, {
          mode: 0o600,
          flag: "wx",
        });
      } else {
        throw new Error(`Source is not referenced by geometry or texture: ${source.id}`);
      }
    }
    return { status: "eligible" };
  } catch (error: unknown) {
    return { status: "rejected", code: "invalid_source_asset", detail: detail(error) };
  }
}

function validateRepairCompilation(
  spec: BlenderSceneSpec,
  input: CompileBlenderSceneInput["repair"],
): RepairCompilationContext | undefined {
  if (!input) return undefined;
  const { plan, parentBundle } = input;
  const { hash: _planHash, ...planMaterial } = plan ?? ({} as SceneRepairPlan);
  if (
    !plan ||
    plan.kind !== "SceneRepairPlan" ||
    !/^[a-f0-9]{64}$/.test(plan.hash) ||
    contentHash(stableJson(planMaterial)) !== plan.hash
  )
    throw new Error("Repair compilation plan identity is invalid");
  const next = blenderSceneSpecHandle(spec);
  if (plan.nextSceneHash !== next.hash)
    throw new Error("Repair compilation plan does not bind the next scene");
  if (
    !parentBundle ||
    parentBundle.kind !== "CompiledSceneBundle" ||
    stableJson(parentBundle.manifest.scene) !== stableJson(plan.parent)
  )
    throw new Error("Repair compilation parent bundle does not bind the repair parent");
  const { hash: _manifestHash, ...manifestMaterial } = parentBundle.manifest;
  if (contentHash(stableJson(manifestMaterial)) !== parentBundle.manifest.hash)
    throw new Error("Repair compilation parent manifest identity is invalid");
  const allPartitions = spec.partitions.map((entry) => entry.id).sort();
  const affectedPartitions = [...plan.affectedPartitionIds].sort();
  const reusedPartitionIds = [...plan.reusedPartitionIds].sort();
  if (
    new Set([...affectedPartitions, ...reusedPartitionIds]).size !== allPartitions.length ||
    stableJson([...affectedPartitions, ...reusedPartitionIds].sort()) !== stableJson(allPartitions)
  )
    throw new Error("Repair compilation partition scope is incomplete or overlapping");
  const viewIds = new Set(spec.reviewViews.map((entry) => entry.id));
  if (plan.affectedViewIds.some((id) => !viewIds.has(id)))
    throw new Error("Repair compilation names an unknown affected review view");
  const affectedViews = new Set(plan.affectedViewIds);
  const reusedViewIds = [...viewIds].filter((id) => !affectedViews.has(id)).sort();
  return { plan, parentBundle, reusedPartitionIds, reusedViewIds };
}

function parentArtifactForReuse(
  repair: RepairCompilationContext,
  declaration: BlenderSceneSpec["expectedOutputs"][number],
): { output: SceneBundleOutput; artifact: BinaryArtifactReference } {
  const entry = repair.parentBundle.artifacts.find((item) => item.output.id === declaration.id);
  if (!entry) throw new Error(`Repair parent lacks reusable output: ${declaration.id}`);
  if (
    entry.output.kind !== declaration.kind ||
    entry.output.relativePath !== declaration.relativePath ||
    entry.output.partitionId !== declaration.partitionId ||
    entry.output.viewId !== declaration.viewId ||
    entry.output.artifactHash !== entry.artifact.artifactHash ||
    entry.output.bytes !== entry.artifact.bytes ||
    entry.output.mediaType !== entry.artifact.mediaType
  )
    throw new Error(`Repair parent reusable output identity changed: ${declaration.id}`);
  return entry;
}

async function readGeneratedOutput(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const path = resolve(root, relativePath);
  assertInside(root, path);
  return readBoundedFile(path, maximumBytes);
}

async function retainOutputs(input: {
  spec: BlenderSceneSpec;
  installationHash: string;
  invocationHash: string;
  outputDirectory: string;
  binaryStore: ImmutableBinaryArtifactStore;
  policy: BlenderCompilerPolicy;
  repair?: RepairCompilationContext;
}): Promise<BlenderCompileResult> {
  try {
    const expected = input.spec.expectedOutputs.filter(
      (entry): entry is typeof entry & { kind: Exclude<typeof entry.kind, "manifest"> } =>
        entry.kind !== "manifest",
    );
    const reused = new Map<string, (typeof expected)[number]>();
    for (const declaration of expected)
      if (
        (declaration.kind === "glb" &&
          input.repair?.reusedPartitionIds.includes(declaration.partitionId!)) ||
        (declaration.kind === "review_render" &&
          input.repair?.reusedViewIds.includes(declaration.viewId!))
      )
        reused.set(declaration.id, declaration);
    const generated = expected.filter((entry) => !reused.has(entry.id));
    const actual = await listFiles(input.outputDirectory, input.policy.maximumOutputFiles);
    const expectedPaths = generated.map((entry) => entry.relativePath).sort();
    if (stableJson(actual) !== stableJson(expectedPaths))
      throw new Error(
        `Compiler output inventory mismatch: expected ${expectedPaths.join(", ")}; found ${actual.join(", ")}`,
      );
    let totalBytes = 0;
    const outputs: SceneBundleOutput[] = [];
    const artifacts: Array<{ output: SceneBundleOutput; artifact: BinaryArtifactReference }> = [];
    const glbReports: GlbInspectionReport[] = [];
    const measuredSceneBounds: Array<{
      stableId: string;
      sourceObjectId?: string;
      bounds: SceneBounds;
    }> = [];
    let geometryReport: z.infer<typeof geometryReportSchema> | undefined;
    let materialReport: z.infer<typeof materialReportSchema> | undefined;
    let budgetReport: z.infer<typeof budgetReportSchema> | undefined;
    let nativeSemantics: unknown;
    for (const declaration of expected) {
      const parent = reused.has(declaration.id)
        ? parentArtifactForReuse(input.repair!, declaration)
        : undefined;
      const bytes = parent
        ? await input.binaryStore.read(parent.artifact)
        : await readGeneratedOutput(
            input.outputDirectory,
            declaration.relativePath,
            input.policy.maximumOutputBytes,
          );
      totalBytes += bytes.byteLength;
      if (totalBytes > input.policy.maximumOutputBytes)
        throw new Error("Compiler aggregate output budget exceeded");
      const mediaType = mediaTypeFor(declaration.kind);
      if (declaration.kind === "glb") {
        const partition = input.spec.partitions.find(
          (entry) => entry.id === declaration.partitionId,
        )!;
        const members = compiledPartitionMembers(input.spec, partition.id);
        const report = inspectGlb(bytes, {
          maximumBytes: input.spec.budgets.maximumGlbBytes,
          maximumTriangles: input.spec.budgets.maximumTriangles,
          maximumTrianglesPerMesh: input.spec.budgets.maximumTrianglesPerMesh,
          maximumMaterials: input.spec.budgets.maximumMaterials,
          maximumTextures: input.spec.budgets.maximumTextures,
          maximumTexturePixels: input.spec.budgets.maximumTexturePixels,
          expectedNodeNames: members.map((entry) => entry.exportName),
        });
        assertMeasuredPartitionEnvelopes(report, members, partition.localOrigin);
        const nodes = new Map(report.nodes.map((entry) => [entry.name, entry]));
        for (const member of members) {
          const measured = nodes.get(member.exportName)!.bounds!;
          measuredSceneBounds.push({
            stableId: member.stableId,
            ...(member.sourceObjectId ? { sourceObjectId: member.sourceObjectId } : {}),
            bounds: {
              center: {
                x: (measured.minimum[0] + measured.maximum[0]) / 2 + partition.localOrigin.x,
                y: (measured.minimum[1] + measured.maximum[1]) / 2 + partition.localOrigin.y,
                z: (measured.minimum[2] + measured.maximum[2]) / 2 + partition.localOrigin.z,
              },
              size: {
                x: measured.maximum[0] - measured.minimum[0],
                y: measured.maximum[1] - measured.minimum[1],
                z: measured.maximum[2] - measured.minimum[2],
              },
            },
          });
        }
        glbReports.push(report);
      } else if (declaration.kind === "review_render") {
        const inspected = inspectVisualPng({
          mimeType: "image/png",
          base64: Buffer.from(bytes).toString("base64"),
        });
        const view = input.spec.reviewViews.find((entry) => entry.id === declaration.viewId)!;
        if (inspected.width !== view.width || inspected.height !== view.height)
          throw new Error(`Review render dimensions differ from view ${view.id}`);
      } else if (declaration.kind === "blend") {
        if (
          bytes.byteLength < 16 ||
          new TextDecoder("ascii").decode(bytes.subarray(0, 16)) !== "BLENDER17-01v050"
        )
          throw new Error("Retained .blend is not an uncompressed Blender 5.2.1 file");
      } else {
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
        if (declaration.kind === "geometry_report")
          geometryReport = geometryReportSchema.parse(parsed);
        else if (declaration.kind === "material_report")
          materialReport = materialReportSchema.parse(parsed);
        else if (declaration.kind === "budget_report")
          budgetReport = budgetReportSchema.parse(parsed);
        else if (declaration.kind === "native_semantics") nativeSemantics = parsed;
      }
      const artifact = parent?.artifact ?? (await input.binaryStore.write(bytes, mediaType));
      const output = {
        ...declaration,
        artifactHash: artifact.artifactHash,
        bytes: artifact.bytes,
        mediaType,
      };
      outputs.push(output);
      artifacts.push({ output, artifact });
    }
    outputs.sort((a, b) => a.id.localeCompare(b.id));
    glbReports.sort((a, b) => a.hash.localeCompare(b.hash));
    assertCompilerReports(
      input.spec,
      glbReports,
      geometryReport,
      materialReport,
      budgetReport,
      nativeSemantics,
    );
    const resolvedDiagnostics = validateResolvedScene(input.spec);
    if (resolvedDiagnostics.length)
      throw new Error(
        `Compiled scene failed resolved constraints: ${resolvedDiagnostics
          .map((entry) => `${entry.code}:${entry.subject}`)
          .join(", ")}`,
      );
    const measuredDiagnostics = validateMeasuredScene(input.spec, measuredSceneBounds);
    if (measuredDiagnostics.length)
      throw new Error(
        `Compiled measured geometry failed constraints: ${measuredDiagnostics
          .map((entry) => `${entry.code}:${entry.subject}`)
          .join(", ")}`,
      );
    const scene = blenderSceneSpecHandle(input.spec);
    const repairDelta = input.repair
      ? await retainSceneRepairDelta({
          scene,
          spec: input.spec,
          repair: input.repair,
          artifacts,
          reusedOutputIds: [...reused.keys()],
          binaryStore: input.binaryStore,
        })
      : undefined;
    const manifestMaterial = {
      kind: "SceneBundleManifest" as const,
      abi: BLENDER_COMPILER_ABI as typeof BLENDER_COMPILER_ABI,
      id: `scene_bundle_${scene.hash.slice(0, 24)}`,
      scene,
      compilerInstallationHash: input.installationHash,
      invocationHash: input.invocationHash,
      coordinateProfile: {
        scene: "roblox-y-up-studs" as const,
        blenderMapping: "x,-z,y" as const,
        export: BLENDER_EXPORT_PROFILE as typeof BLENDER_EXPORT_PROFILE,
      },
      outputs,
      glbReports,
      objectInventory: input.spec.partitions.flatMap((partition) =>
        compiledPartitionMembers(input.spec, partition.id).map(
          ({ bounds: _bounds, transform: _transform, ...entry }) => entry,
        ),
      ),
      partitionInventory: input.spec.partitions.map((partition) => ({
        id: partition.id,
        role: partition.role,
        outputIds: outputs
          .filter((entry) => entry.partitionId === partition.id)
          .map((entry) => entry.id),
      })),
      sourceHashes: input.spec.sources.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      ...(repairDelta ? { repairDeltaHash: repairDelta.delta.hash } : {}),
      generatedAt: new Date().toISOString(),
    };
    const manifest: SceneBundleManifest = {
      ...manifestMaterial,
      hash: contentHash(stableJson(manifestMaterial)),
    };
    const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`);
    const manifestArtifact = await input.binaryStore.write(manifestBytes, "application/json");
    return {
      status: "eligible",
      bundle: {
        kind: "CompiledSceneBundle",
        manifest,
        manifestArtifact,
        artifacts,
        ...(repairDelta ? { repairDelta } : {}),
      },
    };
  } catch (error: unknown) {
    return {
      status: "incomplete",
      code: "malformed_output",
      detail: detail(error),
      invocationHash: input.invocationHash,
    };
  }
}

async function retainSceneRepairDelta(input: {
  scene: ReturnType<typeof blenderSceneSpecHandle>;
  spec: BlenderSceneSpec;
  repair: RepairCompilationContext;
  artifacts: Array<{ output: SceneBundleOutput; artifact: BinaryArtifactReference }>;
  reusedOutputIds: readonly string[];
  binaryStore: ImmutableBinaryArtifactStore;
}): Promise<{ delta: SceneRepairDelta; artifact: BinaryArtifactReference }> {
  const changedPartitions = new Set(input.repair.plan.affectedPartitionIds);
  const changedVisualStableIds = input.spec.partitions
    .filter((partition) => changedPartitions.has(partition.id))
    .flatMap((partition) =>
      compiledPartitionMembers(input.spec, partition.id).map((entry) => entry.stableId),
    );
  const nativeIds = [
    ...input.spec.collisionProxies.map((entry) => entry.id),
    ...input.spec.gameplayAnchors.map((entry) => entry.id),
    ...input.spec.interactiveProps.map((entry) => entry.id),
    ...input.spec.effects.map((entry) => entry.id),
    ...input.spec.sockets.map((entry) => entry.id),
  ];
  const changedNative = new Set(input.repair.plan.affectedNativeIds);
  const material = {
    kind: "SceneRepairDelta" as const,
    abi: BLENDER_COMPILER_ABI as typeof BLENDER_COMPILER_ABI,
    id: `scene_repair_delta_${input.scene.hash.slice(0, 24)}`,
    parentScene: input.repair.plan.parent,
    nextScene: input.scene,
    repairPlanHash: input.repair.plan.hash,
    changedVisualStableIds: [...new Set(changedVisualStableIds)].sort(),
    changedNativeStableIds: [...changedNative].sort(),
    changedPartitionIds: [...changedPartitions].sort(),
    changedViewIds: [...input.repair.plan.affectedViewIds].sort(),
    preservedNativeStableIds: [...new Set(nativeIds)].filter((id) => !changedNative.has(id)).sort(),
    neighboringInterfaceIds: [...input.repair.plan.neighboringInterfaceIds].sort(),
    reusedArtifacts: input.artifacts
      .filter((entry) => input.reusedOutputIds.includes(entry.output.id))
      .map((entry) => ({
        outputId: entry.output.id,
        artifactHash: entry.artifact.artifactHash,
        bytes: entry.artifact.bytes,
        mediaType: entry.artifact.mediaType,
      }))
      .sort((left, right) => left.outputId.localeCompare(right.outputId)),
  };
  const delta: SceneRepairDelta = { ...material, hash: contentHash(stableJson(material)) };
  const artifact = await input.binaryStore.write(
    Buffer.from(`${stableJson(delta)}\n`),
    "application/json",
  );
  return { delta, artifact };
}

function assertCompilerReports(
  spec: BlenderSceneSpec,
  glbReports: readonly GlbInspectionReport[],
  geometry: z.infer<typeof geometryReportSchema> | undefined,
  materials: z.infer<typeof materialReportSchema> | undefined,
  budget: z.infer<typeof budgetReportSchema> | undefined,
  nativeSemantics: unknown,
): void {
  if (!geometry || !materials || !budget || nativeSemantics === undefined)
    throw new Error("Compiler report inventory is incomplete");
  for (const report of [geometry, materials, budget])
    if (report.sceneId !== spec.sceneId || report.revision !== spec.revision)
      throw new Error("Compiler report scene binding mismatch");
  const expectedMembers = spec.partitions
    .flatMap((partition) => compiledPartitionMembers(spec, partition.id))
    .map((entry) => ({ stableId: entry.stableId, exportName: entry.exportName }))
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  const measuredMembers = geometry.objects
    .map((entry) => ({ stableId: entry.stableId, exportName: entry.exportName }))
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  if (
    new Set(geometry.objects.map((entry) => entry.stableId)).size !== geometry.objects.length ||
    stableJson(measuredMembers) !== stableJson(expectedMembers)
  )
    throw new Error("Geometry report inventory differs from the scene");
  const glbNodes = new Map(
    glbReports.flatMap((report) =>
      report.nodes
        .filter((node) => node.meshIndex !== undefined)
        .map((node) => [node.name, node] as const),
    ),
  );
  for (const row of geometry.objects) {
    const measured = glbNodes.get(row.exportName);
    if (!measured || measured.triangleCount !== row.triangles)
      throw new Error(`Geometry report differs from GLB measurement: ${row.stableId}`);
    if (row.blenderBounds.minimum.some((value, axis) => value > row.blenderBounds.maximum[axis]!))
      throw new Error(`Geometry report has inverted bounds: ${row.stableId}`);
  }
  const expectedMaterials = spec.materials
    .map((entry) => ({
      id: entry.id,
      textureIds: [...entry.textureIds],
      alphaMode: entry.alphaMode,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actualMaterials = [...materials.materials].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (
    new Set(actualMaterials.map((entry) => entry.id)).size !== actualMaterials.length ||
    stableJson(actualMaterials) !== stableJson(expectedMaterials)
  )
    throw new Error("Material report differs from the scene");
  const aggregateTriangles = glbReports.reduce((sum, report) => sum + report.triangleCount, 0);
  const aggregateMaterials = glbReports.reduce((sum, report) => sum + report.materialCount, 0);
  const aggregateTextures = glbReports.reduce((sum, report) => sum + report.textureCount, 0);
  if (
    aggregateTriangles > spec.budgets.maximumTriangles ||
    aggregateMaterials > spec.budgets.maximumMaterials ||
    aggregateTextures > spec.budgets.maximumTextures
  )
    throw new Error("Compiled GLB aggregate budget exceeded");
  if (
    budget.objects !== spec.objects.length ||
    budget.expandedInstances !==
      spec.instances.reduce((sum, entry) => sum + entry.transforms.length, 0) ||
    budget.triangles !== aggregateTriangles ||
    stableJson(budget.limits) !== stableJson(spec.budgets)
  )
    throw new Error("Budget report differs from independent measurements");
  const expectedNative = {
    kind: "ForgeNativeSceneSemantics",
    sceneId: spec.sceneId,
    revision: spec.revision,
    coordinateProfile: { scene: "roblox-y-up-studs", blenderMapping: "x,-z,y" },
    partitions: spec.partitions,
    collisionProxies: spec.collisionProxies,
    gameplayAnchors: spec.gameplayAnchors,
    interactiveProps: spec.interactiveProps,
    effects: spec.effects,
    sockets: spec.sockets,
    routes: spec.routes,
  };
  if (stableJson(nativeSemantics) !== stableJson(expectedNative))
    throw new Error("Native semantics report differs from host-derived scene data");
}

function assertBlendInspection(
  spec: BlenderSceneSpec,
  report: z.infer<typeof blendInspectionSchema>,
): void {
  if (report.sceneId !== spec.sceneId || report.revision !== spec.revision)
    throw new Error("Retained .blend inspection scene binding mismatch");
  const expected = spec.partitions
    .flatMap((partition) => compiledPartitionMembers(spec, partition.id))
    .map((entry) => ({
      stableId: entry.stableId,
      name: entry.exportName,
      partitionId: entry.partitionId,
    }))
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  const actual = report.objects
    .map(({ meshVertices: _vertices, meshPolygons: _polygons, ...entry }) => entry)
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  if (
    new Set(actual.map((entry) => entry.stableId)).size !== actual.length ||
    stableJson(actual) !== stableJson(expected)
  )
    throw new Error("Retained .blend inspection inventory mismatch");
}

function exportName(id: string): string {
  return `Forge_${id}_${contentHash(id).slice(0, 10)}`;
}

interface CompiledPartitionMember {
  stableId: string;
  exportName: string;
  partitionId: string;
  sourceObjectId?: string;
  instanceIndex?: number;
  bounds: SceneBounds;
  transform: SceneTransform;
}

function compiledPartitionMembers(
  spec: BlenderSceneSpec,
  partitionId: string,
): CompiledPartitionMember[] {
  const objects = new Map(spec.objects.map((entry) => [entry.id, entry]));
  const members: CompiledPartitionMember[] = spec.objects
    .filter((entry) => entry.partitionId === partitionId)
    .map((entry) => ({
      stableId: entry.id,
      exportName: exportName(entry.id),
      partitionId,
      bounds: entry.localBounds,
      transform: entry.transform,
    }));
  for (const instance of spec.instances.filter((entry) => entry.partitionId === partitionId)) {
    const source = objects.get(instance.sourceObjectId);
    if (!source) throw new Error(`Compiled instance source is missing: ${instance.id}`);
    instance.transforms.forEach((transform, instanceIndex) => {
      const stableId = `${instance.id}_${instanceIndex.toString().padStart(4, "0")}`;
      members.push({
        stableId,
        exportName: exportName(stableId),
        partitionId,
        sourceObjectId: source.id,
        instanceIndex,
        bounds: source.localBounds,
        transform,
      });
    });
  }
  return members.sort((left, right) => left.stableId.localeCompare(right.stableId));
}

function assertMeasuredPartitionEnvelopes(
  report: GlbInspectionReport,
  members: readonly CompiledPartitionMember[],
  localOrigin: { x: number; y: number; z: number },
): void {
  const nodes = new Map(report.nodes.map((entry) => [entry.name, entry]));
  const tolerance = 1e-3;
  for (const member of members) {
    const measured = nodes.get(member.exportName)?.bounds;
    if (!measured) throw new Error(`Compiled GLB lacks measured bounds: ${member.exportName}`);
    const expected = worldAxisAlignedBounds(member.bounds, member.transform, localOrigin);
    for (let axis = 0; axis < 3; axis += 1)
      if (
        measured.minimum[axis]! < expected.minimum[axis]! - tolerance ||
        measured.maximum[axis]! > expected.maximum[axis]! + tolerance
      )
        throw new Error(
          `Compiled GLB exceeds its admitted envelope: ${member.exportName}; measured=${stableJson(measured)}; expected=${stableJson(expected)}`,
        );
  }
}

function worldAxisAlignedBounds(
  bounds: SceneBounds,
  transform: SceneTransform,
  localOrigin: { x: number; y: number; z: number },
): {
  minimum: [number, number, number];
  maximum: [number, number, number];
} {
  const rotation = sceneEulerXyz({
    x: transform.rotation.xDegrees,
    y: transform.rotation.yDegrees,
    z: transform.rotation.zDegrees,
  });
  const scaledCenter = {
    x: bounds.center.x * transform.scale.x,
    y: bounds.center.y * transform.scale.y,
    z: bounds.center.z * transform.scale.z,
  };
  const centerOffset = sceneTransformVector(rotation, scaledCenter);
  const center = [
    transform.position.x + centerOffset.x - localOrigin.x,
    transform.position.y + centerOffset.y - localOrigin.y,
    transform.position.z + centerOffset.z - localOrigin.z,
  ] as const;
  const half = sceneHalfExtents(rotation, {
    x: bounds.size.x * transform.scale.x,
    y: bounds.size.y * transform.scale.y,
    z: bounds.size.z * transform.scale.z,
  });
  return {
    minimum: [center[0] - half.x, center[1] - half.y, center[2] - half.z],
    maximum: [center[0] + half.x, center[1] + half.y, center[2] + half.z],
  };
}

async function workerIdentity(): Promise<{ path: string; hash: string }> {
  const path = resolve(import.meta.dirname, "../../../workers/blender/worker.py");
  const bytes = await readFile(path);
  return { path, hash: sha256(bytes) };
}

async function blendInspectorIdentity(): Promise<{ path: string; hash: string }> {
  const path = resolve(import.meta.dirname, "../../../workers/blender/inspect_blend.py");
  const bytes = await readFile(path);
  return { path, hash: sha256(bytes) };
}

async function assertSafeSourcePath(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Source path must be absolute");
  const absolute = resolve(path);
  const root = roots.find((candidate) => isWithin(candidate, absolute));
  if (!root) throw new Error("Source path is outside declared roots");
  const fromRoot = relative(root, absolute);
  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Source path contains a symbolic link");
  }
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error("Source path is not a regular file");
  return absolute;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file");
    if (info.size <= 0 || info.size > maximumBytes)
      throw new Error("File exceeds its admitted byte range");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    if (
      bytes.byteLength !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ino !== info.ino ||
      bytes.byteLength > maximumBytes
    )
      throw new Error("File changed while it was being read");
    return bytes;
  } finally {
    await descriptor.close();
  }
}

async function listFiles(root: string, maximum: number): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Compiler output contains a symbolic link");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
      else throw new Error("Compiler output contains a non-file entry");
      if (result.length > maximum) throw new Error("Compiler output file budget exceeded");
    }
  };
  await visit(root);
  return result.sort();
}

class ProcessFailure extends Error {
  constructor(
    readonly code: "timeout" | "log_limit",
    detailText: string,
  ) {
    super(detailText);
  }
}

async function runIsolatedBlender(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maximumLogBytes: number,
  cwd: string,
  additionalReadFiles: readonly string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (process.platform !== "darwin")
    throw new ProcessFailure("log_limit", "Qualified Blender execution requires macOS Seatbelt");
  const interpreter = await shebangInterpreter(executable);
  const applicationRoot = resolve(dirname(executable), "../../..");
  const readableFiles = await Promise.all(
    additionalReadFiles.map(async (path) => {
      if (!isAbsolute(path)) throw new Error("Qualified Blender read path must be absolute");
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Qualified Blender read path must be a regular file");
      return realpath(path);
    }),
  );
  const quoted = (value: string): string =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const readable = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/private",
    "/dev",
    applicationRoot,
    ...(interpreter ? [dirname(interpreter)] : []),
    cwd,
  ];
  const executableRules = [executable, ...(interpreter ? [interpreter] : [])]
    .map((path) => `(literal ${quoted(path)})`)
    .join(" ");
  const profile = [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(allow signal)",
    `(allow process-exec ${executableRules})`,
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc*)",
    "(allow iokit*)",
    `(deny file-read-data ${[
      join(homedir(), ".ssh"),
      join(homedir(), ".aws"),
      join(homedir(), ".config"),
      join(homedir(), "Library", "Keychains"),
    ]
      .map((path) => `(subpath ${quoted(path)})`)
      .join(" ")})`,
    `(allow file-read* (literal "/") ${readableFiles
      .map((path) => `(literal ${quoted(path)})`)
      .join(" ")} ${readable.map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
    `(allow file-write* (subpath ${quoted(cwd)}))`,
    "(allow file-write-data (require-not (vnode-type REGULAR-FILE)))",
    "(allow file-ioctl)",
  ].join("\n");
  const profilePath = join(
    cwd,
    `forge-blender-${sha256(Buffer.from(profile, "utf8")).slice(0, 16)}.sb`,
  );
  await writeFile(profilePath, `${profile}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(
    async (error: unknown) => {
      if (!isNodeError(error, "EEXIST")) throw error;
      if ((await readFile(profilePath, "utf8")) !== `${profile}\n`)
        throw new Error("Seatbelt profile changed within one compiler job");
    },
  );
  return runProcess(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, executable, ...args],
    timeoutMs,
    maximumLogBytes,
    cwd,
  );
}

async function shebangInterpreter(path: string): Promise<string | undefined> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(512);
    const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
    const firstLine = bytes.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!;
    if (!firstLine.startsWith("#!")) return undefined;
    const candidate = firstLine.slice(2).trim().split(/\s+/, 1)[0];
    return candidate && isAbsolute(candidate) ? candidate : undefined;
  } finally {
    await descriptor.close();
  }
}

async function runProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maximumLogBytes: number,
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: cwd ?? "/var/empty",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: cwd ?? tmpdir(),
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let logBytes = 0;
    let settled = false;
    let pendingFailure: ProcessFailure | undefined;
    const terminate = (): void => {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      if (settled) return;
      pendingFailure = new ProcessFailure("timeout", "Blender process exceeded its deadline");
      terminate();
    }, timeoutMs);
    const receive = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      logBytes += chunk.byteLength;
      if (logBytes > maximumLogBytes && !pendingFailure) {
        pendingFailure = new ProcessFailure(
          "log_limit",
          "Blender process exceeded its log allowance",
        );
        clearTimeout(timer);
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingFailure) reject(pendingFailure);
      else
        accept({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: [
            Buffer.concat(stderr).toString("utf8"),
            ...(signal === null ? [] : [`Process terminated by signal ${signal}`]),
          ]
            .filter(Boolean)
            .join("\n"),
        });
    });
  });
}

function mediaTypeFor(kind: SceneBundleOutput["kind"]): string {
  switch (kind) {
    case "blend":
      return "application/x-blender";
    case "glb":
      return "model/gltf-binary";
    case "review_render":
      return "image/png";
    default:
      return "application/json";
  }
}
function assertInside(root: string, path: string): void {
  if (!isWithin(root, path)) throw new Error("Compiler output path escapes its root");
}
function isWithin(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function boundedDetail(value: string): string {
  return value.trim().slice(0, 4096) || "Blender compiler failed without a diagnostic";
}
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
