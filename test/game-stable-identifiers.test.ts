import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import {
  projectCreatorGameComponentInput,
  validateCreatorGameComponent,
} from "../packages/creator-session/src/game-authoring.js";
import { createGameSourceContextReader } from "../packages/creator-session/src/game-source-context.js";
import { checkGameSourceImports } from "../packages/creator-session/src/game-source-checks.js";
import {
  assertGamePlan,
  compileGamePlan,
  expandGameDesign,
  materializeGameBuildGraph,
  gameInventoryOperation,
  GAME_COMPILER_ABI,
} from "../packages/game-compiler/src/index.js";
import { itemId } from "../packages/game-composition/src/common.js";
import { COMPOSITION_ID_SCHEMA } from "../packages/game-composition/src/config-schema.js";
import {
  createGameDefinitionRegistry,
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameDesignSpec,
  type GameSourceFile,
  type GameSourcePackage,
} from "../packages/game-ir/src/index.js";
import { entityId } from "../packages/game-ir/src/primitives.js";
import { studioObjectIdentityKey } from "../packages/studio-evidence/src/index.js";
import { PinnedSourceAnalysisHost } from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

const registry = createGameDefinitionRegistry([]);
const catalog = {
  definitions: [],
  registry,
  expanders: [],
  lockedSources: new Map<string, string>(),
  validateComponent: validateCreatorGameComponent,
};
function source(id: string, operationId: string, name: string, server = false): GameSourceFile {
  const root = server ? "ServerScriptService" : "ReplicatedStorage";
  return {
    id,
    path: name + ".luau",
    role: "module",
    context: server ? "server" : "shared",
    content: { kind: "slot", maximumUtf8Bytes: 4096 },
    imports: [],
    placement: {
      kind: "create",
      operationId,
      name,
      className: "ModuleScript",
      parent: { kind: "engine_container", path: root, className: root },
    },
  };
}
function spec(): GameDesignSpec {
  const common: GameSourcePackage = {
    kind: "source_package",
    id: "Shared_Core",
    files: [
      source("Contracts", "Install_Contracts", "Contracts"),
      source("contracts", "Install_contracts", "contracts"),
    ],
    ports: [
      {
        id: "state_broadcast",
        direction: "output",
        schema: { type: "string", maxLength: 128 },
        fileId: "Contracts",
      },
      {
        id: "State_broadcast",
        direction: "output",
        schema: { type: "string", maxLength: 128 },
        fileId: "contracts",
      },
    ],
    obligations: [],
  };
  const other: GameSourcePackage = {
    kind: "source_package",
    id: "shared_Core",
    files: [source("Contracts", "install_Contracts", "OtherContracts")],
    ports: [],
    obligations: [],
  };
  const main = source("Server", "Install_Server", "Authority", true);
  main.imports = [
    { componentId: "Shared_Core", fileId: "Contracts" },
    { componentId: "Shared_Core", fileId: "contracts" },
    { componentId: "shared_Core", fileId: "Contracts" },
  ];
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "Identifier_Fixture",
    intent: "Compose separately identified modules with exact typed connections.",
    components: [
      common,
      other,
      {
        kind: "source_package",
        id: "Authority_pkg",
        files: [main],
        ports: [
          {
            id: "player_action",
            direction: "input",
            schema: { type: "string", maxLength: 128 },
            fileId: "Server",
          },
        ],
        obligations: [],
      },
    ],
    connections: [
      {
        id: "State_to_Authority",
        from: { componentId: "Shared_Core", portId: "state_broadcast" },
        to: { componentId: "Authority_pkg", portId: "player_action" },
      },
    ],
    artifactDependencies: [],
  };
}
function admit(design: GameDesignSpec) {
  return validateGameDesignSpec(design, {
    registry,
    policy: DEFAULT_GAME_ADMISSION_POLICY,
  });
}
function compile(design = spec()) {
  const input = {
    design,
    registry,
    projectId: "identifier-project",
    project: { name: "Identifier fixture", placeId: 0, universeId: 0 },
    initialTopology: ["ReplicatedStorage", "ServerScriptService"].map((path) => ({
      identity: {
        kind: "forge_attribute" as const,
        stableId: "root-" + path,
      },
      path,
      name: path,
      className: path,
      engineContainer: { path, className: path },
    })),
  };
  return compileGamePlan({
    ...input,
    ...expandGameDesign(input),
    sessionId: "identifier-session",
    observedRevisionHash: contentHash("identifier-revision"),
  });
}

