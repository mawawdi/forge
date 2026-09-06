import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { createGameSourceContextReader } from "../packages/creator-session/src/game-source-context.js";
import { createGameSourceBrief } from "../packages/creator-session/src/game-source-brief.js";
import { checkGameSourceImports } from "../packages/creator-session/src/game-source-checks.js";
import { compileGamePlan, expandGameDesign } from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  type GameDesignSpec,
  type GameSourceFile,
} from "../packages/game-ir/src/index.js";
import { PinnedSourceAnalysisHost } from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

function fixture(
  options: {
    names?: string[];
    sourceRoot?: string;
    targetRoot?: string;
    context?: GameSourceFile["context"];
    toolRoot?: string;
    lockedSource?: string;
  } = {},
) {
  const sourceRoot = options.sourceRoot ?? "ReplicatedStorage";
  const targetRoot = options.targetRoot ?? sourceRoot;
  const roots = [
    ...new Set([sourceRoot.split("/")[0]!, targetRoot.split("/")[0]!, sourceRoot, targetRoot]),
  ];
  const topology = roots.map((path) => ({
    identity: { kind: "forge_attribute" as const, stableId: path },
    ...(path.includes("/")
      ? { parentIdentity: { kind: "forge_attribute" as const, stableId: path.split("/")[0]! } }
      : {}),
    name: path.split("/").at(-1)!,
    path,
    className: path === options.toolRoot ? "Tool" : path.split("/").at(-1)!,
    ...(path === options.toolRoot
      ? {}
      : { engineContainer: { path, className: path.split("/").at(-1)! } }),
  }));
  const parentFor = (path: string) =>
    path === options.toolRoot
      ? {
          kind: "instance" as const,
          path,
          className: "Tool",
          identity: { kind: "forge_attribute" as const, stableId: path },
        }
      : { kind: "engine_container" as const, path, className: path.split("/").at(-1)! };
  const files: GameSourceFile[] = (options.names ?? ["Name", 'Quoted "module"', "研究 module"]).map(
    (name, index) => ({
      id: "dependency-" + index,
      path: "Dependency" + index + ".luau",
      context: "shared",
      role: "module",
      imports: [],
      content:
        options.lockedSource === undefined
          ? { kind: "slot", maximumUtf8Bytes: 8192 }
          : {
              kind: "locked",
              sourceHash: contentHash(options.lockedSource),
              utf8Bytes: Buffer.byteLength(options.lockedSource),
            },
      placement: {
        kind: "create",
        operationId: "dependency-" + index,
        name,
        className: "ModuleScript",
        parent: parentFor(targetRoot),
      },
    }),
  );
  files.push({
    id: "main",
    path: "Main.luau",
    context: options.context ?? "shared",
    role: "module",
    imports: files.map((file) => ({ componentId: "code", fileId: file.id })),
    content: { kind: "slot", maximumUtf8Bytes: 32768 },
    placement: {
      kind: "create",
      operationId: "main",
      name: "Main",
      className: "ModuleScript",
      parent: parentFor(sourceRoot),
    },
  });
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "source-navigation",
    intent: "Wire declared modules without reconstructing paths",
    components: [{ kind: "source_package", id: "code", ports: [], obligations: [], files }],
    connections: [],
    artifactDependencies: [],
  };
  const input = {
    design,
    registry: createGameDefinitionRegistry([]),
    projectId: "source-context",
    project: { name: "Source context", placeId: 0, universeId: 0 },
    initialTopology: topology,
  };
  const plan = compileGamePlan({
    ...input,
    ...expandGameDesign(input),
    sessionId: "source-context-session",
    observedRevisionHash: contentHash("source-context-revision"),
  });
  return { plan, read: createGameSourceContextReader(plan), files };
}

