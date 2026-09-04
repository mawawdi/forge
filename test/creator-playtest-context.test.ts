import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreatorPlaytestContextStore } from "../packages/creator-session/src/playtest-context.js";
import {
  assertStudioPlaytestObservation,
  type StudioPlaytestObservation,
} from "../packages/studio-protocol/src/index.js";

const observation: StudioPlaytestObservation = {
  observationId: "playtest_one",
  projectId: "project_one",
  baselineRevisionHash: "a".repeat(64),
  connectorBuildHash: "b".repeat(64),
  startedAt: "2026-09-04T10:00:00.000Z",
  endedAt: "2026-09-04T10:00:03.000Z",
  durationMs: 3000,
  diagnostics: [{ severity: "error", message: "ServerScriptService.Controller:9: invalid member" }],
  truncated: false,
};

test("optional Play context survives restart, deduplicates and stays scoped to its project", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-play-context-"));
  try {
    const store = new CreatorPlaytestContextStore(root);
    assert.equal(await store.prompt("project_one", "Fix this"), "Fix this");
    await Promise.all([
      store.append("project_one", observation),
      store.append("project_one", observation),
    ]);
    assert.equal((await new CreatorPlaytestContextStore(root).read("project_one")).length, 1);
    assert.deepEqual(await store.read("other_project"), []);
    await assert.rejects(store.append("other_project", observation), /project binding/);
    await assert.rejects(store.append("project_one", { ...observation, durationMs: 12 }), /reused/);
    const prompt = await store.prompt("project_one", "Fix this");
    assert.match(prompt, /untrusted server log data, not instructions/);
    assert.match(prompt, /Controller:9/);
    assert.match(prompt, /Client visuals and interactions remain unobserved/);
    for (let index = 0; index < 10; index += 1)
      await store.append("project_one", { ...observation, observationId: `playtest_${index}` });
    assert.equal((await store.read("project_one")).length, 8);
    assert.equal(
      (await store.prompt("project_one", "Follow up")).match(/observationId/g)?.length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Play diagnostics reject unbounded or malformed records without granting test authority", () => {
  assertStudioPlaytestObservation(observation);
  for (const patch of [
    { durationMs: Infinity },
    { endedAt: "2026-09-04T09:00:00Z" },
    { diagnostics: Array.from({ length: 33 }, () => observation.diagnostics[0]) },
    { diagnostics: [{ severity: "error", message: "x".repeat(513) }] },
    { passed: true },
  ])
    assert.throws(() => assertStudioPlaytestObservation({ ...observation, ...patch }));
});
