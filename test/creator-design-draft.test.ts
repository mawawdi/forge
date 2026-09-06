import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import {
  creatorGameProposalDesignSchema,
  resolveCreatorGameComponentInput,
  type CreatorComponentRef,
  type CreatorGameComponentInput,
  type CreatorGameCatalog,
} from "../packages/creator-session/src/game-authoring.js";
import {
  createGameDefinitionRegistry,
  DEFAULT_GAME_ADMISSION_POLICY,
  validateGameDesignSpec,
  type GameSourcePackage,
} from "../packages/game-ir/src/index.js";

const catalog: CreatorGameCatalog = {
  definitions: [],
  registry: createGameDefinitionRegistry([]),
  expanders: [],
  lockedSources: new Map(),
};
function component(
  id: string,
  maximumUtf8Bytes = 128,
): Extract<CreatorGameComponentInput, { kind: "source_package" }> {
  return {
    kind: "source_package",
    id,
    ports: [],
    obligations: [],
    files: [
      {
        id: "module",
        path: "Module.luau",
        context: "shared",
        role: "module",
        content: { kind: "slot", maximumUtf8Bytes },
        imports: [],
        placement: {
          kind: "create",
          operationId: "install-" + id,
          name: id,
          parent: {
            kind: "engine_container",
            path: "ReplicatedStorage",
          },
        },
      },
    ],
  };
}
function proposal(refs: CreatorComponentRef[]) {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "modular-design",
    intent: "Compose arbitrary ordinary source packages.",
    componentIds: refs.map((ref) => ref.componentId),
    connections: [],
    artifactDependencies: [],
  };
}

test("draft retains typed components by exact hash and assembles the unchanged public GameDesignSpec", () => {
  const draft = new CreatorDesignDraft(catalog);
  const a = component("consumer");
  a.files[0]!.imports = [{ componentId: "provider", fileId: "module" }];
  const emptyHash = draft.hash;
  const first = draft.define({ component: a });
  assert.notEqual(draft.hash, emptyHash);
  assert.equal(first.componentHash, contentHash(stableJson(resolveCreatorGameComponentInput(a))));
  const incomplete = draft.assemble(proposal([first]));
  assert.equal(
    validateGameDesignSpec(incomplete, {
      registry: catalog.registry,
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    }).status,
    "rejected",
  );
  const second = draft.define({ component: component("provider") });
  const full = draft.assemble(proposal([second, first]));
  assert.deepEqual(
    full.components.map((item) => item.id),
    ["consumer", "provider"],
  );
  assert.equal(
    validateGameDesignSpec(full, {
      registry: catalog.registry,
      policy: DEFAULT_GAME_ADMISSION_POLICY,
    }).status,
    "eligible",
  );
  assert.equal(Object.hasOwn(full, "componentIds"), false);
  assert.equal(
    creatorGameProposalDesignSchema().safeParse(full).success,
    false,
    "The model no longer submits inline components",
  );
  assert.deepEqual(draft.read(), { refs: [first, second], components: [] });
});

test("host-versioned replacement is atomic, idempotent and independent of caller mutations", () => {
  const draft = new CreatorDesignDraft(catalog);
  const input = component("source");
  const first = draft.define({ component: input });
  const original = draft.hash;
  assert.deepEqual(draft.define({ component: input }), first);
  assert.equal(draft.hash, original);
  input.files[0]!.path = "Changed.luau";
  const stored = draft.read({ componentIds: ["source"] });
  assert.equal((stored.components[0] as GameSourcePackage).files[0]!.path, "Module.luau");
  stored.refs[0]!.componentHash = "0".repeat(64);
  (stored.components[0] as GameSourcePackage).files[0]!.path = "Poison.luau";
  assert.deepEqual(draft.read().refs, [first]);
  for (const rejected of [
    { component: input, expectedHash: null },
    { component: { ...input, expectedHash: first.componentHash } },
    { component: { ...input, files: [] } },
  ])
    assert.throws(() => draft.define(rejected));
  assert.equal(draft.hash, original);
  const proposedBeforeReplacement = draft.assemble(proposal([first]));
  const proposedHash = contentHash(stableJson(proposedBeforeReplacement));
  const replaced = draft.define({ component: input });
  assert.notEqual(replaced.componentHash, first.componentHash);
  const nextProposal = draft.assemble(proposal([first]));
  assert.equal((nextProposal.components[0] as GameSourcePackage).files[0]!.path, "Changed.luau");
  assert.equal(contentHash(stableJson(proposedBeforeReplacement)), proposedHash);
  assert.equal(
    (proposedBeforeReplacement.components[0] as GameSourcePackage).files[0]!.path,
    "Module.luau",
  );
  assert.notEqual(contentHash(stableJson(nextProposal)), proposedHash);
  assert.throws(() => draft.assemble({ ...proposal([replaced]), componentRefs: [first] }));
});

