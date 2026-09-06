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

interface TestReport {
  kind: string;
  issues: Array<{ id: string; ruleId: string; location?: { column: number } }>;
  gate: { status: string; reasons: string[] };
}

test("client-controlled authoritative state produces stable semantic diagnostics", () => {
  const first = runVerify(insecure);
  const second = runVerify(insecure);
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.kind, "VerificationReport");
  assert.ok(first.report.issues.some((issue) => issue.ruleId === "REMOTE_CLIENT_CONTROLLED_STATE"));
});

test("server-owned state is locally eligible", () => {
  const result = runVerify(secure);
  assert.equal(result.status, 0);
  assert.equal(result.report.gate.status, "eligible");
  assert.equal(result.report.issues.length, 0);
});

test("fixture source roots cannot escape the project", () => {
  const result = runVerify(resolve(root, "test/fixtures/source-root-escape"));
  assert.equal(result.status, 2);
  assert.equal(result.report.gate.status, "incomplete");
  assert.match(result.report.gate.reasons[0] ?? "", /Invalid ForgeFixture manifest/);
});

test("missing Roblox-aware tooling is incomplete rather than source blame", () => {
  const result = runVerify(secure, { FORGE_LUAU_LSP: "/definitely/missing/luau-lsp" });
  assert.equal(result.status, 2);
  assert.equal(result.report.gate.status, "incomplete");
  assert.ok(result.report.issues.some((issue) => issue.ruleId === "ROBLOX_TYPE_ENV_UNAVAILABLE"));
  assert.equal(
    result.report.issues.some((issue) => issue.ruleId === "LUAU_TYPE_ERROR"),
    false,
  );
});

test("diagnostic identity retains columns for independent same-line errors", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-fake-lsp-"));
  const executable = resolve(temporaryRoot, "fake-luau-lsp");
  writeFileSync(
    executable,
    `#!/bin/sh\necho "src/server/ApplyAction.server.luau:1.1-1.2: TypeError: first independent error" >&2\necho "src/server/ApplyAction.server.luau:1.3-1.4: TypeError: second independent error" >&2\nexit 1\n`,
  );
  chmodSync(executable, 0o755);
  try {
    const result = runVerify(secure, { FORGE_LUAU_LSP: executable });
    const issues = result.report.issues.filter((issue) => issue.ruleId === "LUAU_TYPE_ERROR");
    assert.equal(issues.length, 2);
    assert.notEqual(issues[0]?.id, issues[1]?.id);
    assert.deepEqual(issues.map((issue) => issue.location?.column).sort(), [1, 3]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("CLI help exposes the conversation control surface and registered experiments", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const lines = result.stdout.split("\n").filter((line) => /^  forge /.test(line));
  assert.equal(lines.length, 23);
  assert.match(result.stdout, /Forge commands/);
  assert.match(result.stdout, /forge creator serve \[--default-model/);
  assert.match(result.stdout, /forge creator state/);
  assert.match(result.stdout, /forge creator turn/);
  assert.match(result.stdout, /forge creator act/);
  assert.match(result.stdout, /--memory-item-id/);
  assert.match(result.stdout, /forge creator replay-verification/);
  assert.match(result.stdout, /forge creator replay-mutation/);
  assert.match(result.stdout, /forge creator timings/);
  assert.match(result.stdout, /forge creator replay-regression/);
  assert.match(result.stdout, /forge creator asset prepare --request-file/);
  assert.match(result.stdout, /forge creator asset doctor --installation/);
  assert.match(result.stdout, /forge creator asset run\|status\|fetch <job-id>/);
  assert.match(result.stdout, /forge creator asset preview <job-id> --output <absolute.html>/);
  assert.match(result.stdout, /forge creator asset reconcile <job-id> --output-sha256/);
  assert.match(result.stdout, /forge creator asset review <job-id> --lock-hash/);
  assert.match(result.stdout, /forge experiment register/);
  assert.match(result.stdout, /--runtime-configuration/);
  assert.match(result.stdout, /forge experiment build/);
  assert.match(result.stdout, /forge experiment evaluate/);
  assert.match(result.stdout, /forge studio api-status/);
  assert.match(result.stdout, /forge studio capabilities/);
  assert.match(result.stdout, /forge studio canary/);
  assert.match(result.stdout, /forge studio bridge/);
  assert.match(result.stdout, /forge verify/);
  assert.match(result.stdout, /forge trace show/);
  assert.doesNotMatch(result.stdout, /forge agent build/);
  assert.doesNotMatch(result.stdout, /forge creator serve --model/);
  assert.doesNotMatch(result.stdout, /forge creator start/);
  assert.doesNotMatch(result.stdout, /forge creator approve-plan/);
  assert.doesNotMatch(
    result.stdout,
    /candidate evaluate|repair|reverify|studio verify|candidate studio/,
  );
});

function runVerify(
  path: string,
  environment: Record<string, string> = {},
): { status: number; report: TestReport } {
  const traceDirectory = mkdtempSync(resolve(tmpdir(), "forge-verify-test-"));
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "verify", path, "--trace-dir", traceDirectory],
      { encoding: "utf8", env: { ...process.env, ...environment } },
    );
    return { status: result.status ?? 2, report: JSON.parse(result.stdout) as TestReport };
  } finally {
    rmSync(traceDirectory, { recursive: true, force: true });
  }
}
