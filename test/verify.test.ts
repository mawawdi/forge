import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "dist/packages/cli/src/index.js");
const fixture = resolve(root, "examples/insecure-tycoon");
const cleanFixture = resolve(root, "examples/clean-tycoon");

interface TestReport {
  kind: string;
  issues: Array<{ ruleId: string }>;
  gate: { status: string; reasons: string[] };
  [key: string]: unknown;
}

test("insecure fixture produces structured deterministic diagnostics", () => {
  const first = runVerify(fixture);
  const second = runVerify(fixture);
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.kind, "VerificationReport");
  assert.ok(first.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "REMOTE_CLIENT_CONTROLLED_REWARD"));
  assert.ok(first.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "LUAU_TYPE_ERROR" || issue.ruleId === "LUAU_ANALYZER_ERROR" || issue.ruleId === "LUAU_PARSE_ERROR"));
});

test("clean fixture exits zero with no blocking issues", () => {
  const result = runVerify(cleanFixture);
  assert.equal(result.status, 0);
  assert.equal(result.report.gate.status, "verified");
  assert.equal(result.report.issues.length, 0);
});

test("fixture paths cannot escape the project root", () => {
  const result = runVerify(resolve(root, "examples/path-traversal"));
  assert.equal(result.status, 2);
  assert.equal(result.report.gate.status, "incomplete");
  assert.match(result.report.gate.reasons[0] ?? "", /must stay inside/);
});

test("missing official analyzer is a structured tooling failure", () => {
  const result = runVerify(cleanFixture, { FORGE_LUAU_ANALYZE: "/definitely/missing/luau-analyze" });
  assert.equal(result.status, 1);
  assert.equal(result.report.gate.status, "rejected");
  assert.ok(result.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "TOOLCHAIN_UNAVAILABLE"));
});

function runVerify(path: string, environment: Record<string, string> = {}): { status: number; report: TestReport } {
  try {
    const output = execFileSync(process.execPath, [cli, "verify", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment } });
    return { status: 0, report: JSON.parse(output) as TestReport };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { status: failure.status, report: JSON.parse(failure.stdout) as TestReport };
  }
}
