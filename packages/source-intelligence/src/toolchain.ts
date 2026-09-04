import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  type SourceDocumentInput,
  type SourceDocumentDescriptor,
  type StudioSourceIndex,
  type VerifiedSourceResolver,
  type SourceLocation,
  type SourceReference,
  type StudioSourceSymbol,
} from "./index.js";

/**
 * The only releases production source analysis may execute.  The JSON lock
 * carries GitHub's release-asset digest and size, not a mutable PATH lookup.
 */
export const OFFICIAL_SOURCE_ANALYSIS_TOOLCHAIN_LOCK_HASH =
  "49699a17a8536fc02448fcc4516d9b0affccf07fdce458f7074d3b37eb1597a2";

export type SourceAnalysisPlatform =
  "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-arm64" | "win32-x64";

export interface SourceAnalysisToolAsset {
  readonly platforms: readonly SourceAnalysisPlatform[];
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The sole regular file extracted from the signed release asset. */
  readonly binary: string;
}

export interface SourceAnalysisToolLock {
  readonly name: "rojo" | "luau-lsp";
  readonly version: string;
  readonly repository: string;
  readonly releaseTag: string;
  readonly githubApiRelease: string;
  readonly assets: readonly SourceAnalysisToolAsset[];
}

export interface SourceAnalysisToolchainLock {
  readonly kind: "ForgeSourceAnalysisToolchainLock";
  readonly version: 1;
  readonly tools: readonly SourceAnalysisToolLock[];
}

export interface VerifiedPinnedSourceAnalysisTool {
  readonly name: "rojo" | "luau-lsp";
  readonly version: string;
  readonly asset: SourceAnalysisToolAsset;
  /** Absolute local path. This is host state and is never copied to an artifact. */
  readonly executable: string;
  readonly binaryHash: string;
  readonly binaryBytes: number;
}

/** A runtime-only proof that binaries came from the exact locked release assets. */
export interface VerifiedPinnedSourceAnalysisToolchain {
  readonly kind: "VerifiedPinnedSourceAnalysisToolchain";
  readonly id: string;
  readonly hash: string;
  readonly authority: "pinned_official_release";
  readonly lockHash: string;
  readonly platform: SourceAnalysisPlatform;
  readonly tools: readonly VerifiedPinnedSourceAnalysisTool[];
}

export interface PinnedSourceAnalysisToolchainProof {
  readonly kind: "PinnedSourceAnalysisToolchainProof";
  readonly hash: string;
  readonly lockHash: string;
  readonly platform: SourceAnalysisPlatform;
  readonly tools: readonly {
    readonly name: "rojo" | "luau-lsp";
    readonly version: string;
    readonly assetName: string;
    readonly assetHash: string;
    readonly assetBytes: number;
    readonly binaryHash: string;
    readonly binaryBytes: number;
  }[];
}

export interface PinnedSourceAnalysisArtifact {
  readonly kind: "PinnedSourceAnalysisArtifact";
  readonly id: string;
  readonly hash: string;
  readonly authority: "pinned_official_toolchain";
  readonly sourceIndexId: string;
  readonly sourceIndexHash: string;
  readonly sourceSnapshotHash: string;
  readonly toolchain: PinnedSourceAnalysisToolchainProof;
  readonly executions: readonly {
    readonly tool: "rojo" | "luau-lsp";
    readonly commandHash: string;
    readonly exitCode: number;
    readonly stdoutHash: string;
    readonly stderrHash: string;
  }[];
}

export interface PinnedSourceAnalysisResult {
  readonly status: "complete";
  readonly index: StudioSourceIndex;
  readonly artifact: PinnedSourceAnalysisArtifact;
}

/** No production semantic artifact exists when LSP does not complete honestly. */
export interface IncompletePinnedSourceAnalysisResult {
  readonly status: "incomplete";
  readonly code: "source_analysis_resource_exhausted" | "source_analysis_failed";
  readonly reason: string;
}

export type PinnedSourceAnalysisOutcome =
  PinnedSourceAnalysisResult | IncompletePinnedSourceAnalysisResult;

const LSP_REQUEST_TIMEOUT_MS = 5_000;
const LSP_SESSION_TIMEOUT_MS = 30_000;
const LSP_MAX_MESSAGE_BYTES = 1_048_576;
// Whole-project collection bounds are separate from 200-row query pages.
const LSP_MAX_SYMBOLS = 16_384;
const LSP_MAX_REFERENCES_PER_SYMBOL = 4_096;
const LSP_MAX_REFERENCE_ROWS = 65_536;

/**
 * Hard host-side admission limits. These are intentionally tighter than the
 * complete project-index policy: LSP needs a private in-memory workspace and
 * must fail closed rather than making the control process memory-dependent.
 */
export const SOURCE_ANALYSIS_RESOURCE_BOUNDS = Object.freeze({
  maximumDocuments: 4_096,
  maximumDocumentUtf8Bytes: 512 * 1024,
  maximumAggregateUtf8Bytes: 32 * 1024 * 1024,
  maximumStaticDependencyRows: 16_384,
});

export interface SourceAnalysisResourceBounds {
  readonly maximumDocuments: number;
  readonly maximumDocumentUtf8Bytes: number;
  readonly maximumAggregateUtf8Bytes: number;
  readonly maximumStaticDependencyRows: number;
}

/** Production analysis takes source metadata and a lazy verified range reader. */
export interface PinnedSourceAnalysisInput {
  readonly snapshotHash: string;
  readonly documents: readonly SourceDocumentDescriptor[];
  readonly resolver: VerifiedSourceResolver;
  readonly bounds?: SourceAnalysisResourceBounds;
}

export interface InstallPinnedSourceAnalysisToolchainOptions {
  readonly root: string;
  readonly lock: SourceAnalysisToolchainLock;
  readonly platform?: SourceAnalysisPlatform;
  /** Test-only transport injection. Production uses the locked HTTPS URL. */
  readonly download?: (asset: SourceAnalysisToolAsset) => Promise<Buffer>;
  /** Test-only extractor injection. Production reads the exact named zip entry. */
  readonly extract?: (archive: string, asset: SourceAnalysisToolAsset) => Promise<Buffer>;
}

