import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  applyRojoSourceChangeSet,
  assertSingleAuthorityDomain,
  createProjectAuthorityMap,
  createRojoSourceChangeSet,
  createRojoSourceRevertSyncProof,
  createRojoSourcemapArtifact,
  createRojoSyncProof,
  replayRojoMutation,
  rojoOwnedStudioPaths,
  revertRojoSourceMutation,
  type ProjectAuthorityManifest,
  type RojoSourcemapArtifact,
} from "../packages/project-authority/src/index.js";

const originalSource = "return { version = 1 }\n";
const updatedSource = "return { version = 2 }\n";
const tool = { version: "7.7.0", binaryHash: "a".repeat(64) } as const;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-project-authority-"));
  await mkdir(join(root, "src", "Shared"), { recursive: true });
  await writeFile(join(root, "default.project.json"), "{}\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(root, "src", "Shared", "Protocol.luau"), originalSource, {
    encoding: "utf8",
    mode: 0o600,
  });
  return root;
}

const manifest: ProjectAuthorityManifest = {
  kind: "ProjectAuthorityManifest",
  studioRoots: ["ReplicatedStorage", "ServerScriptService"],
  rojo: { projectFile: "default.project.json", sourceRoots: ["src"] },
};

function sourceMap(sourcePath = "src/Shared/Protocol.luau"): string {
  return JSON.stringify({
    name: "DataModel",
    className: "DataModel",
    children: [
      {
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        children: [
          {
            name: "Shared",
            className: "Folder",
            filePaths: ["src/Shared"],
            children: [
              {
                name: "Protocol",
                className: "ModuleScript",
                filePaths: [sourcePath],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function authority(root: string, sourcemap?: RojoSourcemapArtifact) {
  const projectSource = await readFile(join(root, "default.project.json"), "utf8");
  const map =
    sourcemap ??
    createRojoSourcemapArtifact({
      manifest,
      projectFileHash: contentHash(projectSource),
      sourceMapJson: sourceMap(),
      tool,
    });
  return createProjectAuthorityMap({
    projectId: "studio_project_authority_test",
    studioRevisionHash: "b".repeat(64),
    manifest,
    workspaceRoot: root,
    rojo: { sourcemap: map },
  });
}

test("Rojo source authority maps and applies a guarded source replacement with exact sync replay", async (t) => {
  const root = await workspace();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const map = await authority(root);
  assert.ok(map.rojo);
  assert.deepEqual(rojoOwnedStudioPaths(map), [
    "ReplicatedStorage/Shared",
    "ReplicatedStorage/Shared/Protocol",
  ]);
  const changeSet = createRojoSourceChangeSet({
    id: "rojo_change_replace_protocol",
    authorityMap: map,
    beforeStudioRevisionHash: "c".repeat(64),
    beforeStudioNonSourceHash: "d".repeat(64),
    afterStudioNonSourceHash: "d".repeat(64),
    operations: [
      {
        id: "replace_protocol",
        kind: "edit_source",
        studioPath: "ReplicatedStorage/Shared/Protocol",
        className: "ModuleScript",
        beforeHash: contentHash(originalSource),
        edits: [
          {
            startByte: 0,
            endByte: Buffer.byteLength(originalSource, "utf8"),
            replacement: updatedSource,
          },
        ],
        finalSourceHash: contentHash(updatedSource),
        finalByteCount: Buffer.byteLength(updatedSource, "utf8"),
      },
    ],
  });
  const attempt = await applyRojoSourceChangeSet({
    workspaceRoot: root,
    authorityMap: map,
    changeSet,
  });
  assert.equal(attempt.status, "applied");
  assert.equal(await readFile(join(root, "src", "Shared", "Protocol.luau"), "utf8"), updatedSource);
  const proof = createRojoSyncProof({
    attempt,
    changeSet,
    observation: {
      complete: true,
      studioRevisionHash: "e".repeat(64),
      nonSourceStateHash: "d".repeat(64),
      sourceEntries: attempt.afterFilesystemRevision.entries,
    },
  });
  assert.equal(proof.status, "matched");
  assert.equal(replayRojoMutation({ changeSet, attempt, syncProof: proof }).status, "exact_match");
});

test("Rojo source creation is limited to a representable mapped directory", async (t) => {
  const root = await workspace();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const map = await authority(root);
  const changeSet = createRojoSourceChangeSet({
    id: "rojo_change_create_module",
    authorityMap: map,
    beforeStudioRevisionHash: "c".repeat(64),
    beforeStudioNonSourceHash: "d".repeat(64),
    afterStudioNonSourceHash: "d".repeat(64),
    operations: [
      {
        id: "create_rules",
        kind: "create_source",
        parentStudioPath: "ReplicatedStorage/Shared",
        name: "Rules",
        className: "ModuleScript",
        sourcePath: "src/Shared/Rules.luau",
        source: "return {}\n",
      },
    ],
  });
  const attempt = await applyRojoSourceChangeSet({
    workspaceRoot: root,
    authorityMap: map,
    changeSet,
  });
  assert.equal(await readFile(join(root, "src", "Shared", "Rules.luau"), "utf8"), "return {}\n");
  assert.ok(
    attempt.afterFilesystemRevision.entries.some(
      (entry) => entry.studioPath === "ReplicatedStorage/Shared/Rules",
    ),
  );
});

test("Rojo source authority rejects stale writes, unsafe sourcemaps, symlinks, and mixed domains", async (t) => {
  const root = await workspace();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const map = await authority(root);
  const changeSet = createRojoSourceChangeSet({
    id: "rojo_change_stale",
    authorityMap: map,
    beforeStudioRevisionHash: "c".repeat(64),
    beforeStudioNonSourceHash: "d".repeat(64),
    afterStudioNonSourceHash: "d".repeat(64),
    operations: [
      {
        id: "replace_protocol",
        kind: "edit_source",
        studioPath: "ReplicatedStorage/Shared/Protocol",
        className: "ModuleScript",
        beforeHash: contentHash(originalSource),
        edits: [
          {
            startByte: 0,
            endByte: Buffer.byteLength(originalSource, "utf8"),
            replacement: updatedSource,
          },
        ],
        finalSourceHash: contentHash(updatedSource),
        finalByteCount: Buffer.byteLength(updatedSource, "utf8"),
      },
    ],
  });
  await writeFile(join(root, "src", "Shared", "Protocol.luau"), "manual change\n", "utf8");
  await assert.rejects(
    () =>
      applyRojoSourceChangeSet({
        workspaceRoot: root,
        authorityMap: map,
        changeSet,
      }),
    /filesystem drift|precondition/i,
  );
  assert.throws(
    () =>
      createRojoSourcemapArtifact({
        manifest,
        projectFileHash: "1".repeat(64),
        sourceMapJson: sourceMap("../outside.luau"),
        tool,
      }),
    /unsafe|escapes/i,
  );
  const linked = join(root, "src", "Shared", "Protocol.luau");
  await rm(linked);
  await symlink("/tmp/forge-project-authority-outside", linked);
  await assert.rejects(() => authority(root), /symbolic link/i);
  assert.throws(
    () => assertSingleAuthorityDomain(["studio_transaction", "rojo_source"]),
    /exactly one authority/i,
  );
});

test("Rojo sync distinguishes incomplete observation, source mismatch, and collateral Studio drift", async (t) => {
  const root = await workspace();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const map = await authority(root);
  const changeSet = createRojoSourceChangeSet({
    id: "rojo_change_sync",
    authorityMap: map,
    beforeStudioRevisionHash: "c".repeat(64),
    beforeStudioNonSourceHash: "d".repeat(64),
    afterStudioNonSourceHash: "d".repeat(64),
    operations: [
      {
        id: "replace_protocol",
        kind: "edit_source",
        studioPath: "ReplicatedStorage/Shared/Protocol",
        className: "ModuleScript",
        beforeHash: contentHash(originalSource),
        edits: [
          {
            startByte: 0,
            endByte: Buffer.byteLength(originalSource, "utf8"),
            replacement: updatedSource,
          },
        ],
        finalSourceHash: contentHash(updatedSource),
        finalByteCount: Buffer.byteLength(updatedSource, "utf8"),
      },
    ],
  });
  const attempt = await applyRojoSourceChangeSet({
    workspaceRoot: root,
    authorityMap: map,
    changeSet,
  });
  const incomplete = createRojoSyncProof({ attempt, changeSet });
  assert.equal(incomplete.status, "awaiting_sync");
  assert.equal(
    replayRojoMutation({ changeSet, attempt, syncProof: incomplete }).status,
    "incomplete",
  );
  const sourceMismatch = createRojoSyncProof({
    attempt,
    changeSet,
    observation: {
      complete: true,
      studioRevisionHash: "e".repeat(64),
      nonSourceStateHash: "d".repeat(64),
      sourceEntries: [
        {
          ...attempt.afterFilesystemRevision.entries[0]!,
          sourceHash: contentHash("not synced"),
        },
      ],
    },
  });
  assert.equal(sourceMismatch.status, "mismatched");
  const collateral = createRojoSyncProof({
    attempt,
    changeSet,
    observation: {
      complete: true,
      studioRevisionHash: "e".repeat(64),
      nonSourceStateHash: "f".repeat(64),
      sourceEntries: attempt.afterFilesystemRevision.entries,
    },
  });
  assert.equal(collateral.status, "mismatched");
  assert.ok(collateral.failureFacts.some((fact) => fact.code === "studio_non_source_drift"));
});

test("creator-authorized source revert is hash guarded and moves created files outside the workspace", async (t) => {
  const root = await workspace();
  const recovery = await mkdtemp(join(tmpdir(), "forge-project-authority-recovery-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(recovery, { recursive: true, force: true }),
    ]);
  });
  const map = await authority(root);
  const changeSet = createRojoSourceChangeSet({
    id: "rojo_change_revert",
    authorityMap: map,
    beforeStudioRevisionHash: "c".repeat(64),
    beforeStudioNonSourceHash: "d".repeat(64),
    afterStudioNonSourceHash: "d".repeat(64),
    operations: [
      {
        id: "replace_protocol",
        kind: "edit_source",
        studioPath: "ReplicatedStorage/Shared/Protocol",
        className: "ModuleScript",
        beforeHash: contentHash(originalSource),
        edits: [
          {
            startByte: 0,
            endByte: Buffer.byteLength(originalSource, "utf8"),
            replacement: updatedSource,
          },
        ],
        finalSourceHash: contentHash(updatedSource),
        finalByteCount: Buffer.byteLength(updatedSource, "utf8"),
      },
      {
        id: "create_rules",
        kind: "create_source",
        parentStudioPath: "ReplicatedStorage/Shared",
        name: "Rules",
        className: "ModuleScript",
        sourcePath: "src/Shared/Rules.luau",
        source: "return {}\n",
      },
    ],
  });
  const attempt = await applyRojoSourceChangeSet({
    workspaceRoot: root,
    authorityMap: map,
    changeSet,
  });
  const reverted = await revertRojoSourceMutation({
    workspaceRoot: root,
    recoveryRoot: recovery,
    authorityMap: map,
    attempt,
  });
  assert.equal(
    await readFile(join(root, "src", "Shared", "Protocol.luau"), "utf8"),
    originalSource,
  );
  await assert.rejects(() => readFile(join(root, "src", "Shared", "Rules.luau"), "utf8"));
  assert.equal(reverted.resultingFilesystemRevision.hash, map.rojo!.filesystemRevision.hash);
  const reverseProof = createRojoSourceRevertSyncProof({
    revert: reverted,
    changeSet,
    observation: {
      complete: true,
      studioRevisionHash: "e".repeat(64),
      nonSourceStateHash: "d".repeat(64),
      sourceEntries: reverted.resultingFilesystemRevision.entries,
    },
  });
  assert.equal(reverseProof.status, "matched");
  const replay = replayRojoMutation({
    changeSet,
    attempt,
    revert: reverted,
    revertSyncProof: reverseProof,
  });
  assert.equal(replay.status, "exact_match");
  assert.equal(replay.finalization, "reverted");
});
