import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash } from "../../contracts/src/index.js";
import {
  assertProjectAuthorityManifest,
  createRojoSourcemapArtifact,
  type ProjectAuthorityHostContext,
  type ProjectAuthorityManifest,
} from "../../project-authority/src/index.js";
import { ensureOfficialSourceAnalysisToolchain } from "../../source-intelligence/src/index.js";
import { generatePinnedRojoSourcemap } from "../../project-authority/src/host.js";

export interface CreatorServeOptions {
  readonly valid: boolean;
  readonly defaultModel?: string;
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
  let defaultModel: string | undefined;
  let sessionDirectory: string | undefined;
  let timeoutMs: number | undefined;
  let controlPort: number | undefined;
  let projectAuthorityManifestPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--default-model" && next) defaultModel = next;
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
    ...(defaultModel ? { defaultModel } : {}),
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
      expectedBinaryHash: rojo.binaryHash,
      workspaceRoot,
      projectFile: manifest.rojo.projectFile,
    });
    context = {
      manifest,
      workspaceRoot,
      rojo: {
        executable: rojo.executable,
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
