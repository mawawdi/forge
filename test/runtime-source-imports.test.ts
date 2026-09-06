import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import type { CreatorProjectIndexView } from "../packages/creator-session/src/index.js";
import { checkGameSourceImports } from "../packages/creator-session/src/game-source-checks.js";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import {
  PinnedSourceAnalysisHost,
  type PinnedLuauAstAnalysis,
  type SourceDocumentInput,
} from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

const revision = contentHash("AST import fixture observation");
const host = PinnedSourceAnalysisHost.create({ root: process.cwd() });
function fixture(source: string, declared = true, moduleName = "Utility") {
  const documents: SourceDocumentInput[] = [
    {
      documentId: "main",
      path: "ReplicatedStorage/Main",
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: contentHash(source),
      source,
    },
    {
      documentId: "utility",
      path: "ReplicatedStorage/" + moduleName,
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: contentHash("return {}"),
      source: "return {}",
    },
  ];
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "ast-imports",
    intent: "Author general utility modules",
    connections: [],
    artifactDependencies: [],
    components: [
      {
        kind: "source_package",
        id: "code",
        ports: [],
        obligations: [],
        files: documents.map((document, index) => ({
          id: document.documentId,
          path: document.documentId + ".luau",
          role: "module",
          context: "shared",
          content: {
            kind: "locked",
            sourceHash: document.sourceHash,
            utf8Bytes: Buffer.byteLength(document.source),
          },
          imports: index === 0 && declared ? [{ componentId: "code", fileId: "utility" }] : [],
          placement: {
            kind: "create",
            operationId: document.documentId,
            className: "ModuleScript",
            name: document.path.split("/").at(-1)!,
            parent: {
              kind: "engine_container",
              path: "ReplicatedStorage",
              className: "ReplicatedStorage",
            },
          },
        })),
      },
    ],
  };
  const input = {
    design,
    registry: createGameDefinitionRegistry([]),
    projectId: "ast-fixture",
    project: { name: "AST Fixture", placeId: 0, universeId: 0 },
    initialTopology: [
      {
        identity: { kind: "forge_attribute" as const, stableId: "replicated-storage" },
        path: "ReplicatedStorage",
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
      },
    ],
  };
  const expanded = expandGameDesign({ ...input, recipeExpanders: [] });
  const plan = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "ast-session",
    observedRevisionHash: revision,
  });
  return { plan, documents };
}
async function parse(documents: SourceDocumentInput[], deadlineMs?: number) {
  return (await host).analyzeAst(
    {
      snapshotHash: revision,
      documents: documents.map(({ source, ...document }) => ({
        ...document,
        utf8Bytes: Buffer.byteLength(source),
      })),
      resolver: createTestFixtureSourceResolver(documents),
    },
    deadlineMs === undefined ? {} : { deadlineMs },
  );
}
async function check(source: string, declared = true, moduleName = "Utility") {
  const { plan, documents } = fixture(source, declared, moduleName);
  const analysis = await parse(documents);
  assert.equal(analysis.status, "complete", JSON.stringify(analysis));
  return checkGameSourceImports({ plan, analysis });
}

