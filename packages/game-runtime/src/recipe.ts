import { stableJson } from "../../contracts/src/index.js";
import type { StudioMutationParent } from "../../creator-session/src/index.js";
import { gameGeneratedTarget } from "../../game-compiler/src/plan.js";
import type {
  GameInventoryItem,
  GameObservedSourceArtifact,
  GameRecipeExpander,
  GameRecipeExpanderInput,
} from "../../game-compiler/src/types.js";
import type { GameSourceMaterial } from "../../game-compiler/src/build.js";
import {
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
  type GameSourceContent,
} from "../../game-ir/src/index.js";
import { assertForgeRuntimeBundle, type ForgeRuntimeBundle } from "./index.js";

/** Trusted optional installation recipe. Its ABI binds the exact local source bundle. */
export function createForgeRuntimeRecipe(bundle: ForgeRuntimeBundle): {
  definition: GameRecipeDefinition;
  expander: GameRecipeExpander;
  lockedSources: ReadonlyMap<string, string>;
  sources(operationId: string, content: GameSourceContent): GameSourceMaterial | undefined;
} {
  assertForgeRuntimeBundle(bundle);
  // Do not let caller mutations alter a previously registered compiler closure.
  const pinned = structuredClone(bundle);
  const definition: GameRecipeDefinition = {
    kind: "GameRecipeDefinition",
    id: "forge-runtime",
    abi: `${pinned.abi}:${pinned.hash}`,
    configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    ports: [],
    sourceExports: pinned.modules.map((module) => ({ id: module.id, context: "shared" })),
    obligations: [
      {
        id: "runtime-lifecycle",
        description:
          "Scope, Event, Task, StateMachine and Network admission/lifecycle behavior is covered by fixed repository Luau tests; integration still requires native checks.",
        evidence: "isolated_test",
      },
    ],
  };
  const lockedSources = new Map(pinned.modules.map((module) => [module.sourceHash, module.source]));
  return {
    definition,
    expander: {
      definition: gameRecipeDefinitionLock(definition),
      expand: (input) => expandRuntime(pinned, input),
      observedSources(input) {
        // Validate the same fixed anchor selection even when this hook is called directly.
        expandRuntime(pinned, input);
        return pinned.modules.flatMap((module) => {
          const artifact = existingModuleArtifact(module, input);
          return artifact ? [artifact] : [];
        });
      },
    },
    lockedSources,
    sources(operationId, content) {
      if (content.kind !== "locked") return undefined;
      const source = lockedSources.get(content.sourceHash);
      if (source === undefined || Buffer.byteLength(source) !== content.utf8Bytes) return undefined;
      return { slotId: operationId, source };
    },
  };
}

function expandRuntime(
  bundle: ForgeRuntimeBundle,
  input: GameRecipeExpanderInput,
): GameInventoryItem[] {
  if (stableJson(input.config) !== "{}")
    throw new Error("ForgeRuntime recipe configuration must be empty");
  const inventory: GameInventoryItem[] = [];
  const observed = (path: string, className: string) => {
    const matches = input.initialTopology.filter((node) => node.path === path);
    if (matches.length > 1 || (matches.length === 1 && matches[0]!.className !== className))
      throw new Error(`ForgeRuntime installation has an ambiguous or incompatible anchor: ${path}`);
    return matches[0];
  };
  const root = observed("ReplicatedStorage", "ReplicatedStorage");
  if (
    !root ||
    root.engineContainer?.path !== "ReplicatedStorage" ||
    root.engineContainer.className !== "ReplicatedStorage"
  )
    throw new Error(
      "ForgeRuntime installation requires the observed ReplicatedStorage engine anchor",
    );
  let parent: StudioMutationParent = { kind: "engine_container", ...root.engineContainer };
  let dependencies: string[] = [];
  for (const name of ["Packages", "ForgeRuntime"]) {
    const path: string = parent.path + "/" + name;
    const node = observed(path, "Folder");
    if (node) {
      parent = { kind: "instance", identity: node.identity, path, className: "Folder" };
      dependencies = [];
      continue;
    }
    const id = `${input.componentId}-${name === "Packages" ? "packages" : "folder"}`;
    inventory.push({
      id,
      componentId: input.componentId,
      outputId: name === "Packages" ? "packages" : "root",
      change: {
        id,
        kind: "create",
        path,
        parent,
        className: "Folder",
        initialization: "initial_properties",
      },
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies,
    });
    parent = gameGeneratedTarget({
      projectId: input.projectId,
      operationId: id,
      path,
      className: "Folder",
    });
    dependencies = [id];
  }
  for (const module of bundle.modules) {
    const path = parent.path + "/" + module.name;
    if (existingModuleArtifact(module, input)) continue;
    const id = `${input.componentId}-${module.id}`;
    inventory.push({
      id,
      componentId: input.componentId,
      outputId: "module/" + module.id,
      change: {
        id,
        kind: "create",
        path,
        parent,
        className: "ModuleScript",
        initialization: "inline_source_required",
      },
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies: [...dependencies],
      source: {
        fileId: module.id,
        content: { kind: "locked", sourceHash: module.sourceHash, utf8Bytes: module.utf8Bytes },
      },
    });
  }
  return inventory;
}

function existingModuleArtifact(
  module: ForgeRuntimeBundle["modules"][number],
  input: GameRecipeExpanderInput,
): GameObservedSourceArtifact | undefined {
  const matches = input.initialTopology.filter((node) => node.path === module.path);
  if (!matches.length) return undefined;
  if (matches.length !== 1 || matches[0]!.className !== "ModuleScript")
    throw new Error(
      `ForgeRuntime installation has an ambiguous or incompatible anchor: ${module.path}`,
    );
  const node = matches[0]!;
  const instances =
    input.observation?.instances.filter(
      (entry) =>
        entry.path === module.path && stableJson(entry.identity) === stableJson(node.identity),
    ) ?? [];
  const scripts =
    input.observation?.scripts.filter(
      (script) => script.path === module.path && script.documentId === instances[0]?.objectId,
    ) ?? [];
  if (
    instances.length !== 1 ||
    scripts.length !== 1 ||
    scripts[0]!.sourceHash !== module.sourceHash ||
    scripts[0]!.utf8Bytes !== module.utf8Bytes
  )
    throw new Error(
      `ForgeRuntime existing module lacks matching observed source evidence: ${module.path}`,
    );
  return {
    componentId: input.componentId,
    fileId: module.id,
    target: {
      kind: "instance",
      identity: node.identity,
      path: node.path,
      className: "ModuleScript",
    },
    sourceHash: module.sourceHash,
    utf8Bytes: module.utf8Bytes,
    imports: [],
  };
}
