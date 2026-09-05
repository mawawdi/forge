import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameSemanticArchitecture,
} from "../packages/game-ir/src/index.js";
import {
  compileGamePlan,
  materializeGameBuildGraph,
  type GameInventoryItem,
  type GameCheckpointReceipt,
} from "../packages/game-compiler/src/index.js";
import { createGameBuildControlView } from "../packages/creator-session/src/game-build-view.js";
import { assertGameBuildControlView } from "../packages/creator-conversation/src/game-build-contract.js";
import {
  sealCreatorControlView,
  assertCreatorControlView,
} from "../packages/creator-conversation/src/index.js";

const HASH = "a".repeat(64);
const DEFINITION = {
  kind: "GameRecipeDefinition",
  id: "view-fixture",
  abi: "1",
  sourceExports: [{ id: "logic", context: "shared" }],
  ports: [],
  obligations: [],
  configSchema: { type: "null" },
} as const;
function fixture(architecture?: GameSemanticArchitecture) {
  const inventory: GameInventoryItem[] = Array.from({ length: 129 }, (_, index) => ({
    id: `object-${String(index).padStart(3, "0")}`,
    componentId: "objects",
    change: {
      id: `object-${String(index).padStart(3, "0")}`,
      kind: "create",
      path: `Workspace/Object${index}`,
      className: "Folder",
      initialization: "initial_properties",
      parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
    },
    lockedProperties: {},
    valueSlots: [],
    attributes: {},
    removedAttributes: [],
    dependencies: index === 128 ? ["object-000"] : [],
  }));
  inventory.push({
    id: "source",
    componentId: "objects",
    change: {
      id: "source",
      kind: "create",
      path: "Workspace/Logic",
      className: "ModuleScript",
      initialization: "inline_source_required",
      parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
    },
    lockedProperties: {},
    valueSlots: [],
    source: { fileId: "logic", content: { kind: "slot", maximumUtf8Bytes: 1024 } },
    attributes: {},
    removedAttributes: [],
    dependencies: ["object-000"],
  });
  const compiled = compileGamePlan({
    design: {
      kind: "GameDesignSpec",
      id: "view-test",
      intent: "Inspect an exact build graph.",
      ...(architecture ? { architecture } : {}),
      components: [
        {
          kind: "recipe_instance",
          id: "objects",
          definition: gameRecipeDefinitionLock(DEFINITION),
          config: null,
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
    registry: createGameDefinitionRegistry([DEFINITION]),
    inventory,
    project: { name: "View", placeId: 0, universeId: 0 },
    projectId: "view-project",
    sessionId: "view-session",
    observedRevisionHash: HASH,
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "view-root" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
      },
    ],
  });
  const graph = materializeGameBuildGraph({
    plan: compiled,
    acceptanceHash: HASH,
    sources: [{ slotId: "source", source: "return {}" }],
    values: [],
    checks: { status: "eligible", artifactHashes: [HASH] },
  }).graph;
  return {
    plan: { compiled },
    build: {
      graph,
      buildContractHash: HASH,
      summary: "View test",
      receipts: [] as GameCheckpointReceipt[],
      status: "building" as const,
    },
  };
}

// Presentation fixture for a ledger the coordinator has already replay-verified.
// This helper creates no native evidence and tests no Studio behavior.
function retainedReceipt(
  build: ReturnType<typeof fixture>["build"],
  ordinal: number,
  previous?: GameCheckpointReceipt,
): GameCheckpointReceipt {
  const payload = {
    kind: "GameCheckpointReceipt" as const,
    graphHash: build.graph.hash,
    partitionHash: build.graph.partitions[ordinal]!.hash,
    ordinal,
    ...(previous ? { previousReceiptHash: previous.hash } : {}),
    attempt: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 12 },
    acknowledgement: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 12 },
    beforeRevisionHash: previous?.afterRevisionHash ?? build.graph.observedRevisionHash,
    afterRevisionHash: contentHash(String(ordinal)),
    reconciliationHash: HASH,
    finalizationHash: HASH,
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

test("build presentation comes from real sealed inventory, source slots, component pins and operation dependencies", () => {
  const { plan } = fixture();
  const view = createGameBuildControlView({ plan, sessionStatus: "awaiting_plan_approval" });
  assert.equal(view.planHash, plan.compiled.hash);
  assert.equal(view.status, "planned");
  assert.equal(view.nodes.length, 130);
  assert.equal(view.nodes.find((node) => node.id === "source")!.source?.maximumUtf8Bytes, 1024);
  assert.equal(view.nodes[0]!.provenance.definitionHash, gameRecipeDefinitionLock(DEFINITION).hash);
  assert.ok(view.edges.some((edge) => edge.from === "object-128" && edge.to === "object-000"));
  assert.deepEqual(view.partitions, []);
  assert.equal(
    view.architecture,
    undefined,
    "No architecture may be inferred from implementation names",
  );
});

test("named systems keep authored meaning and derive a deduplicated descendant operation prefix", () => {
  const architecture: GameSemanticArchitecture = {
    name: "Creative workshop",
    nodes: [
      { id: "creation", name: "Creation", description: "Shared creative tools.", componentIds: [] },
      {
        id: "brush",
        name: "Brush actions",
        description: "Changes to the world.",
        parentId: "creation",
        componentIds: ["objects"],
      },
      {
        id: "palette",
        name: "Palette",
        description: "Selections consumed by the brush.",
        parentId: "creation",
        componentIds: ["objects"],
      },
    ],
    relationships: [
      { id: "selection", from: "palette", to: "brush", label: "Supplies selected material" },
    ],
  };
  const { plan, build } = fixture(architecture);
  build.receipts.push(retainedReceipt(build, 0));
  const view = createGameBuildControlView({
    plan,
    build: { ...build, status: "incomplete" },
    sessionStatus: "incomplete",
  });
  assert.equal(view.architecture?.name, architecture.name);
  assert.deepEqual(view.architecture?.relationships, architecture.relationships);
  const group = view.architecture!.nodes.find((node) => node.id === "creation")!;
  assert.equal(group.name, "Creation");
  assert.equal(
    group.operationIds.length,
    130,
    "Two system bindings to one component must not double count editor work",
  );
  assert.equal(
    group.appliedOperations,
    view.nodes.filter((node) => node.status === "applied").length,
  );
  assert.equal(group.status, "stopped");
  assert.deepEqual(group.componentIds, []);
  assertGameBuildControlView(view);
  assert.throws(() =>
    assertGameBuildControlView({
      ...view,
      architecture: {
        ...view.architecture!,
        nodes: view.architecture!.nodes.map((node) =>
          node.id === "creation" ? { ...node, parentId: "brush" } : node,
        ),
      },
    }),
  );
  assert.throws(() =>
    assertGameBuildControlView({
      ...view,
      architecture: {
        ...view.architecture!,
        relationships: [{ id: "bad", from: "brush", to: "foreign", label: "Invalid" }],
      },
    }),
  );
});

test("component dependency presentation preserves sealed artifact edges independently of object edges", () => {
  const { compiled } = fixture().plan;
  const plan = compileGamePlan({
    ...compiled,
    registry: createGameDefinitionRegistry([DEFINITION]),
    design: {
      ...compiled.design,
      components: [
        ...compiled.design.components,
        { ...compiled.design.components[0]!, id: "dependent" },
      ],
      artifactDependencies: [{ from: "dependent", to: "objects" }],
    },
    inventory: compiled.inventory.map((item) =>
      item.id === "source" ? { ...item, componentId: "dependent", dependencies: [] } : item,
    ),
  });
  const view = createGameBuildControlView({
    plan: { compiled: plan },
    sessionStatus: "awaiting_plan_approval",
  });
  assert.deepEqual(view.componentDependencies, [{ from: "dependent", to: "objects" }]);
  assert.deepEqual(
    view.components.map((component) => component.id),
    ["dependent", "objects"],
  );
  assert.equal(
    view.edges.some((edge) => edge.from === "source"),
    false,
  );
});

test("a declared system with no editor operations is never presented as applied", () => {
  const { compiled } = fixture().plan;
  const plan = compileGamePlan({
    ...compiled,
    registry: createGameDefinitionRegistry([DEFINITION]),
    design: {
      ...compiled.design,
      components: [
        ...compiled.design.components,
        { ...compiled.design.components[0]!, id: "library" },
      ],
      architecture: {
        name: "Workshop",
        nodes: [
          {
            id: "tools",
            name: "Existing tools",
            description: "Tools referenced without editor changes.",
            componentIds: ["library"],
          },
        ],
        relationships: [],
      },
    },
  });
  const view = createGameBuildControlView({
    plan: { compiled: plan },
    sessionStatus: "awaiting_plan_approval",
  });
  assert.equal(view.architecture!.nodes[0]!.status, "no_changes");
  assert.equal(view.architecture!.nodes[0]!.appliedOperations, 0);
  assert.deepEqual(view.architecture!.nodes[0]!.operationIds, []);
});

test("presentation recognizes common bindings of a coordinator-verified Rojo checkpoint prefix", () => {
  const { plan, build } = fixture();
  const first = retainedReceipt(build, 0);
  build.receipts.push(first);
  const artifact = { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 12 };
  const binding = { id: "presentation-binding", hash: HASH, artifact };
  const capture = {
    captureId: "presentation-capture",
    captureHash: HASH,
    detectorEpoch: 1,
    projection: binding,
    manifest: binding,
    revision: binding,
    shards: [],
    sourceManifests: [],
    sourceChunks: [],
  };
  // Presentation-only fixture: native/filesystem replay is tested by the coordinator, not this projection.
  const payload = {
    kind: "GameRojoCheckpointReceipt" as const,
    graphHash: build.graph.hash,
    partitionHash: build.graph.partitions[1]!.hash,
    ordinal: 1,
    previousReceiptHash: first.hash,
    authorityMap: artifact,
    sourceChangeSet: artifact,
    attempt: artifact,
    syncProof: artifact,
    beforeIndexCapture: capture,
    afterIndexCapture: capture,
    beforeRevisionHash: first.afterRevisionHash,
    afterRevisionHash: contentHash("rojo-after"),
    replayHash: HASH,
  };
  build.receipts.push({ ...payload, hash: contentHash(stableJson(payload)) });
  const view = createGameBuildControlView({ plan, build, sessionStatus: "completed" });
  assert.equal(view.status, "complete");
  assert.ok(view.nodes.every((node) => node.status === "applied"));
  assert.equal(view.receipts.length, 2);
});

test("committing and optimistic build completion never paint unacknowledged checkpoints as applied", () => {
  const { plan, build } = fixture();
  const view = createGameBuildControlView({
    plan,
    build: { ...build, status: "complete" },
    sessionStatus: "committing",
    activeChangeSet: { partition: { graphHash: build.graph.hash, ordinal: 0 } },
  });
  assert.equal(view.status, "applying");
  assert.equal(view.partitions[0]!.status, "applying");
  assert.equal(view.partitions[1]!.status, "pending");
  assert.equal(
    view.nodes.some((node) => node.status === "applied"),
    false,
  );
  assert.deepEqual(view.receipts, []);
});

test("stopped graphs retain only the acknowledged contiguous prefix and exact stop reason", () => {
  const { plan, build } = fixture();
  build.receipts.push(retainedReceipt(build, 0));
  const view = createGameBuildControlView({
    plan,
    build: { ...build, status: "incomplete" },
    sessionStatus: "incomplete",
    stoppedReason: "Studio disconnected before the second checkpoint.",
  });
  assert.equal(view.status, "stopped");
  assert.deepEqual(
    view.partitions.map((partition) => partition.status),
    ["applied", "stopped"],
  );
  const expectedApplied = new Set(
    build.graph.partitions[0]!.operationIds.map(
      (id) => build.graph.operations.find((operation) => operation.id === id)!.planChangeId,
    ),
  );
  assert.deepEqual(
    new Set(view.nodes.filter((node) => node.status === "applied").map((node) => node.id)),
    expectedApplied,
  );
  assert.equal(view.stoppedReason, "Studio disconnected before the second checkpoint.");
  assert.equal(view.receipts[0]!.hash, build.receipts[0]!.hash);
});

test("foreign or malformed checkpoint bindings cannot manufacture applied presentation", () => {
  const { plan, build } = fixture();
  build.receipts.push({ ...retainedReceipt(build, 0), hash: "b".repeat(64) });
  const view = createGameBuildControlView({ plan, build, sessionStatus: "committing" });
  assert.equal(view.status, "recovery_required");
  assert.equal(
    view.nodes.some((node) => node.status === "applied"),
    false,
  );
  assert.equal(view.receipts.length, 0);
  assert.throws(
    () =>
      createGameBuildControlView({
        plan,
        build: { ...build, graph: { ...build.graph, planHash: HASH } },
        sessionStatus: "incomplete",
      }),
    /different sealed plan/,
  );
});

test("browser control contract binds graph updates and accepts resume without a model execution", () => {
  const { plan, build } = fixture();
  const view = createGameBuildControlView({
    plan,
    build,
    sessionStatus: "awaiting_change_approval",
  });
  assertGameBuildControlView(view);
  const control = sealCreatorControlView({
    id: "view",
    conversationId: "conversation",
    conversationHash: HASH,
    eventSequence: 1,
    status: "awaiting_creator",
    title: "Continue",
    detail: "Continue the exact graph.",
    actions: [
      {
        actionInstanceId: "resume",
        actionId: "resume_build",
        label: "Continue build",
        intent: "primary",
        controlViewId: "view",
        authorizingEventId: "event",
        authorizingEventHash: HASH,
        target: "none",
        input: { kind: "none" },
      },
    ],
    technicalAttachments: [],
    gameBuild: view,
  });
  assertCreatorControlView(control);
  assert.throws(() =>
    assertCreatorControlView({
      ...control,
      gameBuild: { ...view, edges: [{ from: "foreign", to: "object-000", kind: "parent" }] },
    }),
  );
});
