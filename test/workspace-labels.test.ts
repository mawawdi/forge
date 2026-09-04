import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkspaceLabels,
  workspaceProjectKey,
  workspaceRenameSchema,
} from "../packages/creator-control/src/workspace-labels.js";

test("display names survive restart and concurrent renames without changing project identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-labels-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { kind: "local_linked" as const, forgeProjectId: "forge_project_original" };
  const original = structuredClone(project);
  const labels = new WorkspaceLabels(directory);
  await labels.load();
  await Promise.all([
    labels.set("project", workspaceProjectKey(project), "Orbital"),
    labels.set("conversation", "conversation_1", "Polish the HUD"),
    labels.set("conversation", "conversation_2", "Add sound"),
  ]);
  const reopened = new WorkspaceLabels(directory);
  await reopened.load();
  assert.equal(reopened.get("project", workspaceProjectKey(project)), "Orbital");
  assert.equal(reopened.get("conversation", "conversation_1"), "Polish the HUD");
  assert.equal(reopened.get("conversation", "conversation_2"), "Add sound");
  assert.deepEqual(project, original);
  assert.equal(reopened.get("conversation", "toString"), undefined);
  for (const name of ["", "  ", "a".repeat(81), "two\nlines", "null\u0000byte"]) {
    assert.equal(
      workspaceRenameSchema.safeParse({ scope: "project", conversationId: "c", name }).success,
      false,
    );
  }
});

test("workspace labels fail closed on a symlink or malformed file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-labels-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "other.json"), "{}");
  await symlink(join(directory, "other.json"), join(directory, "workspace-labels.json"));
  await assert.rejects(new WorkspaceLabels(directory).load());
  await rm(join(directory, "workspace-labels.json"));
  await writeFile(join(directory, "workspace-labels.json"), "{}");
  await assert.rejects(new WorkspaceLabels(directory).load());
});
