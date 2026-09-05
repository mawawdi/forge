import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertBuildTrace,
  contentHash,
  stableJson,
  type BuildOutcome,
} from "../packages/contracts/src/index.js";
import {
  FlightRecorder,
  JsonFileTraceSink,
  createBuildKey,
  type FlightRecorderClock,
  type TraceSink,
} from "../packages/flight-recorder/src/index.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "dist/packages/cli/src/index.js");
const cleanFixture = resolve(root, "test/fixtures/authoritative-state-safe");
const insecureFixture = resolve(root, "test/fixtures/client-controlled-authoritative-state");

test("build keys are deterministic while execution trace IDs remain distinct", () => {
  const context = {
    project: {
      id: "project_test",
      startingSnapshotHash: "snapshot_a",
      resultingSnapshotHash: "snapshot_a",
      manifestHash: "manifest_a",
      snapshotRetention: "not_retained" as const,
    },
    references: {},
    components: {
      toolchain: [{ name: "luau-analyze", configHash: "a".repeat(64) }],
      verifiers: [{ name: "forge", configHash: "b".repeat(64) }],
    },
  };
  assert.equal(createBuildKey(context), createBuildKey(context));

  const clock = fixedClock();
  const one = new FlightRecorder(
    { projectId: "project_test", project: context.project, components: context.components },
    { clock, traceIdFactory: () => "trace_one" },
  );
  const two = new FlightRecorder(
    { projectId: "project_test", project: context.project, components: context.components },
    { clock, traceIdFactory: () => "trace_two" },
  );
  const outcome = acceptedOutcome();
  const traceOne = one.complete(outcome, { issues: [] }, semanticReplayability());
  const traceTwo = two.complete(outcome, { issues: [] }, semanticReplayability());
  assert.equal(traceOne.buildKey, traceTwo.buildKey);
  assert.notEqual(traceOne.id, traceTwo.id);
});

