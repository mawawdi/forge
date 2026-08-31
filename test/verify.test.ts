import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "dist/packages/cli/src/index.js");
const insecure = resolve(root, "test/fixtures/client-controlled-authoritative-state");
const secure = resolve(root, "test/fixtures/authoritative-state-safe");

interface TestReport { kind: string; issues: Array<{ id: string; ruleId: string; location?: { column: number } }>; gate: { status: string; reasons: string[] } }

test("client-controlled authoritative state produces stable semantic diagnostics", () => {
  const first = runVerify(insecure); const second = runVerify(insecure);
  assert.equal(first.status, 1); assert.equal(second.status, 1); assert.deepEqual(first.report, second.report);
  assert.equal(first.report.kind, "VerificationReport");
  assert.ok(first.report.issues.some((issue) => issue.ruleId === "REMOTE_CLIENT_CONTROLLED_STATE"));
});

test("server-owned state is locally eligible", () => {
  const result = runVerify(secure);
  assert.equal(result.status, 0); assert.equal(result.report.gate.status, "eligible"); assert.equal(result.report.issues.length, 0);
});

test("fixture source roots cannot escape the project", () => {
  const result = runVerify(resolve(root, "test/fixtures/source-root-escape"));
  assert.equal(result.status, 2); assert.equal(result.report.gate.status, "incomplete"); assert.match(result.report.gate.reasons[0] ?? "", /Invalid ForgeFixture manifest/);
});

test("missing Roblox-aware tooling is incomplete rather than source blame", () => {
  const result = runVerify(secure, { FORGE_LUAU_LSP: "/definitely/missing/luau-lsp" });
  assert.equal(result.status, 2); assert.equal(result.report.gate.status, "incomplete");
  assert.ok(result.report.issues.some((issue) => issue.ruleId === "ROBLOX_TYPE_ENV_UNAVAILABLE"));
  assert.equal(result.report.issues.some((issue) => issue.ruleId === "LUAU_TYPE_ERROR"), false);
});

test("diagnostic identity retains columns for independent same-line errors", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-fake-lsp-"));
  const executable = resolve(temporaryRoot, "fake-luau-lsp");
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.63.0; exit 0; fi\necho "src/server/ApplyAction.server.luau:1.1-1.2: TypeError: first independent error" >&2\necho "src/server/ApplyAction.server.luau:1.3-1.4: TypeError: second independent error" >&2\nexit 1\n`);
  chmodSync(executable, 0o755);
  try {
    const result = runVerify(secure, { FORGE_LUAU_LSP: executable });
    const issues = result.report.issues.filter((issue) => issue.ruleId === "LUAU_TYPE_ERROR");
    assert.equal(issues.length, 2); assert.notEqual(issues[0]?.id, issues[1]?.id); assert.deepEqual(issues.map((issue) => issue.location?.column).sort(), [1, 3]);
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test("CLI help exposes exactly the six canonical commands", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const lines = result.stdout.split("\n").filter((line) => /^  forge /.test(line));
  assert.equal(lines.length, 6);
  assert.match(result.stdout, /forge agent build/); assert.match(result.stdout, /forge candidate evaluate/); assert.match(result.stdout, /forge studio canary/); assert.match(result.stdout, /forge studio bridge/); assert.match(result.stdout, /forge verify/); assert.match(result.stdout, /forge trace show/);
  assert.doesNotMatch(result.stdout, /repair|reverify|studio verify|candidate studio/);
});

function runVerify(path: string, environment: Record<string, string> = {}): { status: number; report: TestReport } {
  const traceDirectory = mkdtempSync(resolve(tmpdir(), "forge-verify-test-"));
  try {
    const result = spawnSync(process.execPath, [cli, "verify", path, "--trace-dir", traceDirectory], { encoding: "utf8", env: { ...process.env, ...environment } });
    return { status: result.status ?? 2, report: JSON.parse(result.stdout) as TestReport };
  } finally { rmSync(traceDirectory, { recursive: true, force: true }); }
}
