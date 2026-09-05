import assert from "node:assert/strict";
import test from "node:test";
import {
  AnalysisProcessDeadline,
  MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES,
} from "../packages/luau-toolchain/src/process.js";

test("analysis subprocess output is limited across consecutive tools", () => {
  const execution = new AnalysisProcessDeadline({ deadlineMs: 10_000 });
  const run = () =>
    execution.run(
      process.execPath,
      ["-e", 'require("node:fs").writeSync(1, "x".repeat(11 * 1024 * 1024));'],
      { cwd: process.cwd(), maxBuffer: MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES },
    );
  const first = run();
  assert.equal(first.failure, undefined);
  assert.equal(first.status, 0);
  const second = run();
  assert.equal(second.failure?.kind, "output_limit");
  const outputBytes = Buffer.byteLength(
    first.stdout + first.stderr + second.stdout + second.stderr,
  );
  assert.ok(outputBytes <= MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES);
  const third = run();
  assert.equal(third.failure?.kind, "output_limit");
  assert.equal(third.stdout + third.stderr, "");
});

test("an output limit fails even when each stream separately fits the subprocess allowance", () => {
  const execution = new AnalysisProcessDeadline({ deadlineMs: 10_000 });
  const result = execution.run(
    process.execPath,
    [
      "-e",
      'require("node:fs").writeSync(1, "a".repeat(700)); require("node:fs").writeSync(2, "b".repeat(700));',
    ],
    { cwd: process.cwd(), maxBuffer: 1_024 },
  );
  assert.equal(result.failure?.kind, "output_limit");
});

test("host execution deadlines reject non-finite, fractional, and unbounded values", () => {
  for (const deadlineMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
    assert.throws(
      () => new AnalysisProcessDeadline({ deadlineMs }),
      /deadlineMs must be an integer/,
    );
});
