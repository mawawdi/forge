import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  gameBuildPartitionOperations,
  materializeGameBuildGraph,
  type GameSourceMaterial,
} from "../packages/game-compiler/src/index.js";
import type { CreatorTransactionTopologyNode } from "../packages/creator-session/src/transaction-topology.js";
import { emitStaticModuleImport } from "../packages/game-runtime/src/index.js";
import { createLastLightFixture } from "./fixtures/last-light.spec.js";

test("Last Light compiles through the production catalog from a solution-free seed; recorded stubs grant no gameplay or source-analysis proof", async () => {
  const seedText = await readFile("examples/last-light/default.project.json", "utf8");
  const seed = JSON.parse(seedText) as { tree: Record<string, unknown> };
  const initialTopology: CreatorTransactionTopologyNode[] = [];
  const visit = (tree: Record<string, unknown>, parentPath = "") => {
    for (const [name, child] of Object.entries(tree)) {
      if (name.startsWith("$")) continue;
      assert.ok(typeof child === "object" && child !== null);
      const row = child as Record<string, unknown>;
      const path = parentPath ? parentPath + "/" + name : name;
      const className = row.$className as string;
      assert.ok(
        [
          "Workspace",
          "ReplicatedStorage",
          "ServerScriptService",
          "StarterGui",
          "StarterPlayer",
          "StarterPlayerScripts",
        ].includes(className),
        "seed contains only engine service containers",
      );
      assert.equal("$properties" in row, false);
      assert.equal("$path" in row, false);
      const identity = { kind: "forge_attribute" as const, stableId: "fixture-seed-" + path };
      const parent = initialTopology.find((node) => node.path === parentPath);
      initialTopology.push({
        identity,
        ...(parent ? { parentIdentity: parent.identity } : {}),
        path,
        name,
        className,
        engineContainer: { path, className },
        properties: {},
      });
      visit(row, path);
    }
  };
  visit(seed.tree);
  assert.equal(
    (await readdir("examples/last-light")).some((name) => /\.lua[u]?$/.test(name)),
    false,
  );
  const { spec, catalog } = await createLastLightFixture();
  const input = {
    design: spec,
    registry: catalog.registry,
    recipeExpanders: catalog.expanders,
    projectId: "last-light-compiler-fixture",
    project: { name: "Last Light structural fixture", placeId: 0, universeId: 0 },
    initialTopology,
  };
  const expanded = expandGameDesign(input);
  const plan = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "last-light-structural",
    observedRevisionHash: contentHash(seedText),
  });
  assert.ok(plan.inventory.length > 20);
  assert.equal(plan.inventory.filter((item) => item.source?.content.kind === "slot").length, 5);
  assert.equal(
    spec.components.some(
      (component) =>
        component.kind === "recipe_instance" && component.definition.id.includes("last-light"),
    ),
    false,
  );
  const paths = new Map(
    plan.inventory.flatMap((item) =>
      item.source
        ? [
            [
              item.componentId + "/" + item.source.fileId,
              item.change.kind === "create" ? item.change.path : item.change.target.path,
            ] as const,
          ]
        : [],
    ),
  );
  const sources: GameSourceMaterial[] = plan.inventory.flatMap((item) => {
    if (!item.source) return [];
    if (item.source.content.kind === "locked") {
      const source = catalog.lockedSources.get(item.source.content.sourceHash);
      assert.ok(
        source !== undefined,
        "trusted recipe source comes from the same production catalog",
      );
      return [{ slotId: item.id, source }];
    }
    const component = spec.components.find((entry) => entry.id === item.componentId);
    assert.ok(component?.kind === "source_package");
    const file = component.files.find((entry) => entry.id === item.source!.fileId)!;
    const imports = file.imports.map((entry, index) => {
      const studioPath = paths.get(entry.componentId + "/" + entry.fileId);
      assert.ok(studioPath, "declared source dependency materializes with a concrete editor path");
      return emitStaticModuleImport({ localName: "Dependency" + index, studioPath });
    });
    return [
      {
        slotId: item.id,
        source:
          "-- Recorded structural fixture only; no gameplay implementation.\n" +
          imports.join("\n") +
          (file.role === "module" ? "\nreturn {}\n" : "\nreturn\n"),
      },
    ];
  });
  const result = materializeGameBuildGraph({
    plan,
    acceptanceHash: contentHash("fixture acceptance, no creator authority"),
    sources,
    values: [],
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(result.graph.localChecks.status, "incomplete");
  assert.equal(result.graph.operations.length, plan.inventory.length);
  assert.equal(result.graph.partitions.length, 2);
  assert.equal(
    gameBuildPartitionOperations(result.graph, 0).some((operation) =>
      ["Script", "LocalScript"].includes(operation.target.className),
    ),
    false,
  );
  assert.deepEqual(
    gameBuildPartitionOperations(result.graph, 1)
      .map((operation) => operation.target.className)
      .sort(),
    ["LocalScript", "Script"],
  );
  assert.equal(stableJson(result.graph.operations).includes("Recorded structural fixture"), false);
  assert.ok(
    result.graph.artifacts.some(
      (artifact) => artifact.componentId === "game-code" && artifact.dependencyHashes.length >= 4,
    ),
  );
});
