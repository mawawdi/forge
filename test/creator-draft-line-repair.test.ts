import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  patchCreatorDraftSource,
  type CreatorDraftLineEdit,
} from "../packages/creator-session/src/index.js";

const patch = (source: string, edits: readonly CreatorDraftLineEdit[]) =>
  patchCreatorDraftSource(source, contentHash(source), edits);

test("line replacements preserve following code without requiring a newline roundtrip", () => {
  const source = "local answer = 1\nprint(answer)\nreturn answer\n";
  for (const replacement of ["local answer = 2", "local answer = 2\n"])
    assert.equal(
      patch(source, [{ startLine: 1, deleteCount: 1, replacement }]),
      "local answer = 2\nprint(answer)\nreturn answer\n",
    );
  assert.equal(
    patch(source, [{ startLine: 2, deleteCount: 1, replacement: "print('ready')\nprint(answer)" }]),
    "local answer = 1\nprint('ready')\nprint(answer)\nreturn answer\n",
  );
});

test("line insertion, deletion and adjacent repairs use original coordinates", () => {
  const source = "local answer = 1\nprint(answer)\nreturn answer\n";
  assert.equal(
    patch(source, [{ startLine: 2, deleteCount: 0, replacement: "-- inserted" }]),
    "local answer = 1\n-- inserted\nprint(answer)\nreturn answer\n",
  );
  assert.equal(
    patch(source, [{ startLine: 2, deleteCount: 1, replacement: "" }]),
    "local answer = 1\nreturn answer\n",
  );
  assert.equal(
    patch(source, [
      { startLine: 2, deleteCount: 1, replacement: "print('ready')" },
      { startLine: 1, deleteCount: 1, replacement: "local answer = 2" },
    ]),
    "local answer = 2\nprint('ready')\nreturn answer\n",
  );
  assert.equal(patch(source, [{ startLine: 2, deleteCount: 0, replacement: "" }]), source);
});

test("end-of-file replacement keeps exact endings and never invents a final blank line", () => {
  for (const source of ["local answer = 1\nreturn answer", "local answer = 1\nreturn answer\n"])
    for (const replacement of ["return 2", "return 2\n", "return 2\n\n", ""])
      assert.equal(
        patch(source, [{ startLine: 2, deleteCount: 1, replacement }]),
        "local answer = 1\n" + replacement,
      );
  assert.equal(
    patch("", [{ startLine: 1, deleteCount: 0, replacement: "return true" }]),
    "return true",
  );
  assert.equal(
    patch("return true\n", [{ startLine: 2, deleteCount: 0, replacement: "-- appended" }]),
    "return true\n-- appended",
  );
  assert.throws(
    () => patch("return true", [{ startLine: 2, deleteCount: 0, replacement: "-- appended" }]),
    /append after an unterminated line/,
  );
});

test("line separators preserve supplied CRLF, blank lines and untouched Unicode bytes", () => {
  const source = "local title = 'שלום'\r\nlocal value = 1\r\nreturn value\r\n";
  for (const replacement of ["local value = 2\r\n", "local value = 2\r"])
    assert.equal(
      patch(source, [{ startLine: 2, deleteCount: 1, replacement }]),
      "local title = 'שלום'\r\nlocal value = 2\r\nreturn value\r\n",
    );
  assert.equal(
    patch(source, [{ startLine: 2, deleteCount: 1, replacement: "local value = 2" }]),
    "local title = 'שלום'\r\nlocal value = 2\nreturn value\r\n",
  );
  assert.equal(
    patch(source, [{ startLine: 2, deleteCount: 1, replacement: "local value = 2\n\n" }]),
    "local title = 'שלום'\r\nlocal value = 2\n\nreturn value\r\n",
  );
});

test("line-boundary materialization retains stale, overlap and invalid-range rejection", () => {
  const source = "first\nsecond\nthird\n";
  assert.throws(
    () =>
      patchCreatorDraftSource(source, contentHash("stale"), [
        { startLine: 1, deleteCount: 1, replacement: "changed" },
      ]),
    /draft changed/i,
  );
  assert.throws(
    () =>
      patch(source, [
        { startLine: 1, deleteCount: 2, replacement: "changed" },
        { startLine: 2, deleteCount: 1, replacement: "overlap" },
      ]),
    /overlap/,
  );
  assert.throws(
    () =>
      patch(source, [
        { startLine: 1, deleteCount: 1, replacement: "changed" },
        { startLine: 9, deleteCount: 1, replacement: "outside" },
      ]),
    /No edits were applied; the source hash is unchanged/,
  );
  assert.equal(contentHash(source), contentHash("first\nsecond\nthird\n"));
});
