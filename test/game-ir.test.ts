import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  validateGameDesignSpec,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import { createLastLightFixture } from "./fixtures/last-light.spec.js";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
type Design = Mutable<GameDesignSpec>;
type Source = Extract<Design["components"][number], { kind: "source_package" }>;
type File = Source["files"][number];
type Options = Parameters<typeof validateGameDesignSpec>[1];

const EMPTY_REGISTRY = createGameDefinitionRegistry([]);
const OPTIONS = { registry: EMPTY_REGISTRY, policy: DEFAULT_GAME_ADMISSION_POLICY };
const SIGNAL_SCHEMA = {
  type: "object",
  properties: { value: { type: "number", minimum: 0, maximum: 1000000 } },
  required: ["value"],
  additionalProperties: false,
} as const;
const OPTIONAL_DEFINITION = {
  kind: "GameRecipeDefinition",
  sourceExports: [],
  id: "independent-pattern",
  abi: "1",
  configSchema: {
    type: "object",
    properties: {
      labels: { type: "array", items: { type: "string", maxLength: 32 }, maxItems: 8 },
      enabled: { type: "boolean" },
    },
    required: ["labels", "enabled"],
    additionalProperties: false,
  },
  ports: [
    { id: "changed", direction: "output", schema: SIGNAL_SCHEMA },
    { id: "change", direction: "input", schema: SIGNAL_SCHEMA },
  ],
  obligations: [
    {
      id: "observe-pattern",
      description: "Observe the independently authored behavior.",
      evidence: "studio_play",
    },
  ],
} as const;

function file(
  id = "main",
  context: File["context"] = "server",
  role: File["role"] = "module",
): File {
  return {
    id,
    path: id + ".luau",
    context,
    role,
    content: { kind: "locked", sourceHash: "a".repeat(64), utf8Bytes: 64 },
    imports: [],
  };
}

function source(
  id = "utility",
  context: File["context"] = "server",
  role: File["role"] = "module",
): Source {
  return {
    kind: "source_package",
    id,
    files: [file("main", context, role)],
    ports: [],
    obligations: [],
  };
}

function design(...components: Design["components"]): Design {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "open-composition",
    intent:
      "Create a new interaction without prescribing a lifecycle, world, interface, or player count.",
    components: components.length ? components : [source()],
    connections: [],
    artifactDependencies: [],
  };
}

test("world authoring is explicit, bounded, and canonical", () => {
  const missing = design();
  delete (missing as Partial<Design>).worldAuthoring;
  rejected(missing, "invalid_game_design");

  const runtime = design();
  runtime.worldAuthoring = {
    mode: "runtime_generated",
    rationale: "The creator explicitly requested a fresh generated arena for every Play session.",
  };
  assert.equal(eligible(runtime).spec.worldAuthoring.mode, "runtime_generated");

  const persistent = design();
  persistent.worldAuthoring = {
    mode: "persistent",
    roots: ["Workspace/Zeta", "Workspace/Alpha"],
  };
  const admitted = eligible(persistent);
  assert.deepEqual(
    admitted.spec.worldAuthoring.mode === "persistent" ? admitted.spec.worldAuthoring.roots : [],
    ["Workspace/Alpha", "Workspace/Zeta"],
  );

  persistent.worldAuthoring = {
    mode: "persistent",
    roots: ["Workspace/Scene", "Workspace/Scene"],
  };
  rejected(persistent, "duplicate_world_root");
});

function eligible(input: unknown, options: Options = OPTIONS) {
  const result = validateGameDesignSpec(input, options);
  assert.equal(result.status, "eligible", JSON.stringify(result));
  assert.ok(result.status === "eligible");
  assert.equal(result.scope, "composition_declarations");
  return result;
}

function rejected(input: unknown, code?: string, options: Options = OPTIONS) {
  const result = validateGameDesignSpec(input, options);
  assert.equal(result.status, "rejected", "Expected a rejected composition");
  assert.ok(result.status === "rejected");
  assert.ok(result.diagnostics.length > 0);
  if (code)
    assert.ok(
      result.diagnostics.some((item) => item.code === code),
      JSON.stringify(result),
    );
  return result;
}

