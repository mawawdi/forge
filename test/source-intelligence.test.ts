import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  SourceConsultationRecorder,
  PinnedSourceAnalysisHost,
  assertCreatorSourceConsultation,
  assertPinnedSourceAnalysisToolchain,
  createHashVerifiedChunkSourceResolver,
  createTestFixtureSourceResolver,
  createStudioSourceIndex,
  findStudioSourceReferences,
  findStudioSourceSymbols,
  inspectStudioSourceDependencies,
  listStudioSourceDocuments,
  readStudioSource,
  readStudioSourceAsync,
  replayCreatorSourceConsultation,
  searchStudioSource,
  ensurePinnedSourceAnalysisToolchain,
  installPinnedSourceAnalysisToolchain,
  type SourceAnalysisToolchainLock,
  type SourceDocumentInput,
} from "../packages/source-intelligence/src/index.js";

const snapshotHash = contentHash("source-intelligence-fixture");

function document(
  documentId: string,
  path: string,
  className: string,
  source: string,
): SourceDocumentInput {
  return {
    documentId,
    path,
    className,
    executionContext:
      className === "LocalScript" ? "client" : className === "Script" ? "server" : "shared",
    sourceHash: contentHash(source),
    source,
  };
}

function sourceIndex() {
  const documents = [
    document(
      "consumer-a",
      "ReplicatedStorage/Systems/A/Consumer",
      "ModuleScript",
      [
        "local Shared = require(script.Parent.Shared)",
        "local door = Shared.open()",
        "return door",
        "",
      ].join("\n"),
    ),
    document(
      "shared-a",
      "ReplicatedStorage/Systems/A/Shared",
      "ModuleScript",
      "return { open = function() return true end }\n",
    ),
    document(
      "consumer-b",
      "ReplicatedStorage/Systems/B/Consumer",
      "ModuleScript",
      "return require(script.Parent.Shared)\n",
    ),
    document(
      "shared-b",
      "ReplicatedStorage/Systems/B/Shared",
      "ModuleScript",
      "return { open = function() return false end }\n",
    ),
    document(
      "dynamic",
      "ServerScriptService/Dynamic",
      "Script",
      [
        'local moduleName = "Shared"',
        "-- require(script.Parent.NotAnEdge)",
        "local module = require(script.Parent[moduleName])",
        'print("require(script.Parent.StringOnly)")',
        "",
      ].join("\n"),
    ),
  ];
  return {
    index: createStudioSourceIndex({
      snapshotHash,
      documents,
    }),
    resolver: createTestFixtureSourceResolver(documents),
  };
}

function productionSourceInput(documents: readonly SourceDocumentInput[]) {
  const descriptors = documents.map(({ source, ...document }) => ({
    ...document,
    utf8Bytes: Buffer.byteLength(source, "utf8"),
  }));
  return {
    documents: descriptors,
    resolver: createHashVerifiedChunkSourceResolver({
      documents: descriptors,
      chunks: [
        ...new Map(
          documents.map((entry) => [
            entry.sourceHash,
            {
              sourceHash: entry.sourceHash,
              ordinal: 0,
              startByte: 0,
              endByte: Buffer.byteLength(entry.source, "utf8"),
              utf8: entry.source,
            },
          ]),
        ).values(),
      ],
    }),
  };
}

test("source index validates source bytes and produces reproducible canonical documents", () => {
  const input = document(
    "with-hyphen-id",
    "ReplicatedStorage/Library",
    "ModuleScript",
    "return true\n",
  );
  const index = createStudioSourceIndex({ snapshotHash, documents: [input] });
  assert.equal(index.documents[0]?.utf8Bytes, Buffer.byteLength(input.source, "utf8"));
  assert.equal(index.documents[0]?.lineCount, 2);
  assert.equal(index.id, createStudioSourceIndex({ snapshotHash, documents: [input] }).id);
  assert.equal(index.analysisAuthority, "fixture_parser");
  assert.equal("source" in (index.documents[0] ?? {}), false);
  assert.throws(
    () =>
      createStudioSourceIndex({
        snapshotHash,
        documents: [{ ...input, sourceHash: contentHash("different") }],
      }),
    /hash does not match/i,
  );
});

