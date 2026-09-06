import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertCreatorBuildRecovery,
  createCreatorBuildRecovery,
  creatorBuildRecoveryBinding,
  loadCreatorBuildRecovery,
  writeCreatorBuildRecovery,
} from "../packages/creator-session/src/build-recovery.js";
import {
  creatorBuildRecoveryFixture,
  recoveryToolResult,
  writeRecoveryTestRun,
  type RecoveryTestStep,
} from "./helpers/creator-build-recovery-fixture.js";

const directory = () => mkdtemp(join(tmpdir(), "forge-build-recovery-"));
const receipt = (text: string) => ({
  planChangeId: "folder",
  kind: "create",
  operationHash: contentHash(text),
});
const write = (name = "studio.build", text = "initial"): RecoveryTestStep => ({
  name,
  input: { sources: [], values: [], activity: text },
  changesState: true,
  result: recoveryToolResult({ changes: [receipt(text)], review: { gate: "incomplete" } }),
});
const rejected = (): RecoveryTestStep => ({
  name: "studio.repair",
  input: { bad: "retain as evidence" },
  result: recoveryToolResult({ code: "TOOL_ARGUMENTS_INVALID", message: "Wrong shape" }, false),
  rejected: true,
});

test("recovery preserves exact ordered source inputs and receipts while excluding failed calls", async () => {
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 4 });
  const sources = Array.from({ length: 4 }, (_, index) => ({
    slotId: "source-" + index,
    source: `-- retained λ ${index}\nreturn { number = ${index} }\n`,
  }));
  const build = write();
  build.input = { sources, values: [], activity: "Exact source bytes" };
  build.result = recoveryToolResult({
    changes: [
      receipt("folder"),
      ...sources.map((source) => ({
        planChangeId: source.slotId,
        kind: "create",
        operationHash: contentHash(source.slotId),
        sourceHash: contentHash(source.source),
        sourceBytes: Buffer.byteLength(source.source),
      })),
    ],
    review: { gate: "incomplete", issues: ["Old diagnostics are not recovery authority"] },
  });
  const repair = write("studio.repair", "replacement");
  repair.input = {
    repairs: [{ kind: "source", planChangeId: "source-2", source: "-- λ\nreturn 42\n" }],
    activity: "Repair the exact source",
  };
  repair.result = recoveryToolResult({
    changes: [
      {
        planChangeId: "source-2",
        operationId: "fixed-operation",
        previousOperationHash: contentHash("source-2"),
        operationHash: contentHash("replacement"),
        sourceHash: contentHash("-- λ\nreturn 42\n"),
        sourceBytes: Buffer.byteLength("-- λ\nreturn 42\n"),
      },
    ],
    review: { gate: "incomplete" },
  });
  const read = {
    name: "game.inspect_inventory",
    input: { maximumUtf8Bytes: 1024 },
    result: recoveryToolResult({ nodes: [] }),
  };
  const failed = { ...rejected(), rejected: false };
  const run = await writeRecoveryTestRun(await directory(), authority, [
    build,
    rejected(),
    read,
    failed,
    repair,
  ]);
  const input = { ...authority, ...run };
  const saved = await writeCreatorBuildRecovery(input);
  assert.deepEqual(
    saved.recovery.calls.map((call) => call.name),
    ["studio.build", "studio.repair"],
  );
  assert.deepEqual(
    saved.recovery.calls.map((call) => call.sequence),
    [1, 5],
  );
  assert.deepEqual(saved.recovery.calls[0]!.input, build.input);
  assert.deepEqual(saved.recovery.calls[1]!.input, repair.input);
  assert.deepEqual(
    saved.recovery.calls[1]!.expectedChanges,
    (repair.result.value as { changes: unknown }).changes,
  );
  assert.equal(saved.recovery.calls[0]!.inputHash, contentHash(stableJson(build.input)));
  assert.doesNotMatch(stableJson(saved.recovery), /Old diagnostics/);
  assert.equal(
    run.run.toolCalls.length,
    5,
    "failed and rejected calls remain in original evidence",
  );
  const loaded = await loadCreatorBuildRecovery({ ...input, artifact: saved.artifact });
  assert.deepEqual(loaded, saved.recovery);
  assertCreatorBuildRecovery(loaded);
});

test("second retry flattens only new repairs and rejects repeated origin runs", async () => {
  const authority = creatorBuildRecoveryFixture();
  const root = await directory();
  const first = await writeRecoveryTestRun(root, authority, [write()]);
  const prior = await writeCreatorBuildRecovery({ ...authority, ...first });
  const second = await writeRecoveryTestRun(root, authority, [write("studio.repair", "second")], {
    initialState: 1,
  });
  const next = await writeCreatorBuildRecovery({
    ...authority,
    ...second,
    priorRecovery: prior.artifact,
  });
  assert.deepEqual(
    next.recovery.calls.map((call) => call.name),
    ["studio.build", "studio.repair"],
  );
  assert.deepEqual(
    next.recovery.sourceRuns.map((source) => source.agentRunId),
    [first.run.id, second.run.id],
  );
  assert.deepEqual(
    await loadCreatorBuildRecovery({ ...authority, ...second, artifact: next.artifact }),
    next.recovery,
  );
  await assert.rejects(
    () => createCreatorBuildRecovery({ ...authority, ...second, priorRecovery: next.artifact }),
    /already represented/,
  );
  await assert.rejects(
    () => createCreatorBuildRecovery({ ...authority, ...second }),
    /initial completed studio.build/,
  );
});