function recipeDesign(): Design {
  return design({
    kind: "recipe_instance",
    id: "pattern",
    definition: gameRecipeDefinitionLock(OPTIONAL_DEFINITION),
    config: { labels: ["first", "second"], enabled: true },
  });
}

function connectedDesign(): Design {
  const left = source("left", "shared");
  const right = source("right", "shared");
  for (const component of [left, right]) {
    component.ports = [
      {
        id: "incoming",
        direction: "input",
        schema: structuredClone(SIGNAL_SCHEMA) as unknown as Mutable<typeof SIGNAL_SCHEMA>,
        fileId: "main",
      },
      {
        id: "outgoing",
        direction: "output",
        schema: structuredClone(SIGNAL_SCHEMA) as unknown as Mutable<typeof SIGNAL_SCHEMA>,
        fileId: "main",
      },
    ];
  }
  const spec = design(left, right);
  spec.connections = [
    {
      id: "left-to-right",
      from: { componentId: "left", portId: "outgoing" },
      to: { componentId: "right", portId: "incoming" },
    },
    {
      id: "right-to-left",
      from: { componentId: "right", portId: "outgoing" },
      to: { componentId: "left", portId: "incoming" },
    },
  ];
  return spec;
}

test("ordinary source-only admission has no universal round, UI, world, entrypoint, or solo requirement", () => {
  for (const context of ["server", "client", "shared"] as const) {
    const spec = design(source("novel-module", context));
    const result = eligible(spec);
    assert.deepEqual(Object.keys(result.spec).sort(), [
      "artifactDependencies",
      "components",
      "connections",
      "id",
      "intent",
      "kind",
      "worldAuthoring",
    ]);
    assert.deepEqual(result.resolvedDefinitions, []);
    assert.deepEqual(result.obligations, []);
  }
  eligible(design(source("interface-only", "client", "entrypoint")));
  eligible(
    design(
      source("ongoing-world", "server", "entrypoint"),
      source("independent-activity", "server", "entrypoint"),
    ),
  );
});

test("source locks describe uninspected bytes and admission grants no build or Studio authority", () => {
  const spec = design();
  const component = spec.components[0] as Source;
  component.files[0]!.content = { kind: "locked", sourceHash: "0".repeat(64), utf8Bytes: 123 };
  const result = eligible(spec);
  assert.ok(result.limitations.length > 0);
  const claims = result.limitations.join(" ").toLowerCase();
  assert.match(claims, /source/);
  assert.match(claims, /behavior/);
  assert.match(claims, /authorit|approv/);
  assert.equal("plan" in result, false);
  assert.equal("buildGraph" in result, false);
  assert.equal("receipt" in result, false);
});

function semanticDesign(): Design {
  return {
    ...design(source("simulation"), source("presentation", "client")),
    architecture: {
      name: "A living observatory",
      icon: "🔭",
      nodes: [
        {
          id: "observatory",
          name: "Observatory",
          description: "Explore an evolving sky.",
          componentIds: [],
        },
        {
          id: "sky",
          parentId: "observatory",
          name: "Celestial ecology",
          description: "Stars influence neighboring constellations continuously.",
          componentIds: ["simulation"],
        },
        {
          id: "lens",
          parentId: "observatory",
          name: "Personal lens",
          description: "Choose how the changing sky is presented.",
          componentIds: ["presentation", "simulation"],
        },
      ],
      relationships: [
        { id: "observe", from: "sky", to: "lens", label: "Reveals changing constellations" },
        { id: "influence", from: "lens", to: "sky", label: "Directs observation" },
      ],
    },
  };
}

test("semantic game maps bind arbitrary named concepts to implementation without prescribing lifecycle", () => {
  const spec = semanticDesign();
  const result = eligible(spec);
  assert.equal(result.spec.architecture?.name, "A living observatory");
  assert.equal(result.spec.architecture?.icon, "🔭");
  assert.equal(result.spec.architecture?.relationships.length, 2);
  const reordered = structuredClone(spec);
  reordered.architecture!.nodes.reverse();
  reordered.architecture!.relationships.reverse();
  for (const node of reordered.architecture!.nodes) node.componentIds.reverse();
  assert.equal(eligible(reordered).hash, result.hash);
  const renamed = structuredClone(spec);
  renamed.architecture!.nodes[1]!.name = "A different reviewed concept";
  assert.notEqual(eligible(renamed).hash, result.hash);
});

