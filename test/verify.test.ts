import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "dist/packages/cli/src/index.js");
const fixture = resolve(root, "examples/insecure-tycoon");
const cleanFixture = resolve(root, "examples/clean-tycoon");
const studioFixture = resolve(root, "examples/collect-fruit/studio");

interface TestReport {
  kind: string;
  issues: Array<{ id: string; ruleId: string; location?: { line: number; column: number; endLine?: number; endColumn?: number } }>;
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

test("missing Roblox-aware analyzer is an incomplete tooling tier, never source blame", () => {
  const result = runVerify(cleanFixture, { FORGE_LUAU_LSP: "/definitely/missing/luau-lsp" });
  assert.equal(result.status, 2);
  assert.equal(result.report.gate.status, "incomplete");
  assert.ok(result.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "ROBLOX_TYPE_ENV_UNAVAILABLE"));
  assert.equal(result.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "LUAU_TYPE_ERROR"), false);
});

test("missing pinned Roblox definitions are an incomplete tooling tier", () => {
  const result = runVerify(cleanFixture, { FORGE_ROBLOX_TYPES: "/definitely/missing/globalTypes.d.luau" });
  assert.equal(result.status, 2);
  assert.equal(result.report.gate.status, "incomplete");
  assert.ok(result.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "ROBLOX_TYPE_ENV_UNAVAILABLE"));
  assert.equal(result.report.issues.some((issue: { ruleId: string }) => issue.ruleId === "LUAU_TYPE_ERROR"), false);
});

test("diagnostic identity retains columns so independent same-line errors are not collapsed", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-fake-lsp-"));
  const executable = resolve(temporaryRoot, "fake-luau-lsp");
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.63.0; exit 0; fi\necho "src/server/Clean.server.luau:1.1-1.2: TypeError: first independent error" >&2\necho "src/server/Clean.server.luau:1.3-1.4: TypeError: second independent error" >&2\nexit 1\n`);
  chmodSync(executable, 0o755);
  try {
    const result = runVerify(cleanFixture, { FORGE_LUAU_LSP: executable });
    const typeIssues = result.report.issues.filter((issue) => issue.ruleId === "LUAU_TYPE_ERROR");
    assert.equal(typeIssues.length, 2);
    assert.notEqual(typeIssues[0]?.id, typeIssues[1]?.id);
    assert.deepEqual(typeIssues.map((issue) => issue.location?.column), [1, 3]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("equivalent secure RemoteEvent parameter renaming preserves the M2 verdict", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-positional-abi-"));
  const studioCopy = resolve(temporaryRoot, "studio");
  try {
    cpSync(studioFixture, studioCopy, { recursive: true, filter: (source) => !source.includes("/.forge") });
    const serverPath = resolve(studioCopy, "src/server/CollectFruit.server.luau");
    const clientPath = resolve(studioCopy, "src/client/CollectFruitClient.client.luau");
    writeFileSync(serverPath, readFileSync(serverPath, "utf8").replaceAll("fruitId", "selectedKey").replaceAll("_claimedAmount", "attackerHint"));
    writeFileSync(clientPath, readFileSync(clientPath, "utf8").replaceAll("fruitId", "selectedKey").replaceAll("claimedAmount", "attackerHint"));
    const result = runVerify(studioCopy);
    assert.equal(result.status, 0, JSON.stringify(result.report));
    assert.equal(result.report.gate.status, "verified");
    assert.equal(result.report.issues.some((issue) => issue.ruleId === "REMOTE_UNVALIDATED_INPUT" || issue.ruleId === "REMOTE_ABI_ARITY_MISMATCH"), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("equivalent distance guards preserve the exact implementation constant without identifier matching", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-distance-interface-"));
  const studioCopy = resolve(temporaryRoot, "studio");
  try {
    cpSync(studioFixture, studioCopy, { recursive: true, filter: (source) => !source.includes("/.forge") });
    const serverPath = resolve(studioCopy, "src/server/CollectFruit.server.luau");
    const source = readFileSync(serverPath, "utf8")
      .replace("local MAX_DISTANCE = 20", "local INTERACTION_RADIUS: number = 20")
      .replace("if (root.Position - Fruit42.Position).Magnitude > MAX_DISTANCE then", "local measuredSeparation = (root.Position - Fruit42.Position).Magnitude\n    if measuredSeparation > INTERACTION_RADIUS then");
    writeFileSync(serverPath, source);
    const result = runVerify(studioCopy);
    assert.equal(result.status, 0, JSON.stringify(result.report));
    assert.equal(result.report.issues.some((issue) => issue.ruleId === "IMPLEMENTATION_CONSTANT_MISMATCH"), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Studio-shaped client-controlled reward flow is rejected by M2", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "forge-studio-fault-test-"));
  const studioCopy = resolve(temporaryRoot, "studio");
  try {
    cpSync(studioFixture, studioCopy, { recursive: true, filter: (source) => !source.includes("/.forge") });
    const serverPath = resolve(studioCopy, "src/server/CollectFruit.server.luau");
    const safe = 'player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + Fruit42:GetAttribute("Reward"))';
    const vulnerable = 'player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + _claimedAmount)';
    writeFileSync(serverPath, readFileSync(serverPath, "utf8").replace(safe, vulnerable));
    const result = runVerify(studioCopy);
    assert.equal(result.status, 1);
    assert.ok(result.report.issues.some((issue) => issue.ruleId === "REMOTE_CLIENT_CONTROLLED_REWARD"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function runVerify(path: string, environment: Record<string, string> = {}): { status: number; report: TestReport } {
  const traceDirectory = mkdtempSync(resolve(tmpdir(), "forge-verify-test-"));
  try {
    const output = execFileSync(process.execPath, [cli, "verify", path, "--trace-dir", traceDirectory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment } });
    return { status: 0, report: JSON.parse(output) as TestReport };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { status: failure.status, report: JSON.parse(failure.stdout) as TestReport };
  } finally {
    rmSync(traceDirectory, { recursive: true, force: true });
  }
}