test("local sink writes a content-addressed, privacy-minimized trace that trace show can read", async () => {
  const traceDirectory = await mkdtemp(resolve(tmpdir(), "forge-flight-recorder-"));
  try {
    const run = await verifyProject(insecureFixture, { traceDirectory });
    assert.equal(run.report.gate.status, "rejected");
    assert.equal(run.tracePersistence.status, "written");
    assert.equal(run.trace.outcome.localGate, "rejected");
    assert.equal(run.trace.outcome.runtimeGate, "not_run");
    assert.deepEqual(
      run.trace.spans.map((span) => span.name),
      ["forge.project.snapshot", "forge.verify.luau", "forge.verify.replication"],
    );
    assert.ok(run.trace.events.some((event) => event.name === "forge.issue.detected"));
    assert.equal(run.trace.privacy.rawSourceStored, false);
    assert.ok(!stableJson(run.trace).includes("claimedAmount"));

    const loaded = await new JsonFileTraceSink(traceDirectory).read(run.trace.id);
    assert.deepEqual(loaded, run.trace);
    assertBuildTrace(loaded);

    const output = execFileSync(
      process.execPath,
      [cli, "trace", "show", run.trace.id, "--trace-dir", traceDirectory],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal((JSON.parse(output) as { id: string }).id, run.trace.id);
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
});

test("trace persistence failures are explicit and never alter a verification decision", async () => {
  const failingSink: TraceSink = {
    async persist() {
      throw new Error("disk intentionally unavailable");
    },
  };
  const run = await verifyProject(cleanFixture, { traceSink: failingSink });
  assert.equal(run.report.gate.status, "eligible");
  assert.equal(run.tracePersistence.status, "failed");
  assert.match(run.tracePersistence.error ?? "", /Trace persistence failed/);
});

test("overlapping spans reserve unique IDs before any completion or recorded interval", () => {
  const clock = new ManualClock();
  const recorder = new FlightRecorder({ projectId: "overlap" }, { clock });
  const first = recorder.startSpan("forge.project.snapshot");
  const second = recorder.startSpan("forge.verify.luau");
  recorder.recordSpan("forge.verify.replication", "ok");
  clock.advance(2);
  recorder.endSpan(second, "ok");
  clock.advance(3);
  recorder.endSpan(first, "ok");
  const trace = recorder.complete(
    { ...acceptedOutcome(), latencyMs: { total: 5 } },
    { issues: [] },
    semanticReplayability(),
  );
  assert.equal(new Set(trace.spans.map((span) => span.id)).size, 3);
  assert.deepEqual(
    trace.spans.map((span) => span.durationMs),
    [0, 2, 5],
  );
  assertBuildTrace(trace);
});

test("flight recorder uses monotonic intervals and BuildTrace rejects impossible timing evidence", () => {
  const clock = new ManualClock();
  const recorder = new FlightRecorder(
    { projectId: "project_timing" },
    { clock, traceIdFactory: () => "trace_timing" },
  );
  const rootSpan = recorder.startSpan("forge.agent.execute");
  clock.advance(7);
  assert.equal(recorder.endSpan(rootSpan, "ok"), 7);
  const trace = recorder.complete(
    { ...acceptedOutcome(), latencyMs: { total: 7 } },
    { issues: [] },
    semanticReplayability(),
  );
  assert.equal(trace.spans[0]?.durationMs, 7);
  assertBuildTrace(trace);

  const durationMismatch = structuredClone(trace);
  durationMismatch.spans[0]!.durationMs = 6;
  assert.throws(() => assertBuildTrace(durationMismatch), /duration/);

  const invalidIso = structuredClone(trace);
  invalidIso.spans[0]!.startedAt = "not-a-timestamp";
  assert.throws(() => assertBuildTrace(invalidIso), /startedAt/);

  const escapedSpan = structuredClone(trace);
  escapedSpan.spans[0]!.endedAt = "2026-08-29T00:00:00.008Z";
  escapedSpan.spans[0]!.durationMs = 8;
  assert.throws(() => assertBuildTrace(escapedSpan), /outside trace interval/);

  const zeroRootLatency = structuredClone(trace);
  zeroRootLatency.spans[0]!.endedAt = zeroRootLatency.spans[0]!.startedAt;
  zeroRootLatency.spans[0]!.durationMs = 0;
  assert.throws(() => assertBuildTrace(zeroRootLatency), /Nonzero aggregate latency/);

  const duplicateSequence = structuredClone(trace);
  duplicateSequence.events[0]!.sequence = duplicateSequence.spans[0]!.sequence;
  assert.throws(() => assertBuildTrace(duplicateSequence), /unique ordered/);
});

function fixedClock(): FlightRecorderClock {
  let milliseconds = 0;
  return {
    now: () =>
      new Date(
        `2026-08-29T00:00:${String(Math.floor(milliseconds / 1_000)).padStart(2, "0")}.${String(milliseconds++ % 1_000).padStart(3, "0")}Z`,
      ),
    monotonicNow: () => milliseconds,
  };
}

class ManualClock implements FlightRecorderClock {
  private milliseconds = 0;
  now(): Date {
    return new Date(`2026-08-29T00:00:00.${String(this.milliseconds).padStart(3, "0")}Z`);
  }
  monotonicNow(): number {
    return this.milliseconds;
  }
  advance(durationMs: number): void {
    this.milliseconds += durationMs;
  }
}

function acceptedOutcome(): BuildOutcome {
  return {
    status: "locally_eligible",
    localGate: "eligible",
    runtimeGate: "not_run",
    assertions: { total: 0, passed: 0 },
    modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: { total: 0 },
    issueCounts: { info: 0, warning: 0, error: 0, critical: 0 },
  };
}

function semanticReplayability() {
  return {
    level: "semantic_reproduction" as const,
    reasons: [contentHash("fixture")],
    randomSeeds: {},
  };
}