test("semantic maps reject missing implementations, orphan relationships, and cyclic grouping", () => {
  const unknownComponent = semanticDesign();
  unknownComponent.architecture!.nodes[1]!.componentIds = ["invented"];
  rejected(unknownComponent, "invalid_architecture_implementation");
  const unbound = semanticDesign();
  unbound.architecture!.nodes[1]!.componentIds = [];
  rejected(unbound, "unbound_architecture_node");
  const orphan = semanticDesign();
  orphan.architecture!.relationships[0]!.to = "absent";
  rejected(orphan, "invalid_architecture_relationship");
  const parent = semanticDesign();
  parent.architecture!.nodes[1]!.parentId = "absent";
  rejected(parent, "invalid_architecture_parent");
  const cyclic = semanticDesign();
  cyclic.architecture!.nodes[0]!.parentId = "sky";
  rejected(cyclic, "architecture_hierarchy_cycle");
  const duplicates = semanticDesign();
  duplicates.architecture!.nodes.push(structuredClone(duplicates.architecture!.nodes[0]!));
  rejected(duplicates, "duplicate_id");
});

test("a new optional trusted definition extends admission without changing the kernel", () => {
  const spec = recipeDesign();
  rejected(spec, "definition_not_found");
  const registry = createGameDefinitionRegistry([OPTIONAL_DEFINITION]);
  const result = eligible(spec, { ...OPTIONS, registry });
  assert.deepEqual(result.resolvedDefinitions, [gameRecipeDefinitionLock(OPTIONAL_DEFINITION)]);
  assert.deepEqual(
    result.obligations.map((item) => [item.componentId, item.id, item.evidence]),
    [["pattern", "observe-pattern", "studio_play"]],
  );
  assert.equal(eligible(design()).hash, eligible(design(), { ...OPTIONS, registry }).hash);
  rejected({ ...spec, definitions: [OPTIONAL_DEFINITION] }, "invalid_game_design", {
    ...OPTIONS,
    registry,
  });
});

test("Last Light composes production recipes and ordinary source slots without a kernel lifecycle", async () => {
  const { spec, catalog } = await createLastLightFixture();
  rejected(spec, "definition_not_found");
  const result = eligible(spec, { ...OPTIONS, registry: catalog.registry });
  assert.equal(result.spec.id, "last-light");
  assert.ok(
    result.obligations.some(
      (item) => item.id === "round-replay" && item.componentId === "game-code",
    ),
  );
  assert.equal("round" in result.spec, false);
  assert.equal("ui" in result.spec, false);
  assert.equal("scene" in result.spec, false);
  const invalid = structuredClone(spec);
  const component = invalid.components[0];
  assert.ok(component?.kind === "recipe_instance");
  Object.assign(component, { config: { seed: 42017 } });
  rejected(invalid, "invalid_recipe_config", { ...OPTIONS, registry: catalog.registry });
});

test("definition pins bind exact ABI, schema, ports and obligations", () => {
  const registry = createGameDefinitionRegistry([OPTIONAL_DEFINITION]);
  for (const replacement of [
    { id: "missing-definition" },
    { abi: "2" },
    { hash: "f".repeat(64) },
  ]) {
    const spec = recipeDesign();
    const component = spec.components[0];
    assert.ok(component?.kind === "recipe_instance");
    Object.assign(component.definition, replacement);
    rejected(spec, undefined, { ...OPTIONS, registry });
  }
  for (const changed of [
    { ...OPTIONAL_DEFINITION, abi: "2" },
    { ...OPTIONAL_DEFINITION, ports: [] },
    { ...OPTIONAL_DEFINITION, obligations: [] },
    { ...OPTIONAL_DEFINITION, configSchema: { type: "boolean" } },
  ]) {
    assert.notEqual(
      gameRecipeDefinitionLock(changed).hash,
      gameRecipeDefinitionLock(OPTIONAL_DEFINITION).hash,
    );
  }
  assert.throws(() => createGameDefinitionRegistry([OPTIONAL_DEFINITION, OPTIONAL_DEFINITION]));
  assert.throws(() =>
    createGameDefinitionRegistry([
      { ...OPTIONAL_DEFINITION, configSchema: { $ref: "https://example.test/schema" } },
    ]),
  );
});

