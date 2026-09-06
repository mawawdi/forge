import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentHash, type VerificationIssue } from "../packages/contracts/src/index.js";
import {
  CreatorSourceRepairGuard,
  assertCreatorSourceMemberDiagnosticFrame,
  creatorSourceMemberDiagnostic,
  type CreatorSourceMemberDiagnosticFrame,
} from "../packages/creator-session/src/source-repair-obligations.js";
import {
  PinnedSourceAnalysisHost,
  type PinnedLuauAstOutcome,
} from "../packages/source-intelligence/src/index.js";

const revision = contentHash("member-repair-regression");
const slotId = "source-slot";
const path = "ServerScriptService/Fixture";
const parser = PinnedSourceAnalysisHost.create({ root: process.cwd() });
const before =
  "local function setVisible(instance: BasePart, visible: boolean)\n    instance.Visible = visible\nend\nreturn setVisible\n";
function frame(source = before, access = "instance.Visible"): CreatorSourceMemberDiagnosticFrame {
  const position = source.indexOf(access);
  assert.notEqual(position, -1);
  const prefix = source.slice(0, position).split("\n");
  const diagnostic = creatorSourceMemberDiagnostic(
    "Key 'Visible' not found in external type 'BasePart'",
    { line: prefix.length, column: Buffer.byteLength(prefix.at(-1)!) + 1 },
  )!;
  return { slotId, source, sourceHash: contentHash(source), diagnostics: [diagnostic] };
}
async function parse(source: string): Promise<PinnedLuauAstOutcome> {
  const descriptor = {
    documentId: slotId,
    path,
    className: "ModuleScript",
    executionContext: "server" as const,
    sourceHash: contentHash(source),
    utf8Bytes: Buffer.byteLength(source),
  };
  return (await parser).analyzeAst({
    snapshotHash: revision,
    documents: [descriptor],
    resolver: {
      authority: "verified_source_blob",
      read: () => source,
      readRange: (_document, range) => ({
        ...range,
        source: Buffer.from(source).subarray(range.startByte, range.endByte).toString("utf8"),
      }),
    },
  });
}
async function check(
  guard: CreatorSourceRepairGuard,
  source: string,
  diagnostics: VerificationIssue[] = [],
  analysis?: PinnedLuauAstOutcome,
) {
  return guard.check({
    snapshotHash: revision,
    sources: [{ slotId, source }],
    diagnostics,
    analysis: analysis ?? (await parse(source)),
    host: await parser,
  });
}
function retained(source = before, access = "instance.Visible") {
  const guard = new CreatorSourceRepairGuard();
  guard.seed([frame(source, access)]);
  return guard;
}

test("known invalid member survives any erasure, renames, casts and bracket spelling", async () => {
  for (const source of [
    before.replace("BasePart", "any"),
    before
      .replaceAll("setVisible", "setFlag")
      .replaceAll("instance", "target")
      .replace("BasePart", "any"),
    before.replace("instance.Visible", "(instance :: any).Visible"),
    before
      .replaceAll("setVisible", "setFlag")
      .replaceAll("instance", "target")
      .replace("BasePart", "any")
      .replace("target.Visible", 'target["Visible"]'),
  ]) {
    const result = await check(retained(), source);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert(result.issues.some((issue) => issue.ruleId === "CREATOR_MEMBER_DIAGNOSTIC_RETAINED"));
  }
});

test("member correction, supported concrete receiver, and direct IsA narrowing resolve the obligation", async () => {
  for (const source of [
    before.replace(
      "instance.Visible = visible",
      "instance.Transparency = if visible then 0 else 1",
    ),
    before.replace("BasePart", "GuiObject"),
    before
      .replace("BasePart", "Instance")
      .replace(
        "    instance.Visible = visible",
        '    if instance:IsA("GuiObject") then\n        instance.Visible = visible\n    end',
      ),
  ])
    assert.equal((await check(retained(), source)).status, "eligible", source);
  assert.equal(
    (await check(new CreatorSourceRepairGuard(), before.replace("BasePart", "any"))).status,
    "eligible",
    "This is a retained diagnostic invariant, not a universal ban on any",
  );
});

test("alias shadowing, generics and casts cannot impersonate native receiver classes", async () => {
  for (const source of [
    "type GuiObject = any\n" + before.replace("BasePart", "GuiObject"),
    before.replace("setVisible(", "setVisible<GuiObject>(").replace("BasePart", "GuiObject"),
    before
      .replace("BasePart", "any")
      .replace("instance.Visible", "(instance :: GuiObject).Visible"),
  ])
    assert.notEqual((await check(retained(), source)).status, "eligible", source);
});

