import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { creatorGameCatalog } from "../packages/creator-session/src/game-authoring.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";
import {
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
} from "../packages/game-compiler/src/index.js";
import { gameRecipeDefinitionLock, type GameDesignSpec } from "../packages/game-ir/src/index.js";
import { loadForgeRuntimeBundle } from "../packages/game-runtime/src/index.js";

test("fixed Network Luau suite exercises admission and remote adapter lifecycle without native networking", () => {
  const result = spawnSync("lune", ["run", "test/runtime-network.luau"], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Network runtime tests passed: 10/);
});

test("creator catalog injects exact locked Network bytes for an ordinary server source-package consumer", async () => {
  const catalog = await creatorGameCatalog();
  const bundle = await loadForgeRuntimeBundle();
  const network = bundle.modules.find((module) => module.id === "network")!;
  const runtime = catalog.definitions.find((definition) => definition.id === "forge-runtime")!;
  assert.ok(runtime.sourceExports.some((entry) => entry.id === "network"));
  assert.equal(catalog.lockedSources.get(network.sourceHash), network.source);
  const initialTopology: CreatorTransactionTopologyNode[] = [
    "ReplicatedStorage",
    "ServerScriptService",
  ].map((path) => ({
    identity: { kind: "forge_attribute", stableId: path },
    path,
    name: path,
    className: path,
    engineContainer: { path, className: path },
  }));
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "server-admission",
    intent: "Use the optional request validator for caller-defined server intents.",
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
            id: "admission",
            path: "Admission.luau",
            role: "module",
            context: "server",
            content: { kind: "slot", maximumUtf8Bytes: 4096 },
            placement: {
              kind: "create",
              operationId: "server-admission",
              name: "Admission",
              className: "ModuleScript",
              parent: {
                kind: "engine_container",
                path: "ServerScriptService",
                className: "ServerScriptService",
              },
            },
            imports: [{ componentId: "runtime", fileId: "network" }],
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
    projectId: "network-project",
    project: { name: "Network proof", placeId: 0, universeId: 0 },
    initialTopology,
  };
  const expanded = expandGameDesign(input);
  const plan = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "network-session",
    observedRevisionHash: "a".repeat(64),
  });
  const consumer = plan.inventory.find((item) => item.id === "server-admission")!;
  assert.ok(consumer.dependencies.includes("runtime-network"));
  // These are fixed source bytes materialized through the production path, not executed gameplay.
  const consumerSource = `--!strict
local storage = game:GetService("ReplicatedStorage")
local modules = storage:WaitForChild("Packages"):WaitForChild("ForgeRuntime")
local Network = require(modules:WaitForChild("Network"))
return Network.new({
  maximumActors = 32, maximumDepth = 4, maximumNodes = 32, maximumBytes = 256,
  intents = { inspect = { capacity = 2, refillPerSecond = 1, schema = { kind = "boolean" } } },
})
`;
  const sources = plan.inventory.flatMap((item) => {
    if (!item.source) return [];
    return [
      {
        slotId: item.id,
        source:
          item.source.content.kind === "locked"
            ? catalog.lockedSources.get(item.source.content.sourceHash)!
            : consumerSource,
      },
    ];
  });
  const material = materializeGameBuildGraph({
    plan,
    acceptanceHash: "b".repeat(64),
    sources,
    values: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(material.graph.operations.length, 8);
  assert.equal(material.graph.localChecks.status, "incomplete");
  const artifact = material.graph.artifacts.find(
    (entry) => entry.kind === "source" && entry.fileId === "network",
  )!;
  assert.equal(artifact.hash, contentHash(network.source));
  const operation = material.graph.operations.find(
    (entry) => entry.planChangeId === "runtime-network",
  );
  assert.equal(operation?.kind, "create");
  assert.ok(operation && !("source" in operation));
});
