import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { LuauParseCache } from "../packages/source-intelligence/src/parse-cache.js";
import {
  AnalysisProcessDeadline,
  MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES,
} from "../packages/luau-toolchain/src/process.js";

test("parser cache evicts least recently used bytes and does not retain oversized output", () => {
  const cache = new LuauParseCache(8);
  cache.put("a", { stdout: "one", stderr: "" });
  cache.put("b", { stdout: "two", stderr: "" });
  assert.equal(cache.get("a")?.stdout, "one");
  cache.put("c", { stdout: "tri", stderr: "" });
  assert.equal(cache.get("b"), undefined);
  const returned = cache.get("a")!;
  returned.stdout = "changed";
  assert.equal(cache.get("a")?.stdout, "one");
  cache.put("d", { stdout: "too large", stderr: "" });
  assert.equal(cache.get("d"), undefined);
  assert.equal(cache.get("c")?.stdout, "tri");
});

test("cached parser output cannot bypass the aggregate analysis output budget", () => {
  const budget = new AnalysisProcessDeadline();
  assert.equal(
    budget.reuse({
      stdout: "a".repeat(MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES - 4),
      stderr: "warn",
    }).status,
    0,
  );
  assert.equal(budget.reuse({ stdout: "x", stderr: "" }).failure?.kind, "output_limit");
});

test("cached parser output cannot bypass an expired host deadline", async () => {
  const budget = new AnalysisProcessDeadline({ deadlineMs: 1 });
  await setTimeout(5);
  assert.equal(budget.reuse({ stdout: "{}", stderr: "" }).failure?.kind, "timeout");
});
