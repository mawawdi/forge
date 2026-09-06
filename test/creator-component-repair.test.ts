import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorComponentRepairStore } from "../packages/creator-session/src/component-repair.js";

const scope = {
  sessionId: "test-session",
  projectCaptureHash: "1".repeat(64),
  catalogHash: "2".repeat(64),
};
const binding = { componentId: "interface", componentHash: null };
const diagnostic = {
  code: "TOOL_ARGUMENTS_INVALID",
  message: "component.config.rows.32.tone: unknown token",
};
function fixture() {
  const store = new CreatorComponentRepairStore(scope);
  const input = {
    component: {
      id: binding.componentId,
      kind: "recipe_instance",
      definition: { id: "ui", hash: "3".repeat(64) },
      config: {
        rows: Array.from({ length: 64 }, (_, index) => ({
          id: `row-${index}`,
          tone: index === 32 ? "typo" : "action",
          description: "Exact authored bytes λ. ".repeat(10),
        })),
      },
    },
  };
  const attempt = store.retain(input, diagnostic, binding)!;
  assert.ok(attempt);
  return { store, input, attempt };
}

test("one-token repairs retain every other byte of a large invalid declaration", () => {
  const { store, input, attempt } = fixture();
  const before = structuredClone(input);
  const request = {
    attemptId: attempt.id,
    edits: [{ op: "replace", path: ["component", "config", "rows", 32, "tone"], value: "action" }],
  };
  assert.ok(Buffer.byteLength(stableJson(request)) < Buffer.byteLength(stableJson(input)) / 10);
  const prepared = store.prepare(request);
  const expected = structuredClone(input);
  expected.component.config.rows[32]!.tone = "action";
  assert.deepEqual(prepared.input, expected);
  assert.deepEqual(input, before);
  assert.deepEqual(prepared.expected, binding);
  assert.deepEqual(prepared.provenance, request);
  const snapshot = store.snapshot();
  assert.equal(snapshot[0]!.authority, "untrusted_model_attempt");
  assert.equal(snapshot[0]!.inputHash, contentHash(stableJson(input)));
  assert.deepEqual(snapshot[0]!.scope, scope);
  snapshot[0]!.binding.componentHash = "f".repeat(64);
  assert.deepEqual(store.prepare(request).expected, binding);
});

test("repair paths reject absent replacements, overlap, changed identity, and prototype access", () => {
  const { store, input, attempt } = fixture();
  const invalid = [
    [{ op: "replace", path: ["component", "id"], value: "changed" }],
    [{ op: "replace", path: ["component", "kind"], value: "source_package" }],
    [{ op: "replace", path: ["component", "definition", "hash"], value: "4".repeat(64) }],
    [{ op: "replace", path: ["component", "config", "missing"], value: 0 }],
    [{ op: "replace", path: ["component", "config", "rows", 100, "tone"], value: "action" }],
    [{ op: "replace", path: ["component", "config", "rows", "0", "tone"], value: "action" }],
    [{ op: "replace", path: ["component", "__proto__", "polluted"], value: true }],
    [{ op: "replace", path: ["component", "config", "constructor"], value: {} }],
    [
      { op: "replace", path: ["component", "config", "rows", 0], value: {} },
      { op: "replace", path: ["component", "config", "rows", 0, "tone"], value: "action" },
    ],
    [
      { op: "replace", path: ["component", "config", "rows", 0, "tone"], value: "action" },
      { op: "replace", path: ["component", "config", "rows", 0, "tone"], value: "danger" },
    ],
    [{ op: "replace", path: ["component", "config", "rows", 0, "tone"], value: "λ".repeat(32768) }],
  ];
  const before = stableJson(store.snapshot());
  for (const edits of invalid) {
    assert.throws(() => store.prepare({ attemptId: attempt.id, edits }));
    assert.equal(stableJson(store.snapshot()), before);
  }
  assert.equal(Object.hasOwn({}, "polluted"), false);
  assert.equal(store.snapshot()[0]!.inputHash, contentHash(stableJson(input)));
});

test("attempt provenance replays exactly and stays bound to its original session and current component", () => {
  const { store, input, attempt } = fixture();
  const request = {
    attemptId: attempt.id,
    edits: [
      { op: "replace", path: ["component", "config", "rows", 32, "tone"], value: "another-typo" },
    ],
  };
  const prepared = store.prepare(request);
  const child = store.retain(prepared.input, diagnostic, prepared.expected, prepared.provenance)!;
  assert.notEqual(child.id, attempt.id);
  const records = JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<typeof store.snapshot>;
  const replay = new CreatorComponentRepairStore(scope);
  for (const record of records) {
    const restored = replay.retain(
      record.input,
      record.diagnostic,
      record.binding,
      record.provenance,
    );
    assert.equal(restored?.id, record.id);
    assert.equal(restored?.hash, record.hash);
  }
  assert.deepEqual(replay.snapshot(), records);
  assert.deepEqual(
    replay.prepare({ ...request, attemptId: child.id }),
    store.prepare({ ...request, attemptId: child.id }),
  );
  const other = new CreatorComponentRepairStore({ ...scope, sessionId: "other-session" });
  assert.notEqual(other.retain(input, diagnostic, binding)!.id, attempt.id);
  assert.throws(() => other.prepare(request), /absent or superseded/);
  const changed = new CreatorComponentRepairStore(scope);
  assert.notEqual(
    changed.retain(input, diagnostic, { ...binding, componentHash: "5".repeat(64) })!.id,
    attempt.id,
  );
  store.clear(binding.componentId);
  assert.throws(() => store.prepare(request), /absent or superseded/);
});

