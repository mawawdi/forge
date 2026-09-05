import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import type { CreatorProjectIndexView } from "../packages/creator-session/src/index.js";
import { studioObjectIdentityKey } from "../packages/studio-evidence/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  type GameRecipeExpanderInput,
} from "../packages/game-compiler/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import {
  createForgeRuntimeRecipe,
  emitScopedBootstrap,
  emitStaticModuleImport,
  forgeRuntimeSourcePackage,
  loadForgeRuntimeBundle,
} from "../packages/game-runtime/src/index.js";

const root = resolve("packages/game-runtime");
const context: GameRecipeExpanderInput = {
  componentId: "runtime",
  config: {},
  projectId: "runtime-test",
  project: { name: "Runtime", placeId: 0, universeId: 0 },
  designHash: "a".repeat(64),
  initialTopology: [
    {
      identity: { kind: "forge_attribute", stableId: "replicated-storage" },
      path: "ReplicatedStorage",
      name: "ReplicatedStorage",
      className: "ReplicatedStorage",
      engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
    },
  ],
};

test("ForgeRuntime load verifies exact source, ABI and MIT provenance without dependencies", async () => {
  const bundle = await loadForgeRuntimeBundle({ root });
  assert.deepEqual(bundle, await loadForgeRuntimeBundle({ root }));
  assert.equal(bundle.abi, "forge-runtime@1");
  assert.deepEqual(bundle.provenance.thirdPartyDependencies, []);
  assert.equal(
    bundle.provenance.licenseHash,
    contentHash(await readFile(join(root, "LICENSE"), "utf8")),
  );
  assert.deepEqual(
    bundle.modules.map((module) => module.id),
    ["event", "scope", "state-machine", "task"],
  );
  for (const module of bundle.modules) {
    assert.equal(module.sourceHash, contentHash(module.source));
    assert.equal(module.utf8Bytes, Buffer.byteLength(module.source));
    assert.ok(module.source.startsWith("--!strict\n"));
    assert.equal(module.imports.length, 0);
  }
});

