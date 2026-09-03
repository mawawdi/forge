import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadCreatorServeOptions,
  parseCreatorServeOptions,
} from "../packages/cli/src/creator-serve-options.js";

test("creator serve accepts one project-authority manifest", () => {
  const parsed = parseCreatorServeOptions([
    "--model",
    "openai/gpt-5.6-luna",
    "--project-authority",
    "project-authority.json",
  ]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.projectAuthorityManifestPath, "project-authority.json");
  assert.equal(
    parseCreatorServeOptions([
      "--model",
      "openai/gpt-5.6-luna",
      "--legacy-authority-root",
      "Workspace/Legacy",
    ]).valid,
    false,
  );
  assert.equal(
    parseCreatorServeOptions([
      "--model",
      "openai/gpt-5.6-luna",
      "--project-authority",
      "one.json",
      "--project-authority",
      "two.json",
    ]).valid,
    false,
  );
});

test("creator serve loads only a valid regular ProjectAuthorityManifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-creator-serve-options-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const manifestPath = join(directory, "project-authority.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      kind: "ProjectAuthorityManifest",
      studioRoots: ["ServerScriptService", "Workspace"],
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const loaded = await loadCreatorServeOptions(
    parseCreatorServeOptions([
      "--model",
      "openai/gpt-5.6-luna",
      "--project-authority",
      manifestPath,
    ]),
  );
  assert.equal(loaded.projectAuthority?.manifestPath, resolve(manifestPath));
  assert.equal(loaded.projectAuthority?.workspaceRoot, directory);
  assert.equal(loaded.projectAuthority?.manifest.rojo, undefined);

  await writeFile(manifestPath, "{not json", { encoding: "utf8", mode: 0o600 });
  await assert.rejects(
    () =>
      loadCreatorServeOptions(
        parseCreatorServeOptions([
          "--model",
          "openai/gpt-5.6-luna",
          "--project-authority",
          manifestPath,
        ]),
      ),
    /Could not read ProjectAuthorityManifest/,
  );

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      kind: "ProjectAuthorityManifest",
      studioRoots: ["Workspace", "ServerScriptService"],
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await assert.rejects(
    () =>
      loadCreatorServeOptions(
        parseCreatorServeOptions([
          "--model",
          "openai/gpt-5.6-luna",
          "--project-authority",
          manifestPath,
        ]),
      ),
    /Invalid ProjectAuthorityManifest studio roots/,
  );

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      kind: "ProjectAuthorityManifest",
      studioRoots: ["ServerScriptService", "Workspace"],
      rojo: {
        projectFile: "default.project.json",
        sourceRoots: ["src"],
        sourcemapFile: "old.json",
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await assert.rejects(
    () =>
      loadCreatorServeOptions(
        parseCreatorServeOptions([
          "--model",
          "openai/gpt-5.6-luna",
          "--project-authority",
          manifestPath,
        ]),
      ),
    /Invalid ProjectAuthorityManifest Rojo declaration/,
  );

  const linkedManifestPath = join(directory, "linked-authority.json");
  await symlink(manifestPath, linkedManifestPath);
  await assert.rejects(
    () =>
      loadCreatorServeOptions(
        parseCreatorServeOptions([
          "--model",
          "openai/gpt-5.6-luna",
          "--project-authority",
          linkedManifestPath,
        ]),
      ),
    /regular file, not a symlink/,
  );
});