test("recipe configuration is checked against trusted schema and cannot replace it", () => {
  const registry = createGameDefinitionRegistry([OPTIONAL_DEFINITION]);
  for (const config of [
    { labels: ["valid"] },
    { labels: ["x".repeat(33)], enabled: true },
    { labels: Array.from({ length: 9 }, () => "valid"), enabled: true },
    { labels: ["valid"], enabled: "true" },
    { labels: ["valid"], enabled: true, extraAuthority: true },
  ]) {
    const spec = recipeDesign();
    Object.assign(spec.components[0]!, { config });
    rejected(spec, "invalid_recipe_config", { ...OPTIONS, registry });
  }
  const injected = recipeDesign();
  Object.assign(injected.components[0]!, { configSchema: { type: "boolean" } });
  rejected(injected, "invalid_game_design", { ...OPTIONS, registry });
});

test("typed runtime feedback connections are allowed independently of build dependencies", () => {
  const spec = connectedDesign();
  spec.artifactDependencies = [{ from: "left", to: "right" }];
  eligible(spec);
  spec.artifactDependencies.push({ from: "right", to: "left" });
  rejected(spec, "dependency_cycle");
  rejected(
    { ...connectedDesign(), artifactDependencies: [{ from: "left", to: "left" }] },
    "dependency_cycle",
  );
});

test("connections resolve exact components and ports and enforce output-to-input schema identity", () => {
  for (const endpoint of [
    { componentId: "missing", portId: "incoming" },
    { componentId: "right", portId: "missing" },
  ]) {
    const spec = connectedDesign();
    spec.connections[0]!.to = endpoint;
    rejected(spec, "invalid_reference");
  }
  const direction = connectedDesign();
  direction.connections[0]!.to.portId = "outgoing";
  rejected(direction, "incompatible_connection");
  const mismatch = connectedDesign();
  const target = mismatch.components[1] as Source;
  target.ports[0]!.schema = { type: "string", maxLength: 128 };
  rejected(mismatch, "incompatible_connection");
  const undeclaredFile = connectedDesign();
  (undeclaredFile.components[0] as Source).ports[0]!.fileId = "missing";
  rejected(undeclaredFile, "invalid_reference");
  rejected(
    { ...connectedDesign(), artifactDependencies: [{ from: "left", to: "missing" }] },
    "invalid_reference",
  );
});

test("source imports resolve exact modules and enforce declared execution-context compatibility", () => {
  const library = source("library", "shared");
  const server = source("server", "server", "entrypoint");
  const client = source("client", "client", "entrypoint");
  server.files[0]!.imports = [{ componentId: "library", fileId: "main" }];
  client.files[0]!.imports = [{ componentId: "library", fileId: "main" }];
  eligible(design(server, library, client));
  for (const imported of [
    { componentId: "missing", fileId: "main" },
    { componentId: "library", fileId: "missing" },
    { componentId: "server", fileId: "main" },
  ]) {
    const changed = structuredClone(client);
    changed.files[0]!.imports = [imported];
    rejected(design(server, library, changed));
  }
  const privateModule = source("private-library", "server");
  client.files[0]!.imports = [{ componentId: "private-library", fileId: "main" }];
  rejected(design(privateModule, client), "invalid_source_manifest");
  const shared = source("shared-library", "shared");
  shared.files[0]!.imports = [{ componentId: "private-library", fileId: "main" }];
  rejected(design(privateModule, shared), "invalid_source_manifest");
  rejected(design(source("invalid-bootstrap", "shared", "entrypoint")), "invalid_source_manifest");
});

test("declared source imports form a DAG independently of runtime connection cycles", () => {
  const spec = connectedDesign();
  const left = spec.components[0] as Source;
  const right = spec.components[1] as Source;
  left.files[0]!.imports = [{ componentId: "right", fileId: "main" }];
  eligible(spec);
  right.files[0]!.imports = [{ componentId: "left", fileId: "main" }];
  rejected(spec, "dependency_cycle");
});

