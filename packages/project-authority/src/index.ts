/**
 * Project authority is deliberately independent of the creator coordinator and
 * Studio protocol. It proves who owns a source path, makes only guarded
 * filesystem changes, and compares later Studio observations. It never starts
 * Rojo, talks to Studio, or treats a synchronised-looking file as proof.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const ROJO_SOURCE_CLASSES = ["Script", "LocalScript", "ModuleScript"] as const;
export type RojoSourceClass = (typeof ROJO_SOURCE_CLASSES)[number];
export const DEFAULT_ROJO_SOURCE_BYTES = 1024 * 1024;

export type ProjectAuthorityDomain = "studio_transaction" | "rojo_source";

/** The checked-in/user-supplied declaration. All filesystem paths are root-relative. */
export interface ProjectAuthorityManifest {
  readonly kind: "ProjectAuthorityManifest";
  readonly studioRoots: readonly string[];
  readonly rojo?: {
    readonly projectFile: string;
    /** Roots that may contain mapped Luau source. No implicit workspace access. */
    readonly sourceRoots: readonly string[];
  };
}

/**
 * Host-only execution material. `workspaceRoot` is deliberately excluded
 * from all content-addressed artifacts, control views, and model context.
 */
export interface ProjectAuthorityHostContext {
  readonly manifest: ProjectAuthorityManifest;
  readonly workspaceRoot: string;
  readonly rojo?: {
    readonly sourcemap: RojoSourcemapArtifact;
  };
}

export interface RojoToolIdentity {
  readonly version: string;
  readonly binaryHash: string;
}

export interface RojoSourceMapping {
  readonly studioPath: string;
  readonly className: RojoSourceClass;
  /** Private root-relative source path. Never place this value in model context. */
  readonly sourcePath: string;
}

export interface RojoDirectoryMapping {
  readonly studioPath: string;
  /** Private root-relative directory path. Never place this value in model context. */
  readonly directoryPath: string;
}

/** A canonical, exact parse of one pinned Rojo `sourcemap` result. */
export interface RojoSourcemapArtifact {
  readonly kind: "RojoSourcemapArtifact";
  readonly id: string;
  readonly hash: string;
  readonly projectFile: string;
  readonly projectFileHash: string;
  readonly sourceMapHash: string;
  readonly tool: RojoToolIdentity;
  readonly scripts: readonly RojoSourceMapping[];
  readonly directories: readonly RojoDirectoryMapping[];
}

export interface SourceHashEntry {
  readonly studioPath: string;
  readonly className: RojoSourceClass;
  readonly sourceHash: string;
}

/** A source-only, host-path-free Merkle-like revision. */
export interface FilesystemSourceRevision {
  readonly kind: "FilesystemSourceRevision";
  readonly id: string;
  readonly hash: string;
  readonly sourcemapHash: string;
  readonly entries: readonly SourceHashEntry[];
}

/**
 * The immutable authority map persisted with a request. Its mapping entries
 * deliberately retain private filesystem paths for the trusted host only.
 */
export interface ProjectAuthorityMap {
  readonly kind: "ProjectAuthorityMap";
  readonly id: string;
  readonly hash: string;
  readonly projectId: string;
  readonly studioRevisionHash: string;
  readonly manifestHash: string;
  readonly studioRoots: readonly string[];
  readonly rojo?: {
    readonly sourcemap: RojoSourcemapArtifact;
    readonly filesystemRevision: FilesystemSourceRevision;
  };
}

export type RojoSourceOperation =
  | {
      readonly id: string;
      readonly kind: "edit_source";
      readonly studioPath: string;
      readonly className: RojoSourceClass;
      readonly beforeHash: string;
      readonly edits: readonly RojoSourceEdit[];
      readonly finalSourceHash: string;
      readonly finalByteCount: number;
    }
  | {
      readonly id: string;
      readonly kind: "create_source";
      readonly parentStudioPath: string;
      readonly name: string;
      readonly className: RojoSourceClass;
      /** The exact conventional filename under the mapped parent directory. */
      readonly sourcePath: string;
      readonly source: string;
    };

export interface RojoSourceEdit {
  readonly startByte: number;
  readonly endByte: number;
  readonly replacement: string;
}

/** A sealed single-domain source mutation; this is not a Studio change set. */
export interface RojoSourceChangeSet {
  readonly kind: "RojoSourceChangeSet";
  readonly id: string;
  readonly hash: string;
  readonly authority: "rojo_source";
  readonly authorityMapHash: string;
  readonly beforeFilesystemRevisionHash: string;
  readonly beforeStudioRevisionHash: string;
  /** State material excluding every mapped script Source fact. */
  readonly beforeStudioNonSourceHash: string;
  /**
   * Exact expected post-sync material after the permitted source-only script
   * delta. This admits representable new scripts without treating their
   * structure as collateral drift.
   */
  readonly afterStudioNonSourceHash: string;
  readonly maximumSourceBytes: number;
  readonly operations: readonly RojoSourceOperation[];
}

export interface RojoWriteReceipt {
  readonly operationId: string;
  readonly kind: RojoSourceOperation["kind"];
  readonly studioPath: string;
  readonly className: RojoSourceClass;
  readonly sourcePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  /** Retained only in the trusted, immutable creator evidence graph for revert. */
  readonly beforeSource?: string;
  readonly afterSource: string;
}

export interface RojoMutationAttempt {
  readonly kind: "RojoMutationAttempt";
  readonly id: string;
  readonly hash: string;
  readonly status: "applied" | "partially_applied";
  readonly authorityMapHash: string;
  readonly changeSetId: string;
  readonly changeSetHash: string;
  readonly beforeFilesystemRevision: FilesystemSourceRevision;
  readonly afterFilesystemRevision: FilesystemSourceRevision;
  readonly receipts: readonly RojoWriteReceipt[];
  readonly failure?: { readonly code: string; readonly detail: string };
}

export interface RojoSyncObservation {
  readonly complete: boolean;
  readonly studioRevisionHash?: string;
  readonly nonSourceStateHash?: string;
  /** Hashes decoded from complete authoritative Studio evidence, not disk. */
  readonly sourceEntries?: readonly SourceHashEntry[];
}

export interface RojoSyncFailureFact {
  readonly code:
    | "studio_observation_incomplete"
    | "studio_revision_missing"
    | "studio_non_source_drift"
    | "studio_source_mismatch";
  readonly statement: string;
  readonly hash: string;
}

/** The read-only evidence that a filesystem mutation reached Studio exactly. */
export interface RojoSyncProof {
  readonly kind: "RojoSyncProof";
  readonly id: string;
  readonly hash: string;
  readonly status: "matched" | "awaiting_sync" | "mismatched";
  readonly attemptId: string;
  readonly attemptHash: string;
  readonly expectedFilesystemRevisionHash: string;
  readonly observation?: RojoSyncObservation;
  readonly failureFacts: readonly RojoSyncFailureFact[];
}

/** The independent reverse synchronization proof for an explicit revert. */
export interface RojoSourceRevertSyncProof {
  readonly kind: "RojoSourceRevertSyncProof";
  readonly id: string;
  readonly hash: string;
  readonly revertId: string;
  readonly revertHash: string;
  readonly expectedFilesystemRevisionHash: string;
  readonly status: "matched" | "awaiting_sync" | "mismatched";
  readonly observation?: RojoSyncObservation;
  readonly failureFacts: readonly RojoSyncFailureFact[];
}

export interface RojoSourceRevert {
  readonly kind: "RojoSourceRevert";
  readonly id: string;
  readonly hash: string;
  readonly attemptId: string;
  readonly attemptHash: string;
  readonly resultingFilesystemRevision: FilesystemSourceRevision;
  readonly receipts: readonly RojoWriteReceipt[];
}

export interface RojoMutationReplay {
  readonly kind: "RojoMutationReplay";
  readonly id: string;
  readonly hash: string;
  readonly status: "exact_match" | "mismatch" | "incomplete";
  readonly attemptId: string;
  readonly attemptHash: string;
  /** Whether the exact terminal proof covers the forward sync or an explicit revert. */
  readonly finalization: "synced" | "reverted";
  readonly proofId?: string;
  readonly proofHash?: string;
  readonly failureFacts: readonly RojoSyncFailureFact[];
}

export interface CreateAuthorityMapInput {
  readonly projectId: string;
  readonly studioRevisionHash: string;
  readonly manifest: ProjectAuthorityManifest;
  readonly workspaceRoot: string;
  readonly rojo?: {
    readonly sourcemap: RojoSourcemapArtifact;
  };
}

export interface CreateRojoSourcemapInput {
  readonly manifest: ProjectAuthorityManifest;
  readonly projectFileHash: string;
  readonly sourceMapJson: string;
  readonly tool: RojoToolIdentity;
}

export interface CreateRojoSourceChangeSetInput {
  readonly id: string;
  readonly authorityMap: ProjectAuthorityMap;
  readonly beforeStudioRevisionHash: string;
  readonly beforeStudioNonSourceHash: string;
  readonly afterStudioNonSourceHash: string;
  readonly operations: readonly RojoSourceOperation[];
  readonly maxSourceBytes?: number;
}

