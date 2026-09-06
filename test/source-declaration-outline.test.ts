import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { PinnedSourceAnalysisHost } from "../packages/source-intelligence/src/index.js";
import { createLuauDeclarationOutline } from "../packages/source-intelligence/src/declaration-outline.js";

const parser = PinnedSourceAnalysisHost.create({ root: process.cwd() });
async function parse(source: string) {
  const document = {
    documentId: contentHash(source),
    path: "ReplicatedStorage/Library",
    className: "ModuleScript",
    executionContext: "shared" as const,
    sourceHash: contentHash(source),
    utf8Bytes: Buffer.byteLength(source),
  };
  const result = await (
    await parser
  ).analyzeAst({
    snapshotHash: contentHash("declaration-outline"),
    documents: [document],
    resolver: {
      authority: "verified_source_blob",
      read: () => source,
      readRange: (_document, range) => ({
        ...range,
        source: Buffer.from(source).subarray(range.startByte, range.endByte).toString("utf8"),
      }),
    },
  });
  assert.equal(result.status, "complete");
  return result.documents[0]!;
}

test("declaration excerpts preserve exact UTF-8/CRLF signatures without implementation bodies", async () => {
  const source = [
    "local Library = {}",
    "local greeting = '你好' -- unrelated trailing comment",
    "export type Config = {",
    "  amount: number,",
    "}",
    "-- 文档 belongs to start",
    "function Library.start(",
    "  config: Config",
    "): number",
    "  local implementationOnly = 42",
    "  return implementationOnly",
    "end",
    "function Library.empty() end",
    "return Library",
    "",
  ].join("\r\n");
  const document = await parse(source);
  const outline = createLuauDeclarationOutline(document, source);
  assert.equal(outline.complete, true);
  assert.equal(outline.declarations.length, 4);
  assert.equal(outline.declarations[0]!.documentation, undefined);
  assert.equal(outline.declarations[1]!.documentation, "-- 文档 belongs to start");
  assert.match(outline.declarations[1]!.text, /config: Config\r\n\): number/);
  assert.doesNotMatch(JSON.stringify(outline), /implementationOnly|unrelated trailing comment/);
  for (const declaration of outline.declarations)
    assert.equal(
      declaration.text,
      Buffer.from(source).subarray(declaration.startByte, declaration.endByte).toString("utf8"),
    );
  assert.deepEqual(createLuauDeclarationOutline(document, source), outline);
  assert.throws(() => createLuauDeclarationOutline(document, source + " "), /does not match/);
});

test("anonymous returned functions are omitted and bounded outlines report incompleteness", async () => {
  const source = "return { run = function() print('implementation') end }\n";
  assert.deepEqual(createLuauDeclarationOutline(await parse(source), source).declarations, []);
  const large = Array.from(
    { length: 80 },
    (_, index) => `export type T${index} = { value: string }`,
  ).join("\n");
  const outline = createLuauDeclarationOutline(await parse(large), large, 1024);
  assert.equal(outline.complete, false);
  assert.ok(outline.declarations.length > 0 && outline.declarations.length < 80);
});
