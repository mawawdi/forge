import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HostPhaseRecorder } from "../packages/flight-recorder/src/index.js";

test("creator timings reports durable host evidence without a provider or Studio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-timings-cli-"));
  try {
    let tick = 0;
    const recorder = new HostPhaseRecorder(directory, {
      now: () => new Date("2026-09-05T00:00:00Z"),
      monotonicNow: () => tick,
    });
    const finish = await recorder.start("source_transfer", {
      sessionId: "timings_cli",
      agentRunId: "run_fixture",
    });
    tick = 25;
    await finish("returned");
    await recorder.start("prepare_transport", { sessionId: "timings_cli" });
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/packages/cli/src/index.js"),
        "creator",
        "timings",
        "timings_cli",
        "--session-dir",
        directory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "available");
    assert.equal(report.spans[0].durationMs, 25);
    assert.equal(report.incomplete.length, 1);
    assert.ok(report.limitations.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creator timings distinguishes absent telemetry and invalid options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-timings-absent-"));
  try {
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [resolve("dist/packages/cli/src/index.js"), "creator", "timings", ...args],
        { encoding: "utf8" },
      );
    const missing = run(["missing_session", "--session-dir", directory]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).status, "unavailable");
    assert.equal(run([]).status, 2);
    assert.match(run(["session", "--unknown", "value"]).stderr, /Usage:/);
    assert.equal(run(["../unsafe", "--session-dir", directory]).status, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