test("source declarations reject invalid hashes, unsafe paths, duplicate files and byte claims", () => {
  for (const change of [
    { content: { kind: "locked", sourceHash: "not-a-hash", utf8Bytes: 64 } },
    { content: { kind: "locked", sourceHash: "A".repeat(64), utf8Bytes: 64 } },
    { path: "../escape.luau" },
    { path: "/absolute.luau" },
    { path: "folder/../../escape.luau" },
    { path: "module.lua" },
    { content: { kind: "locked", sourceHash: "a".repeat(64), utf8Bytes: -1 } },
    { content: { kind: "locked", sourceHash: "a".repeat(64), utf8Bytes: 1.5 } },
  ]) {
    const component = source();
    Object.assign(component.files[0]!, change);
    rejected(design(component));
  }
  const duplicate = source();
  duplicate.files.push({ ...duplicate.files[0]!, id: "other-id" });
  rejected(design(duplicate), "invalid_source_manifest");
  const duplicateId = source();
  duplicateId.files.push({ ...duplicateId.files[0]!, path: "different.luau" });
  rejected(design(duplicateId), "duplicate_id");
});

test("identity and edge duplicates reject rather than silently collapsing during canonicalization", () => {
  const duplicateComponents = design(source("same"), source("same"));
  rejected(duplicateComponents, "duplicate_id");
  const duplicateConnection = connectedDesign();
  duplicateConnection.connections.push(structuredClone(duplicateConnection.connections[0]!));
  rejected(duplicateConnection, "duplicate_id");
  const duplicatePort = connectedDesign();
  const component = duplicatePort.components[0] as Source;
  component.ports.push(structuredClone(component.ports[0]!));
  rejected(duplicatePort, "duplicate_id");
  const duplicateEdge = connectedDesign();
  duplicateEdge.artifactDependencies = [
    { from: "left", to: "right" },
    { from: "left", to: "right" },
  ];
  rejected(duplicateEdge);
  const duplicateImport = source("importer");
  duplicateImport.files[0]!.imports = [
    { componentId: "library", fileId: "main" },
    { componentId: "library", fileId: "main" },
  ];
  rejected(design(duplicateImport, source("library")));
});

test("malformed values are rejected as bounded JSON before schema interpretation or hashing", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const malformed = [
    undefined,
    null,
    true,
    7,
    "not a composition",
    [],
    { ...design(), extra: undefined },
    { ...design(), extra: NaN },
    { ...design(), extra: Infinity },
    { ...design(), extra: 1n },
    { ...design(), extra: () => true },
    { ...design(), extra: new Date() },
    { ...design(), extra: new Map() },
    { ...design(), extra: Object.create({ inherited: true }) as unknown },
    { ...design(), extra: cycle },
  ];
  for (const input of malformed) rejected(input);
  const sparse = design();
  sparse.components = Array(2) as Design["components"];
  rejected(sparse, "invalid_json");
});

test("candidate accessors are rejected without invoking root or nested getters", () => {
  let calls = 0;
  const root = design();
  Object.defineProperty(root, "kind", {
    enumerable: true,
    get: () => {
      calls += 1;
      throw new Error("root getter executed");
    },
  });
  rejected(root, "invalid_json");
  const nested = recipeDesign();
  const config = {};
  Object.defineProperty(config, "labels", {
    enumerable: true,
    get: () => {
      calls += 1;
      throw new Error("nested getter executed");
    },
  });
  Object.assign(nested.components[0]!, { config });
  rejected(nested, "invalid_json");
  const hidden = design();
  Object.defineProperty(hidden, "hidden", {
    enumerable: false,
    get: () => {
      calls += 1;
      throw new Error("hidden getter executed");
    },
  });
  rejected(hidden, "invalid_json");
  assert.equal(calls, 0);
});

test("hostile candidate proxies are rejected without executing proxy traps", () => {
  let traps = 0;
  const fail = () => {
    traps += 1;
    throw new Error("proxy trap executed");
  };
  const proxy = new Proxy(design(), {
    get: fail,
    ownKeys: fail,
    getPrototypeOf: fail,
    getOwnPropertyDescriptor: fail,
  });
  rejected(proxy, "invalid_json");
  rejected({ ...design(), nested: proxy }, "invalid_json");
  assert.equal(traps, 0);
});