export interface ApplyRojoSourceChangeSetInput {
  readonly workspaceRoot: string;
  readonly authorityMap: ProjectAuthorityMap;
  readonly changeSet: RojoSourceChangeSet;
}

export interface RevertRojoSourceMutationInput {
  readonly workspaceRoot: string;
  /** Must be outside the source workspace so moved creation backups never sync. */
  readonly recoveryRoot: string;
  readonly authorityMap: ProjectAuthorityMap;
  readonly attempt: RojoMutationAttempt;
}

export class RojoMutationApplyError extends Error {
  public readonly attempt: RojoMutationAttempt;
  constructor(message: string, attempt: RojoMutationAttempt) {
    super(message);
    this.name = "RojoMutationApplyError";
    this.attempt = attempt;
  }
}

export function assertProjectAuthorityManifest(
  value: unknown,
): asserts value is ProjectAuthorityManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "studioRoots", "rojo"]) ||
    value.kind !== "ProjectAuthorityManifest" ||
    !Array.isArray(value.studioRoots)
  )
    fail("Invalid ProjectAuthorityManifest");
  const studioRoots = value.studioRoots;
  if (studioRoots.length === 0 || !studioRoots.every(isStudioPath) || !isSortedUnique(studioRoots))
    fail("Invalid ProjectAuthorityManifest studio roots");
  if (value.rojo === undefined) return;
  if (
    !isRecord(value.rojo) ||
    !hasExactKeys(value.rojo, ["projectFile", "sourceRoots"]) ||
    !isSafeRelative(value.rojo.projectFile) ||
    !Array.isArray(value.rojo.sourceRoots) ||
    !value.rojo.sourceRoots.every(isSafeRelative) ||
    !isSortedUnique(value.rojo.sourceRoots)
  )
    fail("Invalid ProjectAuthorityManifest Rojo declaration");
}

export function assertProjectAuthorityHostContext(
  value: unknown,
): asserts value is ProjectAuthorityHostContext {
  if (
    !isRecord(value) ||
    typeof value.workspaceRoot !== "string" ||
    value.workspaceRoot.trim().length === 0
  )
    fail("Invalid ProjectAuthorityHostContext");
  assertProjectAuthorityManifest(value.manifest);
  if (value.manifest.rojo === undefined) {
    if (value.rojo !== undefined) fail("Studio authority context cannot carry a Rojo sourcemap");
    return;
  }
  if (!isRecord(value.rojo)) fail("Rojo authority context requires a sourcemap");
  assertRojoSourcemapArtifact(value.rojo.sourcemap);
  if (value.rojo.sourcemap.tool.version !== "7.7.0")
    fail("Rojo authority context requires the pinned Rojo 7.7.0 toolchain");
  if (value.rojo.sourcemap.projectFile !== value.manifest.rojo.projectFile)
    fail("Rojo authority context sourcemap binding mismatch");
}

export function createRojoSourcemapArtifact(
  input: CreateRojoSourcemapInput,
): RojoSourcemapArtifact {
  assertProjectAuthorityManifest(input.manifest);
  if (!input.manifest.rojo) fail("Rojo sourcemap requires a Rojo authority declaration");
  assertHash(input.projectFileHash, "Rojo project file hash");
  assertTool(input.tool);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.sourceMapJson) as unknown;
  } catch {
    fail("Rojo sourcemap is not JSON");
  }
  const root = parseSourcemapNode(parsed);
  const scripts: RojoSourceMapping[] = [];
  const directories = new Map<string, string>();
  visitSourcemap(root, [], input.manifest.rojo.sourceRoots, scripts, directories);
  scripts.sort(compareMapping);
  if (new Set(scripts.map((entry) => entry.studioPath)).size !== scripts.length)
    fail("Rojo sourcemap has duplicate Studio script paths");
  if (new Set(scripts.map((entry) => entry.sourcePath)).size !== scripts.length)
    fail("Rojo sourcemap maps one source file to multiple Studio scripts");
  const directoryEntries = [...directories.entries()]
    .map(([studioPath, directoryPath]) => ({ studioPath, directoryPath }))
    .sort(compareDirectory);
  const payload = {
    projectFile: input.manifest.rojo.projectFile,
    projectFileHash: input.projectFileHash,
    sourceMapHash: contentHash(input.sourceMapJson),
    tool: input.tool,
    scripts,
    directories: directoryEntries,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoSourcemapArtifact",
    id: `rojo_sourcemap_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoSourcemapArtifact(
  value: unknown,
): asserts value is RojoSourcemapArtifact {
  if (
    !isRecord(value) ||
    value.kind !== "RojoSourcemapArtifact" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isSafeRelative(value.projectFile) ||
    !isHash(value.projectFileHash) ||
    !isHash(value.sourceMapHash) ||
    !isRecord(value.tool) ||
    !Array.isArray(value.scripts) ||
    !Array.isArray(value.directories)
  )
    fail("Invalid RojoSourcemapArtifact");
  assertTool(value.tool);
  if (
    !value.scripts.every(isRojoSourceMapping) ||
    !value.directories.every(isRojoDirectoryMapping) ||
    !isSorted(value.scripts, compareMapping) ||
    !isSorted(value.directories, compareDirectory)
  )
    fail("Invalid RojoSourcemapArtifact mappings");
  if (
    new Set(value.scripts.map((entry) => entry.studioPath)).size !== value.scripts.length ||
    new Set(value.scripts.map((entry) => entry.sourcePath)).size !== value.scripts.length ||
    new Set(value.directories.map((entry) => entry.studioPath)).size !== value.directories.length
  )
    fail("RojoSourcemapArtifact mappings are not unique");
  const payload = {
    projectFile: value.projectFile,
    projectFileHash: value.projectFileHash,
    sourceMapHash: value.sourceMapHash,
    tool: value.tool,
    scripts: value.scripts,
    directories: value.directories,
  };
  assertContentIdentity(value, "rojo_sourcemap", payload, "RojoSourcemapArtifact");
}

export async function createProjectAuthorityMap(
  input: CreateAuthorityMapInput,
): Promise<ProjectAuthorityMap> {
  assertProjectAuthorityManifest(input.manifest);
  if (!isId(input.projectId)) fail("Invalid project authority project ID");
  assertHash(input.studioRevisionHash, "Studio revision hash");
  const manifestHash = contentHash(stableJson(input.manifest));
  let rojo: ProjectAuthorityMap["rojo"];
  if (input.manifest.rojo) {
    if (!input.rojo) fail("Rojo authority declaration requires a sourcemap artifact");
    assertRojoSourcemapArtifact(input.rojo.sourcemap);
    if (input.rojo.sourcemap.projectFile !== input.manifest.rojo.projectFile)
      fail("Rojo sourcemap project-file binding mismatch");
    await assertSafeExistingFile(input.workspaceRoot, input.manifest.rojo.projectFile);
    const projectFile = await readFile(
      resolveWithin(input.workspaceRoot, input.manifest.rojo.projectFile),
      "utf8",
    );
    if (contentHash(projectFile) !== input.rojo.sourcemap.projectFileHash)
      fail("Rojo project file changed after sourcemap creation");
    const filesystemRevision = await readFilesystemSourceRevision(
      input.workspaceRoot,
      input.rojo.sourcemap,
    );
    rojo = { sourcemap: input.rojo.sourcemap, filesystemRevision };
  } else if (input.rojo !== undefined) {
    fail("Project authority has a sourcemap but no Rojo declaration");
  }
  const payload = {
    projectId: input.projectId,
    studioRevisionHash: input.studioRevisionHash,
    manifestHash,
    studioRoots: [...input.manifest.studioRoots],
    ...(rojo ? { rojo } : {}),
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "ProjectAuthorityMap",
    id: `project_authority_map_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertProjectAuthorityMap(value: unknown): asserts value is ProjectAuthorityMap {
  if (
    !isRecord(value) ||
    value.kind !== "ProjectAuthorityMap" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.projectId) ||
    !isHash(value.studioRevisionHash) ||
    !isHash(value.manifestHash) ||
    !Array.isArray(value.studioRoots) ||
    !value.studioRoots.every(isStudioPath) ||
    !isSortedUnique(value.studioRoots)
  )
    fail("Invalid ProjectAuthorityMap");
  if (value.rojo !== undefined) {
    if (!isRecord(value.rojo)) fail("Invalid ProjectAuthorityMap Rojo authority");
    assertRojoSourcemapArtifact(value.rojo.sourcemap);
    assertFilesystemSourceRevision(value.rojo.filesystemRevision);
    if (value.rojo.filesystemRevision.sourcemapHash !== value.rojo.sourcemap.hash)
      fail("ProjectAuthorityMap filesystem/sourcemap binding mismatch");
  }
  const payload = {
    projectId: value.projectId,
    studioRevisionHash: value.studioRevisionHash,
    manifestHash: value.manifestHash,
    studioRoots: value.studioRoots,
    ...(value.rojo === undefined ? {} : { rojo: value.rojo }),
  };
  assertContentIdentity(value, "project_authority_map", payload, "ProjectAuthorityMap");
}

