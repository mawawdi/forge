import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { creatorGameCatalog } from "../packages/creator-session/src/game-authoring.js";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
} from "../packages/game-compiler/src/index.js";
import { gameRecipeDefinitionLock, type GameDesignSpec } from "../packages/game-ir/src/index.js";
import {
  emitStaticModuleImport,
  loadForgeRuntimeBundle,
} from "../packages/game-runtime/src/index.js";

test("real locked Task source handles immediate scheduler settlement and late thread acquisition", () => {
  const result = spawnSync("luau", ["test/runtime-task-immediate.luau"], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ForgeRuntime immediate Task tests passed: 7/);
});

test("ordinary server entrypoint consumes the corrected locked Task after runtime installation", async () => {
  const catalog = await creatorGameCatalog();
  const bundle = await loadForgeRuntimeBundle();
  const runtime = catalog.definitions.find((definition) => definition.id === "forge-runtime")!;
  const task = bundle.modules.find((module) => module.id === "task")!;
  assert.equal(catalog.lockedSources.get(task.sourceHash), task.source);
  const source = [
    "--!strict",
    emitStaticModuleImport({
      localName: "Scope",
      studioPath: "ReplicatedStorage/Packages/ForgeRuntime/Scope",
    }),
    emitStaticModuleImport({
      localName: "Task",
      studioPath: "ReplicatedStorage/Packages/ForgeRuntime/Task",
    }),
    "local scope = Scope.new()",
    "Task.start(scope, function(token)",
    "  if token:IsCurrent() then scope:Close() end",
    "end)",
    "",
  ].join("\n");
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "task-entrypoint",
    intent: "Start optional scoped asynchronous work from an ordinary server entrypoint.",
    components: [
      {
        kind: "recipe_instance",
        id: "runtime",
        definition: gameRecipeDefinitionLock(runtime),
        config: {},
      },
      {
        kind: "source_package",
        id: "server",
        ports: [],
        obligations: [],
        files: [
          {
            id: "main",
            path: "Main.server.luau",
            role: "entrypoint",
            context: "server",
            imports: [
              { componentId: "runtime", fileId: "scope" },
              { componentId: "runtime", fileId: "task" },
            ],
            content: {
              kind: "locked",
              sourceHash: contentHash(source),
              utf8Bytes: Buffer.byteLength(source),
            },
            placement: {
              kind: "create",
              operationId: "server-main",
              name: "Main",
              className: "Script",
              parent: {
                kind: "engine_container",
                path: "ServerScriptService",
                className: "ServerScriptService",
              },
            },
          },
        ],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const input = {
    design,
    registry: catalog.registry,
    recipeExpanders: catalog.expanders,
    projectId: "task-entrypoint",
    project: { name: "Task entrypoint fixture", placeId: 0, universeId: 0 },
    initialTopology: ["ReplicatedStorage", "ServerScriptService"].map((path) => ({
      identity: { kind: "forge_attribute" as const, stableId: path },
      path,
      name: path,
      className: path,
      engineContainer: { path, className: path },
    })),
  };
  const plan = compileGamePlan({
    ...input,
    ...expandGameDesign(input),
    sessionId: "task-session",
    observedRevisionHash: "a".repeat(64),
  });
  const entrypoint = plan.inventory.find((item) => item.id === "server-main")!;
  assert.ok(entrypoint.dependencies.includes("runtime-scope"));
  assert.ok(entrypoint.dependencies.includes("runtime-task"));
  const material = materializeGameBuildGraph({
    plan,
    acceptanceHash: "b".repeat(64),
    sources: plan.inventory.flatMap((item) => {
      if (!item.source || item.source.content.kind !== "locked") return [];
      return [
        {
          slotId: item.id,
          source:
            item.id === "server-main"
              ? source
              : catalog.lockedSources.get(item.source.content.sourceHash)!,
        },
      ];
    }),
    values: [],
    // Structural assembly is not a claim of executed gameplay or native activation.
    checks: { status: "incomplete", artifactHashes: [] },
  });
  const graph = material.graph;
  assert.equal(graph.localChecks.status, "incomplete");
  assert.equal(graph.partitions.length, 2);
  const installed = graph.partitions[0]!.operationIds;
  const activated = graph.partitions[1]!.operationIds;
  assert.equal(installed.length, 7);
  assert.deepEqual(
    graph.operations
      .filter((operation) => activated.includes(operation.id))
      .map((operation) => operation.planChangeId),
    ["server-main"],
  );
  assert.equal(
    graph.artifacts.find((artifact) => artifact.kind === "source" && artifact.fileId === "task")
      ?.hash,
    task.sourceHash,
  );
  assert.ok(graph.operations.every((operation) => !("source" in operation)));
});
