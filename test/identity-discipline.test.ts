import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("Forge source, connector, and fixtures carry no release or schema numbering", () => {
  const files = ["packages", "plugin", "scripts", "examples"]
    .flatMap((directory) => walk(resolve(root, directory)))
    .filter((path) => !path.endsWith("packages/luau-toolchain/roblox/globalTypes.d.luau"));
  const forbidden = /schemaVersion|protocolVersion|pluginVersion|studioVersion|FORGE_VERSION|STUDIO_PROTOCOL_VERSION|STUDIO_PLUGIN_VERSION|PROTOCOL_SCHEMA|PROTOCOL_VERSION|\/v\d+\//;

  for (const path of files) {
    assert.doesNotMatch(readFileSync(path, "utf8"), forbidden, path);
  }
  assert.equal(existsSync(resolve(root, "packages/version")), false);

  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as { version?: unknown; packages?: Record<string, Record<string, unknown>> };
  assert.equal("version" in manifest, false);
  assert.equal("version" in lock, false);
  assert.equal("version" in (lock.packages?.[""] ?? {}), false);
});

function walk(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => walk(resolve(path, entry)));
}