test("initial source brief supplies deduplicated exact declarations and imports with explicit deferred pages", async () => {
  const source =
    "local Library = {}\nexport type Input = { value: number }\nfunction Library.apply(input: Input): number\n  local privateCalculation = input.value * 2\n  return privateCalculation\nend\nreturn Library\n";
  const { plan, read } = fixture({
    lockedSource: source,
    names: Array.from({ length: 35 }, (_, index) => "Utility" + index),
  });
  const reference = await createGameSourceBrief(plan, new Map([[contentHash(source), source]]));
  assert.equal(reference.slots.length, 1);
  assert.equal(reference.slots[0]!.nextOffset, 32);
  assert.equal(reference.modules.length, 32);
  assert.equal(reference.declarations.length, 1);
  assert.equal(reference.declarations[0]!.sourceHash, contentHash(source));
  assert.equal(reference.parsing.status, "complete");
  assert.deepEqual(reference.deferredDeclarations, []);
  assert.doesNotMatch(stableJson(reference.declarations), /privateCalculation/);
  const page = read({ planHash: plan.hash, operationId: "main", offset: 0 });
  assert.deepEqual(
    reference.slots[0]!.imports.map((item) => item.requireExpression),
    page.imports.map((item) => item.requireExpression),
  );
  assert.ok(
    reference.modules.every(
      (module) => module.className === "ModuleScript" && module.context === "shared",
    ),
  );
  await assert.rejects(
    createGameSourceBrief(plan, new Map([[contentHash(source), source + " "]])),
    /unavailable or changed/,
  );
});

test("accepted source navigation paginates deterministically and rejects stale or unrelated requests", () => {
  const { plan, read } = fixture({
    names: Array.from({ length: 35 }, (_, index) => "Utility" + index),
  });
  const request = { planHash: plan.hash, operationId: "main", offset: 0 };
  const first = read(request);
  assert.equal(first.imports.length, 32);
  assert.equal(first.nextOffset, 32);
  assert.equal(read({ ...request, offset: first.nextOffset! }).imports.length, 3);
  const original = read(request);
  first.source.content.kind = "tampered";
  first.imports[0]!.path = "Workspace/Unapproved";
  assert.deepEqual(read(request), original);
  assert.throws(
    () => read({ ...request, planHash: contentHash("stale") }),
    /different accepted plan/,
  );
  assert.throws(() => read({ ...request, operationId: "missing" }), /accepted source operation/);
  for (const offset of [-1, 36, 0.5, Number.NaN])
    assert.throws(() => read({ ...request, offset }), /offset/);
});

test("generated source navigation resolves exact static imports with property-name collisions and quoted Unicode names", async () => {
  const { plan, read } = fixture();
  const page = read({ planHash: plan.hash, operationId: "main", offset: 0 });
  assert.equal(page.imports[0]!.requireExpression, 'require(script.Parent:WaitForChild("Name"))');
  assert.match(page.imports[1]!.requireExpression!, /\\"module\\"/);
  const source =
    page.imports
      .map((imported, index) => "local dependency" + index + " = " + imported.requireExpression)
      .join("\n") + "\nreturn {}";
  const documents = plan.inventory.map((item) => {
    assert.equal(item.change.kind, "create");
    const body = item.id === "main" ? source : "return {}";
    return {
      documentId: item.id,
      path: item.change.kind === "create" ? item.change.path : "",
      className: "ModuleScript",
      executionContext: "shared" as const,
      sourceHash: contentHash(body),
      source: body,
    };
  });
  const host = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
  const analysis = await host.analyzeAst({
    snapshotHash: plan.observedRevisionHash,
    documents: documents.map(({ source, ...document }) => ({
      ...document,
      utf8Bytes: Buffer.byteLength(source),
    })),
    resolver: createTestFixtureSourceResolver(documents),
  });
  const result = checkGameSourceImports({ plan, analysis });
  assert.equal(result.status, "eligible", JSON.stringify(result));
  assert.equal(result.imports.length, 3);
});