export interface VerifyPinnedSourceAnalysisToolchainOptions {
  readonly root: string;
  readonly lock: SourceAnalysisToolchainLock;
  readonly platform?: SourceAnalysisPlatform;
  /** Test-only extractor injection. */
  readonly extract?: (archive: string, asset: SourceAnalysisToolAsset) => Promise<Buffer>;
}

/**
 * Absence is the one recoverable toolchain state: the host may provision the
 * exact locked bytes. Integrity and path-safety failures deliberately use
 * ordinary errors so callers cannot turn tampering into an overwrite.
 */
export class PinnedSourceAnalysisToolchainMissingError extends Error {
  readonly code = "pinned_source_analysis_toolchain_missing";

  constructor(message: string) {
    super(message);
    this.name = "PinnedSourceAnalysisToolchainMissingError";
  }
}

/**
 * Installs only content-addressed release archives. Existing mismatch is an
 * integrity failure, never an invitation to overwrite a potentially tampered
 * executable. A concurrent installer can win only by installing the same
 * verified bytes through the atomic hard-link publication step.
 */
export async function installPinnedSourceAnalysisToolchain(
  input: InstallPinnedSourceAnalysisToolchainOptions,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  assertSourceAnalysisToolchainLock(input.lock);
  const platform = input.platform ?? currentPlatform();
  const directory = installationDirectory(input.root, input.lock, platform);
  await ensureSafeDirectory(directory, resolve(input.root));
  const download = input.download ?? downloadLockedAsset;
  const extract = input.extract ?? extractLockedBinary;

  for (const tool of orderedTools(input.lock)) {
    const asset = assetForPlatform(tool, platform);
    const archive = archivePath(directory, tool, asset);
    const archiveState = await verifiedArchiveState(archive, asset);
    if (archiveState === "missing") {
      const bytes = await download(asset);
      if (bytes.byteLength !== asset.bytes)
        throw new Error(`Downloaded ${tool.name} release asset size mismatch`);
      if (hashBytes(bytes) !== asset.sha256)
        throw new Error(`Downloaded ${tool.name} release asset SHA-256 mismatch`);
      await publishRegularFile(archive, bytes, 0o600, directory);
    }

    // Re-read after publication, including when another installer won the race.
    await assertVerifiedArchive(archive, asset);
    const expectedBinary = await extract(archive, asset);
    if (expectedBinary.byteLength === 0)
      throw new Error(`Pinned ${tool.name} release asset has an empty executable`);
    const executable = executablePath(directory, tool);
    const binaryState = await verifiedBinaryState(executable, expectedBinary);
    if (binaryState === "missing")
      await publishRegularFile(executable, expectedBinary, 0o700, directory);
    await assertVerifiedBinary(executable, expectedBinary);
    await chmod(executable, 0o700);
  }
  return assertPinnedSourceAnalysisToolchain({
    root: input.root,
    lock: input.lock,
    platform,
    extract,
  });
}

/** Validates a previously installed toolchain without consulting PATH or the network. */
export async function assertPinnedSourceAnalysisToolchain(
  input: VerifyPinnedSourceAnalysisToolchainOptions,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  assertSourceAnalysisToolchainLock(input.lock);
  const platform = input.platform ?? currentPlatform();
  const directory = installationDirectory(input.root, input.lock, platform);
  await assertSafeDirectory(directory, resolve(input.root));
  const extract = input.extract ?? extractLockedBinary;
  const tools: VerifiedPinnedSourceAnalysisTool[] = [];
  for (const tool of orderedTools(input.lock)) {
    const asset = assetForPlatform(tool, platform);
    const archive = archivePath(directory, tool, asset);
    await assertVerifiedArchive(archive, asset);
    const expectedBinary = await extract(archive, asset);
    if (expectedBinary.byteLength === 0)
      throw new Error(`Pinned ${tool.name} release asset has an empty executable`);
    const executable = executablePath(directory, tool);
    await assertVerifiedBinary(executable, expectedBinary);
    tools.push({
      name: tool.name,
      version: tool.version,
      asset,
      executable,
      binaryHash: hashBytes(expectedBinary),
      binaryBytes: expectedBinary.byteLength,
    });
  }
  const lockHash = contentHash(stableJson(input.lock));
  const payload = {
    authority: "pinned_official_release" as const,
    lockHash,
    platform,
    tools: tools.map(toolMaterial),
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "VerifiedPinnedSourceAnalysisToolchain",
    id: `pinned_source_analysis_toolchain_${hash.slice(0, 24)}`,
    hash,
    ...payload,
    tools,
  };
}

/**
 * Verifies an existing installation, or atomically provisions it when and
 * only when locked material is absent. A malformed directory, symlink,
 * unexpected archive, or hash mismatch remains a terminal integrity error.
 */
export async function ensurePinnedSourceAnalysisToolchain(
  input: InstallPinnedSourceAnalysisToolchainOptions,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  try {
    return await assertPinnedSourceAnalysisToolchain(input);
  } catch (error) {
    if (!(error instanceof PinnedSourceAnalysisToolchainMissingError)) throw error;
  }
  return installPinnedSourceAnalysisToolchain(input);
}

/** Reads the repository-owned lock and rejects edits that do not match the pinned release set. */
export async function readOfficialSourceAnalysisToolchainLock(): Promise<SourceAnalysisToolchainLock> {
  const path = resolve(
    process.cwd(),
    "packages/source-intelligence/source-analysis-toolchain.lock.json",
  );
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertSourceAnalysisToolchainLock(value);
  if (contentHash(stableJson(value)) !== OFFICIAL_SOURCE_ANALYSIS_TOOLCHAIN_LOCK_HASH)
    throw new Error(
      "Source analysis toolchain lock does not match the pinned official release set",
    );
  return value;
}

export async function setupOfficialSourceAnalysisToolchain(
  root: string,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  const lock = await readOfficialSourceAnalysisToolchainLock();
  return installPinnedSourceAnalysisToolchain({ root, lock });
}

/** Creator startup uses this boundary so a disposable `.forge` cache is not a manual prerequisite. */
export async function ensureOfficialSourceAnalysisToolchain(
  root: string,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  const lock = await readOfficialSourceAnalysisToolchainLock();
  return ensurePinnedSourceAnalysisToolchain({ root, lock });
}