test("mixed-case identifiers survive draft tools, exact graph references and deterministic compilation", () => {
  const design = spec();
  const draft = new CreatorDesignDraft(catalog);
  const refs = design.components.map((component) =>
    draft.define({ component: projectCreatorGameComponentInput(component) }),
  );
  assert.deepEqual(
    draft
      .read({ componentIds: ["Shared_Core", "shared_Core"] })
      .components.map((entry) => entry.id),
    ["Shared_Core", "shared_Core"],
  );
  assert.throws(() => draft.read({ componentIds: ["SHARED_Core"] }), /Unknown draft component/);
  const { components: _components, ...metadata } = design;
  const assembled = draft.assemble({
    ...metadata,
    componentIds: refs.map((ref) => ref.componentId),
  });
  assert.equal(admit(assembled).status, "eligible");
  const plan = compile(assembled);
  const reordered = structuredClone(design);
  reordered.components.reverse();
  for (const component of reordered.components) {
    if (component.kind !== "source_package") continue;
    component.files.reverse();
    component.ports.reverse();
    for (const file of component.files) file.imports.reverse();
  }
  assert.equal(compile(reordered).hash, plan.hash);
  const identities = plan.inventory.map((item) =>
    studioObjectIdentityKey(gameInventoryOperation(plan, item).target.identity),
  );
  assert.equal(new Set(identities).size, 4);
  const context = {
    componentId: "Shared_Core",
    projectId: "identifier-project",
    designHash: plan.designHash,
  };
  assert.notEqual(itemId(context, "Contracts"), itemId(context, "contracts"));
  assert.notEqual(
    itemId(context, "Contracts"),
    itemId({ ...context, componentId: "shared_Core" }, "Contracts"),
  );
  const graph = materializeGameBuildGraph({
    plan,
    acceptanceHash: contentHash("fixture acceptance"),
    sources: plan.inventory.map((item) => ({
      slotId: item.id,
      source: "return {}",
    })),
    values: [],
    checks: {
      status: "eligible",
      artifactHashes: [contentHash("fixture local report")],
    },
  }).graph;
  assert.deepEqual(
    graph.artifacts
      .filter((item) => item.kind === "source")
      .map((item) => [item.componentId, item.fileId])
      .sort(),
    [
      ["Authority_pkg", "Server"],
      ["Shared_Core", "Contracts"],
      ["Shared_Core", "contracts"],
      ["shared_Core", "Contracts"],
    ],
  );
});

