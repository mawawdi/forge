import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import {
  compileGamePlan,
  materializeGameBuildGraph,
  type GameInventoryItem,
} from "../packages/game-compiler/src/index.js";

test("the admitted 8192-operation profile compiles reproducibly within physical partition limits", () => {
  const definition = {
    kind: "GameRecipeDefinition",
    id: "scale-fixture",
    abi: "1",
    configSchema: { type: "null" },
    sourceExports: [],
    ports: [],
    obligations: [],
  } as const;
  const inventory: GameInventoryItem[] = Array.from({ length: 8192 }, (_, index) => {
    const id = "object-" + index.toString().padStart(4, "0");
    return {
      id,
      componentId: "objects",
      change: {
        id,
        kind: "create",
        className: "Folder",
        initialization: "initial_properties",
        path: "Workspace/" + id,
        parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
      },
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies: [],
    };
  });
  const input = {
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "scale",
      intent: "Exercise the admitted operation budget without a provider or Studio.",
      components: [
        {
          kind: "recipe_instance",
          id: "objects",
          definition: gameRecipeDefinitionLock(definition),
          config: null,
        },
      ],
      connections: [],
      artifactDependencies: [],
    } satisfies GameDesignSpec,
    registry: createGameDefinitionRegistry([definition]),
    projectId: "scale-project",
    project: { name: "Scale", placeId: 0, universeId: 0 },
    sessionId: "scale-session",
    observedRevisionHash: contentHash("empty scale capture"),
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "scale-workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ] as const,
  };
  const materialize = (rows: GameInventoryItem[]) => {
    const plan = compileGamePlan({ ...input, inventory: rows });
    return materializeGameBuildGraph({
      plan,
      acceptanceHash: contentHash("scale acceptance"),
      values: [],
      sources: [],
      checks: { status: "eligible", artifactHashes: [contentHash("structural scale fixture")] },
    }).graph;
  };
  const first = materialize(inventory);
  assert.equal(first.operations.length, 8192);
  assert.equal(first.partitions.length, 64);
  assert.equal(new Set(first.partitions.flatMap((partition) => partition.operationIds)).size, 8192);
  for (const partition of first.partitions) {
    assert.equal(partition.operationIds.length, 128);
    assert.ok(partition.preflight.factCount <= 16384);
    assert.ok(partition.readback.factCount <= 16384);
    assert.ok(partition.preflight.canonicalBytes <= 2 * 1024 * 1024);
    assert.ok(partition.readback.canonicalBytes <= 2 * 1024 * 1024);
  }
  assert.equal(stableJson(materialize([...inventory].reverse())), stableJson(first));
});
