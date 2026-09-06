import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["worker.py", "inspect_blend.py"]) {
  const sourcePath = resolve(repositoryRoot, "workers/blender", name);
  const destinationPath = resolve(repositoryRoot, "dist/workers/blender", name);
  const sourceRealPath = await realpath(sourcePath);
  if (sourceRealPath !== sourcePath) {
    throw new Error("Blender worker source must not contain symbolic links");
  }
  const sourceInfo = await lstat(sourceRealPath);
  if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > 4 * 1024 * 1024) {
    throw new Error("Blender worker source is not a bounded regular file");
  }

  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o755 });
  await copyFile(sourceRealPath, destinationPath, constants.COPYFILE_EXCL);
  const destination = await open(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const destinationInfo = await destination.stat();
    if (!destinationInfo.isFile() || destinationInfo.size !== sourceInfo.size) {
      throw new Error("Published Blender worker does not match its source byte count");
    }
  } finally {
    await destination.close();
  }
}
