import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  creatorBuildRecoverySourceMemberHistory,
  loadCreatorBuildRecovery,
  writeCreatorBuildRecovery,
} from "../packages/creator-session/src/build-recovery.js";
import {
  creatorBuildRecoveryFixture,
  recoveryToolResult,
  writeRecoveryTestRun,
  type RecoveryTestStep,
} from "./helpers/creator-build-recovery-fixture.js";

const before =
  "--!strict\nlocal function setVisible(instance: BasePart)\n  instance.Visible = true\nend\nreturn setVisible\n";
const after = before.replace("instance: BasePart", "instance: any");
const diagnostic = {
  message: "Key 'Visible' not found in external type 'BasePart'",
  line: 3,
  column: 3,
  endLine: 3,
  endColumn: 19,
};
const sourceReceipt = (source: string) => ({
  planChangeId: "source-0",
  kind: "create",
  operationHash: contentHash("operation:" + source),
  sourceHash: contentHash(source),
  sourceBytes: Buffer.byteLength(source),
});
function buildStep(): RecoveryTestStep {
  const { message, ...location } = diagnostic;
  return {
    name: "studio.build",
    input: {
      sources: [{ slotId: "source-0", source: before }],
      summary: "Created the declared module.",
    },
    changesState: true,
    result: recoveryToolResult({
      changes: [
        { planChangeId: "folder", kind: "create", operationHash: contentHash("folder") },
        sourceReceipt(before),
      ],
      review: {
        status: "rejected",
        issues: [
          {
            ruleId: "LUAU_TYPE_ERROR",
            severity: "error",
            planChangeId: "source-0",
            message,
            locations: [location],
            count: 1,
          },
          {
            ruleId: "OTHER_RULE",
            severity: "error",
            planChangeId: "source-0",
            message,
            locations: [location],
            count: 1,
          },
        ],
      },
    }),
  };
}
function repairStep(): RecoveryTestStep {
  return {
    name: "studio.repair",
    input: {
      repairs: [
        {
          kind: "source",
          planChangeId: "source-0",
          expectedSourceHash: contentHash(before),
          edits: [
            {
              startLine: 2,
              deleteCount: 1,
              replacement: "local function setVisible(instance: any)\n",
            },
          ],
        },
      ],
      summary: "Retained the same member access.",
    },
    changesState: true,
    result: recoveryToolResult({
      changes: [sourceReceipt(after)],
      review: { status: "rejected", issues: [] },
    }),
  };
}

test("journal-derived member history survives type erasure and excludes unrelated diagnostics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-member-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 1 });
  const run = await writeRecoveryTestRun(directory, authority, [buildStep(), repairStep()]);
  const saved = await writeCreatorBuildRecovery({ ...authority, ...run });
  assert.deepEqual(saved.recovery.calls[0]!.sourceMemberDiagnostics, [
    { slotId: "source-0", diagnostics: [diagnostic] },
  ]);
  assert.deepEqual(saved.recovery.calls[1]!.sourceMemberDiagnostics, []);
  const history = creatorBuildRecoverySourceMemberHistory(saved.recovery);
  assert.deepEqual(history, [
    {
      slotId: "source-0",
      source: before,
      sourceHash: contentHash(before),
      diagnostics: [diagnostic],
    },
  ]);
  assert.equal(run.run.toolCalls.length, 2, "No fabricated historical tool calls");
  assert.deepEqual(
    await loadCreatorBuildRecovery({ ...authority, ...run, artifact: saved.artifact }),
    saved.recovery,
  );

  const altered = structuredClone(saved.recovery);
  altered.calls[0]!.sourceMemberDiagnostics = [];
  const { id: _id, hash: _hash, ...payload } = altered;
  const hash = contentHash(stableJson(payload));
  const artifact = await run.store.write({
    ...payload,
    id: "creator_build_recovery_" + hash.slice(0, 24),
    hash,
  });
  await assert.rejects(
    () => loadCreatorBuildRecovery({ ...authority, ...run, artifact }),
    /exact completed journal/,
  );
});

test("member history refuses stale repairs, mismatched source receipts and out-of-source locations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-member-recovery-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const authority = creatorBuildRecoveryFixture({ sourceSlots: 1 });
  for (const kind of ["stale", "receipt", "location"] as const) {
    const build = buildStep();
    const repair = repairStep();
    if (kind === "stale")
      (
        repair.input as { repairs: { expectedSourceHash: string }[] }
      ).repairs[0]!.expectedSourceHash = contentHash("unrelated");
    if (kind === "receipt")
      repair.result = recoveryToolResult({
        changes: [sourceReceipt(before)],
        review: { status: "rejected", issues: [] },
      });
    if (kind === "location") {
      const value = structuredClone(build.result.value) as {
        review: { issues: { locations: { line: number }[] }[] };
      };
      value.review.issues[0]!.locations[0]!.line = 100;
      build.result = recoveryToolResult(value);
    }
    const run = await writeRecoveryTestRun(directory, authority, [build, repair]);
    const saved = await writeCreatorBuildRecovery({ ...authority, ...run });
    assert.throws(
      () => creatorBuildRecoverySourceMemberHistory(saved.recovery),
      kind === "stale" ? /hash|stale/i : kind === "receipt" ? /receipt/ : /location/,
    );
  }
});