test("deep, oversized, and overpopulated JSON fails within the admission profile", () => {
  let deep: unknown = "leaf";
  for (let depth = 0; depth < 2048; depth += 1) deep = { child: deep };
  rejected({ ...design(), extra: deep }, "resource_limit");
  const wide = { ...design(), extra: Array.from({ length: 100 }, () => false) };
  rejected(wide, "resource_limit", {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumJsonNodes: 64 },
  });
  const text = { ...design(), extra: "x".repeat(1024) };
  rejected(text, "resource_limit", {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumStringUtf8Bytes: 256 },
  });
  const bytes = { ...design(), extra: ["é".repeat(100), "é".repeat(100)] };
  rejected(bytes, "resource_limit", {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumJsonBytes: 512 },
  });
});

test("resource profiles bound work without becoming the semantic definition of a game", () => {
  const spec = design(source("first"), source("second"));
  rejected(spec, "resource_limit", {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumComponents: 1 },
  });
  const first = eligible(spec);
  const larger = eligible(spec, {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumComponents: 512 },
  });
  assert.equal(first.hash, larger.hash);
  const huge = source();
  huge.files[0]!.content = {
    kind: "locked",
    sourceHash: "a".repeat(64),
    utf8Bytes: DEFAULT_GAME_ADMISSION_POLICY.maximumFileSourceBytes + 1,
  };
  rejected(design(huge), "resource_limit");
  const total = design(source("first"), source("second"));
  rejected(total, "resource_limit", {
    ...OPTIONS,
    policy: { ...DEFAULT_GAME_ADMISSION_POLICY, maximumDeclaredSourceBytes: 100 },
  });
});

test("canonical identity sorts declarations while preserving meaningful configuration array order", () => {
  const spec = connectedDesign();
  for (const component of spec.components as Source[]) {
    component.files.push(file("util", "shared"));
    component.files.push(file("helper", "shared"));
    component.files[0]!.imports = [
      { componentId: component.id, fileId: "util" },
      { componentId: component.id, fileId: "helper" },
    ];
    component.obligations = [
      { id: "observe", description: "Observe runtime behavior.", evidence: "studio_play" },
      { id: "analyze", description: "Analyze source.", evidence: "source_analysis" },
    ];
  }
  const before = structuredClone(spec);
  const first = eligible(spec);
  const reordered = structuredClone(spec);
  reordered.components.reverse();
  reordered.connections.reverse();
  for (const component of reordered.components as Source[]) {
    component.files.reverse();
    component.ports.reverse();
    component.obligations.reverse();
    for (const sourceFile of component.files) sourceFile.imports.reverse();
  }
  const second = eligible(reordered);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.spec, second.spec);
  assert.deepEqual(spec, before);

  const registry = createGameDefinitionRegistry([OPTIONAL_DEFINITION]);
  const configured = recipeDesign();
  const originalHash = eligible(configured, { ...OPTIONS, registry }).hash;
  Object.assign(configured.components[0]!, {
    config: { enabled: true, labels: ["first", "second"] },
  });
  assert.equal(eligible(configured, { ...OPTIONS, registry }).hash, originalHash);
  Object.assign(configured.components[0]!, {
    config: { labels: ["second", "first"], enabled: true },
  });
  assert.notEqual(eligible(configured, { ...OPTIONS, registry }).hash, originalHash);
});

test("trusted definition pins canonicalize set declarations and preserve supplied definitions", () => {
  const original = structuredClone(OPTIONAL_DEFINITION);
  const reordered = structuredClone(OPTIONAL_DEFINITION) as unknown as Mutable<
    typeof OPTIONAL_DEFINITION
  >;
  reordered.ports.reverse();
  reordered.configSchema.required.reverse();
  assert.deepEqual(gameRecipeDefinitionLock(reordered), gameRecipeDefinitionLock(original));
  assert.deepEqual(OPTIONAL_DEFINITION, original);
});

test("every game IR source module remains independent of acceptance fixtures and examples", () => {
  const root = resolve("packages/game-ir/src");
  const modules = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".ts"),
  );
  assert.ok(modules.length > 0);
  for (const entry of modules) {
    const path = resolve(entry.parentPath, entry.name);
    const body = readFileSync(path, "utf8");
    assert.doesNotMatch(
      body,
      /(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:fixtures|examples|\/test\/)[^"']*["']/,
      path,
    );
    assert.doesNotMatch(body, /LAST_LIGHT|Last Light|last-light/, path);
  }
});
