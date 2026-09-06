import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorComponentRepairStore } from "../packages/creator-session/src/component-repair.js";
import { creatorComponentIssueDetails } from "../packages/creator-session/src/component-issue-details.js";
import {
  creatorGameCatalog,
  creatorGameComponentSchema,
} from "../packages/creator-session/src/game-authoring.js";
import { gameRecipeDefinitionLock } from "../packages/game-ir/src/index.js";

test("the recorded UI rejection exposes exact issue values and repairs without resending its declaration", async () => {
  const fixture = JSON.parse(await readFile("test/fixtures/rejected-component-ui.json", "utf8"));
  assert.equal(contentHash(stableJson(fixture.input)), fixture.origin.inputHash);
  const catalog = await creatorGameCatalog();
  const definition = catalog.definitions.find(
    (entry) => entry.id === fixture.input.component.definition.id,
  )!;
  // Preserve the exact recorded semantic declaration; only the explicit installed
  // recipe lock is rebound for current-code regression, never live authority.
  const input = structuredClone(fixture.input);
  input.component.definition = gameRecipeDefinitionLock(definition);
  const schema = z
    .object({ component: creatorGameComponentSchema(catalog), activity: z.string().optional() })
    .strict();
  const issues = creatorComponentIssueDetails(schema, input);
  assert.equal(issues.omittedCount, 0);
  const controller = issues.items.find(
    (issue) => stableJson(issue.path) === stableJson(["component", "controller"]),
  );
  assert.ok(controller);
  assert.deepEqual(controller.operations, ["remove"]);
  assert.deepEqual(controller.current, { status: "present", value: input.component.controller });
  const bounds = issues.items.filter((issue) =>
    ["maxWidth", "maxHeight"].includes(String(issue.path.at(-1))),
  );
  assert.ok(bounds.length >= 10);
  assert.ok(
    bounds.every(
      (issue) => stableJson(issue.current) === stableJson({ status: "present", value: 0 }),
    ),
  );
  const horizontal = issues.items.find((issue) => issue.path.at(-1) === "horizontal");
  assert.ok(horizontal);
  const store = new CreatorComponentRepairStore({
    sessionId: "rejected-ui-fixture",
    projectCaptureHash: "1".repeat(64),
    catalogHash: "2".repeat(64),
  });
  const attempt = store.retain(
    input,
    { code: "TOOL_ARGUMENTS_INVALID", message: "Recorded UI schema failure" },
    { componentId: input.component.id, componentHash: null },
  )!;
  const read = store.read(attempt.id);
  assert.equal(read.authority, "untrusted_model_attempt");
  assert.deepEqual(read.selected, {
    path: ["component"],
    status: "present",
    value: input.component,
  });
  const edits = [
    { op: "remove", path: controller.path },
    ...bounds.map((issue) => ({ op: "replace", path: issue.path, value: 640 })),
    { op: "replace", path: horizontal.path, value: "Center" },
  ];
  const prepared = store.prepare({ attemptId: attempt.id, edits });
  const result = schema.safeParse(prepared.input);
  assert.equal(result.success, true, result.success ? "" : result.error.message);
  assert.deepEqual(store.inputFor(attempt.id), input);
  assert.ok(
    Buffer.byteLength(stableJson({ attemptId: attempt.id, edits })) <
      Buffer.byteLength(stableJson(input)) / 3,
  );
});

test("structured issue views explicitly bound values and omitted issue locations", () => {
  const schema = z
    .object({ component: z.object({ names: z.array(z.string().max(1)) }).strict() })
    .strict();
  const input = {
    component: { names: Array.from({ length: 80 }, () => "large invalid string".repeat(100)) },
  };
  const issues = creatorComponentIssueDetails(schema, input);
  assert.equal(issues.total, 80);
  assert.ok(issues.items.length <= 32);
  assert.equal(issues.omittedCount, 80 - issues.items.length);
  assert.ok(issues.items.every((issue) => issue.current.status === "not_loaded"));
  assert.ok(Buffer.byteLength(stableJson(issues.items)) < 9 * 1024);
});

test("issue suggestions never offer edits to protected or unaddressable paths", () => {
  const schema = z
    .object({ component: z.object({ config: z.object({}).strict() }).strict() })
    .strict();
  const input = JSON.parse(
    '{"component":{"id":"a","config":{"constructor":1,"__proto__":2,"prototype":3}}}',
  );
  const issues = creatorComponentIssueDetails(schema, input);
  assert.equal(issues.total, 4);
  assert.ok(issues.items.every((issue) => issue.operations.length === 0));
});