test("source pages bound the complete serialized UTF-8 response including escaping and envelope", () => {
  const { plan, read } = fixture({
    names: Array.from({ length: 35 }, (_, index) => "\\".repeat(60) + "研究" + index),
  });
  let offset = 0,
    count = 0;
  while (true) {
    const page = read({ planHash: plan.hash, operationId: "main", offset });
    assert.ok(Buffer.byteLength(stableJson(page)) <= 16 * 1024);
    assert.ok(page.imports.length > 0);
    count += page.imports.length;
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(count, 35);
});

test("source navigation preserves same-copy imports and leaves cross-copy runtime binding explicit", () => {
  const same = fixture({
    sourceRoot: "StarterPlayer/StarterPlayerScripts",
    context: "client",
    names: ["Local Utility"],
  });
  assert.equal(
    same.read({ planHash: same.plan.hash, operationId: "main", offset: 0 }).imports[0]!
      .requireExpression,
    'require(script.Parent:WaitForChild("Local Utility"))',
  );
  const cross = fixture({
    sourceRoot: "StarterPlayer/StarterPlayerScripts",
    targetRoot: "StarterGui",
    context: "client",
    names: ["Screen"],
  });
  assert.equal(
    cross.read({ planHash: cross.plan.hash, operationId: "main", offset: 0 }).imports[0]!
      .requireExpression,
    undefined,
  );
  const shared = fixture({
    sourceRoot: "StarterPlayer/StarterPlayerScripts",
    targetRoot: "ReplicatedStorage",
    context: "client",
    names: ["Public"],
  });
  assert.equal(
    shared.read({ planHash: shared.plan.hash, operationId: "main", offset: 0 }).imports[0]!
      .requireExpression,
    'require(game:GetService("ReplicatedStorage"):WaitForChild("Public"))',
  );
  const ancestor = fixture({
    sourceRoot: "StarterPlayer/StarterPlayerScripts",
    targetRoot: "StarterPlayer",
    context: "client",
    names: ["Utility"],
  });
  assert.equal(
    ancestor.read({ planHash: ancestor.plan.hash, operationId: "main", offset: 0 }).imports[0]!
      .requireExpression,
    'require(game:GetService("StarterPlayer"):WaitForChild("Utility"))',
  );
});

test("source navigation keeps imports within movable Tools relative without climbing into their changing parent", () => {
  for (const root of ["Workspace", "StarterPack"]) {
    const toolRoot = root + "/Tool";
    const same = fixture({ sourceRoot: toolRoot, toolRoot, names: ["Utility"] });
    assert.equal(
      same.read({ planHash: same.plan.hash, operationId: "main", offset: 0 }).imports[0]!
        .requireExpression,
      'require(script.Parent:WaitForChild("Utility"))',
    );
    const outside = fixture({
      sourceRoot: toolRoot,
      targetRoot: "ReplicatedStorage",
      toolRoot,
      names: ["Public"],
    });
    assert.equal(
      outside.read({ planHash: outside.plan.hash, operationId: "main", offset: 0 }).imports[0]!
        .requireExpression,
      'require(game:GetService("ReplicatedStorage"):WaitForChild("Public"))',
    );
    const enters = fixture({
      sourceRoot: "ReplicatedStorage",
      targetRoot: toolRoot,
      toolRoot,
      names: ["Utility"],
    });
    assert.equal(
      enters.read({ planHash: enters.plan.hash, operationId: "main", offset: 0 }).imports[0]!
        .requireExpression,
      undefined,
    );
  }
  const leaves = fixture({
    sourceRoot: "Workspace/Tool",
    targetRoot: "Workspace",
    toolRoot: "Workspace/Tool",
    names: ["Public"],
  });
  assert.equal(
    leaves.read({ planHash: leaves.plan.hash, operationId: "main", offset: 0 }).imports[0]!
      .requireExpression,
    'require(game:GetService("Workspace"):WaitForChild("Public"))',
  );
});

test("client imports cannot make server-only modules available by declaring them shared", async () => {
  const { plan, read } = fixture({
    sourceRoot: "ReplicatedStorage",
    targetRoot: "ServerStorage",
    context: "client",
    names: ["Private"],
  });
  assert.equal(
    read({ planHash: plan.hash, operationId: "main", offset: 0 }).imports[0]!.requireExpression,
    undefined,
  );
  const documents = plan.inventory.map((item) => {
    const source =
      item.id === "main"
        ? 'return require(game:GetService("ServerStorage"):WaitForChild("Private"))'
        : "return {}";
    return {
      documentId: item.id,
      path: item.change.kind === "create" ? item.change.path : "",
      className: "ModuleScript",
      executionContext: item.id === "main" ? ("client" as const) : ("shared" as const),
      sourceHash: contentHash(source),
      source,
    };
  });
  const host = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
  const analysis = await host.analyzeAst({
    snapshotHash: plan.observedRevisionHash,
    documents: documents.map(({ source, ...document }) => ({
      ...document,
      utf8Bytes: Buffer.byteLength(source),
    })),
    resolver: createTestFixtureSourceResolver(documents),
  });
  const result = checkGameSourceImports({ plan, analysis });
  assert.equal(result.status, "rejected", JSON.stringify(result));
  assert.ok(result.issues.some((issue) => issue.ruleId === "game_import_server_only_target"));
});