export async function assertOfficialSourceAnalysisToolchain(
  root: string,
): Promise<VerifiedPinnedSourceAnalysisToolchain> {
  const lock = await readOfficialSourceAnalysisToolchainLock();
  return assertPinnedSourceAnalysisToolchain({ root, lock });
}

/**
 * Production-only host boundary. Construction verifies the two absolute
 * binaries before any source is staged. The deterministic navigation index
 * remains intentionally separate: it offers bounded document navigation while
 * this artifact proves that the pinned tools analyzed the same source hashes.
 */
export class PinnedSourceAnalysisHost {
  private constructor(private readonly toolchain: VerifiedPinnedSourceAnalysisToolchain) {}

  static async create(input: {
    readonly root: string;
    readonly lock?: SourceAnalysisToolchainLock;
    readonly platform?: SourceAnalysisPlatform;
  }): Promise<PinnedSourceAnalysisHost> {
    const toolchain = input.lock
      ? await assertPinnedSourceAnalysisToolchain({
          root: input.root,
          lock: input.lock,
          ...(input.platform ? { platform: input.platform } : {}),
        })
      : await assertOfficialSourceAnalysisToolchain(input.root);
    return new PinnedSourceAnalysisHost(toolchain);
  }

  proof(): PinnedSourceAnalysisToolchainProof {
    return toolchainProof(this.toolchain);
  }

  async analyze(input: PinnedSourceAnalysisInput): Promise<PinnedSourceAnalysisOutcome> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-pinned-source-analysis-"));
    try {
      const admitted = admitProductionSourceAnalysis(input);
      const staged = await stageSourceDocuments(admitted, temporaryRoot);
      const projectPath = join(temporaryRoot, "default.project.json");
      await writeFile(
        projectPath,
        stableJson({ name: "ForgePinnedSourceAnalysis", tree: staged.tree }),
        { encoding: "utf8", mode: 0o600 },
      );
      const sourcemapPath = join(temporaryRoot, "sourcemap.json");
      const rojo = this.requiredTool("rojo");
      const rojoRun = await runVerifiedBinary(
        rojo.executable,
        ["sourcemap", projectPath, "--output", sourcemapPath],
        temporaryRoot,
      );
      if (rojoRun.exitCode !== 0)
        return {
          status: "incomplete",
          code: "source_analysis_failed",
          reason: `Pinned Rojo sourcemap failed (exit ${rojoRun.exitCode}): ${rojoRun.stderr.toString("utf8").split(temporaryRoot).join("<private-source-workspace>").trim()}`,
        };
      // Rojo's source map can contain the private temporary workspace path.
      // Persist a stable redacted representation, never that host-local path.
      const sourcemapHash = await canonicalPrivateSourcemapHash(sourcemapPath, temporaryRoot);
      const lsp = this.requiredTool("luau-lsp");
      const semantic = await collectBoundedLuauLspSemantics(
        lsp.executable,
        temporaryRoot,
        staged.entries,
      );
      const toolchain = toolchainProof(this.toolchain);
      const index = createPinnedLuauLspSourceIndex(
        {
          snapshotHash: input.snapshotHash,
          documents: staged.documents,
        },
        semantic,
        {
          analysisConfigHash: contentHash(
            stableJson({
              toolchainProofHash: toolchain.hash,
              sourcemapHash,
              protocol: "lsp-stdio-document-symbol-references-v1",
              limits: {
                messageBytes: LSP_MAX_MESSAGE_BYTES,
                symbols: LSP_MAX_SYMBOLS,
                referencesPerSymbol: LSP_MAX_REFERENCES_PER_SYMBOL,
                referenceRows: LSP_MAX_REFERENCE_ROWS,
              },
              resourceBounds: admitted.bounds,
            }),
          ),
          pinnedToolchainProof: {
            hash: toolchain.hash,
            lockHash: toolchain.lockHash,
            platform: toolchain.platform,
          },
          sourcemapHash,
        },
        {
          maximumStaticDependencyRows: admitted.bounds.maximumStaticDependencyRows,
        },
      );
      const executions = [
        executionRecord(
          "rojo",
          ["sourcemap", "<staged-project>", "--output", "<temporary-sourcemap>"],
          rojoRun,
        ),
        {
          tool: "luau-lsp" as const,
          commandHash: contentHash(
            stableJson([
              "lsp",
              "--stdio",
              "initialize",
              "textDocument/documentSymbol",
              "textDocument/references",
              "shutdown",
            ]),
          ),
          exitCode: 0,
          stdoutHash: semantic.transcriptHash,
          stderrHash: contentHash(""),
        },
      ];
      const payload = {
        authority: "pinned_official_toolchain" as const,
        sourceIndexId: index.id,
        sourceIndexHash: index.hash,
        sourceSnapshotHash: index.snapshotHash,
        toolchain,
        executions,
      };
      const hash = contentHash(stableJson(payload));
      return {
        status: "complete",
        index,
        artifact: {
          kind: "PinnedSourceAnalysisArtifact",
          id: `pinned_source_analysis_${hash.slice(0, 24)}`,
          hash,
          ...payload,
        },
      };
    } catch (error) {
      const exhausted =
        error instanceof SourceAnalysisResourceExhausted ||
        (error instanceof Error && error.message.startsWith("source_analysis_resource_exhausted:"));
      return {
        status: "incomplete",
        code: exhausted ? "source_analysis_resource_exhausted" : "source_analysis_failed",
        reason: exhausted ? error.message : error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private requiredTool(name: "rojo" | "luau-lsp"): VerifiedPinnedSourceAnalysisTool {
    const tool = this.toolchain.tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Verified source analysis toolchain is missing ${name}`);
    return tool;
  }
}

export function assertSourceAnalysisToolchainLock(
  value: unknown,
): asserts value is SourceAnalysisToolchainLock {
  if (
    !isRecord(value) ||
    value.kind !== "ForgeSourceAnalysisToolchainLock" ||
    value.version !== 1 ||
    !Array.isArray(value.tools) ||
    value.tools.length !== 2
  )
    throw new Error("Invalid source analysis toolchain lock");
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (
      !isRecord(tool) ||
      (tool.name !== "rojo" && tool.name !== "luau-lsp") ||
      typeof tool.version !== "string" ||
      !nonEmptyText(tool.repository) ||
      !nonEmptyText(tool.releaseTag) ||
      !httpsUrl(tool.githubApiRelease) ||
      !Array.isArray(tool.assets) ||
      tool.assets.length === 0
    )
      throw new Error("Invalid source analysis toolchain lock tool");
    names.add(tool.name);
    const assetNames = new Set<string>();
    for (const asset of tool.assets) {
      if (
        !isRecord(asset) ||
        !Array.isArray(asset.platforms) ||
        asset.platforms.length === 0 ||
        !asset.platforms.every(isPlatform) ||
        !safeFileName(asset.name) ||
        !httpsUrl(asset.url) ||
        !isHash(asset.sha256) ||
        !positiveInteger(asset.bytes) ||
        !safeFileName(asset.binary)
      )
        throw new Error("Invalid source analysis toolchain lock asset");
      if (assetNames.has(asset.name))
        throw new Error("Source analysis toolchain lock has duplicate release asset name");
      assetNames.add(asset.name);
    }
  }
  if (names.size !== 2 || !names.has("rojo") || !names.has("luau-lsp"))
    throw new Error("Source analysis toolchain lock must pin Rojo and luau-lsp exactly once");
}

function orderedTools(lock: SourceAnalysisToolchainLock): readonly SourceAnalysisToolLock[] {
  return ["rojo", "luau-lsp"].map((name) => {
    const tool = lock.tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Source analysis toolchain lock is missing ${name}`);
    return tool;
  });
}

