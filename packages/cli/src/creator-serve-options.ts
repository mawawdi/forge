import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentHash } from "../../contracts/src/index.js";
import {
  assertProjectAuthorityManifest,
  createRojoSourcemapArtifact,
  type ProjectAuthorityHostContext,
  type ProjectAuthorityManifest,
} from "../../project-authority/src/index.js";
import { ensureOfficialSourceAnalysisToolchain } from "../../source-intelligence/src/index.js";

const execFile = promisify(execFileCallback);

export interface CreatorServeOptions {
  readonly valid: boolean;
  readonly model?: string;
  readonly sessionDirectory?: string;
  readonly timeoutMs?: number;
  readonly controlPort?: number;
  /** Path to the one clean-break project authority declaration. */
  readonly projectAuthorityManifestPath?: string;
}

/**
 * A trusted-host-only option. Its manifest is validated before coordinator
 * startup and selects the request's sole writer domain.
 */
export interface LoadedProjectAuthorityOption {
  readonly manifestPath: string;
  /** The root against which the manifest's private paths are resolved. */
  readonly workspaceRoot: string;
  readonly manifest: ProjectAuthorityManifest;
  /** Host-only context; the private workspace root is never persisted. */
  readonly context: ProjectAuthorityHostContext;
}

export interface LoadedCreatorServeOptions extends CreatorServeOptions {
  readonly projectAuthority?: LoadedProjectAuthorityOption;
}

export function parseCreatorServeOptions(values: readonly string[]): CreatorServeOptions {
  let model: string | undefined;
  let sessionDirectory: string | undefined;
  let timeoutMs: number | undefined;
  let controlPort: number | undefined;
  let projectAuthorityManifestPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--model" && next) model = next;
    else if (option === "--session-dir" && next) sessionDirectory = next;
    else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next);
    else if (
      option === "--control-port" &&
      next &&
      /^\d+$/.test(next) &&
      Number(next) > 0 &&
      Number(next) <= 65_535
    )
      controlPort = Number(next);
    else if (option === "--project-authority" && next && projectAuthorityManifestPath === undefined)
      projectAuthorityManifestPath = next;
    else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(model ? { model } : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(controlPort !== undefined ? { controlPort } : {}),
    ...(projectAuthorityManifestPath ? { projectAuthorityManifestPath } : {}),
  };
}

export async function loadCreatorServeOptions(
  options: CreatorServeOptions,
): Promise<LoadedCreatorServeOptions> {
  if (!options.valid || options.projectAuthorityManifestPath === undefined) return options;
  const manifestPath = resolve(options.projectAuthorityManifestPath);
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Project authority manifest must be a regular file, not a symlink");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read ProjectAuthorityManifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    assertProjectAuthorityManifest(value);
  } catch (error) {
    throw new Error(
      `Invalid ProjectAuthorityManifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = value as ProjectAuthorityManifest;
  const workspaceRoot = dirname(manifestPath);
  let context: ProjectAuthorityHostContext = { manifest, workspaceRoot };
  if (manifest.rojo) {
    const projectFile = await readRegularText(
      workspaceRoot,
      manifest.rojo.projectFile,
      "Rojo project file",
    );
    const verifiedToolchain = await ensureOfficialSourceAnalysisToolchain(resolve(process.cwd()));
    const rojo = verifiedToolchain.tools.find((tool) => tool.name === "rojo");
    if (!rojo || rojo.version !== "7.7.0")
      throw new Error(
        "Verified Rojo 7.7.0 tool is unavailable after pinned toolchain provisioning",
      );
    const sourceMap = await generatePinnedRojoSourcemap({
      executable: rojo.executable,
      workspaceRoot,
      projectFile: manifest.rojo.projectFile,
    });
    context = {
      manifest,
      workspaceRoot,
      rojo: {
        sourcemap: createRojoSourcemapArtifact({
          manifest,
          projectFileHash: contentHash(projectFile),
          sourceMapJson: sourceMap,
          tool: { version: rojo.version, binaryHash: rojo.binaryHash },
        }),
      },
    };
  }
  return {
    ...options,
    projectAuthority: {
      manifestPath,
      workspaceRoot,
      manifest,
      context,
    },
  };
}

/**
 * The only authority map source is a fresh result from the verified, pinned
 * Rojo executable. A manifest can name the project root but cannot smuggle a
 * user-authored sourcemap into a creator transaction.
 */
async function generatePinnedRojoSourcemap(input: {
  readonly executable: string;
  readonly workspaceRoot: string;
  readonly projectFile: string;
}): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-rojo-sourcemap-"));
  const output = join(temporaryRoot, "sourcemap.json");
  try {
    const projectPath = resolve(input.workspaceRoot, input.projectFile);
    const result = await execFile(
      input.executable,
      ["sourcemap", projectPath, "--output", output],
      {
        cwd: input.workspaceRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.stdout.length > 256 * 1024 || result.stderr.length > 256 * 1024)
      throw new Error("Pinned Rojo sourcemap produced excessive diagnostic output");
    const sourceMap = await readRegularText(
      temporaryRoot,
      basename(output),
      "Pinned Rojo sourcemap",
    );
    if (Buffer.byteLength(sourceMap, "utf8") > 16 * 1024 * 1024)
      throw new Error("Pinned Rojo sourcemap exceeds the 16 MiB authority bound");
    return sourceMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Verified Rojo sourcemap failed before creator startup: ${message}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readRegularText(
  workspaceRoot: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const path = resolve(workspaceRoot, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a regular file, not a symlink`);
  return readFile(path, "utf8");
}