test("observed source packages retain client/shared private-import restrictions", async () => {
  for (const context of ["client", "shared", "server"] as const) {
    const source = 'return require(game:GetService("ServerStorage"):WaitForChild("Utility"))';
    const { plan: base, documents: original } = fixture(source);
    const documents = original.map((document, index) =>
      index === 0
        ? { ...document, executionContext: context }
        : { ...document, path: "ServerStorage/Utility" },
    );
    const identity = { kind: "forge_attribute" as const, stableId: "observed-main" };
    const target = {
      kind: "instance" as const,
      identity,
      path: "ReplicatedStorage/Main",
      className: "ModuleScript",
    };
    const code = base.design.components[0]!;
    assert.equal(code.kind, "source_package");
    if (code.kind !== "source_package") return;
    const design: GameDesignSpec = {
      ...base.design,
      components: [
        {
          ...code,
          files: code.files.map((file) =>
            file.id === "main"
              ? { ...file, context, placement: { kind: "observed", target } }
              : {
                  ...file,
                  placement: {
                    kind: "create",
                    operationId: "utility",
                    name: "Utility",
                    className: "ModuleScript",
                    parent: {
                      kind: "engine_container",
                      path: "ServerStorage",
                      className: "ServerStorage",
                    },
                  },
                },
          ),
        },
      ],
    };
    const observation: CreatorProjectIndexView = {
      project: base.project,
      revision: { hash: revision } as CreatorProjectIndexView["revision"],
      instances: [
        {
          objectId: "observed-main",
          identity,
          path: target.path,
          name: "Main",
          className: target.className,
          properties: {},
          attributes: {},
          tags: [],
        },
      ],
      scripts: [
        {
          documentId: "observed-main",
          path: target.path,
          className: "ModuleScript",
          executionContext: context,
          sourceHash: contentHash(source),
          utf8Bytes: Buffer.byteLength(source),
        },
      ],
    };
    const input = {
      design,
      registry: createGameDefinitionRegistry([]),
      projectId: base.projectId,
      project: base.project,
      observation,
      initialTopology: [
        ...base.initialTopology,
        {
          identity: { kind: "forge_attribute" as const, stableId: "server-storage" },
          path: "ServerStorage",
          name: "ServerStorage",
          className: "ServerStorage",
          engineContainer: { path: "ServerStorage", className: "ServerStorage" },
        },
        {
          identity,
          path: target.path,
          name: "Main",
          className: target.className,
          parentIdentity: base.initialTopology[0]!.identity,
        },
      ],
    };
    const plan = compileGamePlan({
      ...input,
      ...expandGameDesign(input),
      sessionId: "observed-import-session",
      observedRevisionHash: revision,
    });
    assert.equal(plan.observedSources.length, 1);
    assert.equal(plan.inventory.length, 1, "observed source remains unmodified");
    const analysis = await parse(documents);
    assert.equal(analysis.status, "complete", JSON.stringify(analysis));
    const result = checkGameSourceImports({ plan, analysis });
    assert.equal(
      result.status,
      context === "server" ? "eligible" : "rejected",
      JSON.stringify(result),
    );
    assert.equal(
      result.issues.some((issue) => issue.ruleId === "game_import_server_only_target"),
      context !== "server",
    );
  }
});

test("official parser reuses unchanged source bytes across hosts while rechecking the current import topology", async () => {
  const source = "local parseReuseProbe = 739271\nreturn require(script.Parent.Utility)";
  const original = fixture(source);
  const first = await parse(original.documents);
  assert.equal(first.status, "complete");
  if (first.status !== "complete") return;
  const repeat = await parse(original.documents);
  assert.equal(repeat.status, "complete");
  if (repeat.status !== "complete") return;
  assert.equal(repeat.executions.length, 0);
  assert.equal(repeat.reusedParses.length, 2);
  assert.deepEqual(repeat.documents, first.documents);
  // Mutating one consumer's AST cannot modify the retained parser bytes.
  (repeat.documents[0]!.ast as Record<string, unknown>).root = null;
  const moved = fixture(source, true, "RenamedUtility");
  const freshHost = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
  const current = await freshHost.analyzeAst({
    snapshotHash: revision,
    documents: moved.documents.map(({ source: body, ...document }) => ({
      ...document,
      utf8Bytes: Buffer.byteLength(body),
    })),
    resolver: createTestFixtureSourceResolver(moved.documents),
  });
  assert.equal(current.status, "complete");
  if (current.status !== "complete") return;
  assert.equal(current.executions.length, 0);
  assert.equal(checkGameSourceImports({ plan: moved.plan, analysis: current }).status, "rejected");
  const repaired = fixture(source.replace("739271", "739272"));
  const changed = await parse(repaired.documents);
  assert.equal(changed.status, "complete");
  if (changed.status !== "complete") return;
  assert.equal(changed.executions.length, 1);
  assert.deepEqual(
    changed.reusedParses.map((entry) => entry.documentId),
    ["utility"],
  );
  assert.equal(
    checkGameSourceImports({ plan: repaired.plan, analysis: changed }).status,
    "eligible",
  );
});

test("official pinned AST resolves exact imports through immutable aliases, groups and child lookups", async () => {
  for (const source of [
    "return require(script.Parent.Utility)",
    "local RS = game:GetService('ReplicatedStorage')\nlocal Modules = RS\nreturn require(Modules:WaitForChild('Utility'))",
    "local Parent = script.Parent\nreturn require((Parent['Utility'] :: ModuleScript))",
  ]) {
    const result = await check(source);
    assert.equal(result.status, "eligible", JSON.stringify(result));
    assert.deepEqual(result.imports, [{ from: "code/main", to: "code/utility" }]);
  }
});