function assetForPlatform(
  tool: SourceAnalysisToolLock,
  platform: SourceAnalysisPlatform,
): SourceAnalysisToolAsset {
  const asset = tool.assets.find((entry) => entry.platforms.includes(platform));
  if (!asset) throw new Error(`Pinned ${tool.name} has no release asset for ${platform}`);
  return asset;
}

function installationDirectory(
  root: string,
  lock: SourceAnalysisToolchainLock,
  platform: SourceAnalysisPlatform,
): string {
  return resolve(
    root,
    ".forge",
    "tooling",
    "source-analysis",
    `lock-${contentHash(stableJson(lock)).slice(0, 16)}`,
    platform,
  );
}

function archivePath(
  directory: string,
  tool: SourceAnalysisToolLock,
  asset: SourceAnalysisToolAsset,
): string {
  return resolve(directory, "archives", `${tool.name}-${asset.name}`);
}

function executablePath(directory: string, tool: SourceAnalysisToolLock): string {
  return resolve(directory, "bin", tool.name === "rojo" ? "rojo" : "luau-lsp");
}

async function verifiedArchiveState(
  path: string,
  asset: SourceAnalysisToolAsset,
): Promise<"missing" | "verified"> {
  const info = await lstat(path).catch((error: unknown) => missingOrThrow(error));
  if (!info) return "missing";
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Pinned release asset is not a regular file: ${path}`);
  if (info.size !== asset.bytes) throw new Error(`Pinned release asset size mismatch: ${path}`);
  const actual = hashBytes(await readFile(path));
  if (actual !== asset.sha256) throw new Error(`Pinned release asset SHA-256 mismatch: ${path}`);
  return "verified";
}

async function assertVerifiedArchive(path: string, asset: SourceAnalysisToolAsset): Promise<void> {
  if ((await verifiedArchiveState(path, asset)) === "missing")
    throw new PinnedSourceAnalysisToolchainMissingError(`Pinned release asset is missing: ${path}`);
}

async function verifiedBinaryState(
  path: string,
  expected: Buffer,
): Promise<"missing" | "verified"> {
  const info = await lstat(path).catch((error: unknown) => missingOrThrow(error));
  if (!info) return "missing";
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Pinned executable is not a regular file: ${path}`);
  if (info.size !== expected.byteLength)
    throw new Error(`Pinned executable size mismatch: ${path}`);
  if (hashBytes(await readFile(path)) !== hashBytes(expected))
    throw new Error(`Pinned executable SHA-256 mismatch: ${path}`);
  return "verified";
}

async function assertVerifiedBinary(path: string, expected: Buffer): Promise<void> {
  if ((await verifiedBinaryState(path, expected)) === "missing")
    throw new PinnedSourceAnalysisToolchainMissingError(`Pinned executable is missing: ${path}`);
}

async function publishRegularFile(
  target: string,
  value: Buffer,
  mode: number,
  trustedRoot: string,
): Promise<void> {
  await ensureSafeDirectory(resolve(target, ".."), trustedRoot);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const descriptor = await open(temporary, "wx", mode);
  try {
    await descriptor.writeFile(value);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function ensureSafeDirectory(directory: string, trustedRoot: string): Promise<void> {
  const absolute = resolve(directory);
  const root = resolve(trustedRoot);
  const relativeDirectory = relative(root, absolute);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`))
    throw new Error("Source analysis toolchain target escapes its trusted root");
  let current = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error: unknown) => missingOrThrow(error));
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe source analysis toolchain directory: ${current}`);
      continue;
    }
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    const created = await lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory())
      throw new Error(`Unsafe source analysis toolchain directory: ${current}`);
  }
}

async function assertSafeDirectory(directory: string, trustedRoot: string): Promise<void> {
  const absolute = resolve(directory);
  const root = resolve(trustedRoot);
  const relativeDirectory = relative(root, absolute);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`))
    throw new Error("Source analysis toolchain target escapes its trusted root");
  let current = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error))
        throw new PinnedSourceAnalysisToolchainMissingError(
          `Pinned source analysis toolchain is missing: ${directory}`,
        );
      throw error;
    });
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Unsafe source analysis toolchain directory: ${current}`);
  }
}

async function downloadLockedAsset(asset: SourceAnalysisToolAsset): Promise<Buffer> {
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(
      `Unable to download pinned source analysis asset ${asset.name} (${response.status})`,
    );
  return Buffer.from(await response.arrayBuffer());
}

