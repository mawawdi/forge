import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  assertRojoSourcemapRefresh,
  createRojoSourcemapArtifact,
  type RojoSourceOperation,
} from "../packages/project-authority/src/index.js";
import { generatePinnedRojoSourcemap } from "../packages/project-authority/src/host.js";

const manifest = {
  kind: "ProjectAuthorityManifest",
  studioRoots: ["ReplicatedStorage"],
  rojo: { projectFile: "default.project.json", sourceRoots: ["src"] },
} as const;
const tool = { version: "7.7.0", binaryHash: contentHash("pinned fixture binary") };
function map(names: readonly string[], directory = "src/Shared") {
  return createRojoSourcemapArtifact({
    manifest,
    projectFileHash: contentHash("{}\n"),
    tool,
    sourceMapJson: JSON.stringify({
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
              filePaths: [directory],
              children: names.map((name) => ({
                name,
                className: "ModuleScript",
                filePaths: [directory + "/" + name + ".luau"],
              })),
            },
          ],
        },
      ],
    }),
  });
}

test("sourcemap refresh admits only the exact verified source creations under the original pinned mappings", () => {
  const previous = map(["Protocol"]),
    next = map(["Protocol", "Added"]);
  const creations: RojoSourceOperation[] = [
    {
      id: "add",
      kind: "create_source",
      parentStudioPath: "ReplicatedStorage/Shared",
      name: "Added",
      className: "ModuleScript",
      sourcePath: "src/Shared/Added.luau",
      source: "return {}\n",
    },
  ];
  assert.doesNotThrow(() => assertRojoSourcemapRefresh({ manifest, previous, next, creations }));
  assert.throws(
    () => assertRojoSourcemapRefresh({ manifest, previous, next, creations: [] }),
    /exact verified source allocations/,
  );
  assert.throws(
    () =>
      assertRojoSourcemapRefresh({
        manifest,
        previous,
        next: map(["Protocol", "Added", "Unapproved"]),
        creations,
      }),
    /exact verified source allocations/,
  );
  assert.throws(
    () => assertRojoSourcemapRefresh({ manifest, previous, next: map(["Added"]), creations }),
    /exact verified source allocations/,
  );
  assert.throws(
    () =>
      assertRojoSourcemapRefresh({
        manifest,
        previous,
        next: map(["Protocol", "Added"], "src/Elsewhere"),
        creations,
      }),
    /declared directories/,
  );
});

test("pinned sourcemap host command rejects changed binaries and symlinked inputs before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-rojo-host-"));
  try {
    const executable = join(root, "fixture-rojo");
    const script =
      '#!/bin/sh\nprintf \'%s\' \'{"name":"DataModel","className":"DataModel"}\' > "$4"\n';
    await writeFile(executable, script, { mode: 0o700 });
    await writeFile(join(root, "default.project.json"), "{}\n");
    const input = {
      executable,
      workspaceRoot: root,
      projectFile: "default.project.json",
      expectedBinaryHash: contentHash(script),
    };
    const result = await generatePinnedRojoSourcemap(input);
    assert.equal(
      JSON.parse(result).className,
      "DataModel",
      "Fixture process exercises the fixed argument vector and regular bounded result",
    );
    await assert.rejects(
      () => generatePinnedRojoSourcemap({ ...input, expectedBinaryHash: contentHash("changed") }),
      /executable changed/,
    );
    await symlink(executable, join(root, "linked-tool"));
    await assert.rejects(
      () => generatePinnedRojoSourcemap({ ...input, executable: join(root, "linked-tool") }),
      /executable changed/,
    );
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "default.project.json"), "{}\n");
    await symlink(join(root, "real"), join(root, "linked-project"));
    await assert.rejects(
      () =>
        generatePinnedRojoSourcemap({
          ...input,
          projectFile: "linked-project/default.project.json",
        }),
      /symlink or non-regular/,
    );
    assert.equal(await readFile(join(root, "default.project.json"), "utf8"), "{}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
