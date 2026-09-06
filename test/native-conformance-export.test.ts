import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const beforeSaveJson = `{
  "status": "passed",
  "tiny": -4.371138828673793e-8,
  "numbers": [1e-08, 2.5000E+0, -0.0],
  "text": "literal exponent 1e-8, café 🧩, escaped newline\\n",
  "fixtureBuild": {"hash": "${"b".repeat(64)}"},
  "manifestHash": "${"a".repeat(64)}",
  "kind": "ForgeNativePreflightConformance"
}
`;
const afterReopenJson = `{
 "beforeReportHash": "${sha256(beforeSaveJson)}",
 "kind": "ForgeNativePreflightConformance",
 "manifestHash": "${"a".repeat(64)}",
 "fixtureBuild": { "hash": "${"b".repeat(64)}" },
 "tiny": -4.371138828673793e-8,
 "status": "passed"
}
`;
function lune(script: string, args: string[]) {
  const result = spawnSync("lune", ["run", script, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  return result;
}
async function serializedPlace(
  root: string,
  id: string,
  reopened = afterReopenJson,
  format = "xml",
) {
  const input = join(root, `${id}.input.json`);
  const path = join(root, `${id}.${format === "xml" ? "rbxlx" : "rbxl"}`);
  await writeFile(input, JSON.stringify({ beforeSaveJson, afterReopenJson: reopened }));
  const result = lune("test/native-conformance-export-place.luau", [input, path, format]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return path;
}

test("native conformance export preserves exact raw receipt strings and source bytes for XML and binary places", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-native-export-"));
  try {
    for (const format of ["xml", "binary"]) {
      const place = await serializedPlace(root, format, afterReopenJson, format);
      const sourceBytes = await readFile(place);
      const output = join(root, `${format}.export.json`);
      const result = lune("scripts/export-native-conformance.luau", [place, output]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const exported = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(Object.keys(exported).sort(), [
        "afterReopenJson",
        "beforeSaveJson",
        "kind",
        "sourcePlace",
      ]);
      assert.equal(exported.kind, "ForgeNativeConformanceExport");
      assert.deepEqual(exported.sourcePlace, {
        sha256: sha256(sourceBytes),
        bytes: sourceBytes.length,
      });
      assert.equal(exported.beforeSaveJson, beforeSaveJson);
      assert.equal(exported.afterReopenJson, afterReopenJson);
      assert.equal(
        JSON.parse(exported.afterReopenJson).beforeReportHash,
        sha256(exported.beforeSaveJson),
      );
      assert.notEqual(
        exported.beforeSaveJson,
        JSON.stringify(JSON.parse(beforeSaveJson)),
        "The export is a receipt byte container, not a normalized report",
      );
      assert.deepEqual(
        await readFile(place),
        sourceBytes,
        "Export must not rewrite the saved place",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native conformance export rejects wrong raw binding or metadata and preserves existing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-native-export-reject-"));
  try {
    const replacements = [
      {
        id: "binding",
        value: afterReopenJson.replace(sha256(beforeSaveJson), "0".repeat(64)),
        reason: /does not bind saved before report/,
      },
      {
        id: "manifest",
        value: afterReopenJson.replace("a".repeat(64), "c".repeat(64)),
        reason: /receipt identity mismatch/,
      },
      {
        id: "fixture",
        value: afterReopenJson.replace("b".repeat(64), "c".repeat(64)),
        reason: /receipt identity mismatch/,
      },
      {
        id: "kind",
        value: afterReopenJson.replace("ForgeNativePreflightConformance", "DifferentReport"),
        reason: /unexpected receipt kind/,
      },
    ];
    for (const variant of replacements) {
      const place = await serializedPlace(root, variant.id, variant.value);
      const output = join(root, `${variant.id}.export.json`);
      const result = lune("scripts/export-native-conformance.luau", [place, output]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, variant.reason);
      await assert.rejects(() => stat(output), { code: "ENOENT" });
    }
    const place = await serializedPlace(root, "existing");
    const output = join(root, "preserved.json");
    const existing = Buffer.from("existing independently reviewed artifact\n");
    await writeFile(output, existing);
    const result = lune("scripts/export-native-conformance.luau", [place, output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /output already exists/);
    assert.deepEqual(await readFile(output), existing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