test("pinned import checks distinguish case-sensitive source and component identities", async () => {
  const plan = compile();
  const read = createGameSourceContextReader(plan);
  const page = read({
    planHash: plan.hash,
    operationId: "Install_Server",
    offset: 0,
  });
  assert.deepEqual(
    page.imports.map((entry) => [entry.componentId, entry.fileId]),
    [
      ["Shared_Core", "Contracts"],
      ["Shared_Core", "contracts"],
      ["shared_Core", "Contracts"],
    ],
  );
  assert.equal(new Set(page.imports.map((entry) => entry.requireExpression)).size, 3);
  assert.ok(page.imports.every((entry) => entry.requireExpression));
  const host = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
  const check = async (approved: typeof plan, body: string) => {
    const documents = approved.inventory.map((item) => {
      assert.equal(item.change.kind, "create");
      const source = item.id === "Install_Server" ? body : "return {}";
      return {
        documentId: item.id,
        path: item.change.kind === "create" ? item.change.path : "",
        className: "ModuleScript",
        executionContext: item.id === "Install_Server" ? ("server" as const) : ("shared" as const),
        sourceHash: contentHash(source),
        source,
      };
    });
    const analysis = await host.analyzeAst({
      snapshotHash: approved.observedRevisionHash,
      documents: documents.map(({ source, ...document }) => ({
        ...document,
        utf8Bytes: Buffer.byteLength(source),
      })),
      resolver: createTestFixtureSourceResolver(documents),
    });
    return checkGameSourceImports({ plan: approved, analysis });
  };
  const valid = await check(
    plan,
    page.imports
      .map((entry, index) => `local dependency${index} = ${entry.requireExpression}`)
      .join("\n") + "\nreturn {}",
  );
  assert.equal(valid.status, "eligible", stableJson(valid));
  assert.equal(valid.imports.length, 3);
  const narrower = spec();
  const authority = narrower.components.find((entry) => entry.id === "Authority_pkg")!;
  assert.equal(authority.kind, "source_package");
  if (authority.kind !== "source_package") throw new Error("Source fixture required");
  authority.files[0]!.imports = [{ componentId: "Shared_Core", fileId: "Contracts" }];
  const wrongCase = page.imports.find((entry) => entry.fileId === "contracts")!;
  const rejected = await check(compile(narrower), `return ${wrongCase.requireExpression}`);
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.issues.some((issue) => issue.message.includes("does not declare its import")));
});

test("identifier admission preserves separator, length, duplicate and exact-reference boundaries", () => {
  for (const id of [
    "Contracts",
    "Server",
    "Authority",
    "player_action",
    "state_broadcast",
    "a".repeat(64),
  ]) {
    assert.equal(entityId.parse(id), id);
    assert.equal(COMPOSITION_ID_SCHEMA.parse(id), id);
  }
  for (const id of [
    "",
    "_hidden",
    "1start",
    "a".repeat(65),
    "A/B",
    "A\\B",
    ".",
    "..",
    "A.B",
    "A:B",
    "A B",
    "A\nB",
    "A\u0000B",
    "A%2fB",
  ]) {
    assert.equal(entityId.safeParse(id).success, false, id);
    assert.equal(COMPOSITION_ID_SCHEMA.safeParse(id).success, false, id);
    const invalid = spec();
    invalid.components[0]!.id = id;
    assert.equal(admit(invalid).status, "rejected", id);
  }
  const wrongReference = spec();
  wrongReference.connections[0]!.from.portId = "STATE_broadcast";
  const result = admit(wrongReference);
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") throw new Error("Expected rejected reference");
  assert.ok(result.diagnostics.some((issue) => issue.code === "invalid_reference"));
  const duplicate = spec();
  duplicate.components.push(structuredClone(duplicate.components[0]!));
  const duplicated = admit(duplicate);
  assert.equal(duplicated.status, "rejected");
  if (duplicated.status !== "rejected") throw new Error("Expected duplicate rejection");
  assert.ok(duplicated.diagnostics.some((issue) => issue.code === "duplicate_id"));
});

test("expanded identifier syntax never aliases installed recipe locks or prior compiler authority", () => {
  const definition = {
    kind: "GameRecipeDefinition",
    id: "Library_Def",
    abi: "1",
    configSchema: { type: "null" },
    sourceExports: [],
    ports: [],
    obligations: [],
  } as const;
  const lock = gameRecipeDefinitionLock(definition);
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "Locked_Definition",
    intent: "Select an exact installed recipe.",
    components: [
      {
        kind: "recipe_instance",
        id: "Library",
        definition: { ...lock, id: "library_def" },
        config: null,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  assert.equal(
    validateGameDesignSpec(design, {
      registry: createGameDefinitionRegistry([definition]),
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    }).status,
    "rejected",
  );
  const plan = compile();
  assert.equal(plan.compilerAbi, GAME_COMPILER_ABI);
  assert.throws(
    () => assertGamePlan({ ...plan, compilerAbi: "forge-game-compiler@3" }),
    /Invalid GamePlan envelope/,
  );
});