test("IsA proof must dominate the same immutable receiver access", async () => {
  for (const source of [
    before
      .replace("BasePart", "Instance")
      .replace(
        "    instance.Visible = visible",
        '    if instance:IsA("GuiObject") then\n    else\n        instance.Visible = visible\n    end',
      ),
    before
      .replace("BasePart", "Instance")
      .replace(
        "    instance.Visible = visible",
        '    if instance:IsA("GuiObject") then\n        instance = nil\n        instance.Visible = visible\n    end',
      ),
    before
      .replace("BasePart", "Instance")
      .replace(
        "    instance.Visible = visible",
        '    local other: any = instance\n    if other:IsA("GuiObject") then\n        instance.Visible = visible\n    end',
      ),
    before
      .replace("BasePart", "any")
      .replace(
        "    instance.Visible = visible",
        '    if instance:IsA("GuiObject") then\n        instance.Visible = visible\n    end',
      ),
  ])
    assert.notEqual((await check(retained(), source)).status, "eligible", source);
});

test("call argument member accesses retain diagnostics and allow a real correction", async () => {
  const source = before.replace("instance.Visible = visible", "print(instance.Visible)");
  assert.equal(
    (await check(retained(source), source.replace("BasePart", "any"))).status,
    "rejected",
  );
  assert.equal(
    (await check(retained(source), source.replace("instance.Visible", "instance.Transparency")))
      .status,
    "eligible",
  );
});

test("raw current diagnostics become retained witnesses before the next repair", async () => {
  const guard = new CreatorSourceRepairGuard();
  const diagnostic = frame().diagnostics[0]!;
  const { message, ...location } = diagnostic;
  await check(guard, before, [
    {
      kind: "VerificationIssue",
      id: contentHash(message),
      ruleId: "LUAU_TYPE_ERROR",
      severity: "error",
      category: "language",
      message,
      path,
      location,
      authoritativeTier: "static",
      evidence: [],
    },
  ]);
  assert.equal((await check(guard, before.replace("BasePart", "any"))).status, "rejected");
});

test("history and parser bindings fail closed on tampering or ambiguous locations", async () => {
  assert.throws(
    () =>
      assertCreatorSourceMemberDiagnosticFrame({ ...frame(), sourceHash: contentHash("other") }),
    /hash/,
  );
  assert.throws(
    () =>
      assertCreatorSourceMemberDiagnosticFrame({
        ...frame(),
        diagnostics: [{ ...frame().diagnostics[0], line: 500 }],
      }),
    /location/,
  );
  assert.equal(
    creatorSourceMemberDiagnostic("unrelated type error", { line: 1, column: 1 }),
    undefined,
  );
  const analysis = await parse(before.replace("BasePart", "any"));
  assert.equal(analysis.status, "complete");
  assert.equal(
    (
      await check(retained(), before.replace("BasePart", "any"), [], {
        ...analysis,
        hash: contentHash("tampered"),
      } as PinnedLuauAstOutcome)
    ).status,
    "incomplete",
  );
  const guard = new CreatorSourceRepairGuard();
  guard.seed([{ ...frame(), diagnostics: [{ ...frame().diagnostics[0]!, line: 1, column: 1 }] }]);
  assert.equal((await check(guard, before.replace("BasePart", "any"))).status, "incomplete");
});

test("exact observed repair cannot hide its BasePart member failure with any", async () => {
  // Immutable source bytes from agent_run_8abf3dba-0ebe-4852-8a55-f5609f7f9990,
  // studio.repair turn 29. This parses the regression; it does not execute game code.
  const prior = readFileSync(
    "test/fixtures/source-member-repair/conduits-before-turn-29.luau",
    "utf8",
  );
  const next = readFileSync(
    "test/fixtures/source-member-repair/conduits-after-turn-29.luau",
    "utf8",
  );
  assert.equal(
    contentHash(prior),
    "2103113bb0f20380c4098d5f45f431ac1d46978f4fc6a20d67b74630a091901c",
  );
  assert.equal(
    contentHash(next),
    "7a44295d86f885960ac9973a253b8a92eabc0e33c1c7359d032ca1b326986245",
  );
  const guard = new CreatorSourceRepairGuard();
  guard.seed([
    {
      slotId,
      source: prior,
      sourceHash: contentHash(prior),
      diagnostics: [
        {
          message: "Key 'Visible' not found in external type 'BasePart'",
          line: 45,
          column: 2,
          endLine: 45,
          endColumn: 17,
        },
      ],
    },
  ]);
  const result = await check(guard, next);
  assert.equal(result.status, "rejected", JSON.stringify(result));
  assert.equal(result.witnessedDiagnostics, 1);
});