test("chunk source resolver defers hash verification until the selected source is read", () => {
  const source = "alpha\néclair\nomega\n";
  const bytes = Buffer.from(source, "utf8");
  const split = Buffer.byteLength("alpha\né", "utf8");
  const input = document("chunked", "ReplicatedStorage/Chunked", "ModuleScript", source);
  const descriptor = {
    documentId: input.documentId,
    path: input.path,
    className: input.className,
    executionContext: input.executionContext,
    sourceHash: input.sourceHash,
    utf8Bytes: bytes.byteLength,
  };
  const resolver = createHashVerifiedChunkSourceResolver({
    documents: [descriptor],
    chunks: [
      {
        sourceHash: input.sourceHash,
        ordinal: 0,
        startByte: 0,
        endByte: split,
        utf8: bytes.subarray(0, split).toString("utf8"),
      },
      {
        sourceHash: input.sourceHash,
        ordinal: 1,
        startByte: split,
        endByte: bytes.byteLength,
        utf8: bytes.subarray(split).toString("utf8"),
      },
    ],
  });
  const range = resolver.readRange(
    {
      documentId: input.documentId,
      path: input.path,
      className: input.className,
      executionContext: input.executionContext,
      sourceHash: input.sourceHash,
    },
    {
      startByte: Buffer.byteLength("alpha\n", "utf8"),
      endByte: Buffer.byteLength("alpha\néclair", "utf8"),
    },
  );
  assert.equal(range.source, "éclair");
  assert.equal(range.endByte - range.startByte, Buffer.byteLength("éclair", "utf8"));
  const index = createStudioSourceIndex({ snapshotHash, documents: [input] });
  assert.equal(
    readStudioSource(index, resolver, {
      documentId: input.documentId,
      maximumUtf8Bytes: 7,
    }).source,
    "alpha\n",
  );
  assert.equal(
    searchStudioSource(index, resolver, {
      query: "éclair",
      contextUtf8Bytes: 16,
    }).matches[0]?.location.startByte,
    Buffer.byteLength("alpha\n", "utf8"),
  );
  const tampered = createHashVerifiedChunkSourceResolver({
    documents: [descriptor],
    chunks: [
      {
        sourceHash: input.sourceHash,
        ordinal: 0,
        startByte: 0,
        endByte: bytes.byteLength,
        utf8: "x".repeat(bytes.byteLength),
      },
    ],
  });
  assert.throws(
    () =>
      tampered.readRange(
        {
          documentId: input.documentId,
          path: input.path,
          className: input.className,
          executionContext: input.executionContext,
          sourceHash: input.sourceHash,
        },
        { startByte: 0, endByte: 1 },
      ),
    /bytes do not match/i,
  );
});

test("source reads preserve a valid zero-byte script in sync and async resolvers", async () => {
  const input = document("empty-script", "ServerScriptService/Empty", "Script", "");
  const { resolver } = productionSourceInput([input]);
  const index = createStudioSourceIndex({ snapshotHash, documents: [input] });
  const expected = {
    indexId: index.id,
    indexHash: index.hash,
    document: {
      documentId: input.documentId,
      path: input.path,
      className: input.className,
      executionContext: input.executionContext,
      sourceHash: input.sourceHash,
    },
    totalUtf8Bytes: 0,
    range: { startByte: 0, endByte: 0 },
    source: "",
  };
  assert.deepEqual(readStudioSource(index, resolver, { documentId: input.documentId }), expected);
  assert.deepEqual(
    await readStudioSourceAsync(
      index,
      {
        authority: "verified_source_blob",
        readRange: async (entry, range) => resolver.readRange(entry, range),
      },
      { documentId: input.documentId },
    ),
    expected,
  );
});

