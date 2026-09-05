import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  HostPhaseRecorder,
  loadCreatorHostTimingReport,
} from "../packages/flight-recorder/src/host-phase.js";

test("durable host timings retain failed and interrupted work without inventing totals or outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-host-timing-"));
  try {
    let elapsed = 0;
    const recorder = new HostPhaseRecorder(directory, {
      now: () => new Date("2026-09-05T00:00:00.000Z"),
      monotonicNow: () => elapsed,
    });
    const correlation = { sessionId: "creator_session_timing", agentRunId: "agent_run_timing" };
    const result = await recorder.measure("local_build_review", correlation, () => {
      elapsed += 12;
      return "candidate rejected";
    });
    assert.equal(result, "candidate rejected");
    const fault = new Error("transport lost");
    await assert.rejects(
      recorder.measure("apply_readback_roundtrip", correlation, () => {
        elapsed += 7;
        throw fault;
      }),
      (error) => error === fault,
    );
    await recorder.start("finalization_roundtrip", correlation); // Simulated interrupted host.
    const report = await loadCreatorHostTimingReport(directory, correlation.sessionId);
    assert.equal(report.status, "available");
    assert.deepEqual(
      report.spans.map((item) => item.durationMs).sort((a, b) => a - b),
      [7, 12],
    );
    assert.equal(
      report.spans.find((item) => item.span.phase === "apply_readback_roundtrip")!.outcome,
      "threw",
    );
    assert.equal(report.incomplete.length, 1);
    assert.equal(report.incomplete[0]!.phase, "finalization_roundtrip");
    assert.equal("durationMs" in report.incomplete[0]!, false);
    assert.deepEqual(report.agentRunIds, ["agent_run_timing"]);
    const missing = await loadCreatorHostTimingReport(directory, "creator_session_unrecorded");
    assert.equal(missing.status, "unavailable");
    assert.deepEqual(missing.phases, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timing report rejects tampering, unsafe paths and symlinked evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-timing-safety-"));
  try {
    const sessionId = "creator_session_safety";
    await new HostPhaseRecorder(directory).measure("source_analysis", { sessionId }, () => 1);
    const artifacts = join(directory, "host-timings", contentHash(sessionId), "artifacts");
    const names = await readdir(artifacts);
    await writeFile(join(artifacts, names[0]!), "{}\n");
    await assert.rejects(loadCreatorHostTimingReport(directory, sessionId), /SHA-256|byte count/);
    await assert.rejects(loadCreatorHostTimingReport(directory, "../../outside"), /session ID/);
    const linkSession = "creator_session_symlink";
    await symlink(
      join(directory, "host-timings", contentHash(sessionId)),
      join(directory, "host-timings", contentHash(linkSession)),
    );
    await assert.rejects(loadCreatorHostTimingReport(directory, linkSession), /Unsafe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timing persistence failure cannot replace an authoritative operation result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-timing-storage-"));
  try {
    await writeFile(join(directory, "host-timings"), "blocked");
    const recorder = new HostPhaseRecorder(directory);
    assert.equal(
      await recorder.measure("reconciliation", { sessionId: "session" }, () => "matched"),
      "matched",
    );
    assert.deepEqual(recorder.persistenceFailures, [
      { sessionId: "session", phase: "reconciliation" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
