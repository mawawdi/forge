import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("native conformance Runner publication, cleanup and reopen lifecycle with fixed offline dependencies", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-native-conformance-lifecycle-"));
  try {
    const source = await readFile("test/fixtures/studio-native-conformance/Runner.luau", "utf8");
    await writeFile(
      join(temp, "Environment.luau"),
      await readFile("test/native-conformance-environment.luau"),
    );
    await writeFile(join(temp, "NativeHash.luau"), await readFile("plugin/src/Forge/Hash.luau"));
    const inputHashes = new Map<string, Buffer>();
    const digest = (value: string) => {
      const bytes = createHash("sha256").update(value).digest();
      inputHashes.set(value, bytes);
      return bytes.toString("hex");
    };
    for (const changed of [false, true]) {
      const sources = {
        fixture: digest(source),
        cases: digest("fixed lifecycle dependency Cases" + (changed ? " changed" : "")),
        GeneratedStudioEvidence: digest("fixed lifecycle dependency GeneratedStudioEvidence"),
        StudioAuthoring: digest("fixed lifecycle dependency StudioAuthoring"),
        Hash: digest("fixed lifecycle dependency Hash"),
      };
      digest(
        Object.entries(sources)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => `${key}:${value}`)
          .join("\n"),
      );
    }
    for (let index = 1; index <= 128; index++) digest(`fixed report snapshot ${index}`);
    const digestEntries = [...inputHashes].map(
      ([value, bytes]) =>
        `[${JSON.stringify(value)}] = "${[...bytes].map((byte) => "\\" + byte.toString().padStart(3, "0")).join("")}"`,
    );
    await writeFile(
      join(temp, "Hash.luau"),
      [
        'local Hash = require("./NativeHash")',
        `local digests = {${digestEntries.join(",\n")}}`,
        'Hash.setDigestForTest(function(value) return assert(digests[value], "unregistered fixed SHA-256 input") end)',
        "return Hash",
      ].join("\n"),
    );
    await writeFile(
      join(temp, "Lifecycle.luau"),
      await readFile("test/native-conformance-lifecycle.luau"),
    );
    const prefix = [
      'local environment = require("./Environment")',
      "local game, workspace, Instance, Enum = environment.game, environment.workspace, environment.Instance, environment.Enum",
      "local script, require, version, print = environment.script, environment.require, environment.version, environment.print",
      `script.Source = ${JSON.stringify(source)}`,
      "",
    ].join("\n");
    // Distinct files emulate fresh ModuleScript evaluation while preserving the same saved output.
    for (let index = 1; index <= 12; index++)
      await writeFile(join(temp, `Runner${index}.luau`), prefix + source);
    const result = spawnSync("luau", [join(temp, "Lifecycle.luau")], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Native conformance lifecycle cases passed: 9/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