test("ForgeRuntime loader rejects altered source, license, lock, non-UTF8 and symlinks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-runtime-integrity-"));
  try {
    const cases = [
      async (copy: string) => writeFile(join(copy, "luau/Scope.luau"), "return {}\n"),
      async (copy: string) => writeFile(join(copy, "LICENSE"), "modified"),
      async (copy: string) => writeFile(join(copy, "luau/Scope.luau"), Buffer.from([255, 254])),
      async (copy: string) => {
        const lock = JSON.parse(await readFile(join(copy, "runtime.lock.json"), "utf8"));
        lock.bundleHash = "0".repeat(64);
        await writeFile(join(copy, "runtime.lock.json"), JSON.stringify(lock));
      },
      async (copy: string) => {
        await rm(join(copy, "luau/Scope.luau"));
        await symlink(join(root, "luau/Scope.luau"), join(copy, "luau/Scope.luau"));
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const copy = join(temp, String(i));
      await cp(root, copy, { recursive: true });
      await cases[i]!(copy);
      await assert.rejects(
        loadForgeRuntimeBundle({ root: copy }),
        /integrity|identity|UTF-8|symlink/,
      );
    }
    const link = join(temp, "linked-root");
    await symlink(root, link);
    await assert.rejects(loadForgeRuntimeBundle({ root: link }), /symlink/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("runtime source package remains ordinary optional module material with exact placements", async () => {
  const bundle = await loadForgeRuntimeBundle({ root });
  const material = forgeRuntimeSourcePackage(bundle, {
    parent: { kind: "generated", operationId: "runtime-folder" },
    rootPath: "ReplicatedStorage/Packages/ForgeRuntime",
  });
  assert.equal(material.component.files.length, 4);
  assert.throws(
    () =>
      forgeRuntimeSourcePackage(bundle, {
        parent: {
          kind: "engine_container",
          path: "ReplicatedStorage",
          className: "ReplicatedStorage",
        },
        rootPath: "ReplicatedStorage/Elsewhere",
      }),
    /installation parent/,
  );
  assert.ok(
    material.component.files.every(
      (file) =>
        file.role === "module" &&
        file.content.kind === "locked" &&
        file.placement?.kind === "create",
    ),
  );
  const utility: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "utility",
    intent: "Install independent utility modules.",
    components: [material.component],
    connections: [],
    artifactDependencies: [],
  };
  assert.equal(
    validateGameDesignSpec(utility, {
      registry: createGameDefinitionRegistry([]),
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    }).status,
    "eligible",
  );
  bundle.modules[0]!.source += "\n";
  assert.throws(
    () =>
      forgeRuntimeSourcePackage(bundle, {
        parent: { kind: "generated", operationId: "folder" },
        rootPath: "ReplicatedStorage/Packages/ForgeRuntime",
      }),
    /material/,
  );
});

test("runtime recipe compiles folders and four locked modules into exact creator inventory", async () => {
  const bundle = await loadForgeRuntimeBundle({ root });
  const recipe = createForgeRuntimeRecipe(bundle);
  const registry = createGameDefinitionRegistry([recipe.definition]);
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "runtime-install",
    intent: "Install optional lifecycle modules.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(recipe.definition),
        config: {},
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const expanded = expandGameDesign({
    ...context,
    design,
    registry,
    recipeExpanders: [recipe.expander],
  });
  const plan = compileGamePlan({
    ...context,
    design,
    registry,
    inventory: expanded.inventory,
    sessionId: "runtime-session",
    observedRevisionHash: "b".repeat(64),
  });
  assert.equal(plan.inventory.length, 6);
  assert.equal(plan.inventory.filter((item) => item.source).length, 4);
  assert.equal(
    plan.inventory.find((item) => item.id === "runtime-folder")?.dependencies[0],
    "runtime-packages",
  );
  for (const item of plan.inventory.filter((item) => item.source)) {
    const source = recipe.sources(item.id, item.source!.content)!;
    assert.equal(source.slotId, item.id);
    assert.equal(
      contentHash(source.source),
      item.source!.content.kind === "locked" ? item.source!.content.sourceHash : "",
    );
    assert.deepEqual(item.dependencies, ["runtime-folder"]);
  }
  assert.equal(recipe.sources("unknown", { kind: "slot", maximumUtf8Bytes: 4 }), undefined);
  bundle.modules[0]!.source = "return nil";
  assert.equal(
    recipe.expander.expand(context).length,
    6,
    "registered closure snapshots verified material",
  );
});

test("runtime recipe reuses observed folder identities and rejects ambiguous or unsafe collisions", async () => {
  const recipe = createForgeRuntimeRecipe(await loadForgeRuntimeBundle({ root }));
  const packages = {
    identity: { kind: "forge_attribute" as const, stableId: "user-packages" },
    path: "ReplicatedStorage/Packages",
    name: "Packages",
    className: "Folder",
    parentIdentity: context.initialTopology[0]!.identity,
  };
  const installed = {
    identity: { kind: "forge_attribute" as const, stableId: "user-runtime" },
    path: packages.path + "/ForgeRuntime",
    name: "ForgeRuntime",
    className: "Folder",
    parentIdentity: packages.identity,
  };
  const observed = {
    ...context,
    initialTopology: [...context.initialTopology, packages, installed],
  };
  const items = recipe.expander.expand(observed);
  assert.equal(items.length, 4);
  for (const item of items) {
    assert.ok(item.change.kind === "create");
    assert.deepEqual(item.change.parent, {
      kind: "instance",
      identity: installed.identity,
      path: installed.path,
      className: "Folder",
    });
  }
  assert.throws(
    () =>
      recipe.expander.expand({
        ...observed,
        initialTopology: [...observed.initialTopology, packages],
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      recipe.expander.expand({
        ...context,
        initialTopology: [...context.initialTopology, { ...packages, className: "Model" }],
      }),
    /incompatible/,
  );
  assert.throws(
    () =>
      recipe.expander.expand({
        ...observed,
        initialTopology: [
          ...observed.initialTopology,
          {
            identity: { kind: "forge_attribute", stableId: "foreign-module" },
            path: installed.path + "/Scope",
            name: "Scope",
            className: "ModuleScript",
          },
        ],
      }),
    /source evidence/,
  );
  assert.throws(() => recipe.expander.expand({ ...context, config: { genre: "fixed" } }), /empty/);
});

test("runtime recipe declares imported existing locked modules without rewriting their source", async () => {
  const bundle = await loadForgeRuntimeBundle({ root });
  const recipe = createForgeRuntimeRecipe(bundle);
  const scope = bundle.modules.find((module) => module.id === "scope")!;
  const packages = {
    identity: { kind: "forge_attribute" as const, stableId: "packages" },
    path: "ReplicatedStorage/Packages",
    name: "Packages",
    className: "Folder",
    parentIdentity: context.initialTopology[0]!.identity,
  };
  const folder = {
    identity: { kind: "forge_attribute" as const, stableId: "runtime" },
    path: packages.path + "/ForgeRuntime",
    name: "ForgeRuntime",
    className: "Folder",
    parentIdentity: packages.identity,
  };
  const existing = {
    identity: { kind: "forge_attribute" as const, stableId: "scope" },
    path: scope.path,
    name: "Scope",
    className: "ModuleScript",
    parentIdentity: folder.identity,
  };
  const nodes = [...context.initialTopology, packages, folder, existing];
  const observation: CreatorProjectIndexView = {
    project: context.project,
    revision: { hash: "b".repeat(64) } as CreatorProjectIndexView["revision"],
    instances: nodes.map((node) => ({
      ...node,
      objectId: studioObjectIdentityKey(node.identity),
      properties: {},
      attributes: {},
      tags: [],
    })),
    scripts: [
      {
        documentId: studioObjectIdentityKey(existing.identity),
        path: scope.path,
        className: "ModuleScript",
        executionContext: "shared",
        sourceHash: scope.sourceHash,
        utf8Bytes: scope.utf8Bytes,
      },
    ],
  };
  const registry = createGameDefinitionRegistry([recipe.definition]);
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    id: "runtime-import",
    intent: "Import an already installed lifecycle module.",
    components: [
      {
        kind: "recipe_instance",
        id: context.componentId,
        definition: gameRecipeDefinitionLock(recipe.definition),
        config: {},
      },
      {
        kind: "source_package",
        id: "consumer",
        ports: [],
        obligations: [],
        files: [
          {
            id: "main",
            path: "Main.luau",
            context: "shared",
            role: "module",
            content: { kind: "slot", maximumUtf8Bytes: 1024 },
            placement: {
              operationId: "consumer-main",
              kind: "create",
              name: "Consumer",
              className: "ModuleScript",
              parent: {
                kind: "engine_container",
                path: "ReplicatedStorage",
                className: "ReplicatedStorage",
              },
            },
            imports: [{ componentId: context.componentId, fileId: "scope" }],
          },
        ],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const input = {
    ...context,
    initialTopology: nodes,
    observation,
    design,
    registry,
    recipeExpanders: [recipe.expander],
  };
  const expanded = expandGameDesign(input);
  assert.equal(expanded.inventory.length, 4);
  assert.equal(
    expanded.inventory.some((item) => item.source?.fileId === "scope"),
    false,
  );
  assert.equal(expanded.observedSources.length, 1);
  const plan = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "runtime-import-session",
    observedRevisionHash: observation.revision.hash,
  });
  assert.equal(plan.observedSources[0]!.sourceHash, scope.sourceHash);
  const changed = {
    ...observation,
    scripts: observation.scripts.map((script) => ({ ...script, sourceHash: "f".repeat(64) })),
  };
  assert.throws(() => expandGameDesign({ ...input, observation: changed }), /source evidence/);
});

test("static imports and optional bootstrap reject injected identifiers and parse as Luau", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-runtime-bootstrap-"));
  try {
    const source = emitScopedBootstrap({
      scopeStudioPath: "ReplicatedStorage/Packages/ForgeRuntime/Scope",
      modules: [
        {
          localName: "Controller",
          studioPath: "ReplicatedStorage/User Modules/Controller",
          startExport: "start",
        },
      ],
    });
    assert.match(source, /scope:Close\(\)/);
    assert.match(source, /Controller.start\(scope\)/);
    const path = join(temp, "Bootstrap.server.luau");
    await writeFile(path, source);
    const result = spawnSync("luau-compile", ["--only-parse", path], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    for (const localName of ["end", "x; error('injected')", "a.b"])
      assert.throws(
        () => emitStaticModuleImport({ localName, studioPath: "ReplicatedStorage/Module" }),
        /identifier/,
      );
    for (const studioPath of [
      "ReplicatedStorage/../Module",
      "ReplicatedStorage/\nModule",
      "ReplicatedStorage//Module",
    ])
      assert.throws(() => emitStaticModuleImport({ localName: "Module", studioPath }), /path/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("fixed repository Luau runtime suite executes real source with bounded host subprocesses", () => {
  // This is a repository-owned regression runner. No candidate source or paths are accepted.
  const result = spawnSync("luau", ["test/runtime-modules.luau"], {
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ForgeRuntime real Luau tests passed: 12/);
  const modules = ["Scope", "Event", "Task", "StateMachine"].map((name) =>
    join(root, "luau", name + ".luau"),
  );
  for (const [command, args] of [
    ["luau-compile", ["--only-parse", ...modules]],
    [
      "luau-lsp",
      [
        "analyze",
        "--no-strict-dm-types",
        "--definitions",
        "packages/luau-toolchain/roblox/globalTypes.d.luau",
        ...modules,
      ],
    ],
  ] as const) {
    const check = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(check.error, undefined);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
});
