import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { BLENDER_MACOS_ARM64_DMG_SHA256, BLENDER_VERSION } from "../../visual-world/src/index.js";
import {
  BLENDER_COMPILER_ABI,
  BLENDER_COMPILER_INSTALLATION_SCHEMA,
  BLENDER_INSTALLATION_QUALIFICATION_ABI,
  type BlenderCompilerInstallation,
} from "./contracts.js";

export const BLENDER_SEATBELT_POLICY = Object.freeze({
  version: "forge-blender-seatbelt@2",
  sourceRevision: "2026-09-07.6",
  default: "deny",
  network: "deny",
  processFork: "deny",
  processExec: "qualified-blender-and-interpreter-only",
  iokit: "allow-system-device-discovery-for-headless-startup",
  fileWrite: "private-job-directory-only",
  fileRead: "qualified-application-system-runtime-and-private-job-only",
  sensitiveUserRoots: [".aws", ".config", ".ssh", "Library/Keychains"],
});

export function blenderSeatbeltPolicySha256(): string {
  return contentHash(stableJson(BLENDER_SEATBELT_POLICY));
}

export interface FixedBlenderCompilerIdentity {
  workerSha256: string;
  inspectorSha256: string;
  operationSetSha256: string;
  exportProfileSha256: string;
}

export type BlenderQualificationResult =
  | {
      status: "eligible";
      qualification: BlenderCompilerInstallation;
      qualificationHash: string;
    }
  | {
      status: "incomplete" | "rejected";
      code: "missing_blender" | "unqualified_blender";
      detail: string;
    };

/**
 * Qualifies the exact mounted official distribution. This is a host operation:
 * no path or executable field is read from a scene or model-authored artifact.
 */
