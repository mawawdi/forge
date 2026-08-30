import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { assertFixtureManifest, assertPatchSet, contentHash, type PatchSet, type RelativePath } from "../../contracts/src/index.js";
import { buildSemanticMap, createProjectSnapshot } from "../../semantic-map/src/index.js";

export interface PatchValidationIssue {
  code: "PATCH_BOUNDS_INVALID" | "PATCH_PATH_INVALID" | "PATCH_OPERATION_UNSUPPORTED" | "PATCH_PROJECT_HASH_MISMATCH" | "PATCH_BEFORE_HASH_MISMATCH" | "PATCH_BEFORE_TEXT_MISMATCH";
  path?: RelativePath;
  message: string;
}

export interface PatchApplicationResult {
  patchSetId: string;
  beforeSnapshotHash: string;
  afterSnapshotHash: string;
  changedPaths: RelativePath[];
  addedLines: number;
  removedLines: number;
  destinationRoot: string;
}

export async function sourceSnapshotHash(root: string): Promise<string> {
  const projectRoot = resolve(root);
  const manifest = JSON.parse(await readFile(join(projectRoot, "forge.fixture.json"), "utf8")) as unknown;
  assertFixtureManifest(manifest);
  return createProjectSnapshot(await buildSemanticMap(projectRoot, manifest)).sourceHash;
}

export function validatePatchSet(patchSet: PatchSet): PatchValidationIssue[] {
  const issues: PatchValidationIssue[] = [];
  try {
    assertPatchSet(patchSet);
  } catch (error) {
    issues.push({ code: "PATCH_BOUNDS_INVALID", message: error instanceof Error ? error.message : "Invalid PatchSet" });
    return issues;
  }
  const paths = new Set<string>();
  let unsupported = false;
  for (const operation of patchSet.operations) {
    if (!isProjectRelative(operation.path)) {
      issues.push({ code: "PATCH_PATH_INVALID", path: operation.path, message: `Patch path must stay inside the project root: ${operation.path}` });
    }
    paths.add(operation.path);
    if (operation.type !== "replace_text" && operation.type !== "create_script") unsupported = true;
  }
  if (paths.size > patchSet.bounds.maxFiles) issues.push({ code: "PATCH_BOUNDS_INVALID", message: `Patch changes ${paths.size} files, exceeding maxFiles ${patchSet.bounds.maxFiles}` });
  if (unsupported) issues.push({ code: "PATCH_OPERATION_UNSUPPORTED", message: "M2 only applies replace_text and create_script operations" });
  return issues;
}

export async function applyPatchSet(sourceRoot: string, patchSet: PatchSet, destinationRoot: string): Promise<PatchApplicationResult> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const validation = validatePatchSet(patchSet);
  if (validation.length > 0) throw new Error(validation.map((issue) => issue.message).join("; "));
  if (source === destination || destination.startsWith(`${source}${sep}`)) throw new Error("Patch destination must be outside the source project");
  if (await exists(destination)) throw new Error(`Patch destination already exists: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });

  const beforeSnapshotHash = await sourceSnapshotHash(source);
  if (beforeSnapshotHash !== patchSet.projectHash) throw new Error(`Patch project hash mismatch: expected ${patchSet.projectHash}, found ${beforeSnapshotHash}`);

  const staging = await mkdtemp(join(dirname(destination), `.${basename(destination)}-staging-`));
  try {
    await cp(source, staging, { recursive: true, errorOnExist: false, force: true });
    const changedPaths = new Set<RelativePath>();
    let addedLines = 0;
    let removedLines = 0;
    for (const operation of patchSet.operations) {
      if (operation.type === "replace_text") {
        const target = resolvePatchPath(staging, operation.path);
        const current = await readFile(target, "utf8");
        if (contentHash(current) !== operation.beforeHash) throw new Error(`Patch before hash mismatch for ${operation.path}`);
        if (current !== operation.before) throw new Error(`Patch before text mismatch for ${operation.path}`);
        await writeFile(target, operation.after, "utf8");
        const beforeCount = lineCount(operation.before);
        const afterCount = lineCount(operation.after);
        addedLines += Math.max(0, afterCount - beforeCount);
        removedLines += Math.max(0, beforeCount - afterCount);
        changedPaths.add(operation.path);
      } else if (operation.type === "create_script") {
        const target = resolvePatchPath(staging, operation.path);
        if (await exists(target)) throw new Error(`Patch create target already exists: ${operation.path}`);
        await writeFile(target, operation.source, "utf8");
        addedLines += lineCount(operation.source);
        changedPaths.add(operation.path);
      } else {
        throw new Error(`M2 does not apply operation ${operation.type}`);
      }
    }
    if (addedLines > patchSet.bounds.maxAddedLines || removedLines > patchSet.bounds.maxRemovedLines) throw new Error(`Patch line bounds exceeded: added ${addedLines}/${patchSet.bounds.maxAddedLines}, removed ${removedLines}/${patchSet.bounds.maxRemovedLines}`);
    const afterSnapshotHash = await sourceSnapshotHash(staging);
    await rename(staging, destination);
    return { patchSetId: patchSet.id, beforeSnapshotHash, afterSnapshotHash, changedPaths: [...changedPaths].sort(), addedLines, removedLines, destinationRoot: destination };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function resolvePatchPath(root: string, path: string): string {
  if (!isProjectRelative(path)) throw new Error(`Patch path must stay inside the project root: ${path}`);
  return resolve(root, path);
}

function isProjectRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]+/).includes("..");
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}