test("ordinary service use, constructors, local functions and require strings are not import restrictions", async () => {
  const result = await check(
    "local text = 'require(workspace.Dynamic)'\nlocal Http = game:GetService('HttpService')\nlocal part = Instance.new('Part')\nlocal function require(value) return value end\nreturn require({part, Http, text})",
    false,
  );
  assert.equal(result.status, "eligible", JSON.stringify(result));
  assert.deepEqual(result.imports, []);
});

test("AST catches global require aliases and dynamic imports omitted by LSP require-graph", async () => {
  for (const source of [
    "local load = require\nreturn load(script.Parent.Utility)",
    "return pcall(require, script.Parent.Utility)",
    "return require(workspace.Dynamic)",
    "local id = 12345\nreturn require(id)",
    "local name = 'Utility'\nreturn require(script.Parent[name])",
    "return (require)(script.Parent.Utility)",
  ]) {
    const result = await check(source);
    assert.equal(result.status, "rejected", source + JSON.stringify(result));
    assert.ok(
      result.issues.some((issue) =>
        ["game_import_require_alias", "game_import_dynamic_target"].includes(issue.ruleId),
      ),
    );
  }
});

test("reassigned instance aliases and roots cannot certify static import targets", async () => {
  for (const source of [
    "local Parent = script.Parent\nParent = workspace\nreturn require(Parent.Utility)",
    "local Parent = script.Parent\nlocal function replace() Parent = workspace end\nreturn require(Parent.Utility)",
    "game = workspace\nreturn require(game.ReplicatedStorage.Utility)",
  ])
    assert.equal((await check(source)).status, "rejected", source);
});

test("approved imports are an upper bound; unused declarations warn without requiring module execution", async () => {
  const { plan, documents } = fixture("return { ready = true }", true);
  const unused = checkGameSourceImports({ plan, analysis: await parse(documents) });
  assert.equal(unused.status, "eligible", JSON.stringify(unused));
  assert.deepEqual(unused.imports, [], "The actual import graph does not invent approved edges");
  assert.equal(unused.issues.length, 1);
  assert.equal(unused.issues[0]?.ruleId, "game_import_unused_declaration");
  assert.equal(unused.issues[0]?.severity, "warning");
  assert.ok(
    plan.inventory.find((item) => item.id === "main")?.dependencies.includes("utility"),
    "An unused approval remains a conservative build-order dependency",
  );
  const { graph } = materializeGameBuildGraph({
    plan,
    acceptanceHash: contentHash("approved import upper-bound fixture"),
    values: [],
    sources: documents.map((document) => ({
      slotId: document.documentId,
      source: document.source,
    })),
    checks: { status: unused.status, artifactHashes: [unused.hash] },
  });
  assert.deepEqual(
    graph.artifacts.find((artifact) => artifact.kind === "source" && artifact.fileId === "main")
      ?.dependencyHashes,
    [documents[1]!.sourceHash],
    "Content identity still includes the unused approved dependency",
  );

  const undeclared = await check("return require(script.Parent.Utility)", false);
  assert.equal(undeclared.status, "rejected", JSON.stringify(undeclared));
  assert.ok(
    undeclared.issues.some(
      (issue) => issue.ruleId === "game_import_undeclared_edge" && issue.severity === "error",
    ),
  );
  const nonModule = await check("return require(game:GetService('ReplicatedStorage'))");
  assert.equal(nonModule.status, "rejected", JSON.stringify(nonModule));
  assert.ok(
    nonModule.issues.some(
      (issue) => issue.ruleId === "game_import_undeclared_target" && issue.severity === "error",
    ),
  );
});

test("Roblox API members shadow child names; explicit child lookup remains resolvable", async () => {
  assert.equal(
    (await check("return require(script.Parent.Name)", true, "Name")).status,
    "rejected",
  );
  assert.equal(
    (await check("return require(script.Parent:WaitForChild('Name'))", true, "Name")).status,
    "eligible",
  );
});