/**
 * The only authority-map projection that creator ownership needs. It exposes
 * Studio-visible paths, never a workspace root or any filesystem mapping.
 * Callers must pass this exact value while materializing an ownership map;
 * they must not infer ownership from a manifest or from source-path strings.
 */
export function rojoOwnedStudioPaths(
  authorityMap: ProjectAuthorityMap,
): readonly string[] | undefined {
  assertProjectAuthorityMap(authorityMap);
  if (authorityMap.rojo === undefined) return undefined;
  return [
    ...new Set([
      ...authorityMap.rojo.sourcemap.directories.map((entry) => entry.studioPath),
      ...authorityMap.rojo.sourcemap.scripts.map((entry) => entry.studioPath),
    ]),
  ].sort();
}

export async function readFilesystemSourceRevision(
  workspaceRoot: string,
  sourcemap: RojoSourcemapArtifact,
): Promise<FilesystemSourceRevision> {
  assertRojoSourcemapArtifact(sourcemap);
  const entries: SourceHashEntry[] = [];
  for (const mapping of sourcemap.scripts) {
    await assertSafeExistingFile(workspaceRoot, mapping.sourcePath);
    const source = await readFile(resolveWithin(workspaceRoot, mapping.sourcePath), "utf8");
    entries.push({
      studioPath: mapping.studioPath,
      className: mapping.className,
      sourceHash: contentHash(source),
    });
  }
  return createFilesystemSourceRevision(sourcemap.hash, entries);
}

