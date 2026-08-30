import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("rendered Studio server and client harnesses pass the real Luau parser", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "forge-generated-harness-"));
  for (const mode of ["server", "client"] as const) {
    const rendered = spawnSync("lune", ["run", resolve(root, "scripts/render-collect-fruit-harness.luau"), mode], { cwd: root, encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr || `failed to render ${mode} harness`);
    assert.ok(rendered.stdout.includes("StudioTestService:EndTest") === (mode === "server"));
    const path = resolve(directory, `${mode}.luau`);
    await writeFile(path, rendered.stdout, "utf8");
    const parsed = spawnSync("luau-compile", ["--only-parse", path], { cwd: root, encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout || `generated ${mode} harness did not parse`);
  }
});