export async function qualifyBlenderInstallation(input: {
  distributionPath: string;
  applicationPath: string;
  compilerIdentity: FixedBlenderCompilerIdentity;
  qualifiedAt?: string;
}): Promise<BlenderQualificationResult> {
  try {
    if (!isAbsolute(input.distributionPath) || !isAbsolute(input.applicationPath))
      throw new Error("Blender qualification paths must be absolute host paths");
    const distribution = await lstat(input.distributionPath);
    if (distribution.isSymbolicLink() || !distribution.isFile())
      throw new Error("Blender distribution is not a regular file");
    if (
      (await qualifiedRegularFileIdentity(input.distributionPath, 2 * 1024 * 1024 * 1024)).hash !==
      BLENDER_MACOS_ARM64_DMG_SHA256
    )
      throw new Error("Blender distribution does not match the pinned official checksum");
    const imageVerification = await runFixed(
      "/usr/bin/hdiutil",
      ["verify", input.distributionPath],
      120_000,
      256 * 1024,
    );
    if (imageVerification.exitCode !== 0 || !/checksum.+is VALID/i.test(imageVerification.output))
      throw new Error("Blender disk image verification failed");

    const application = await lstat(input.applicationPath);
    if (application.isSymbolicLink() || !application.isDirectory())
      throw new Error("Blender application is not a regular app bundle directory");
    const applicationRoot = await realpath(input.applicationPath);
    const executablePath = join(applicationRoot, "Contents/MacOS/Blender");
    const executable = await qualifiedRegularFileIdentity(executablePath, 1024 * 1024 * 1024);
    const architecture = await runFixed("/usr/bin/file", [executablePath], 10_000, 64 * 1024);
    if (
      architecture.exitCode !== 0 ||
      !/Mach-O 64-bit executable arm64\s*$/m.test(architecture.output)
    )
      throw new Error("Blender executable is not a thin arm64 Mach-O");

    const verifySignature = await runFixed(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", applicationRoot],
      120_000,
      512 * 1024,
    );
    if (
      verifySignature.exitCode !== 0 ||
      !verifySignature.output.includes("valid on disk") ||
      !verifySignature.output.includes("satisfies its Designated Requirement")
    )
      throw new Error("Blender application signature validation failed");
    const signature = await runFixed(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", applicationRoot],
      30_000,
      512 * 1024,
    );
    if (
      signature.exitCode !== 0 ||
      field(signature.output, "Identifier") !== "org.blenderfoundation.blender" ||
      field(signature.output, "TeamIdentifier") !== "68UA947AUU" ||
      !signature.output.includes(
        "Authority=Developer ID Application: Stichting Blender Foundation (68UA947AUU)",
      )
    )
      throw new Error("Blender signing identity differs from the qualified publisher");
    const requirement = await runFixed(
      "/usr/bin/codesign",
      ["-dr", "-", applicationRoot],
      30_000,
      128 * 1024,
    );
    if (requirement.exitCode !== 0 || !requirement.output.includes("designated =>"))
      throw new Error("Blender designated requirement could not be read");

    const version = await runFixed(executablePath, ["--version"], 30_000, 128 * 1024);
    if (version.exitCode !== 0 || !version.output.startsWith(`Blender ${BLENDER_VERSION}`))
      throw new Error("Blender executable version does not match the pinned compiler");

    const inventory = await inspectApplicationInventory(applicationRoot);
    const pythonRelativePath = "Contents/Resources/5.2/python/bin/python3.13" as const;
    const python = await qualifiedRegularFileIdentity(
      join(applicationRoot, pythonRelativePath),
      256 * 1024 * 1024,
    );
    const libraries = inventory.entries.filter(
      (entry) =>
        entry.kind === "file" &&
        entry.path.startsWith("Contents/Resources/lib/") &&
        entry.path.endsWith(".dylib"),
    );
    if (libraries.length === 0) throw new Error("Blender bundled library inventory is empty");

    const qualification = BLENDER_COMPILER_INSTALLATION_SCHEMA.parse({
      kind: "BlenderInstallationQualification",
      qualificationAbi: BLENDER_INSTALLATION_QUALIFICATION_ABI,
      abi: BLENDER_COMPILER_ABI,
      profile: "forge-blender-macos-arm64@2",
      platform: "darwin-arm64",
      blenderVersion: BLENDER_VERSION,
      distributionPath: input.distributionPath,
      distributionBytes: distribution.size,
      distributionImageVerified: true,
      distributionSha256: BLENDER_MACOS_ARM64_DMG_SHA256,
      applicationPath: applicationRoot,
      applicationInventorySha256: inventory.hash,
      applicationFileCount: inventory.fileCount,
      applicationBytes: inventory.bytes,
      executablePath,
      executableSha256: executable.hash,
      executableArchitecture: "arm64",
      bundleIdentifier: "org.blenderfoundation.blender",
      teamIdentifier: "68UA947AUU",
      designatedRequirementSha256: contentHash(requirement.output.trim()),
      codeSignatureValidated: true,
      bundledPythonRelativePath: pythonRelativePath,
      bundledPythonSha256: python.hash,
      bundledLibraryCount: libraries.length,
      bundledLibraryInventorySha256: contentHash(stableJson(libraries)),
      seatbeltPolicySha256: blenderSeatbeltPolicySha256(),
      ...input.compilerIdentity,
      qualifiedAt: input.qualifiedAt ?? new Date().toISOString(),
    });
    return {
      status: "eligible",
      qualification,
      qualificationHash: contentHash(stableJson(qualification)),
    };
  } catch (error: unknown) {
    const missing = isNodeError(error, "ENOENT");
    return {
      status: missing ? "incomplete" : "rejected",
      code: missing ? "missing_blender" : "unqualified_blender",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectApplicationInventory(applicationPath: string): Promise<{
  hash: string;
  fileCount: number;
  bytes: number;
  entries: Array<
    | { kind: "file"; path: string; bytes: number; sha256: string }
    | { kind: "symlink"; path: string; target: string }
  >;
}> {
  const root = await realpath(applicationPath);
  const entries: Array<
    | { kind: "file"; path: string; bytes: number; sha256: string }
    | { kind: "symlink"; path: string; target: string }
  > = [];
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 50_000) throw new Error("Blender application inventory exceeds entry limit");
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const file = await qualifiedRegularFileIdentity(path, 1024 * 1024 * 1024);
        entries.push({ kind: "file", path: relativePath, bytes: file.bytes, sha256: file.hash });
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path);
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
          throw new Error(`Blender application symlink escapes its bundle: ${relativePath}`);
        entries.push({ kind: "symlink", path: relativePath, target });
      } else throw new Error(`Blender application has an unsupported file type: ${relativePath}`);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    hash: contentHash(stableJson(entries)),
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    bytes: entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0), 0),
    entries,
  };
}

export async function qualifiedRegularFileIdentity(
  path: string,
  maximumBytes: number,
): Promise<{ hash: string; bytes: number }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error(`Expected regular file: ${path}`);
  if (before.size > maximumBytes) throw new Error(`File exceeds qualification bounds: ${path}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: "r" })) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error(`File grew beyond qualification bounds: ${path}`);
    hash.update(chunk);
  }
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes !== before.size
  )
    throw new Error(`File changed during qualification: ${path}`);
  return { hash: hash.digest("hex"), bytes };
}

async function runFixed(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/var/empty", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        exceeded = true;
        child.kill("SIGKILL");
      } else chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (exceeded)
        return rejectPromise(new Error("Qualification command output exceeded its bound"));
      resolvePromise({ exitCode: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function field(output: string, name: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