test("provider failure before staging retains a verified empty recovery lineage", async () => {
  const authority = creatorBuildRecoveryFixture();
  const run = await writeRecoveryTestRun(await directory(), authority, []);
  const saved = await writeCreatorBuildRecovery({ ...authority, ...run });
  assert.deepEqual(saved.recovery.calls, []);
  assert.equal(saved.recovery.sourceRuns.length, 1);
  assert.deepEqual(
    await loadCreatorBuildRecovery({ ...authority, ...run, artifact: saved.artifact }),
    saved.recovery,
  );
});

test("terminal rejected builder status can retain completed work without a sealed success claim", async () => {
  const authority = creatorBuildRecoveryFixture();
  const run = await writeRecoveryTestRun(await directory(), authority, [write()], {
    rejectedRun: true,
  });
  const recovery = await createCreatorBuildRecovery({ ...authority, ...run });
  assert.equal(recovery.calls.length, 1);
  assert.equal(run.run.status, "rejected");
});

test("recovery rejects mismatched authority and exact journal/run or tool digest tampering", async () => {
  const authority = creatorBuildRecoveryFixture();
  const run = await writeRecoveryTestRun(await directory(), authority, [write()]);
  for (const field of [
    "sessionId",
    "projectId",
    "promptHash",
    "revisionHash",
    "planHash",
    "compiledPlanHash",
    "approvalHash",
  ] as const) {
    await assert.rejects(
      () =>
        createCreatorBuildRecovery({
          ...authority,
          ...run,
          expected: { ...authority.expected, [field]: contentHash("different") },
        }),
      /exact accepted/,
    );
  }
  const altered = structuredClone(run.run);
  altered.toolCalls[0]!.input = { unrecorded: "replacement" };
  const priorRun = await run.store.write(altered);
  await assert.rejects(
    () => createCreatorBuildRecovery({ ...authority, ...run, priorRun }),
    /disagree|hash|Invalid/,
  );
  const bad = write();
  bad.result = { ...bad.result, resultHash: contentHash("forged") };
  const forged = await writeRecoveryTestRun(await directory(), authority, [bad]);
  await assert.rejects(
    () => createCreatorBuildRecovery({ ...authority, ...forged }),
    /hashes are inconsistent/,
  );
});

test("failed mutations, unexpected executed tools and unapproved receipts cannot be skipped", async () => {
  const authority = creatorBuildRecoveryFixture();
  const cases: Array<[RecoveryTestStep, RegExp]> = [
    [{ ...rejected(), rejected: false, changesState: true }, /changed staged state/],
    [
      { name: "studio.unknown_mutation", input: {}, result: recoveryToolResult({ ok: true }) },
      /unknown executed/,
    ],
    [
      {
        ...write(),
        result: recoveryToolResult({
          changes: [{ ...receipt("outside"), planChangeId: "unapproved" }],
        }),
      },
      /exceed the accepted inventory/,
    ],
  ];
  for (const [step, error] of cases) {
    const run = await writeRecoveryTestRun(await directory(), authority, [write(), step]);
    await assert.rejects(() => createCreatorBuildRecovery({ ...authority, ...run }), error);
  }
});

test("load verifies immutable originating artifacts again rather than trusting retained arguments", async () => {
  const authority = creatorBuildRecoveryFixture();
  const root = await directory();
  const run = await writeRecoveryTestRun(root, authority, [write()]);
  const saved = await writeCreatorBuildRecovery({ ...authority, ...run });
  const path = join(root, run.priorRun.locator);
  const bytes = await readFile(path, "utf8");
  await writeFile(
    path,
    bytes.replace("Offline simulated provider outage", "Changed simulated provider outage"),
  );
  await assert.rejects(
    () => loadCreatorBuildRecovery({ ...authority, ...run, artifact: saved.artifact }),
    /SHA-256 mismatch/,
  );
});

test("binding derives accepted revision independently of later current session revision", () => {
  const authority = creatorBuildRecoveryFixture();
  assert.deepEqual(creatorBuildRecoveryBinding(authority), authority.expected);
  const { hash: _hash, ...payload } = authority.session;
  const advanced = { ...payload, currentRevisionHash: contentHash("later checkpoint") };
  const session = { ...advanced, hash: contentHash(stableJson(advanced)) };
  assert.deepEqual(creatorBuildRecoveryBinding({ ...authority, session }), authority.expected);
  assert.equal(authority.expected.revisionHash, authority.plan.projectRevisionHash);
  assert.equal(authority.expected.revisionHash, authority.contract.initialRevisionHash);
});