test("pinned toolchain startup provisions only missing locked bytes and rejects tampered executables", async () => {
  const root = await mkdtemp(`${tmpdir()}/forge-source-toolchain-test-`);
  const archive = Buffer.from("fixture release archive", "utf8");
  const rojoBinary = Buffer.from("fixture rojo binary", "utf8");
  const lspBinary = Buffer.from("fixture lsp binary", "utf8");
  const asset = (name: string, binary: string) => ({
    platforms: ["darwin-arm64" as const],
    name,
    url: `https://example.invalid/${name}`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.byteLength,
    binary,
  });
  const lock: SourceAnalysisToolchainLock = {
    kind: "ForgeSourceAnalysisToolchainLock",
    version: 1,
    tools: [
      {
        name: "rojo",
        version: "fixture",
        repository: "example/rojo",
        releaseTag: "fixture",
        githubApiRelease: "https://example.invalid/rojo",
        assets: [asset("rojo.zip", "rojo")],
      },
      {
        name: "luau-lsp",
        version: "fixture",
        repository: "example/lsp",
        releaseTag: "fixture",
        githubApiRelease: "https://example.invalid/lsp",
        assets: [asset("lsp.zip", "luau-lsp")],
      },
    ],
  };
  const extract = async (
    _archive: string,
    releaseAsset: { readonly binary: string },
  ): Promise<Buffer> => (releaseAsset.binary === "rojo" ? rojoBinary : lspBinary);
  await assert.rejects(
    assertPinnedSourceAnalysisToolchain({
      root,
      lock,
      platform: "darwin-arm64",
      extract,
    }),
    /missing/i,
  );
  let downloads = 0;
  const installed = await ensurePinnedSourceAnalysisToolchain({
    root,
    lock,
    platform: "darwin-arm64",
    download: async () => {
      downloads += 1;
      return archive;
    },
    extract,
  });
  assert.equal(installed.tools.length, 2);
  assert.equal(downloads, 2);
  const reused = await ensurePinnedSourceAnalysisToolchain({
    root,
    lock,
    platform: "darwin-arm64",
    download: async () => {
      downloads += 1;
      return archive;
    },
    extract,
  });
  assert.equal(reused.hash, installed.hash);
  assert.equal(downloads, 2);
  await writeFile(installed.tools[0]!.executable, "tampered", "utf8");
  await assert.rejects(
    ensurePinnedSourceAnalysisToolchain({
      root,
      lock,
      platform: "darwin-arm64",
      download: async () => {
        downloads += 1;
        return archive;
      },
      extract,
    }),
    /size mismatch|SHA-256 mismatch/i,
  );
  assert.equal(downloads, 2);
  const missingRoot = await mkdtemp(`${tmpdir()}/forge-source-toolchain-missing-`);
  await assert.rejects(PinnedSourceAnalysisHost.create({ root: missingRoot, lock }), /missing/i);
});