async function extractLockedBinary(
  archive: string,
  asset: SourceAnalysisToolAsset,
): Promise<Buffer> {
  const listing = await captureBinary("unzip", ["-Z1", archive]);
  if (listing.exitCode !== 0)
    throw new Error(`Unable to inspect pinned release archive ${archive}`);
  const entries = listing.stdout.toString("utf8").split(/\r?\n/u).filter(Boolean);
  if (entries.length !== 1 || entries[0] !== asset.binary)
    throw new Error(`Pinned release archive has an unexpected file layout: ${archive}`);
  const extracted = await captureBinary("unzip", ["-p", archive, asset.binary]);
  if (extracted.exitCode !== 0)
    throw new Error(`Unable to extract pinned executable from ${archive}`);
  return extracted.stdout;
}

async function captureBinary(
  command: string,
  args: readonly string[],
): Promise<{
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

async function runVerifiedBinary(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

interface LspPosition {
  readonly line: number;
  readonly character: number;
}
interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}
interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly selectionRange: LspRange;
  readonly children?: readonly LspDocumentSymbol[];
}
interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

/**
 * Bounded, private stdio collection from the verified language server.  It
 * persists only normalized rows and transcript hashes, never source text or
 * raw diagnostics. Any timeout, crash, response overflow, or malformed LSP
 * result becomes an incomplete host outcome.
 */
async function collectBoundedLuauLspSemantics(
  executable: string,
  root: string,
  entries: readonly StagedSourceDocument[],
): Promise<{
  readonly symbols: readonly StudioSourceSymbol[];
  readonly references: readonly SourceReference[];
  readonly transcriptHash: string;
}> {
  const session = await BoundedLspSession.start(executable, root);
  try {
    const initialized = await session.request("initialize", {
      processId: null,
      rootUri: pathToFileURL(root).href,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: { dynamicRegistration: false },
        },
      },
    });
    if (!isRecord(initialized) || !isRecord(initialized.capabilities))
      throw new Error("Luau LSP returned a nonconforming initialize response");
    session.notify("initialized", {});

    const byUri = new Map(entries.map((entry) => [pathToFileURL(entry.file).href, entry]));
    for (const entry of entries) {
      session.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(entry.file).href,
          languageId: "luau",
          version: 1,
          text: entry.source,
        },
      });
    }

    const symbols: StudioSourceSymbol[] = [];
    const symbolIds = new Set<string>();
    const symbolQueries: Array<{
      readonly symbol: StudioSourceSymbol;
      readonly uri: string;
      readonly position: LspPosition;
    }> = [];
    for (const entry of entries) {
      const uri = pathToFileURL(entry.file).href;
      const response = await session.request("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      for (const raw of flattenLspDocumentSymbols(response)) {
        const sourceLocation = sourceLocationFromLsp(
          entry.source,
          raw.selectionRange,
          entry.document.path,
        );
        const kind = lspSymbolKind(raw.kind);
        const payload = {
          document: entry.document,
          name: raw.name,
          kind,
          startByte: sourceLocation.startByte,
          endByte: sourceLocation.endByte,
        };
        const symbol: StudioSourceSymbol = {
          id: `source_symbol_${contentHash(stableJson(payload)).slice(0, 24)}`,
          document: entry.document,
          name: raw.name,
          kind,
          location: sourceLocation,
        };
        if (!symbolIds.has(symbol.id)) {
          if (symbols.length >= LSP_MAX_SYMBOLS)
            throw new SourceAnalysisResourceExhausted("symbol_rows_exceeded");
          symbols.push(symbol);
          symbolIds.add(symbol.id);
          // Keep the exact LSP UTF-16 position. Reconstructing it from our
          // user-facing code-point column would be wrong before non-BMP text.
          symbolQueries.push({
            symbol,
            uri,
            position: raw.selectionRange.start,
          });
        }
      }
    }

    const references: SourceReference[] = [];
    const referenceIds = new Set<string>();
    for (const query of symbolQueries) {
      const response = await session.request("textDocument/references", {
        textDocument: { uri: query.uri },
        position: query.position,
        context: { includeDeclaration: true },
      });
      if (response !== null && !Array.isArray(response))
        throw new Error("Luau LSP returned a nonconforming references response");
      const locations = response ?? [];
      if (locations.length > LSP_MAX_REFERENCES_PER_SYMBOL)
        throw new SourceAnalysisResourceExhausted("symbol_references_exceeded");
      for (const raw of locations) {
        const location = parseLspLocation(raw);
        const target = byUri.get(location.uri);
        // References outside this private staged source snapshot are neither
        // exposed nor persisted as project facts.
        if (!target) continue;
        const sourceLocation = sourceLocationFromLsp(
          target.source,
          location.range,
          target.document.path,
        );
        const role = sameSourceRange(
          query.symbol.document,
          query.symbol.location,
          target.document,
          sourceLocation,
        )
          ? ("declaration" as const)
          : ("reference" as const);
        const payload = {
          document: target.document,
          name: query.symbol.name,
          role,
          startByte: sourceLocation.startByte,
          endByte: sourceLocation.endByte,
        };
        const reference: SourceReference = {
          id: `source_reference_${contentHash(stableJson(payload)).slice(0, 24)}`,
          document: target.document,
          name: query.symbol.name,
          role,
          location: sourceLocation,
        };
        if (!referenceIds.has(reference.id)) {
          if (references.length >= LSP_MAX_REFERENCE_ROWS)
            throw new SourceAnalysisResourceExhausted("reference_rows_exceeded");
          references.push(reference);
          referenceIds.add(reference.id);
        }
      }
    }
    await session.shutdown();
    return {
      symbols: symbols.sort(compareSemanticSymbols),
      references: references.sort(compareSemanticReferences),
      transcriptHash: session.transcriptHash(),
    };
  } finally {
    await session.close();
  }
}

class BoundedLspSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly transcript = createHash("sha256");
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: Error) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  private remainder = Buffer.alloc(0);
  private nextId = 1;
  private readonly deadline = Date.now() + LSP_SESSION_TIMEOUT_MS;
  private closed = false;

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process;
    process.stdout.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)));
    process.stderr.on("data", (chunk: Buffer) => this.transcript.update(Buffer.from(chunk)));
    process.once("error", (error) =>
      this.failAll(new Error(`Luau LSP failed to start: ${error.message}`)),
    );
    process.once("close", (code) => {
      this.closed = true;
      this.failAll(new Error(`Luau LSP exited before shutdown (exit ${code ?? "unknown"})`));
    });
  }

  static async start(executable: string, cwd: string): Promise<BoundedLspSession> {
    const process = spawn(executable, ["lsp", "--stdio"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new BoundedLspSession(process);
  }

  notify(method: string, params: object): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Luau LSP is not running"));
    const remaining = Math.min(LSP_REQUEST_TIMEOUT_MS, this.deadline - Date.now());
    if (remaining <= 0)
      return Promise.reject(new Error("Luau LSP session exceeded its time bound"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Luau LSP timed out responding to ${method}`));
      }, remaining);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.request("shutdown", {});
    this.notify("exit", {});
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(
        () => {
          this.process.kill();
          resolvePromise();
        },
        Math.min(2_000, Math.max(1, this.deadline - Date.now())),
      );
      this.process.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.closed) this.process.kill();
  }

  transcriptHash(): string {
    return this.transcript.copy().digest("hex");
  }

  private send(value: object): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.byteLength > LSP_MAX_MESSAGE_BYTES)
      throw new Error("Luau LSP request exceeds the body bound");
    this.process.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]),
    );
  }

  private receive(chunk: Buffer): void {
    this.remainder = Buffer.concat([this.remainder, chunk]);
    while (true) {
      const headerEnd = this.remainder.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.remainder.byteLength > 8_192)
          this.failAll(new Error("Luau LSP sent an oversized header"));
        return;
      }
      const header = this.remainder.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/^Content-Length:\s*(\d+)\s*$/imu);
      if (!match?.[1]) {
        this.failAll(new Error("Luau LSP sent an invalid JSON-RPC header"));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > LSP_MAX_MESSAGE_BYTES) {
        this.failAll(new Error("Luau LSP response exceeds the body bound"));
        return;
      }
      const messageEnd = headerEnd + 4 + length;
      if (this.remainder.byteLength < messageEnd) return;
      const body = this.remainder.subarray(headerEnd + 4, messageEnd);
      this.remainder = this.remainder.subarray(messageEnd);
      this.transcript.update(body);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        this.failAll(new Error("Luau LSP sent invalid JSON"));
        return;
      }
      if (!isRecord(message)) {
        this.failAll(new Error("Luau LSP sent a non-object JSON-RPC message"));
        return;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined)
        pending.reject(new Error("Luau LSP returned an error response"));
      else if ("result" in message) pending.resolve(message.result);
      else pending.reject(new Error("Luau LSP response has no result"));
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

function flattenLspDocumentSymbols(value: unknown): readonly LspDocumentSymbol[] {
  if (!Array.isArray(value))
    throw new Error("Luau LSP returned a nonconforming documentSymbol response");
  const output: LspDocumentSymbol[] = [];
  const visit = (candidate: unknown): void => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      !Number.isSafeInteger(candidate.kind) ||
      !isLspRange(candidate.selectionRange)
    )
      throw new Error("Luau LSP returned a malformed document symbol");
    const symbol: LspDocumentSymbol = {
      name: candidate.name,
      kind: Number(candidate.kind),
      selectionRange: candidate.selectionRange,
      ...(candidate.children === undefined
        ? {}
        : {
            children: Array.isArray(candidate.children)
              ? candidate.children.map((entry) => parseLspDocumentSymbol(entry))
              : invalidChildren(),
          }),
    };
    output.push(symbol);
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const candidate of value) visit(candidate);
  return output;
}

function parseLspDocumentSymbol(value: unknown): LspDocumentSymbol {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !Number.isSafeInteger(value.kind) ||
    !isLspRange(value.selectionRange)
  )
    throw new Error("Luau LSP returned a malformed document symbol");
  return {
    name: value.name,
    kind: Number(value.kind),
    selectionRange: value.selectionRange,
    ...(value.children === undefined
      ? {}
      : {
          children: Array.isArray(value.children)
            ? value.children.map(parseLspDocumentSymbol)
            : invalidChildren(),
        }),
  };
}

function invalidChildren(): never {
  throw new Error("Luau LSP returned malformed document symbol children");
}

function parseLspLocation(value: unknown): LspLocation {
  if (!isRecord(value) || typeof value.uri !== "string" || !isLspRange(value.range))
    throw new Error("Luau LSP returned a malformed reference location");
  return { uri: value.uri, range: value.range };
}

function isLspRange(value: unknown): value is LspRange {
  return (
    isRecord(value) &&
    isLspPosition(value.start) &&
    isLspPosition(value.end) &&
    (value.end.line > value.start.line ||
      (value.end.line === value.start.line && value.end.character > value.start.character))
  );
}

function isLspPosition(value: unknown): value is LspPosition {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) >= 0 &&
    Number.isSafeInteger(value.character) &&
    Number(value.character) >= 0
  );
}

function sourceLocationFromLsp(source: string, range: LspRange, path: string): SourceLocation {
  const start = sourceOffsetFromLsp(source, range.start, path);
  const end = sourceOffsetFromLsp(source, range.end, path);
  if (end <= start) throw new Error(`Luau LSP returned an empty source range at ${path}`);
  const prefix = source.slice(0, start);
  const endPrefix = source.slice(0, end);
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const startColumn = Array.from(prefix.slice(prefix.lastIndexOf("\n") + 1)).length + 1;
  const endColumn = Array.from(endPrefix.slice(endPrefix.lastIndexOf("\n") + 1)).length + 1;
  return {
    startByte: Buffer.byteLength(prefix, "utf8"),
    endByte: Buffer.byteLength(endPrefix, "utf8"),
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}

function sourceOffsetFromLsp(source: string, position: LspPosition, path: string): number {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) throw new Error(`Luau LSP location is outside ${path}`);
    offset = newline + 1;
  }
  const lineEnd = source.indexOf("\n", offset);
  const end = lineEnd < 0 ? source.length : lineEnd;
  const result = offset + position.character;
  if (
    result > end ||
    (result > offset && result < end && isLowSurrogate(source.charCodeAt(result)))
  )
    throw new Error(`Luau LSP location is not a valid UTF-16 boundary at ${path}`);
  return result;
}

function sameSourceRange(
  leftDocument: { readonly documentId: string },
  left: SourceLocation,
  rightDocument: { readonly documentId: string },
  right: SourceLocation,
): boolean {
  return (
    leftDocument.documentId === rightDocument.documentId &&
    left.startByte === right.startByte &&
    left.endByte === right.endByte
  );
}

function lspSymbolKind(value: number): StudioSourceSymbol["kind"] {
  if (value === 6 || value === 12) return "function";
  if ([5, 10, 11, 23, 26].includes(value)) return "type";
  return "local";
}

function compareSemanticSymbols(left: StudioSourceSymbol, right: StudioSourceSymbol): number {
  return (
    left.document.path.localeCompare(right.document.path) ||
    left.document.documentId.localeCompare(right.document.documentId) ||
    left.location.startByte - right.location.startByte ||
    left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind)
  );
}

function compareSemanticReferences(left: SourceReference, right: SourceReference): number {
  return (
    left.document.path.localeCompare(right.document.path) ||
    left.document.documentId.localeCompare(right.document.documentId) ||
    left.location.startByte - right.location.startByte ||
    left.name.localeCompare(right.name) ||
    left.role.localeCompare(right.role)
  );
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

class SourceAnalysisResourceExhausted extends Error {
  constructor(
    reason:
      | "document_count_exceeded"
      | "document_source_bytes_exceeded"
      | "aggregate_source_bytes_exceeded"
      | "symbol_rows_exceeded"
      | "symbol_references_exceeded"
      | "reference_rows_exceeded",
  ) {
    super(`source_analysis_resource_exhausted: ${reason}`);
    this.name = "SourceAnalysisResourceExhausted";
  }
}

function admitProductionSourceAnalysis(input: PinnedSourceAnalysisInput): {
  readonly documents: readonly SourceDocumentDescriptor[];
  readonly resolver: VerifiedSourceResolver;
  readonly bounds: SourceAnalysisResourceBounds;
} {
  if (
    !isHash(input.snapshotHash) ||
    !Array.isArray(input.documents) ||
    !input.resolver ||
    input.resolver.authority !== "verified_source_blob" ||
    typeof input.resolver.readRange !== "function"
  )
    throw new Error("Pinned source analysis requires verified chunk-backed source input");
  const bounds = normalizeSourceAnalysisBounds(input.bounds ?? SOURCE_ANALYSIS_RESOURCE_BOUNDS);
  if (input.documents.length > bounds.maximumDocuments)
    throw new SourceAnalysisResourceExhausted("document_count_exceeded");
  let aggregateBytes = 0;
  const documentIds = new Set<string>();
  const documents = input.documents
    .map((value) => {
      const document = normalizeSourceDescriptor(value);
      if (documentIds.has(document.documentId))
        throw new Error("Pinned source analysis received duplicate document identities");
      documentIds.add(document.documentId);
      if (document.utf8Bytes > bounds.maximumDocumentUtf8Bytes)
        throw new SourceAnalysisResourceExhausted("document_source_bytes_exceeded");
      aggregateBytes += document.utf8Bytes;
      if (aggregateBytes > bounds.maximumAggregateUtf8Bytes)
        throw new SourceAnalysisResourceExhausted("aggregate_source_bytes_exceeded");
      return document;
    })
    .sort(compareSourceDescriptors);
  return { documents, resolver: input.resolver, bounds };
}

function normalizeSourceAnalysisBounds(
  value: SourceAnalysisResourceBounds,
): SourceAnalysisResourceBounds {
  if (
    !positiveInteger(value.maximumDocuments) ||
    !positiveInteger(value.maximumDocumentUtf8Bytes) ||
    !positiveInteger(value.maximumAggregateUtf8Bytes) ||
    !positiveInteger(value.maximumStaticDependencyRows) ||
    value.maximumAggregateUtf8Bytes < value.maximumDocumentUtf8Bytes
  )
    throw new Error("Invalid source analysis resource bounds");
  return {
    maximumDocuments: value.maximumDocuments,
    maximumDocumentUtf8Bytes: value.maximumDocumentUtf8Bytes,
    maximumAggregateUtf8Bytes: value.maximumAggregateUtf8Bytes,
    maximumStaticDependencyRows: value.maximumStaticDependencyRows,
  };
}

function normalizeSourceDescriptor(value: SourceDocumentDescriptor): SourceDocumentDescriptor {
  if (
    !isRecord(value) ||
    !nonEmptyText(value.documentId) ||
    !nonEmptyText(value.path) ||
    !nonEmptyText(value.className) ||
    !["client", "server", "shared"].includes(String(value.executionContext)) ||
    !isHash(value.sourceHash) ||
    !Number.isSafeInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) < 0
  )
    throw new Error("Invalid production source document descriptor");
  return {
    documentId: value.documentId,
    path: value.path,
    className: value.className,
    executionContext: value.executionContext,
    sourceHash: value.sourceHash,
    utf8Bytes: Number(value.utf8Bytes),
  };
}

function compareSourceDescriptors(
  left: SourceDocumentDescriptor,
  right: SourceDocumentDescriptor,
): number {
  return (
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")) ||
    Buffer.compare(Buffer.from(left.documentId, "utf8"), Buffer.from(right.documentId, "utf8"))
  );
}

function materializeVerifiedSourceDocument(
  resolver: VerifiedSourceResolver,
  descriptor: SourceDocumentDescriptor,
): SourceDocumentInput {
  const result = resolver.readRange(
    {
      documentId: descriptor.documentId,
      path: descriptor.path,
      className: descriptor.className,
      executionContext: descriptor.executionContext,
      sourceHash: descriptor.sourceHash,
    },
    { startByte: 0, endByte: descriptor.utf8Bytes },
  );
  if (
    !isRecord(result) ||
    result.startByte !== 0 ||
    result.endByte !== descriptor.utf8Bytes ||
    typeof result.source !== "string" ||
    Buffer.byteLength(result.source, "utf8") !== descriptor.utf8Bytes ||
    contentHash(result.source) !== descriptor.sourceHash
  )
    throw new Error(
      `Verified source resolver returned a changed body for ${descriptor.documentId}`,
    );
  return {
    documentId: descriptor.documentId,
    path: descriptor.path,
    className: descriptor.className,
    executionContext: descriptor.executionContext,
    sourceHash: descriptor.sourceHash,
    source: result.source,
  };
}

interface StagedSourceDocument {
  readonly documentId: string;
  readonly document: {
    readonly documentId: string;
    readonly path: string;
    readonly className: string;
    readonly executionContext: "client" | "server" | "shared";
    readonly sourceHash: string;
  };
  readonly file: string;
  readonly source: string;
}

async function stageSourceDocuments(
  input: {
    readonly documents: readonly SourceDocumentDescriptor[];
    readonly resolver: VerifiedSourceResolver;
    readonly bounds: SourceAnalysisResourceBounds;
  },
  root: string,
): Promise<{
  readonly tree: Record<string, unknown>;
  readonly entries: readonly StagedSourceDocument[];
  readonly documents: readonly SourceDocumentInput[];
}> {
  const tree: Record<string, unknown> = { $className: "DataModel" };
  const entries: StagedSourceDocument[] = [];
  const documents: SourceDocumentInput[] = [];
  for (let ordinal = 0; ordinal < input.documents.length; ordinal += 1) {
    const descriptor = input.documents[ordinal]!;
    const document = materializeVerifiedSourceDocument(input.resolver, descriptor);
    if (Buffer.byteLength(document.source, "utf8") > input.bounds.maximumDocumentUtf8Bytes)
      throw new SourceAnalysisResourceExhausted("document_source_bytes_exceeded");
    const suffix =
      document.className === "Script"
        ? ".server.luau"
        : document.className === "LocalScript"
          ? ".client.luau"
          : ".luau";
    const file = join(
      root,
      "source",
      `${String(ordinal).padStart(6, "0")}-${safeStageName(document.documentId)}${suffix}`,
    );
    await ensureSafeDirectory(resolve(file, ".."), root);
    await writeFile(file, document.source, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    entries.push({
      documentId: document.documentId,
      document: {
        documentId: document.documentId,
        path: document.path,
        className: document.className,
        executionContext: document.executionContext,
        sourceHash: document.sourceHash,
      },
      file,
      source: document.source,
    });
    // `path` is a display label and deliberately not a filesystem or
    // authority key. Equal display paths remain legal in the snapshot.
    stageTreeNode(
      tree,
      `Source/${String(ordinal).padStart(6, "0")}-${safeStageName(document.documentId)}`,
      file,
    );
    documents.push(document);
  }
  return { tree, entries, documents };
}

function stageTreeNode(tree: Record<string, unknown>, sourcePath: string, file: string): void {
  let current = tree;
  const segments = sourcePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const leaf = index === segments.length - 1;
    const existing = current[segment];
    if (
      existing !== undefined &&
      (typeof existing !== "object" || existing === null || Array.isArray(existing))
    )
      throw new Error(`Pinned source analysis staging has a conflicting path at ${sourcePath}`);
    const node =
      (existing as Record<string, unknown> | undefined) ?? (leaf ? {} : { $className: "Folder" });
    if (leaf) {
      if ("$path" in node)
        throw new Error(
          `Pinned source analysis staging has a duplicate source path at ${sourcePath}`,
        );
      node.$path = file;
    }
    current[segment] = node;
    current = node;
  }
}

function safeStageName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96);
  return normalized || "source";
}

async function canonicalPrivateSourcemapHash(
  sourcemapPath: string,
  temporaryRoot: string,
): Promise<string> {
  const parsed = JSON.parse(await readFile(sourcemapPath, "utf8")) as unknown;
  const roots = new Set([resolve(temporaryRoot)]);
  try {
    roots.add(await realpath(temporaryRoot));
  } catch {
    /* removed only after this point */
  }
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const root of roots)
        result = result.split(root).join("<forge-private-source-workspace>");
      return result;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  };
  return contentHash(stableJson(redact(parsed)));
}

function executionRecord(
  tool: "rojo" | "luau-lsp",
  command: readonly string[],
  result: {
    readonly exitCode: number;
    readonly stdout: Buffer;
    readonly stderr: Buffer;
  },
): PinnedSourceAnalysisArtifact["executions"][number] {
  return {
    tool,
    commandHash: contentHash(stableJson(command)),
    exitCode: result.exitCode,
    stdoutHash: hashBytes(result.stdout),
    stderrHash: hashBytes(result.stderr),
  };
}

function toolchainProof(
  value: VerifiedPinnedSourceAnalysisToolchain,
): PinnedSourceAnalysisToolchainProof {
  const tools = value.tools.map((tool) => ({
    name: tool.name,
    version: tool.version,
    assetName: tool.asset.name,
    assetHash: tool.asset.sha256,
    assetBytes: tool.asset.bytes,
    binaryHash: tool.binaryHash,
    binaryBytes: tool.binaryBytes,
  }));
  const payload = { lockHash: value.lockHash, platform: value.platform, tools };
  return {
    kind: "PinnedSourceAnalysisToolchainProof",
    hash: contentHash(stableJson(payload)),
    ...payload,
  };
}

function toolMaterial(tool: VerifiedPinnedSourceAnalysisTool): Omit<
  VerifiedPinnedSourceAnalysisTool,
  "executable" | "asset"
> & {
  readonly asset: {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
  };
} {
  return {
    name: tool.name,
    version: tool.version,
    asset: {
      name: tool.asset.name,
      sha256: tool.asset.sha256,
      bytes: tool.asset.bytes,
    },
    binaryHash: tool.binaryHash,
    binaryBytes: tool.binaryBytes,
  };
}

function currentPlatform(): SourceAnalysisPlatform {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "win32"
          : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!platform || !arch)
    throw new Error(`Pinned source analysis does not support ${process.platform}-${process.arch}`);
  return `${platform}-${arch}` as SourceAnalysisPlatform;
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function httpsUrl(value: unknown): value is string {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
function safeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value === basename(value) &&
    !value.includes("\\") &&
    !value.includes("/")
  );
}
function isPlatform(value: unknown): value is SourceAnalysisPlatform {
  return (
    value === "darwin-arm64" ||
    value === "darwin-x64" ||
    value === "linux-arm64" ||
    value === "linux-x64" ||
    value === "win32-arm64" ||
    value === "win32-x64"
  );
}
function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
function missingOrThrow(error: unknown): undefined {
  if (isMissing(error)) return undefined;
  throw error;
}