export function createFilesystemSourceRevision(
  sourcemapHash: string,
  entries: readonly SourceHashEntry[],
): FilesystemSourceRevision {
  assertHash(sourcemapHash, "Filesystem source revision sourcemap hash");
  if (!entries.every(isSourceHashEntry)) fail("Invalid filesystem source revision entry");
  const canonical = [...entries].sort(compareSourceEntry);
  if (new Set(canonical.map((entry) => entry.studioPath)).size !== canonical.length)
    fail("Filesystem source revision has duplicate Studio paths");
  const payload = { sourcemapHash, entries: canonical };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "FilesystemSourceRevision",
    id: `filesystem_source_revision_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertFilesystemSourceRevision(
  value: unknown,
): asserts value is FilesystemSourceRevision {
  if (
    !isRecord(value) ||
    value.kind !== "FilesystemSourceRevision" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isHash(value.sourcemapHash) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isSourceHashEntry) ||
    !isSorted(value.entries, compareSourceEntry)
  )
    fail("Invalid FilesystemSourceRevision");
  if (new Set(value.entries.map((entry) => entry.studioPath)).size !== value.entries.length)
    fail("FilesystemSourceRevision has duplicate Studio paths");
  assertContentIdentity(
    value,
    "filesystem_source_revision",
    { sourcemapHash: value.sourcemapHash, entries: value.entries },
    "FilesystemSourceRevision",
  );
}

export function createRojoSourceChangeSet(
  input: CreateRojoSourceChangeSetInput,
): RojoSourceChangeSet {
  assertProjectAuthorityMap(input.authorityMap);
  if (!input.authorityMap.rojo) fail("Rojo source change set requires a Rojo authority map");
  if (!isId(input.id)) fail("Invalid Rojo source change-set ID");
  assertHash(input.beforeStudioRevisionHash, "Rojo source change-set Studio revision");
  assertHash(input.beforeStudioNonSourceHash, "Rojo source change-set non-source state hash");
  assertHash(
    input.afterStudioNonSourceHash,
    "Rojo source change-set post-sync non-source state hash",
  );
  const maxSourceBytes = input.maxSourceBytes ?? DEFAULT_ROJO_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
    fail("Invalid Rojo source byte limit");
  const operations = [...input.operations];
  if (
    operations.length === 0 ||
    !operations.every((operation) => isRojoSourceOperation(operation, maxSourceBytes))
  )
    fail("Invalid Rojo source change-set operation");
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
    fail("Rojo source change-set has duplicate operation IDs");
  const writeTargets = new Set<string>();
  for (const operation of operations) {
    const target =
      operation.kind === "edit_source"
        ? operation.studioPath
        : `${operation.parentStudioPath}/${operation.name}`;
    if (writeTargets.has(target)) fail("Rojo source change-set has duplicate Studio targets");
    writeTargets.add(target);
    assertOperationAgainstAuthority(operation, input.authorityMap.rojo.sourcemap);
    if (operation.kind === "edit_source") {
      const before = input.authorityMap.rojo.filesystemRevision.entries.find(
        (entry) =>
          entry.studioPath === operation.studioPath && entry.className === operation.className,
      );
      if (!before || before.sourceHash !== operation.beforeHash)
        fail("Rojo write source precondition does not match the authority-map revision");
    }
  }
  assertSingleAuthorityDomain(["rojo_source"]);
  const payload = {
    authority: "rojo_source" as const,
    authorityMapHash: input.authorityMap.hash,
    beforeFilesystemRevisionHash: input.authorityMap.rojo.filesystemRevision.hash,
    beforeStudioRevisionHash: input.beforeStudioRevisionHash,
    beforeStudioNonSourceHash: input.beforeStudioNonSourceHash,
    afterStudioNonSourceHash: input.afterStudioNonSourceHash,
    maximumSourceBytes: maxSourceBytes,
    operations,
  };
  const hash = contentHash(stableJson(payload));
  return { kind: "RojoSourceChangeSet", id: input.id, hash, ...payload };
}

export function assertRojoSourceChangeSet(value: unknown): asserts value is RojoSourceChangeSet {
  if (
    !isRecord(value) ||
    value.kind !== "RojoSourceChangeSet" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    value.authority !== "rojo_source" ||
    !isHash(value.authorityMapHash) ||
    !isHash(value.beforeFilesystemRevisionHash) ||
    !isHash(value.beforeStudioRevisionHash) ||
    !isHash(value.beforeStudioNonSourceHash) ||
    !isHash(value.afterStudioNonSourceHash) ||
    !Number.isSafeInteger(value.maximumSourceBytes) ||
    Number(value.maximumSourceBytes) <= 0 ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    !value.operations.every((operation) =>
      isRojoSourceOperation(operation, Number(value.maximumSourceBytes)),
    )
  )
    fail("Invalid RojoSourceChangeSet");
  if (new Set(value.operations.map((operation) => operation.id)).size !== value.operations.length)
    fail("RojoSourceChangeSet has duplicate operation IDs");
  const payload = {
    authority: value.authority,
    authorityMapHash: value.authorityMapHash,
    beforeFilesystemRevisionHash: value.beforeFilesystemRevisionHash,
    beforeStudioRevisionHash: value.beforeStudioRevisionHash,
    beforeStudioNonSourceHash: value.beforeStudioNonSourceHash,
    afterStudioNonSourceHash: value.afterStudioNonSourceHash,
    maximumSourceBytes: value.maximumSourceBytes,
    operations: value.operations,
  };
  if (value.hash !== contentHash(stableJson(payload))) fail("Invalid RojoSourceChangeSet identity");
}

export function assertSingleAuthorityDomain(domains: readonly ProjectAuthorityDomain[]): void {
  if (domains.length !== 1 || new Set(domains).size !== 1)
    fail("A creator change set must have exactly one authority domain");
}

export async function applyRojoSourceChangeSet(
  input: ApplyRojoSourceChangeSetInput,
): Promise<RojoMutationAttempt> {
  assertProjectAuthorityMap(input.authorityMap);
  assertRojoSourceChangeSet(input.changeSet);
  const rojo = input.authorityMap.rojo;
  if (!rojo) fail("Rojo source mutation requires a Rojo authority map");
  if (
    input.changeSet.authorityMapHash !== input.authorityMap.hash ||
    input.changeSet.beforeFilesystemRevisionHash !== rojo.filesystemRevision.hash
  )
    fail("Rojo source mutation authority/revision binding mismatch");
  for (const operation of input.changeSet.operations)
    assertOperationAgainstAuthority(operation, rojo.sourcemap);
  const current = await readFilesystemSourceRevision(input.workspaceRoot, rojo.sourcemap);
  if (current.hash !== rojo.filesystemRevision.hash)
    fail("Rojo source filesystem drift before apply");
  // Fully preflight before the first source write. There is no automatic
  // rollback when an OS-level write later fails; callers persist the partial
  // attempt carried by RojoMutationApplyError.
  for (const operation of input.changeSet.operations)
    await assertFilesystemOperationPrecondition(input.workspaceRoot, operation, rojo.sourcemap);
  const receipts: RojoWriteReceipt[] = [];
  try {
    for (const operation of input.changeSet.operations) {
      const receipt = await applyFilesystemOperation(
        input.workspaceRoot,
        operation,
        rojo.sourcemap,
      );
      receipts.push(receipt);
    }
  } catch (error) {
    const after = await readFilesystemSourceRevisionAfterChangeSet(
      input.workspaceRoot,
      rojo.sourcemap,
      input.changeSet,
    );
    const attempt = createRojoMutationAttempt({
      status: "partially_applied",
      authorityMapHash: input.authorityMap.hash,
      changeSet: input.changeSet,
      beforeFilesystemRevision: rojo.filesystemRevision,
      afterFilesystemRevision: after,
      receipts,
      failure: { code: "filesystem_write_failed", detail: boundedError(error) },
    });
    throw new RojoMutationApplyError("Rojo source mutation was only partially applied", attempt);
  }
  const after = await readFilesystemSourceRevisionAfterChangeSet(
    input.workspaceRoot,
    rojo.sourcemap,
    input.changeSet,
  );
  return createRojoMutationAttempt({
    status: "applied",
    authorityMapHash: input.authorityMap.hash,
    changeSet: input.changeSet,
    beforeFilesystemRevision: rojo.filesystemRevision,
    afterFilesystemRevision: after,
    receipts,
  });
}

export function createRojoMutationAttempt(input: {
  readonly status: RojoMutationAttempt["status"];
  readonly authorityMapHash: string;
  readonly changeSet: RojoSourceChangeSet;
  readonly beforeFilesystemRevision: FilesystemSourceRevision;
  readonly afterFilesystemRevision: FilesystemSourceRevision;
  readonly receipts: readonly RojoWriteReceipt[];
  readonly failure?: { readonly code: string; readonly detail: string };
}): RojoMutationAttempt {
  assertRojoSourceChangeSet(input.changeSet);
  assertHash(input.authorityMapHash, "Rojo mutation attempt authority map hash");
  assertFilesystemSourceRevision(input.beforeFilesystemRevision);
  assertFilesystemSourceRevision(input.afterFilesystemRevision);
  if (!input.receipts.every(isRojoWriteReceipt)) fail("Invalid Rojo mutation receipt");
  if (input.status === "applied" && input.receipts.length !== input.changeSet.operations.length)
    fail("Applied Rojo mutation must have every receipt");
  if (
    input.status === "partially_applied" &&
    input.receipts.length >= input.changeSet.operations.length
  )
    fail("Partially applied Rojo mutation has an invalid receipt count");
  if (
    input.failure !== undefined &&
    (!isNonEmpty(input.failure.code) || !isNonEmpty(input.failure.detail))
  )
    fail("Invalid Rojo mutation failure");
  assertReceiptsAgainstChangeSet(input.receipts, input.changeSet.operations);
  const expectedAfter = deriveFilesystemRevisionForOperations(
    input.beforeFilesystemRevision,
    input.changeSet.operations.slice(0, input.receipts.length),
    input.afterFilesystemRevision.sourcemapHash,
  );
  if (expectedAfter.hash !== input.afterFilesystemRevision.hash)
    fail("Rojo mutation attempt receipts do not reproduce the resulting filesystem revision");
  const payload = {
    status: input.status,
    authorityMapHash: input.authorityMapHash,
    changeSetId: input.changeSet.id,
    changeSetHash: input.changeSet.hash,
    beforeFilesystemRevision: input.beforeFilesystemRevision,
    afterFilesystemRevision: input.afterFilesystemRevision,
    receipts: [...input.receipts],
    ...(input.failure ? { failure: input.failure } : {}),
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoMutationAttempt",
    id: `rojo_mutation_attempt_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoMutationAttempt(value: unknown): asserts value is RojoMutationAttempt {
  if (
    !isRecord(value) ||
    value.kind !== "RojoMutationAttempt" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !["applied", "partially_applied"].includes(String(value.status)) ||
    !isHash(value.authorityMapHash) ||
    !isId(value.changeSetId) ||
    !isHash(value.changeSetHash) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every(isRojoWriteReceipt)
  )
    fail("Invalid RojoMutationAttempt");
  assertFilesystemSourceRevision(value.beforeFilesystemRevision);
  assertFilesystemSourceRevision(value.afterFilesystemRevision);
  if (
    value.failure !== undefined &&
    (!isRecord(value.failure) ||
      !isNonEmpty(value.failure.code) ||
      !isNonEmpty(value.failure.detail))
  )
    fail("Invalid RojoMutationAttempt failure");
  const payload = {
    status: value.status,
    authorityMapHash: value.authorityMapHash,
    changeSetId: value.changeSetId,
    changeSetHash: value.changeSetHash,
    beforeFilesystemRevision: value.beforeFilesystemRevision,
    afterFilesystemRevision: value.afterFilesystemRevision,
    receipts: value.receipts,
    ...(value.failure === undefined ? {} : { failure: value.failure }),
  };
  assertContentIdentity(value, "rojo_mutation_attempt", payload, "RojoMutationAttempt");
}

export function createRojoSyncProof(input: {
  readonly attempt: RojoMutationAttempt;
  readonly changeSet: RojoSourceChangeSet;
  readonly observation?: RojoSyncObservation;
}): RojoSyncProof {
  assertRojoMutationAttempt(input.attempt);
  assertRojoSourceChangeSet(input.changeSet);
  if (
    input.attempt.changeSetId !== input.changeSet.id ||
    input.attempt.changeSetHash !== input.changeSet.hash
  )
    fail("Rojo sync proof change-set binding mismatch");
  const observation = input.observation;
  const failureFacts: RojoSyncFailureFact[] = [];
  let status: RojoSyncProof["status"];
  if (!observation || !observation.complete) {
    if (observation) assertRojoSyncObservation(observation);
    status = "awaiting_sync";
    failureFacts.push(
      failureFact(
        "studio_observation_incomplete",
        "Studio has not supplied complete authoritative evidence for this source mutation.",
      ),
    );
  } else {
    assertRojoSyncObservation(observation);
    if (!observation.studioRevisionHash)
      failureFacts.push(
        failureFact(
          "studio_revision_missing",
          "Studio sync observation did not carry a revision hash.",
        ),
      );
    if (observation.nonSourceStateHash !== input.changeSet.afterStudioNonSourceHash)
      failureFacts.push(
        failureFact(
          "studio_non_source_drift",
          "Studio changed facts outside the approved Rojo source delta.",
        ),
      );
    const observed = createFilesystemSourceRevision(
      input.attempt.afterFilesystemRevision.sourcemapHash,
      observation.sourceEntries ?? [],
    );
    if (observed.hash !== input.attempt.afterFilesystemRevision.hash)
      failureFacts.push(
        failureFact(
          "studio_source_mismatch",
          "Studio source facts do not exactly match the approved filesystem source revision.",
        ),
      );
    status = failureFacts.length === 0 ? "matched" : "mismatched";
  }
  const payload = {
    status,
    attemptId: input.attempt.id,
    attemptHash: input.attempt.hash,
    expectedFilesystemRevisionHash: input.attempt.afterFilesystemRevision.hash,
    ...(observation ? { observation: cloneObservation(observation) } : {}),
    failureFacts,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoSyncProof",
    id: `rojo_sync_proof_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoSyncProof(value: unknown): asserts value is RojoSyncProof {
  if (
    !isRecord(value) ||
    value.kind !== "RojoSyncProof" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !["matched", "awaiting_sync", "mismatched"].includes(String(value.status)) ||
    !isId(value.attemptId) ||
    !isHash(value.attemptHash) ||
    !isHash(value.expectedFilesystemRevisionHash) ||
    !Array.isArray(value.failureFacts) ||
    !value.failureFacts.every(isRojoSyncFailureFact)
  )
    fail("Invalid RojoSyncProof");
  if (value.observation !== undefined) assertRojoSyncObservation(value.observation);
  const payload = {
    status: value.status,
    attemptId: value.attemptId,
    attemptHash: value.attemptHash,
    expectedFilesystemRevisionHash: value.expectedFilesystemRevisionHash,
    ...(value.observation === undefined ? {} : { observation: value.observation }),
    failureFacts: value.failureFacts,
  };
  assertContentIdentity(value, "rojo_sync_proof", payload, "RojoSyncProof");
}

/**
 * Grade a complete Studio readback of an explicit filesystem revert. This is
 * deliberately a separate proof: a forward source-sync receipt can never be
 * reinterpreted as evidence that a rollback reached Studio.
 */
export function createRojoSourceRevertSyncProof(input: {
  readonly revert: RojoSourceRevert;
  readonly changeSet: RojoSourceChangeSet;
  readonly observation?: RojoSyncObservation;
}): RojoSourceRevertSyncProof {
  assertRojoSourceRevert(input.revert);
  assertRojoSourceChangeSet(input.changeSet);
  if (
    input.revert.attemptId.length === 0 ||
    input.revert.resultingFilesystemRevision.hash !== input.changeSet.beforeFilesystemRevisionHash
  )
    fail("Rojo source revert proof binding mismatch");
  const observation = input.observation;
  const failureFacts: RojoSyncFailureFact[] = [];
  let status: RojoSourceRevertSyncProof["status"];
  if (!observation || !observation.complete) {
    if (observation) assertRojoSyncObservation(observation);
    status = "awaiting_sync";
    failureFacts.push(
      failureFact(
        "studio_observation_incomplete",
        "Studio has not supplied complete authoritative evidence for this source revert.",
      ),
    );
  } else {
    assertRojoSyncObservation(observation);
    if (!observation.studioRevisionHash)
      failureFacts.push(
        failureFact(
          "studio_revision_missing",
          "Studio revert observation did not carry a revision hash.",
        ),
      );
    if (observation.nonSourceStateHash !== input.changeSet.beforeStudioNonSourceHash)
      failureFacts.push(
        failureFact(
          "studio_non_source_drift",
          "Studio changed facts outside the reversed Rojo source delta.",
        ),
      );
    const observed = createFilesystemSourceRevision(
      input.revert.resultingFilesystemRevision.sourcemapHash,
      observation.sourceEntries ?? [],
    );
    if (observed.hash !== input.revert.resultingFilesystemRevision.hash)
      failureFacts.push(
        failureFact(
          "studio_source_mismatch",
          "Studio source facts do not exactly match the reverted filesystem source revision.",
        ),
      );
    status = failureFacts.length === 0 ? "matched" : "mismatched";
  }
  const payload = {
    revertId: input.revert.id,
    revertHash: input.revert.hash,
    expectedFilesystemRevisionHash: input.revert.resultingFilesystemRevision.hash,
    status,
    ...(observation ? { observation: cloneObservation(observation) } : {}),
    failureFacts,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoSourceRevertSyncProof",
    id: `rojo_source_revert_sync_proof_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoSourceRevertSyncProof(
  value: unknown,
): asserts value is RojoSourceRevertSyncProof {
  if (
    !isRecord(value) ||
    value.kind !== "RojoSourceRevertSyncProof" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.revertId) ||
    !isHash(value.revertHash) ||
    !isHash(value.expectedFilesystemRevisionHash) ||
    !["matched", "awaiting_sync", "mismatched"].includes(String(value.status)) ||
    !Array.isArray(value.failureFacts) ||
    !value.failureFacts.every(isRojoSyncFailureFact)
  )
    fail("Invalid RojoSourceRevertSyncProof");
  if (value.observation !== undefined) assertRojoSyncObservation(value.observation);
  assertContentIdentity(
    value,
    "rojo_source_revert_sync_proof",
    {
      revertId: value.revertId,
      revertHash: value.revertHash,
      expectedFilesystemRevisionHash: value.expectedFilesystemRevisionHash,
      status: value.status,
      ...(value.observation === undefined ? {} : { observation: value.observation }),
      failureFacts: value.failureFacts,
    },
    "RojoSourceRevertSyncProof",
  );
}

/** Verify a persisted proof without filesystem, Studio, provider, or network access. */
export function replayRojoMutation(input: {
  readonly changeSet: RojoSourceChangeSet;
  readonly attempt: RojoMutationAttempt;
  readonly syncProof?: RojoSyncProof;
  readonly revert?: RojoSourceRevert;
  readonly revertSyncProof?: RojoSourceRevertSyncProof;
}): RojoMutationReplay {
  let status: RojoMutationReplay["status"] = "exact_match";
  let finalization: RojoMutationReplay["finalization"] = "synced";
  const facts: RojoSyncFailureFact[] = [];
  let proofId: string | undefined;
  let proofHash: string | undefined;
  try {
    assertRojoSourceChangeSet(input.changeSet);
    assertRojoMutationAttempt(input.attempt);
    if (
      input.attempt.changeSetId !== input.changeSet.id ||
      input.attempt.changeSetHash !== input.changeSet.hash
    )
      fail("Mutation attempt change-set binding mismatch");
    assertReceiptsAgainstChangeSet(input.attempt.receipts, input.changeSet.operations);
    if (
      input.attempt.status === "applied" &&
      input.attempt.receipts.length !== input.changeSet.operations.length
    )
      fail("Applied mutation attempt does not retain every source receipt");
    const expectedAfter = deriveFilesystemRevisionForOperations(
      input.attempt.beforeFilesystemRevision,
      input.changeSet.operations.slice(0, input.attempt.receipts.length),
      input.attempt.afterFilesystemRevision.sourcemapHash,
    );
    if (expectedAfter.hash !== input.attempt.afterFilesystemRevision.hash)
      fail("Mutation attempt filesystem receipt does not reproduce its resulting revision");
    if (input.revert) {
      finalization = "reverted";
      assertRojoSourceRevert(input.revert);
      if (
        input.revert.attemptId !== input.attempt.id ||
        input.revert.attemptHash !== input.attempt.hash ||
        input.revert.resultingFilesystemRevision.hash !==
          input.changeSet.beforeFilesystemRevisionHash
      )
        fail(
          "Rojo source revert does not bind the exact mutation attempt or pre-mutation revision",
        );
      if (!input.revertSyncProof) {
        status = "incomplete";
        facts.push(
          failureFact(
            "studio_observation_incomplete",
            "No immutable Studio reverse-sync proof was retained.",
          ),
        );
      } else {
        assertRojoSourceRevertSyncProof(input.revertSyncProof);
        const replayedProof = createRojoSourceRevertSyncProof({
          revert: input.revert,
          changeSet: input.changeSet,
          ...(input.revertSyncProof.observation
            ? { observation: input.revertSyncProof.observation }
            : {}),
        });
        if (replayedProof.hash !== input.revertSyncProof.hash)
          fail("Rojo reverse-sync proof does not replay exactly");
        proofId = input.revertSyncProof.id;
        proofHash = input.revertSyncProof.hash;
        facts.push(...replayedProof.failureFacts);
        status =
          replayedProof.status === "matched"
            ? "exact_match"
            : replayedProof.status === "awaiting_sync"
              ? "incomplete"
              : "mismatch";
      }
    } else if (!input.syncProof) {
      status = "incomplete";
      facts.push(
        failureFact(
          "studio_observation_incomplete",
          "No immutable Studio sync proof was retained.",
        ),
      );
    } else {
      assertRojoSyncProof(input.syncProof);
      const replayedProof = createRojoSyncProof({
        attempt: input.attempt,
        changeSet: input.changeSet,
        ...(input.syncProof.observation ? { observation: input.syncProof.observation } : {}),
      });
      if (replayedProof.hash !== input.syncProof.hash)
        fail("Rojo sync proof does not replay exactly");
      proofId = input.syncProof.id;
      proofHash = input.syncProof.hash;
      facts.push(...replayedProof.failureFacts);
      status =
        replayedProof.status === "matched"
          ? "exact_match"
          : replayedProof.status === "awaiting_sync"
            ? "incomplete"
            : "mismatch";
    }
  } catch (error) {
    status = "mismatch";
    facts.push(failureFact("studio_source_mismatch", boundedError(error)));
  }
  const payload = {
    status,
    attemptId: input.attempt.id,
    attemptHash: input.attempt.hash,
    finalization,
    ...(proofId && proofHash ? { proofId, proofHash } : {}),
    failureFacts: facts,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoMutationReplay",
    id: `rojo_mutation_replay_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoMutationReplay(value: unknown): asserts value is RojoMutationReplay {
  if (
    !isRecord(value) ||
    value.kind !== "RojoMutationReplay" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !["exact_match", "mismatch", "incomplete"].includes(String(value.status)) ||
    !isId(value.attemptId) ||
    !isHash(value.attemptHash) ||
    !["synced", "reverted"].includes(String(value.finalization)) ||
    !Array.isArray(value.failureFacts) ||
    !value.failureFacts.every(isRojoSyncFailureFact) ||
    (value.proofId !== undefined && !isId(value.proofId)) ||
    (value.proofHash !== undefined && !isHash(value.proofHash))
  )
    fail("Invalid RojoMutationReplay");
  const payload = {
    status: value.status,
    attemptId: value.attemptId,
    attemptHash: value.attemptHash,
    finalization: value.finalization,
    ...(value.proofId === undefined ? {} : { proofId: value.proofId }),
    ...(value.proofHash === undefined ? {} : { proofHash: value.proofHash }),
    failureFacts: value.failureFacts,
  };
  assertContentIdentity(value, "rojo_mutation_replay", payload, "RojoMutationReplay");
}

export async function revertRojoSourceMutation(
  input: RevertRojoSourceMutationInput,
): Promise<RojoSourceRevert> {
  assertProjectAuthorityMap(input.authorityMap);
  assertRojoMutationAttempt(input.attempt);
  const rojo = input.authorityMap.rojo;
  if (!rojo || input.attempt.authorityMapHash !== input.authorityMap.hash)
    fail("Rojo source revert authority binding mismatch");
  if (input.attempt.receipts.length === 0)
    fail("Rojo source revert requires at least one guarded write receipt");
  if (isInside(resolve(input.workspaceRoot), resolve(input.recoveryRoot)))
    fail("Rojo source recovery root must be outside the source workspace");
  await ensureSafeDirectory(input.recoveryRoot);
  // Check every post-write hash first. Do not overwrite manual edits during a
  // creator-authorised rollback.
  for (const receipt of input.attempt.receipts)
    await assertReceiptStillCurrent(input.workspaceRoot, receipt);
  const reversed: RojoWriteReceipt[] = [];
  for (const receipt of [...input.attempt.receipts].reverse()) {
    const target = resolveWithin(input.workspaceRoot, receipt.sourcePath);
    if (receipt.kind === "edit_source") {
      if (receipt.beforeSource === undefined || receipt.beforeHash === null)
        fail("Rojo write receipt lacks reversible before-source evidence");
      await atomicReplace(
        input.workspaceRoot,
        receipt.sourcePath,
        receipt.afterHash,
        receipt.beforeSource,
      );
      reversed.push({
        ...receipt,
        beforeHash: receipt.afterHash,
        afterHash: receipt.beforeHash,
        beforeSource: receipt.afterSource,
        afterSource: receipt.beforeSource,
      });
    } else {
      const backup = resolveRecoveryPath(input.recoveryRoot, input.attempt.id, receipt.sourcePath);
      await ensureSafeParentForNewPath(input.recoveryRoot, backup);
      await rename(target, backup);
      reversed.push({
        ...receipt,
        beforeHash: receipt.afterHash,
        afterHash: receipt.beforeHash ?? contentHash(""),
        beforeSource: receipt.afterSource,
        afterSource: receipt.beforeSource ?? "",
      });
    }
  }
  const resultingFilesystemRevision = await readFilesystemSourceRevision(
    input.workspaceRoot,
    rojo.sourcemap,
  );
  const payload = {
    attemptId: input.attempt.id,
    attemptHash: input.attempt.hash,
    resultingFilesystemRevision,
    receipts: reversed,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "RojoSourceRevert",
    id: `rojo_source_revert_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertRojoSourceRevert(value: unknown): asserts value is RojoSourceRevert {
  if (
    !isRecord(value) ||
    value.kind !== "RojoSourceRevert" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    !isId(value.attemptId) ||
    !isHash(value.attemptHash) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every(isRojoWriteReceipt)
  )
    fail("Invalid RojoSourceRevert");
  assertFilesystemSourceRevision(value.resultingFilesystemRevision);
  assertContentIdentity(
    value,
    "rojo_source_revert",
    {
      attemptId: value.attemptId,
      attemptHash: value.attemptHash,
      resultingFilesystemRevision: value.resultingFilesystemRevision,
      receipts: value.receipts,
    },
    "RojoSourceRevert",
  );
}

interface RojoSourcemapNode {
  readonly name: string;
  readonly className: string;
  readonly filePaths: readonly string[];
  readonly children: readonly RojoSourcemapNode[];
}

function parseSourcemapNode(value: unknown): RojoSourcemapNode {
  if (!isRecord(value) || !isNonEmpty(value.name) || !isNonEmpty(value.className))
    fail("Invalid Rojo sourcemap node");
  const filePaths =
    value.filePaths === undefined ? [] : stringArray(value.filePaths, "Rojo sourcemap filePaths");
  if (!filePaths.every(isSafeRelative)) fail("Rojo sourcemap file path is unsafe");
  const children =
    value.children === undefined
      ? []
      : array(value.children, "Rojo sourcemap children").map(parseSourcemapNode);
  if (new Set(children.map((child) => child.name)).size !== children.length)
    fail("Rojo sourcemap node has duplicate child names");
  return { name: value.name, className: value.className, filePaths, children };
}

function visitSourcemap(
  node: RojoSourcemapNode,
  parents: readonly string[],
  sourceRoots: readonly string[],
  scripts: RojoSourceMapping[],
  directories: Map<string, string>,
): void {
  const current =
    node.className === "DataModel" && parents.length === 0 ? [] : [...parents, node.name];
  const studioPath = current.join("/");
  // Rojo records `$path` directory ownership in `filePaths` too. Retain only
  // root-contained candidates here; the guarded creation preflight later
  // proves that the candidate is an actual regular directory before use.
  if (isStudioPath(studioPath)) {
    for (const path of node.filePaths)
      if (
        !isLuauFile(path) &&
        sourceRoots.some((root) => path === root || path.startsWith(`${root}/`))
      )
        registerDirectoryMapping(directories, studioPath, path);
  }
  if (ROJO_SOURCE_CLASSES.includes(node.className as RojoSourceClass)) {
    const sourceFiles = node.filePaths.filter(isLuauFile);
    if (sourceFiles.length !== 1)
      fail(`Rojo script ${studioPath} must have exactly one mapped Luau source file`);
    const sourcePath = sourceFiles[0]!;
    if (!sourceRoots.some((root) => sourcePath === root || sourcePath.startsWith(`${root}/`)))
      fail(`Rojo script ${studioPath} escapes declared source roots`);
    const className = node.className as RojoSourceClass;
    if (!sourceFileMatchesClass(sourcePath, className))
      fail(`Rojo script ${studioPath} source suffix does not match ${className}`);
    if (!isStudioPath(studioPath)) fail("Rojo sourcemap produced an unsafe Studio path");
    scripts.push({ studioPath, className, sourcePath });
    const parentPath = current.slice(0, -1).join("/");
    if (isStudioPath(parentPath))
      registerDirectoryMapping(directories, parentPath, dirname(sourcePath));
  }
  for (const child of node.children)
    visitSourcemap(child, current, sourceRoots, scripts, directories);
}

function registerDirectoryMapping(
  map: Map<string, string>,
  studioPath: string,
  directoryPath: string,
): void {
  const current = map.get(studioPath);
  if (current !== undefined && current !== directoryPath)
    fail(`Rojo Studio parent ${studioPath} maps to more than one filesystem directory`);
  map.set(studioPath, directoryPath);
}

function assertOperationAgainstAuthority(
  operation: RojoSourceOperation,
  sourcemap: RojoSourcemapArtifact,
): void {
  if (operation.kind === "edit_source") {
    const mapping = sourcemap.scripts.find((entry) => entry.studioPath === operation.studioPath);
    if (!mapping || mapping.className !== operation.className)
      fail("Rojo write target is not an exact mapped script");
    if (!isHash(operation.beforeHash)) fail("Rojo write source precondition is invalid");
    return;
  }
  const directory = sourcemap.directories.find(
    (entry) => entry.studioPath === operation.parentStudioPath,
  );
  if (!directory) fail("Rojo create parent is not a representable mapped directory");
  const expectedPath = `${directory.directoryPath}/${rojoSourceFilename(operation.name, operation.className)}`;
  if (operation.sourcePath !== expectedPath)
    fail("Rojo create source path is not the exact conventional mapped path");
  if (
    sourcemap.scripts.some(
      (entry) =>
        entry.sourcePath === operation.sourcePath ||
        entry.studioPath === `${operation.parentStudioPath}/${operation.name}`,
    )
  )
    fail("Rojo create target already exists in the sourcemap");
}

async function assertFilesystemOperationPrecondition(
  workspaceRoot: string,
  operation: RojoSourceOperation,
  sourcemap: RojoSourcemapArtifact,
): Promise<void> {
  const sourcePath =
    operation.kind === "edit_source"
      ? sourceMappingFor(operation, sourcemap).sourcePath
      : operation.sourcePath;
  const target = resolveWithin(workspaceRoot, sourcePath);
  if (operation.kind === "edit_source") {
    await assertSafeExistingFile(workspaceRoot, sourcePath);
    const source = await readFile(target, "utf8");
    if (contentHash(source) !== operation.beforeHash)
      fail("Rojo source write precondition hash does not match");
  } else {
    await assertSafeParentForNewPath(workspaceRoot, target);
    if (await pathExists(target)) fail("Rojo source create target already exists");
  }
}

async function applyFilesystemOperation(
  workspaceRoot: string,
  operation: RojoSourceOperation,
  sourcemap: RojoSourcemapArtifact,
): Promise<RojoWriteReceipt> {
  if (operation.kind === "edit_source") {
    const mapping = sourceMappingFor(operation, sourcemap);
    const target = resolveWithin(workspaceRoot, mapping.sourcePath);
    const beforeSource = await readFile(target, "utf8");
    const afterSource = applyRojoSourceEdits(beforeSource, operation.edits);
    if (
      contentHash(afterSource) !== operation.finalSourceHash ||
      Buffer.byteLength(afterSource, "utf8") !== operation.finalByteCount
    )
      fail("Rojo source edit final hash or byte count is not reproducible");
    await atomicReplace(workspaceRoot, mapping.sourcePath, operation.beforeHash, afterSource);
    return {
      operationId: operation.id,
      kind: operation.kind,
      studioPath: operation.studioPath,
      className: operation.className,
      sourcePath: mapping.sourcePath,
      beforeHash: operation.beforeHash,
      afterHash: operation.finalSourceHash,
      beforeSource,
      afterSource,
    };
  }
  await createAbsentFile(workspaceRoot, operation.sourcePath, operation.source);
  return {
    operationId: operation.id,
    kind: operation.kind,
    studioPath: `${operation.parentStudioPath}/${operation.name}`,
    className: operation.className,
    sourcePath: operation.sourcePath,
    beforeHash: null,
    afterHash: contentHash(operation.source),
    afterSource: operation.source,
  };
}

async function readFilesystemSourceRevisionAfterChangeSet(
  workspaceRoot: string,
  sourcemap: RojoSourcemapArtifact,
  changeSet: RojoSourceChangeSet,
): Promise<FilesystemSourceRevision> {
  const entries = new Map(
    (await readFilesystemSourceRevision(workspaceRoot, sourcemap)).entries.map((entry) => [
      entry.studioPath,
      entry,
    ]),
  );
  for (const operation of changeSet.operations) {
    if (operation.kind !== "create_source") continue;
    const target = resolveWithin(workspaceRoot, operation.sourcePath);
    if (!(await pathExists(target))) continue;
    await assertSafeExistingFile(workspaceRoot, operation.sourcePath);
    const source = await readFile(target, "utf8");
    const studioPath = `${operation.parentStudioPath}/${operation.name}`;
    entries.set(studioPath, {
      studioPath,
      className: operation.className,
      sourceHash: contentHash(source),
    });
  }
  return createFilesystemSourceRevision(sourcemap.hash, [...entries.values()]);
}

function deriveFilesystemRevisionForOperations(
  before: FilesystemSourceRevision,
  operations: readonly RojoSourceOperation[],
  sourcemapHash: string,
): FilesystemSourceRevision {
  const entries = new Map(before.entries.map((entry) => [entry.studioPath, entry]));
  for (const operation of operations) {
    const studioPath =
      operation.kind === "edit_source"
        ? operation.studioPath
        : `${operation.parentStudioPath}/${operation.name}`;
    entries.set(studioPath, {
      studioPath,
      className: operation.className,
      sourceHash:
        operation.kind === "edit_source"
          ? operation.finalSourceHash
          : contentHash(operation.source),
    });
  }
  return createFilesystemSourceRevision(sourcemapHash, [...entries.values()]);
}

function sourceMappingFor(
  operation: Extract<RojoSourceOperation, { kind: "edit_source" }>,
  sourcemap: RojoSourcemapArtifact,
): RojoSourceMapping {
  const mapping = sourcemap.scripts.find(
    (entry) => entry.studioPath === operation.studioPath && entry.className === operation.className,
  );
  if (!mapping) fail("Rojo write target is not an exact mapped script");
  return mapping;
}

function assertReceiptsAgainstChangeSet(
  receipts: readonly RojoWriteReceipt[],
  operations: readonly RojoSourceOperation[],
): void {
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    const operation = operations[index];
    const expectedAfterHash =
      operation?.kind === "edit_source"
        ? operation.finalSourceHash
        : operation
          ? contentHash(operation.source)
          : undefined;
    if (
      !operation ||
      receipt.operationId !== operation.id ||
      receipt.kind !== operation.kind ||
      receipt.className !== operation.className ||
      receipt.afterHash !== expectedAfterHash ||
      contentHash(receipt.afterSource) !== expectedAfterHash
    )
      fail("Rojo mutation receipt does not match its sealed source operation");
    if (operation.kind === "edit_source") {
      if (
        receipt.studioPath !== operation.studioPath ||
        receipt.beforeHash !== operation.beforeHash ||
        receipt.beforeSource === undefined ||
        contentHash(receipt.beforeSource) !== operation.beforeHash
      )
        fail("Rojo write receipt does not match its sealed precondition");
    } else if (
      receipt.studioPath !== `${operation.parentStudioPath}/${operation.name}` ||
      receipt.sourcePath !== operation.sourcePath ||
      receipt.beforeHash !== null
    ) {
      fail("Rojo creation receipt does not match its sealed target");
    }
  }
}

export function applyRojoSourceEdits(source: string, edits: readonly RojoSourceEdit[]): string {
  if (edits.length === 0 || edits.length > 1_024)
    fail("Rojo source edits must contain 1-1024 entries");
  const original = Buffer.from(source, "utf8");
  const chunks: Buffer[] = [];
  let previousEnd = 0;
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.startByte) ||
      !Number.isSafeInteger(edit.endByte) ||
      edit.startByte < previousEnd ||
      edit.endByte < edit.startByte ||
      edit.endByte > original.length ||
      !isUtf8Boundary(original, edit.startByte) ||
      !isUtf8Boundary(original, edit.endByte)
    )
      fail("Rojo source edits must be sorted, non-overlapping, in bounds, and UTF-8 aligned");
    chunks.push(original.subarray(previousEnd, edit.startByte));
    chunks.push(Buffer.from(edit.replacement, "utf8"));
    previousEnd = edit.endByte;
  }
  chunks.push(original.subarray(previousEnd));
  return Buffer.concat(chunks).toString("utf8");
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}