test("verified host produces production semantic rows only from bounded LSP stdio responses", async () => {
  const root = await mkdtemp(`${tmpdir()}/forge-source-lsp-host-`);
  const assets = await mkdtemp(`${tmpdir()}/forge-source-lsp-assets-`);
  const rojo = join(assets, "rojo");
  const lsp = join(assets, "luau-lsp");
  await writeFile(
    rojo,
    [
      "#!/bin/sh",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output" ]; then shift; printf \'{}\' > "$1"; exit 0; fi',
      "  shift",
      "done",
      "exit 1",
      "",
    ].join("\n"),
  );
  await writeFile(
    lsp,
    [
      "#!/usr/bin/env node",
      "let buffer = Buffer.alloc(0); let uri = '';",
      "function send(id, result) { const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result})); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body])); }",
      "function receive(message) { if (message.method === 'textDocument/didOpen') uri = message.params.textDocument.uri; if (message.id === undefined) { if (message.method === 'exit') process.exit(0); return; } if (message.method === 'initialize') return send(message.id,{capabilities:{}}); if (message.method === 'textDocument/documentSymbol') return send(message.id,[{name:'greet',kind:12,selectionRange:{start:{line:0,character:15},end:{line:0,character:20}}}]); if (message.method === 'textDocument/references') return send(message.id,[{uri,range:{start:{line:0,character:15},end:{line:0,character:20}}},{uri,range:{start:{line:1,character:7},end:{line:1,character:12}}}]); if (message.method === 'shutdown') return send(message.id,null); send(message.id,null); }",
      "process.stdin.on('data',(chunk)=>{ buffer=Buffer.concat([buffer,chunk]); for(;;){ const split=buffer.indexOf('\\r\\n\\r\\n'); if(split<0)return; const match=buffer.subarray(0,split).toString().match(/Content-Length:\\s*(\\d+)/i); if(!match)process.exit(2); const end=split+4+Number(match[1]); if(buffer.length<end)return; const body=buffer.subarray(split+4,end); buffer=buffer.subarray(end); receive(JSON.parse(body.toString('utf8'))); } });",
      "",
    ].join("\n"),
  );
  await chmod(rojo, 0o700);
  await chmod(lsp, 0o700);
  const archive = async (
    name: string,
  ): Promise<{ readonly bytes: Buffer; readonly name: string }> => {
    const path = join(assets, `${name}.zip`);
    const result = spawnSync("zip", ["-j", path, join(assets, name)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return { bytes: await readFile(path), name: `${name}.zip` };
  };
  const rojoArchive = await archive("rojo");
  const lspArchive = await archive("luau-lsp");
  const lockedAsset = (
    entry: { readonly bytes: Buffer; readonly name: string },
    binary: string,
  ) => ({
    platforms: ["darwin-arm64" as const],
    name: entry.name,
    url: `https://example.invalid/${entry.name}`,
    sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    bytes: entry.bytes.byteLength,
    binary,
  });
  const lock: SourceAnalysisToolchainLock = {
    kind: "ForgeSourceAnalysisToolchainLock",
    version: 1,
    tools: [
      {
        name: "rojo",
        version: "fixture",
        repository: "example/rojo",
        releaseTag: "fixture",
        githubApiRelease: "https://example.invalid/rojo",
        assets: [lockedAsset(rojoArchive, "rojo")],
      },
      {
        name: "luau-lsp",
        version: "fixture",
        repository: "example/lsp",
        releaseTag: "fixture",
        githubApiRelease: "https://example.invalid/lsp",
        assets: [lockedAsset(lspArchive, "luau-lsp")],
      },
    ],
  };
  await installPinnedSourceAnalysisToolchain({
    root,
    lock,
    platform: "darwin-arm64",
    download: async (asset) =>
      asset.name === rojoArchive.name ? rojoArchive.bytes : lspArchive.bytes,
  });
  const source = "local function greet() return true end\nreturn greet()\n";
  const host = await PinnedSourceAnalysisHost.create({
    root,
    lock,
    platform: "darwin-arm64",
  });
  const sourceDocuments = [
    document("studio:module:semantic-left", "ReplicatedStorage/Greet", "ModuleScript", source),
    document("studio:module:semantic-right", "ReplicatedStorage/Greet", "ModuleScript", source),
  ];
  const material = productionSourceInput(sourceDocuments);
  const outcome = await host.analyze({
    snapshotHash,
    // Display paths are not authority keys; the private staged workspace must
    // still analyze two distinct opaque documents without collapsing them.
    ...material,
  });
  if (outcome.status !== "complete") throw new Error(outcome.reason);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.index.analysisAuthority, "pinned_luau_lsp");
  assert.ok(outcome.index.pinnedToolchainProof);
  assert.equal(
    outcome.index.documents.filter((entry) => entry.path === "ReplicatedStorage/Greet").length,
    2,
  );
  assert.equal(outcome.index.symbols[0]?.name, "greet");
  assert.ok(outcome.index.references.length >= 2);
  assert.equal("source" in (outcome.index.documents[0] ?? {}), false);

  const exhausted = await host.analyze({
    snapshotHash,
    ...material,
    bounds: {
      maximumDocuments: 1,
      maximumDocumentUtf8Bytes: 1024,
      maximumAggregateUtf8Bytes: 1024,
      maximumStaticDependencyRows: 16,
    },
  });
  assert.deepEqual(exhausted, {
    status: "incomplete",
    code: "source_analysis_resource_exhausted",
    reason: "source_analysis_resource_exhausted: document_count_exceeded",
  });
});

test("static requires resolve by exact path, retain dynamic edges, and do not confuse duplicate module names", () => {
  const { index } = sourceIndex();
  const a = inspectStudioSourceDependencies(index, {
    documentId: "consumer-a",
    direction: "imports",
  });
  assert.equal(a.dependencies.length, 1);
  assert.equal(a.dependencies[0]?.resolution, "resolved");
  assert.equal(a.dependencies[0]?.target?.path, "ReplicatedStorage/Systems/A/Shared");
  const b = inspectStudioSourceDependencies(index, {
    documentId: "consumer-b",
    direction: "imports",
  });
  assert.equal(b.dependencies[0]?.target?.path, "ReplicatedStorage/Systems/B/Shared");
  const dynamic = inspectStudioSourceDependencies(index, {
    documentId: "dynamic",
    direction: "imports",
  });
  assert.equal(dynamic.dependencies.length, 1);
  assert.equal(dynamic.dependencies[0]?.resolution, "dynamic");
  assert.equal(dynamic.dependencies[0]?.reason, "non_static_member_expression");
  const reverse = inspectStudioSourceDependencies(index, {
    documentId: "shared-a",
    direction: "importers",
  });
  assert.equal(reverse.dependencies[0]?.source.path, "ReplicatedStorage/Systems/A/Consumer");
});

test("duplicate display paths are never document authority and static requires fail closed as ambiguous", () => {
  const documents = [
    document(
      "consumer",
      "ReplicatedStorage/Consumer",
      "ModuleScript",
      "return require(script.Parent.Shared)\n",
    ),
    document(
      "shared-left",
      "ReplicatedStorage/Shared",
      "ModuleScript",
      'return { side = "left" }\n',
    ),
    document(
      "shared-right",
      "ReplicatedStorage/Shared",
      "ModuleScript",
      'return { side = "right" }\n',
    ),
  ];
  const index = createStudioSourceIndex({
    snapshotHash,
    documents,
  });
  const resolver = createTestFixtureSourceResolver(documents);

  assert.equal(
    index.documents.filter((entry) => entry.path === "ReplicatedStorage/Shared").length,
    2,
  );
  const dependencies = inspectStudioSourceDependencies(index, {
    documentId: "consumer",
    direction: "imports",
  });
  assert.equal(dependencies.dependencies.length, 1);
  assert.equal(dependencies.dependencies[0]?.resolution, "unresolved");
  assert.equal(dependencies.dependencies[0]?.reason, "ambiguous_duplicate_path");
  assert.throws(
    () =>
      readStudioSource(index, resolver, {
        documentId: "ReplicatedStorage/Shared",
      }),
    /document is absent/i,
  );
  assert.match(readStudioSource(index, resolver, { documentId: "shared-left" }).source, /left/);
  assert.match(readStudioSource(index, resolver, { documentId: "shared-right" }).source, /right/);
});

test("source search, document listing, and reads are bounded and cursor-bound", () => {
  const source = `${"é".repeat(17_000)} marker`; // 34,007 UTF-8 bytes: requires more than one read page.
  const documents = [
    document("a", "ReplicatedStorage/A", "ModuleScript", "-- marker\nreturn true\n"),
    document("b", "ReplicatedStorage/B", "ModuleScript", "-- marker\nreturn true\n"),
    document("large", "ReplicatedStorage/Large", "ModuleScript", source),
  ];
  const index = createStudioSourceIndex({
    snapshotHash,
    documents,
  });
  const resolver = createTestFixtureSourceResolver(documents);
  const firstDocuments = listStudioSourceDocuments(index, { limit: 1 });
  assert.equal(firstDocuments.documents.length, 1);
  assert.ok(firstDocuments.nextCursor);
  const secondDocuments = listStudioSourceDocuments(index, {
    limit: 1,
    cursor: firstDocuments.nextCursor,
  });
  assert.notEqual(secondDocuments.documents[0]?.path, firstDocuments.documents[0]?.path);
  const firstSearch = searchStudioSource(index, resolver, {
    query: "marker",
    limit: 1,
    contextUtf8Bytes: 32,
  });
  assert.equal(firstSearch.matches.length, 1);
  assert.ok(firstSearch.nextCursor);
  const searchCursor = firstSearch.nextCursor;
  const secondSearch = searchStudioSource(index, resolver, {
    query: "marker",
    limit: 1,
    contextUtf8Bytes: 32,
    cursor: searchCursor,
  });
  assert.notEqual(secondSearch.matches[0]?.document.path, firstSearch.matches[0]?.document.path);
  assert.throws(
    () =>
      searchStudioSource(index, resolver, {
        query: "other",
        limit: 1,
        contextUtf8Bytes: 32,
        cursor: searchCursor,
      }),
    /cursor is invalid/i,
  );
  const tampered = `${firstSearch.nextCursor!.slice(0, -1)}A`;
  assert.throws(
    () =>
      searchStudioSource(index, resolver, {
        query: "marker",
        limit: 1,
        contextUtf8Bytes: 32,
        cursor: tampered,
      }),
    /cursor/i,
  );
  const firstRead = readStudioSource(index, resolver, { documentId: "large" });
  assert.equal(Buffer.byteLength(firstRead.source, "utf8"), 32 * 1024);
  assert.ok(firstRead.nextCursor);
  const secondRead = readStudioSource(index, resolver, {
    documentId: "large",
    cursor: firstRead.nextCursor,
  });
  assert.equal(`${firstRead.source}${secondRead.source}`, source);
});

test("symbols and references are lexical, excluding comment and string text", () => {
  const { index } = sourceIndex();
  const symbols = findStudioSourceSymbols(index, { query: "door" });
  assert.deepEqual(
    symbols.symbols.map((entry) => entry.name),
    ["door"],
  );
  const references = findStudioSourceReferences(index, { symbol: "require" });
  assert.equal(references.references.length, 3);
  assert.ok(references.references.every((entry) => entry.role === "reference"));
  assert.ok(
    references.references.every(
      (entry) =>
        entry.document.path !== "ServerScriptService/Dynamic" || entry.location.startLine === 3,
    ),
  );
});

test("symbol, reference, and dependency cursors remain bound to their exact query", () => {
  const documents = [
    document(
      "runner",
      "ReplicatedStorage/Runner",
      "ModuleScript",
      [
        "local value = require(script.Parent.A)",
        "local again = require(script.Parent.B)",
        "return value + value",
        "",
      ].join("\n"),
    ),
    document("a", "ReplicatedStorage/A", "ModuleScript", "return 1\n"),
    document("b", "ReplicatedStorage/B", "ModuleScript", "return 2\n"),
  ];
  const index = createStudioSourceIndex({
    snapshotHash,
    documents,
  });
  const symbols = findStudioSourceSymbols(index, { query: "a", limit: 1 });
  assert.ok(symbols.nextCursor);
  const nextSymbols = findStudioSourceSymbols(index, {
    query: "a",
    limit: 1,
    cursor: symbols.nextCursor,
  });
  assert.equal(nextSymbols.symbols.length, 1);
  const references = findStudioSourceReferences(index, {
    symbol: "value",
    limit: 1,
  });
  assert.ok(references.nextCursor);
  const nextReferences = findStudioSourceReferences(index, {
    symbol: "value",
    limit: 1,
    cursor: references.nextCursor,
  });
  assert.equal(nextReferences.references.length, 1);
  const dependencies = inspectStudioSourceDependencies(index, {
    documentId: "runner",
    direction: "imports",
    limit: 1,
  });
  assert.ok(dependencies.nextCursor);
  const dependencyCursor = dependencies.nextCursor;
  const nextDependencies = inspectStudioSourceDependencies(index, {
    documentId: "runner",
    direction: "imports",
    limit: 1,
    cursor: dependencyCursor,
  });
  assert.equal(nextDependencies.dependencies.length, 1);
  assert.throws(
    () =>
      inspectStudioSourceDependencies(index, {
        documentId: "runner",
        direction: "closure",
        limit: 1,
        cursor: dependencyCursor,
      }),
    /cursor is invalid/i,
  );
});

test("host-derived consultations seal exact exposed source and graph facts and replay validates them", () => {
  const { index, resolver } = sourceIndex();
  const recorder = new SourceConsultationRecorder(index, resolver);
  recorder.search({ query: "Shared", limit: 2 });
  recorder.read({ documentId: "consumer-a", maximumUtf8Bytes: 64 });
  recorder.dependenciesPage({
    documentId: "consumer-a",
    direction: "closure",
    maxDepth: 4,
  });
  const consultation = recorder.seal();
  assertCreatorSourceConsultation(consultation, index);
  const readConsultation = consultation.sources.find(
    (entry) => entry.document.path === "ReplicatedStorage/Systems/A/Consumer",
  );
  assert.ok(
    readConsultation?.ranges.some((range) => range.startByte === 0 && range.endByte === 64),
  );
  assert.equal(
    readConsultation?.document.sourceHash,
    index.documents.find((entry) => entry.path === "ReplicatedStorage/Systems/A/Consumer")
      ?.sourceHash,
  );
  const replayed = replayCreatorSourceConsultation(index, consultation);
  assert.ok(
    replayed.sources.some(
      (entry) => entry.document.path === "ReplicatedStorage/Systems/A/Consumer",
    ),
  );
  assert.ok(replayed.sources.some((entry) => entry.ranges.length > 0));
  assert.equal(
    replayed.dependencies[0]?.target?.sourceHash,
    index.documents.find((entry) => entry.path === "ReplicatedStorage/Systems/A/Shared")
      ?.sourceHash,
  );
  assert.throws(
    () =>
      assertCreatorSourceConsultation(
        {
          ...consultation,
          sources: [
            {
              ...consultation.sources[0]!,
              document: {
                ...consultation.sources[0]!.document,
                sourceHash: contentHash("forged"),
              },
            },
          ],
        },
        index,
      ),
    /outside its index/i,
  );
  const forgedOperation = consultation.operations.find((operation) => operation.kind === "read");
  assert.ok(forgedOperation);
  assert.throws(
    () =>
      assertCreatorSourceConsultation(
        {
          ...consultation,
          operations: consultation.operations.map((operation) =>
            operation === forgedOperation ? { ...operation, sources: [] } : operation,
          ),
        },
        index,
      ),
    /result hash|aggregate sources/i,
  );
});