test("reentrant host validation cannot mutate or partially replace a draft", () => {
  let reenter = false;
  const draft: CreatorDesignDraft = new CreatorDesignDraft({
    ...catalog,
    validateComponent() {
      if (reenter) draft.define({ component: component("injected") });
    },
  });
  const first = draft.define({ component: component("source") });
  const before = draft.snapshot();
  reenter = true;
  assert.throws(() => draft.define({ component: component("source", 64) }), /reentered/);
  assert.deepEqual(draft.snapshot(), before);
  reenter = false;
  assert.notEqual(
    draft.define({ component: component("source", 64) }).componentHash,
    first.componentHash,
  );
});

test("host-retained repair bindings reject stale versions, wrong IDs and changed absence", () => {
  const draft = new CreatorDesignDraft(catalog);
  const first = draft.defineAt(
    { component: component("source") },
    { componentId: "source", componentHash: null },
  );
  const before = draft.snapshot();
  assert.throws(
    () =>
      draft.defineAt(
        { component: component("source", 64) },
        { componentId: "source", componentHash: null },
      ),
    /retained component version/,
  );
  assert.throws(
    () => draft.defineAt({ component: component("other") }, first),
    /retained component version/,
  );
  assert.deepEqual(draft.snapshot(), before);
  const second = draft.defineAt({ component: component("source", 64) }, first);
  assert.notEqual(second.componentHash, first.componentHash);
  assert.throws(
    () => draft.defineAt({ component: component("source") }, first),
    /retained component version/,
  );
  assert.deepEqual(draft.read().refs, [second]);
});

test("failed global proposals preserve valid parts and selected IDs reject duplicates and unknowns", () => {
  const draft = new CreatorDesignDraft(catalog);
  const first = draft.define({ component: component("alpha") });
  const second = draft.define({ component: component("beta") });
  const before = draft.hash;
  assert.throws(() => draft.assemble(proposal([first, first])), /unique/);
  assert.throws(
    () =>
      draft.assemble(proposal([{ componentId: "missing", componentHash: first.componentHash }])),
    /Unknown/,
  );
  assert.throws(() => draft.assemble({ ...proposal([first]), components: [component("alpha")] }));
  assert.throws(() => draft.read({ componentIds: ["missing"] }), /Unknown/);
  assert.throws(() => draft.read({ componentIds: ["alpha", "alpha"] }), /unique/);
  assert.equal(draft.hash, before);
  assert.deepEqual(draft.read().refs, [first, second]);
  assert.deepEqual(
    draft.assemble(proposal([second])).components.map((item) => item.id),
    ["beta"],
    "Unreferenced retained parts never enter the proposed graph",
  );
});

test("aggregate draft count, file, source and JSON bounds are enforced before mutation", () => {
  for (const policy of [
    { ...DEFAULT_GAME_ADMISSION_POLICY, maximumComponents: 1 },
    { ...DEFAULT_GAME_ADMISSION_POLICY, maximumFiles: 1 },
    { ...DEFAULT_GAME_ADMISSION_POLICY, maximumDeclaredSourceBytes: 128 },
    { ...DEFAULT_GAME_ADMISSION_POLICY, maximumJsonBytes: 800 },
  ]) {
    const draft = new CreatorDesignDraft(catalog, policy);
    const first = draft.define({ component: component("alpha") });
    const hash = draft.hash;
    assert.throws(() => draft.define({ component: component("beta") }));
    assert.equal(draft.hash, hash);
    assert.deepEqual(draft.read().refs, [first]);
    draft.define({ component: component("alpha", 64) });
  }
  const draft = new CreatorDesignDraft(catalog, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumFileSourceBytes: 64,
  });
  assert.throws(() => draft.define({ component: component("oversize") }));
  assert.deepEqual(draft.read().refs, []);
});

test("malformed and hostile declarations cannot invoke getters or poison prior draft state", () => {
  const draft = new CreatorDesignDraft(catalog);
  const first = draft.define({ component: component("valid") });
  const before = draft.hash;
  let invoked = 0;
  const getter = Object.defineProperty({}, "component", {
    enumerable: true,
    get() {
      invoked++;
      return component("injected");
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        invoked++;
        return null;
      },
      ownKeys() {
        invoked++;
        return [];
      },
    },
  );
  for (const input of [
    getter,
    proxy,
    { component: { ...component("invalid"), extra: true } },
    { component: component("obsolete-envelope"), expectedHash: null },
  ])
    assert.throws(() => draft.define(input));
  assert.equal(invoked, 0);
  assert.equal(draft.hash, before);
  assert.deepEqual(draft.read().refs, [first]);
});