async function atomicReplace(
  workspaceRoot: string,
  sourcePath: string,
  expectedHash: string,
  source: string,
): Promise<void> {
  // Revalidate the whole root-relative component chain at the actual write
  // boundary. The earlier change-set preflight is deliberately not treated as
  // authority for a later filesystem operation.
  await assertSafeExistingFile(workspaceRoot, sourcePath);
  const target = resolveWithin(workspaceRoot, sourcePath);
  const existing = await readFile(target, "utf8");
  if (contentHash(existing) !== expectedHash)
    fail("Rojo source write precondition changed before replacement");
  const temporary = `${dirname(target)}/.${basename(target)}.forge-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    // Recheck immediately before the atomic replacement. POSIX does not offer
    // a portable compare-and-exchange rename; the surrounding revision/sync
    // evidence turns any external race into explicit drift instead of a merge.
    await assertSafeExistingFile(workspaceRoot, sourcePath);
    const current = await readFile(target, "utf8");
    if (contentHash(current) !== expectedHash)
      fail("Rojo source write precondition changed before replacement");
    await rename(temporary, target);
  } catch (error) {
    // This exact private temporary has not replaced a source on the error
    // path, so its removal cannot affect user project content.
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
}

async function createAbsentFile(
  workspaceRoot: string,
  sourcePath: string,
  source: string,
): Promise<void> {
  const target = resolveWithin(workspaceRoot, sourcePath);
  // `wx` proves absence at creation; this recheck makes the parent-chain
  // invariant explicit at the same boundary and rejects a swapped symlink.
  await assertSafeParentForNewPath(workspaceRoot, target);
  await writeFile(target, source, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function assertReceiptStillCurrent(
  workspaceRoot: string,
  receipt: RojoWriteReceipt,
): Promise<void> {
  await assertSafeExistingFile(workspaceRoot, receipt.sourcePath);
  const source = await readFile(resolveWithin(workspaceRoot, receipt.sourcePath), "utf8");
  if (contentHash(source) !== receipt.afterHash)
    fail("Rojo source revert refused because a file changed after Forge wrote it");
}

async function assertSafeExistingFile(root: string, path: string): Promise<void> {
  if (!isSafeRelative(path)) fail("Filesystem path is unsafe");
  const target = resolveWithin(root, path);
  await assertSafeExistingDirectory(root);
  const pieces = path.split("/");
  let cursor = resolve(root);
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    cursor = `${cursor}${sep}${piece}`;
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail("Filesystem path contains a symbolic link");
    if (index === pieces.length - 1) {
      if (!info.isFile()) fail("Filesystem target is not a regular file");
    } else if (!info.isDirectory()) {
      fail("Filesystem path component is not a directory");
    }
  }
  if (target !== cursor) fail("Filesystem path resolution mismatch");
}

async function assertSafeParentForNewPath(root: string, target: string): Promise<void> {
  const canonicalRoot = resolve(root);
  if (!isInside(canonicalRoot, target)) fail("Filesystem target escapes workspace root");
  await assertSafeExistingDirectory(canonicalRoot);
  const parent = dirname(target);
  const rel = relative(canonicalRoot, parent).replaceAll("\\", "/");
  if (rel === "" || !isSafeRelative(rel)) fail("Filesystem target parent is unsafe");
  let cursor = canonicalRoot;
  for (const piece of rel.split("/")) {
    cursor = `${cursor}${sep}${piece}`;
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory())
      fail("Filesystem target parent is not a regular non-symlink directory");
  }
}

async function assertSafeExistingDirectory(root: string): Promise<void> {
  const absolute = resolve(root);
  // The OS may expose a safe system temporary directory through an ancestor
  // symlink (`/tmp` on macOS). The security boundary begins at the caller's
  // selected workspace root: reject that root if it is a link, then inspect
  // every component below it before read/write operations.
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory())
    fail("Workspace root must be a regular non-symlink directory");
}

async function ensureSafeDirectory(root: string): Promise<void> {
  const absolute = resolve(root);
  await assertSafeExistingDirectory(absolute);
}

async function ensureSafeParentForNewPath(root: string, target: string): Promise<void> {
  if (!isInside(resolve(root), target)) fail("Recovery target escapes recovery root");
  await assertSafeExistingDirectory(root);
  const parent = dirname(target);
  const rel = relative(resolve(root), parent).replaceAll("\\", "/");
  if (rel === "" || !isSafeRelative(rel)) fail("Recovery target parent is unsafe");
  let cursor = resolve(root);
  for (const piece of rel.split("/")) {
    cursor = `${cursor}${sep}${piece}`;
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory())
        fail("Recovery target contains a symbolic link or non-directory component");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await mkdir(cursor, { mode: 0o700 });
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("Recovery target directory is unsafe");
    }
  }
}

function resolveRecoveryPath(recoveryRoot: string, attemptId: string, sourcePath: string): string {
  if (!isSafeRelative(sourcePath) || !isId(attemptId)) fail("Invalid Rojo recovery path");
  const destination = resolve(recoveryRoot, attemptId, ...sourcePath.split("/"));
  if (!isInside(resolve(recoveryRoot), destination))
    fail("Rojo recovery path escapes recovery root");
  return destination;
}

function resolveWithin(root: string, path: string): string {
  if (!isSafeRelative(path)) fail("Filesystem path is unsafe");
  const destination = resolve(root, ...path.split("/"));
  if (!isInside(resolve(root), destination)) fail("Filesystem path escapes workspace root");
  return destination;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The one conventional filename rule shared by source-change translation and guarded write preflight. */
export function rojoSourceFilename(name: string, className: RojoSourceClass): string {
  if (!isSimpleName(name)) fail("Rojo source name is unsafe");
  if (className === "Script") return `${name}.server.luau`;
  if (className === "LocalScript") return `${name}.client.luau`;
  return `${name}.luau`;
}

function sourceFileMatchesClass(path: string, className: RojoSourceClass): boolean {
  if (className === "Script") return /\.server\.(?:lua|luau)$/.test(path);
  if (className === "LocalScript") return /\.client\.(?:lua|luau)$/.test(path);
  return /(?<!\.(?:server|client))\.(?:lua|luau)$/.test(path);
}

function isRojoSourceOperation(
  value: unknown,
  maxSourceBytes: number,
): value is RojoSourceOperation {
  if (!isRecord(value) || !isId(value.id) || !isRojoSourceClass(value.className)) return false;
  if (value.kind === "edit_source")
    return (
      isStudioPath(value.studioPath) &&
      isHash(value.beforeHash) &&
      isHash(value.finalSourceHash) &&
      Number.isSafeInteger(value.finalByteCount) &&
      Number(value.finalByteCount) >= 0 &&
      Number(value.finalByteCount) <= maxSourceBytes &&
      Array.isArray(value.edits) &&
      value.edits.length > 0 &&
      value.edits.length <= 1_024 &&
      value.edits.every((edit) => isRojoSourceEdit(edit, maxSourceBytes)) &&
      value.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.replacement, "utf8"), 0) <=
        maxSourceBytes
    );
  return (
    value.kind === "create_source" &&
    typeof value.source === "string" &&
    Buffer.byteLength(value.source, "utf8") <= maxSourceBytes &&
    isStudioPath(value.parentStudioPath) &&
    isSimpleName(value.name) &&
    isSafeRelative(value.sourcePath)
  );
}

function isRojoSourceMapping(value: unknown): value is RojoSourceMapping {
  return (
    isRecord(value) &&
    isStudioPath(value.studioPath) &&
    isRojoSourceClass(value.className) &&
    isSafeRelative(value.sourcePath)
  );
}

function isRojoDirectoryMapping(value: unknown): value is RojoDirectoryMapping {
  return isRecord(value) && isStudioPath(value.studioPath) && isSafeRelative(value.directoryPath);
}

function isSourceHashEntry(value: unknown): value is SourceHashEntry {
  return (
    isRecord(value) &&
    isStudioPath(value.studioPath) &&
    isRojoSourceClass(value.className) &&
    isHash(value.sourceHash)
  );
}

function isRojoWriteReceipt(value: unknown): value is RojoWriteReceipt {
  return (
    isRecord(value) &&
    isId(value.operationId) &&
    ["edit_source", "create_source"].includes(String(value.kind)) &&
    isStudioPath(value.studioPath) &&
    isRojoSourceClass(value.className) &&
    isSafeRelative(value.sourcePath) &&
    (value.beforeHash === null || isHash(value.beforeHash)) &&
    isHash(value.afterHash) &&
    typeof value.afterSource === "string" &&
    (value.beforeSource === undefined || typeof value.beforeSource === "string")
  );
}

function isRojoSourceEdit(value: unknown, maxSourceBytes: number): value is RojoSourceEdit {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.startByte) &&
    Number(value.startByte) >= 0 &&
    Number.isSafeInteger(value.endByte) &&
    Number(value.endByte) >= Number(value.startByte) &&
    typeof value.replacement === "string" &&
    Buffer.byteLength(value.replacement, "utf8") <= maxSourceBytes
  );
}

function assertRojoSyncObservation(value: unknown): asserts value is RojoSyncObservation {
  if (
    !isRecord(value) ||
    typeof value.complete !== "boolean" ||
    (value.studioRevisionHash !== undefined && !isHash(value.studioRevisionHash)) ||
    (value.nonSourceStateHash !== undefined && !isHash(value.nonSourceStateHash)) ||
    (value.sourceEntries !== undefined &&
      (!Array.isArray(value.sourceEntries) || !value.sourceEntries.every(isSourceHashEntry)))
  )
    fail("Invalid Rojo sync observation");
}

function cloneObservation(observation: RojoSyncObservation): RojoSyncObservation {
  return {
    complete: observation.complete,
    ...(observation.studioRevisionHash
      ? { studioRevisionHash: observation.studioRevisionHash }
      : {}),
    ...(observation.nonSourceStateHash
      ? { nonSourceStateHash: observation.nonSourceStateHash }
      : {}),
    ...(observation.sourceEntries
      ? {
          sourceEntries: [...observation.sourceEntries].sort(compareSourceEntry),
        }
      : {}),
  };
}

function failureFact(code: RojoSyncFailureFact["code"], statement: string): RojoSyncFailureFact {
  return {
    code,
    statement,
    hash: contentHash(stableJson({ code, statement })),
  };
}

function isRojoSyncFailureFact(value: unknown): value is RojoSyncFailureFact {
  if (
    !isRecord(value) ||
    ![
      "studio_observation_incomplete",
      "studio_revision_missing",
      "studio_non_source_drift",
      "studio_source_mismatch",
    ].includes(String(value.code)) ||
    !isNonEmpty(value.statement) ||
    !isHash(value.hash)
  )
    return false;
  return value.hash === contentHash(stableJson({ code: value.code, statement: value.statement }));
}

function assertTool(value: unknown): asserts value is RojoToolIdentity {
  if (!isRecord(value) || !isNonEmpty(value.version) || !isHash(value.binaryHash))
    fail("Invalid pinned Rojo tool identity");
}

function assertContentIdentity(
  value: Record<string, unknown>,
  prefix: string,
  payload: unknown,
  label: string,
): void {
  const hash = contentHash(stableJson(payload));
  if (value.hash !== hash || value.id !== `${prefix}_${hash.slice(0, 24)}`)
    fail(`Invalid ${label} identity`);
}

function compareMapping(left: RojoSourceMapping, right: RojoSourceMapping): number {
  return (
    left.studioPath.localeCompare(right.studioPath) ||
    left.sourcePath.localeCompare(right.sourcePath)
  );
}
function compareDirectory(left: RojoDirectoryMapping, right: RojoDirectoryMapping): number {
  return (
    left.studioPath.localeCompare(right.studioPath) ||
    left.directoryPath.localeCompare(right.directoryPath)
  );
}
function compareSourceEntry(left: SourceHashEntry, right: SourceHashEntry): number {
  return (
    left.studioPath.localeCompare(right.studioPath) || left.className.localeCompare(right.className)
  );
}
function isSorted<T>(items: readonly T[], compare: (left: T, right: T) => number): boolean {
  return items.every((item, index) => index === 0 || compare(items[index - 1]!, item) < 0);
}
function isSortedUnique(items: readonly string[]): boolean {
  return items.every((item, index) => index === 0 || items[index - 1]! < item);
}
function isRojoSourceClass(value: unknown): value is RojoSourceClass {
  return ROJO_SOURCE_CLASSES.includes(value as RojoSourceClass);
}
function isLuauFile(path: string): boolean {
  return /\.(?:lua|luau)$/.test(path);
}
function isStudioPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.split("/").every(isSimpleName)
  );
}
function isSimpleName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0")
  );
}
function isSafeRelative(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  )
    return false;
  return value.split("/").every((part) => isSimpleName(part));
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (!isHash(value)) fail(`Invalid ${label}`);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
}
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry) => {
    if (typeof entry !== "string") fail(`${label} contains a non-string`);
    return entry;
  });
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}
function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 4096) || "unknown error";
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}
function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
function fail(message: string): never {
  throw new Error(message);
}
