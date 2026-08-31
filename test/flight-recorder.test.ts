import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertBuildTrace, contentHash, stableJson, type BuildOutcome } from "../packages/contracts/src/index.js";
import { FlightRecorder, JsonFileTraceSink, createBuildKey, type TraceSink } from "../packages/flight-recorder/src/index.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "dist/packages/cli/src/index.js");
const cleanFixture = resolve(root, "test/fixtures/authoritative-state-safe");
const insecureFixture = resolve(root, "test/fixtures/client-controlled-authoritative-state");

test("build keys are deterministic while execution trace IDs remain distinct", () => {
  const context = {
    project: { id: "project_test", startingSnapshotHash: "snapshot_a", resultingSnapshotHash: "snapshot_a", manifestHash: "manifest_a", snapshotRetention: "not_retained" as const },
    references: {},
    components: { toolchain: [{ name: "luau-analyze", version: "binary_a" }], verifiers: [{ name: "forge", version: "rules_a" }] }
  };
  assert.equal(createBuildKey(context), createBuildKey(context));

  const now = fixedClock();
  const one = new FlightRecorder({ projectId: "project_test", project: context.project, components: context.components }, { now, traceIdFactory: () => "trace_one" });
  const two = new FlightRecorder({ projectId: "project_test", project: context.project, components: context.components }, { now, traceIdFactory: () => "trace_two" });
  const outcome = acceptedOutcome();
  const traceOne = one.complete(outcome, { issues: [] }, semanticReplayability());
  const traceTwo = two.complete(outcome, { issues: [] }, semanticReplayability());
  assert.equal(traceOne.buildKey, traceTwo.buildKey);
  assert.notEqual(traceOne.id, traceTwo.id);
});

test("local sink writes a versioned, privacy-minimized trace that trace show can read", async () => {
  const traceDirectory = await mkdtemp(resolve(tmpdir(), "forge-flight-recorder-"));
  try {
    const run = await verifyProject(insecureFixture, { traceDirectory });
    assert.equal(run.report.gate.status, "rejected");
    assert.equal(run.tracePersistence.status, "written");
    assert.equal(run.trace.outcome.localGate, "rejected");
    assert.equal(run.trace.outcome.runtimeGate, "not_run");
    assert.deepEqual(run.trace.spans.map((span) => span.name), ["forge.project.snapshot", "forge.verify.luau", "forge.verify.replication"]);
    assert.ok(run.trace.events.some((event) => event.name === "forge.issue.detected"));
    assert.equal(run.trace.privacy.rawSourceStored, false);
    assert.ok(!stableJson(run.trace).includes("claimedAmount"));

    const loaded = await new JsonFileTraceSink(traceDirectory).read(run.trace.id);
    assert.deepEqual(loaded, run.trace);
    assertBuildTrace(loaded);

    const output = execFileSync(process.execPath, [cli, "trace", "show", run.trace.id, "--trace-dir", traceDirectory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((JSON.parse(output) as { id: string }).id, run.trace.id);
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
});

test("trace persistence failures are explicit and never alter a verification decision", async () => {
  const failingSink: TraceSink = {
    async persist() {
      throw new Error("disk intentionally unavailable");
    }
  };
  const run = await verifyProject(cleanFixture, { traceSink: failingSink });
  assert.equal(run.report.gate.status, "eligible");
  assert.equal(run.tracePersistence.status, "failed");
  assert.match(run.tracePersistence.error ?? "", /Trace persistence failed/);
});

test("trace boundary validation rejects an unversioned object", () => {
  assert.throws(() => assertBuildTrace({ kind: "BuildTrace", schemaVersion: 0 }), /Invalid BuildTrace/);
});

function fixedClock(): () => Date {
  let milliseconds = 0;
  return () => new Date(`2026-08-29T00:00:${String(milliseconds++).padStart(2, "0")}.000Z`);
}

function acceptedOutcome(): BuildOutcome {
  return {
    status: "locally_eligible",
    localGate: "eligible",
    runtimeGate: "not_run",
    assertions: { total: 0, passed: 0 },
    modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: { total: 0 },
    issueCounts: { info: 0, warning: 0, error: 0, critical: 0 }
  };
}

function semanticReplayability() {
  return { level: "semantic_reproduction" as const, reasons: [contentHash("fixture")], randomSeeds: {} };
}
