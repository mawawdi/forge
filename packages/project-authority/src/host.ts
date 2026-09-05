import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Fixed host command, bounded independently of model material; this never starts Studio. */
export async function generatePinnedRojoSourcemap(input: {
  readonly executable: string;
  readonly workspaceRoot: string;
  readonly projectFile: string;
  readonly expectedBinaryHash: string;
}): Promise<string> {
  if (!isAbsolute(input.executable) || !/^[a-f0-9]{64}$/.test(input.expectedBinaryHash))
    throw new Error("Pinned Rojo requires an exact host executable and binary hash");
  const executable = await lstat(input.executable);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.size > 256 * 1024 * 1024 ||
    createHash("sha256")
      .update(await readFile(input.executable))
      .digest("hex") !== input.expectedBinaryHash
  )
    throw new Error("Pinned Rojo executable changed or is not a bounded regular file");
  const workspace = resolve(input.workspaceRoot);
  const project = resolve(workspace, input.projectFile);
  const projectRelative = relative(workspace, project);
  if (
    !projectRelative ||
    isAbsolute(input.projectFile) ||
    projectRelative === ".." ||
    projectRelative.startsWith(".." + sep)
  )
    throw new Error("Rojo project file escapes its declared workspace");
  const root = await lstat(workspace);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Rojo workspace is not a regular directory");
  let current = workspace;
  const parts = projectRelative.split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const metadata = await lstat(current);
    if (
      metadata.isSymbolicLink() ||
      (index === parts.length - 1 ? !metadata.isFile() : !metadata.isDirectory())
    )
      throw new Error("Rojo project path contains a symlink or non-regular component");
  }
  const temporary = await mkdtemp(join(tmpdir(), "forge-rojo-sourcemap-"));
  try {
    const output = join(temporary, "sourcemap.json");
    await execFile(input.executable, ["sourcemap", project, "--output", output], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const metadata = await lstat(output);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024)
      throw new Error("Pinned Rojo sourcemap is not a bounded regular output file");
    return await readFile(output, "utf8");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