test("environment and dynamic code introspection yield incomplete dependency authority", async () => {
  for (const source of [
    "return getfenv()[('requ' .. 'ire')](script.Parent.Utility)",
    "return _G['require'](script.Parent.Utility)",
    "return loadstring('return 1')()",
  ])
    assert.equal((await check(source, false)).status, "incomplete", source);
});

test("missing dependency source and tampered parser evidence cannot produce an eligible graph", async () => {
  const { plan, documents } = fixture("return require(script.Parent.Utility)");
  assert.equal(
    checkGameSourceImports({ plan, analysis: await parse([documents[0]!]) }).status,
    "incomplete",
  );
  const analysis = await parse(documents);
  assert.equal(analysis.status, "complete");
  if (analysis.status !== "complete") return;
  const altered: PinnedLuauAstAnalysis = {
    ...analysis,
    documents: analysis.documents.map((document) => ({
      ...document,
      ast: { root: { type: "AstStatBlock", body: [] }, commentLocations: [] },
    })),
  };
  assert.equal(checkGameSourceImports({ plan, analysis: altered }).status, "incomplete");
  const { reusedParses: _reusedParses, hash: _oldHash, ...withoutReuseEvidence } = analysis;
  assert.equal(
    checkGameSourceImports({
      plan,
      analysis: {
        ...withoutReuseEvidence,
        hash: contentHash(stableJson(withoutReuseEvidence)),
      } as PinnedLuauAstAnalysis,
    }).status,
    "incomplete",
    "Missing reuse provenance cannot be accepted as a current AST receipt",
  );
  const { hash: _hash, ...payload } = analysis;
  const wrongRevision = { ...payload, snapshotHash: contentHash("other revision") };
  assert.equal(
    checkGameSourceImports({
      plan,
      analysis: { ...wrongRevision, hash: contentHash(stableJson(wrongRevision)) },
    }).status,
    "incomplete",
  );
});

test("official AST syntax failure and a shared host deadline return incomplete analysis", async () => {
  const broken = fixture("local = !", false).documents;
  const invalid = await parse(broken);
  assert.equal(invalid.status, "incomplete");
  if (invalid.status === "incomplete") assert.equal(invalid.code, "source_analysis_failed");
  const documents = Array.from({ length: 32 }, (_, i) => ({
    ...broken[1]!,
    documentId: "module-" + i,
    path: "ReplicatedStorage/Module" + i,
  }));
  const timeout = await parse(documents, 1);
  assert.equal(timeout.status, "incomplete");
  if (timeout.status === "incomplete")
    assert.equal(timeout.code, "source_analysis_resource_exhausted");
});

test("AST parsing never executes candidate runtime or type-function bodies", async () => {
  for (const source of [
    "while true do end\nreturn {}",
    "type function Forever() while true do end end\nreturn {}",
  ])
    assert.equal((await check(source, false)).status, "eligible", source);
});

test("official comment ranges enforce effective header strictness without matching strings or ordinary comments", async () => {
  for (const source of [
    "--!nocheck\nreturn {}",
    "--!nonstrict\r\nreturn {}",
    "-- normal comment\n--!nocheck  \nreturn {}",
    "--[=[header]=]\n--!nonstrict\nreturn {}",
  ])
    assert.ok(
      (await check(source, false)).issues.some(
        (issue) => issue.ruleId === "game_source_strictness_directive",
      ),
      source,
    );
  for (const source of [
    "return '--!nocheck'",
    "--[[--!nocheck]]\nreturn {}",
    "-- !nocheck\nreturn {}",
    "--!strict\n--!nocheck\nreturn {}",
    "local text = 'header'\n--!nocheck\nreturn text",
    "--!nocheck extra\nreturn {}",
  ])
    assert.equal((await check(source, false)).status, "eligible", source);
});

test("debug.traceback logging is admitted while reflective debug access is incomplete", async () => {
  assert.equal((await check("return debug.traceback('diagnostic')", false)).status, "eligible");
  assert.equal(
    (await check("local trace = debug['traceback']\nreturn trace('diagnostic')", false)).status,
    "eligible",
  );
  assert.equal((await check("return debug.info(1, 'f')", false)).status, "incomplete");
  assert.equal((await check("local inspect = debug\nreturn inspect", false)).status, "incomplete");
});