test("malformed text never acquires a guessed editable component identity", () => {
  const store = new CreatorComponentRepairStore(scope);
  assert.equal(store.retain('{"component":{"id":"interface"', diagnostic, binding), undefined);
  assert.equal(store.retain({ component: { id: "another" } }, diagnostic, binding), undefined);
  assert.deepEqual(store.snapshot(), []);
});

test("explicit add/remove operations preserve original array positions and every unrelated value", () => {
  const store = new CreatorComponentRepairStore(scope);
  const input = {
    component: {
      id: binding.componentId,
      config: { first: ["a", "b", "c", "d"], second: [1, 2, 3], extra: "remove me" },
    },
  };
  const attempt = store.retain(input, diagnostic, binding)!;
  const prepared = store.prepare({
    attemptId: attempt.id,
    edits: [
      { op: "remove", path: ["component", "config", "first", 0] },
      { op: "remove", path: ["component", "config", "second", 1] },
      { op: "remove", path: ["component", "config", "first", 2] },
      { op: "replace", path: ["component", "config", "first", 3], value: "updated" },
      { op: "remove", path: ["component", "config", "extra"] },
      { op: "add", path: ["component", "config", "constraints"], value: [] },
    ],
  });
  assert.deepEqual(prepared.input, {
    component: {
      id: binding.componentId,
      config: { first: ["b", "updated"], second: [1, 3], constraints: [] },
    },
  });
  assert.deepEqual(store.inputFor(attempt.id), input);
  for (const edits of [
    [{ path: ["component", "config", "extra"], value: "old implicit format" }],
    [{ op: "add", path: ["component", "config", "extra"], value: 1 }],
    [{ op: "add", path: ["component", "config", "first", 4], value: "no array insertion" }],
    [{ op: "add", path: ["component", "missing", "child"], value: 1 }],
    [{ op: "remove", path: ["component", "id"] }],
    [{ op: "remove", path: ["component", "config", "absent"] }],
    [{ op: "add", path: ["component", "config", "__proto__"], value: {} }],
    [
      { op: "remove", path: ["component", "config", "first"] },
      { op: "replace", path: ["component", "config", "first", 0], value: 0 },
    ],
  ])
    assert.throws(() => store.prepare({ attemptId: attempt.id, edits }));
});

test("failed-attempt reads expose exact untrusted input with bounded subtree navigation", () => {
  const { store, input, attempt } = fixture();
  const read = store.read(attempt.id);
  assert.equal(read.authority, "untrusted_model_attempt");
  assert.equal(read.inputHash, contentHash(stableJson(input)));
  assert.equal(read.selected.status, "not_loaded");
  assert.equal("components" in read, false);
  assert.equal("componentHash" in read, false);
  assert.equal(store.latestFor(binding.componentId), attempt.id);
  const selected = store.read(attempt.id, ["component", "config", "rows", 32]);
  assert.deepEqual(selected.selected, {
    path: ["component", "config", "rows", 32],
    status: "present",
    value: input.component.config.rows[32],
  });
  if (selected.selected.status === "present")
    (selected.selected.value as { tone: string }).tone = "mutated caller";
  assert.deepEqual(store.inputFor(attempt.id), input);
  assert.throws(() => store.read(attempt.id, ["component", "config", "rows", "32"]), /absent/);
  store.clear(binding.componentId);
  assert.equal(store.latestFor(binding.componentId), undefined);
  assert.throws(() => store.read(attempt.id), /absent or superseded/);
});

test("malformed syntax reads preserve UTF-8 bytes across bounded slices without granting editable identity", () => {
  const store = new CreatorComponentRepairStore(scope);
  const input = "a".repeat(16383) + "🦊λ".repeat(5000) + '{"component":';
  const retained = store.retainSyntax(input, diagnostic)!;
  assert.equal(retained.bytes, Buffer.byteLength(input));
  assert.equal(retained.inputHash, contentHash(input));
  const chunks: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const read = store.readSyntax(retained.id, offset);
    assert.equal(read.authority, "untrusted_model_attempt");
    assert.equal(read.offset, offset);
    assert.ok(Buffer.byteLength(read.text) <= 16 * 1024);
    chunks.push(read.text);
    offset = read.nextOffset;
  }
  assert.equal(chunks.join(""), input);
  assert.deepEqual(store.snapshot(), []);
  assert.throws(() => store.prepare({ attemptId: retained.id, edits: [] }));
  assert.throws(() => store.readSyntax(retained.id, 16384), /UTF-8 boundary/);
  assert.throws(() => store.readSyntax(retained.id, retained.bytes + 1), /UTF-8 boundary/);
  assert.throws(() => store.readSyntax(retained.id, -1));
  const fresh = new CreatorComponentRepairStore(scope);
  assert.deepEqual(fresh.retainSyntax(input, diagnostic), retained);
  assert.deepEqual(fresh.readSyntax(retained.id), store.readSyntax(retained.id));
  const other = new CreatorComponentRepairStore({ ...scope, sessionId: "other" });
  assert.notEqual(other.retainSyntax(input, diagnostic)!.id, retained.id);
  assert.throws(() => other.readSyntax(retained.id), /absent/);
  store.clear(binding.componentId);
  assert.equal(store.readSyntax(retained.id).inputHash, retained.inputHash);
});
