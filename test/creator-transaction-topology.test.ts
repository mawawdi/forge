import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCreatorTransactionTopologyOrder,
  compileCreatorTransactionTopology,
  creatorTransactionFinalTargetForOriginalIdentity,
  type CreatorTransactionTopologyNode,
  type CreatorTransactionTopologyOperation,
} from "../packages/creator-session/src/transaction-topology.js";

const identity = (stableId: string) => ({ kind: "forge_attribute" as const, stableId });
const target = (stableId: string, path = `Workspace/${stableId}`, className = "Folder") => ({
  kind: "instance" as const,
  identity: identity(stableId),
  path,
  className,
});
const parent = (stableId: string) =>
  target(stableId, stableId === "root" ? "Workspace" : undefined);
const emptyProperties = {};

function node(
  stableId: string,
  options: Partial<
    Omit<CreatorTransactionTopologyNode, "identity" | "path" | "name" | "className">
  > & {
    readonly parentIdentity?: ReturnType<typeof identity>;
    readonly path?: string;
    readonly name?: string;
    readonly className?: string;
  } = {},
): CreatorTransactionTopologyNode {
  return {
    identity: identity(stableId),
    path: options.path ?? `Workspace/${stableId}`,
    name: options.name ?? stableId,
    className: options.className ?? "Folder",
    ...(options.parentIdentity === undefined ? {} : { parentIdentity: options.parentIdentity }),
    ...(options.engineContainer === undefined ? {} : { engineContainer: options.engineContainer }),
    ...(options.properties === undefined ? {} : { properties: options.properties }),
  };
}

function create(
  id: string,
  stableId: string,
  parentTarget: ReturnType<typeof target>,
  name = stableId,
): CreatorTransactionTopologyOperation {
  return {
    id,
    kind: "create",
    target: target(stableId, `${parentTarget.path}/${name}`),
    parent: parentTarget,
    name,
    properties: emptyProperties,
  };
}

function move(
  id: string,
  stableId: string,
  parentTarget: ReturnType<typeof target>,
  name = stableId,
): CreatorTransactionTopologyOperation {
  return {
    id,
    kind: "move",
    target: target(stableId),
    parent: parentTarget,
    name,
    properties: emptyProperties,
  };
}

function remove(id: string, stableId: string): CreatorTransactionTopologyOperation {
  return { id, kind: "delete", target: target(stableId) };
}

test("topology compiler orders a new parent before its new child", () => {
  const root = target("root", "Workspace");
  const projection = compileCreatorTransactionTopology({
    initial: [node("root", { path: "Workspace", name: "Workspace" })],
    operations: [
      create("create-child", "child", target("new-parent")),
      create("create-parent", "new-parent", root),
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, ["create-parent", "create-child"]);
  assert.throws(
    () =>
      assertCreatorTransactionTopologyOrder({
        initial: [node("root", { path: "Workspace", name: "Workspace" })],
        operations: [
          create("create-child", "child", target("new-parent")),
          create("create-parent", "new-parent", root),
        ],
      }),
    /canonical safe topology order/,
  );
});

test("topology compiler rejects parent-to-descendant and multi-node parent cycles", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const ancestor = node("ancestor", { parentIdentity: identity("root") });
  const descendant = node("descendant", { parentIdentity: identity("ancestor") });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, ancestor, descendant],
        operations: [move("move-ancestor", "ancestor", parent("descendant"))],
      }),
    /parent cycle/,
  );

  const a = node("a", { parentIdentity: identity("root") });
  const b = node("b", { parentIdentity: identity("root") });
  const c = node("c", { parentIdentity: identity("root") });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, a, b, c],
        operations: [
          move("move-a", "a", parent("b")),
          move("move-b", "b", parent("c")),
          move("move-c", "c", parent("a")),
        ],
      }),
    /parent cycle/,
  );
});

test("topology compiler rejects final sibling collisions and unsafe name swaps", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const first = node("first", { parentIdentity: identity("root"), name: "First" });
  const second = node("second", { parentIdentity: identity("root"), name: "Second" });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, first, second],
        operations: [move("rename-second", "second", parent("root"), "First")],
      }),
    /sibling name collision/,
  );
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, first, second],
        operations: [
          move("rename-first", "first", parent("root"), "Second"),
          move("rename-second", "second", parent("root"), "First"),
        ],
      }),
    /no safe deterministic operation order/,
  );
});

test("topology compiler preserves pre-existing duplicate sibling names by opaque identity", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const first = node("first", { parentIdentity: identity("root"), name: "Duplicate" });
  const second = node("second", { parentIdentity: identity("root"), name: "Duplicate" });
  const projection = compileCreatorTransactionTopology({
    initial: [root, first, second],
    operations: [
      {
        id: "update-first-by-identity",
        kind: "update",
        target: target("first"),
        properties: emptyProperties,
      },
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, ["update-first-by-identity"]);
  assert.equal(projection.finalNodes.length, 3);
});

test("topology compiler rejects nested deletes and work that remains inside deleted subtrees", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const deleted = node("deleted", { parentIdentity: identity("root") });
  const child = node("child", { parentIdentity: identity("deleted") });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, deleted, child],
        operations: [remove("delete-root", "deleted"), remove("delete-child", "child")],
      }),
    /delete dependencies overlap|inside deleted subtree/,
  );
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, deleted, child],
        operations: [
          remove("delete-root", "deleted"),
          {
            id: "update-child",
            kind: "update",
            target: target("child"),
            properties: emptyProperties,
          },
        ],
      }),
    /inside deleted subtree/,
  );
});

test("topology compiler extracts a subtree before deleting its former ancestor", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const deleted = node("deleted", {
    parentIdentity: identity("root"),
    path: "Workspace/DeleteMe",
    name: "DeleteMe",
  });
  const extracted = node("extracted", {
    parentIdentity: identity("deleted"),
    path: "Workspace/DeleteMe/Extracted",
    name: "Extracted",
  });
  const outside = node("outside", {
    parentIdentity: identity("root"),
    path: "Workspace/Outside",
    name: "Outside",
  });
  const createUnderExtracted: CreatorTransactionTopologyOperation = {
    id: "a-create-under-extracted",
    kind: "create",
    target: target("created", "Workspace/Extracted/Created"),
    // The existing parent is still addressed at its exact pre-Apply path.
    parent: target("extracted", "Workspace/DeleteMe/Extracted"),
    name: "Created",
    properties: emptyProperties,
  };
  const extract: CreatorTransactionTopologyOperation = {
    id: "b-extract",
    kind: "move",
    target: target("extracted", "Workspace/DeleteMe/Extracted"),
    parent: target("root", "Workspace"),
    name: "Extracted",
    properties: emptyProperties,
  };
  const deleteFormerAncestor: CreatorTransactionTopologyOperation = {
    id: "z-delete-former-ancestor",
    kind: "delete",
    target: target("deleted", "Workspace/DeleteMe"),
  };
  const projection = compileCreatorTransactionTopology({
    initial: [root, deleted, extracted],
    operations: [deleteFormerAncestor, extract, createUnderExtracted],
  });
  assert.deepEqual(projection.orderedOperationIds, [
    "a-create-under-extracted",
    "b-extract",
    "z-delete-former-ancestor",
  ]);
  assert.deepEqual(projection.deletedIdentityKeys, ["forge_attribute:deleted"]);
  assert.equal(
    creatorTransactionFinalTargetForOriginalIdentity(projection, identity("created"))?.path,
    "Workspace/Extracted/Created",
  );
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, deleted, extracted, outside],
        operations: [
          {
            id: "delete-former-ancestor",
            kind: "delete",
            target: target("deleted", "Workspace/DeleteMe"),
          },
          {
            ...extract,
            id: "move-into-deleted",
            target: target("outside", "Workspace/Outside"),
            parent: target("deleted", "Workspace/DeleteMe"),
            name: "Outside",
          },
        ],
      }),
    /deleted subtree/,
  );
});

test("topology compiler requires exact parent and instance-reference targets", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const child = node("child", {
    parentIdentity: identity("root"),
    path: "Workspace/Child",
    name: "Child",
  });
  const owner = node("owner", {
    parentIdentity: identity("root"),
    path: "Workspace/Owner",
    name: "Owner",
  });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, child, owner],
        operations: [
          {
            id: "move-child-with-stale-parent",
            kind: "move",
            target: target("child", "Workspace/Child"),
            parent: target("root", "Workspace/Stale", "Part"),
            name: "Child",
            properties: emptyProperties,
          },
        ],
      }),
    /contradictory move parent path/,
  );
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, child, owner],
        operations: [
          {
            id: "move-child",
            kind: "move",
            target: target("child", "Workspace/Child"),
            parent: target("root", "Workspace"),
            name: "RenamedChild",
            properties: emptyProperties,
          },
          {
            id: "reference-child-at-its-future-path",
            kind: "update",
            target: target("owner", "Workspace/Owner"),
            properties: {
              Linked: {
                kind: "instance_ref",
                state: "reference",
                identity: identity("child"),
                path: "Workspace/RenamedChild",
                className: "Folder",
                expectedClass: "Instance",
              },
            },
          },
        ],
      }),
    /instance_ref has a contradictory target/,
  );
  const newParent = create("create-parent", "new-parent", target("root", "Workspace"), "NewParent");
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, child, owner],
        operations: [
          newParent,
          {
            ...create("create-child", "new-child", target("new-parent", "Workspace/NewParent")),
            parent: target("new-parent", "Workspace/StaleParent"),
          },
        ],
      }),
    /contradictory create parent path/,
  );
});

test("topology compiler supports self, forward, and mutual references to created objects", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const selfReference: CreatorTransactionTopologyOperation = {
    id: "create-self",
    kind: "create",
    target: target("self", "Workspace/Self"),
    parent: target("root", "Workspace"),
    name: "Self",
    properties: {
      Linked: {
        kind: "instance_ref",
        state: "reference",
        identity: identity("self"),
        path: "Workspace/Self",
        className: "Folder",
        expectedClass: "Instance",
      },
    },
  };
  const forwardReference: CreatorTransactionTopologyOperation = {
    id: "create-a",
    kind: "create",
    target: target("a", "Workspace/A"),
    parent: target("root", "Workspace"),
    name: "A",
    properties: {
      Linked: {
        kind: "instance_ref",
        state: "reference",
        identity: identity("b"),
        path: "Workspace/B",
        className: "Folder",
        expectedClass: "Instance",
      },
    },
  };
  const referencedCreate: CreatorTransactionTopologyOperation = {
    id: "create-b",
    kind: "create",
    target: target("b", "Workspace/B"),
    parent: target("root", "Workspace"),
    name: "B",
    properties: {
      Linked: {
        kind: "instance_ref",
        state: "reference",
        identity: identity("a"),
        path: "Workspace/A",
        className: "Folder",
        expectedClass: "Instance",
      },
    },
  };
  const projection = compileCreatorTransactionTopology({
    initial: [root],
    operations: [forwardReference, selfReference, referencedCreate],
  });
  assert.deepEqual(projection.orderedOperationIds, ["create-a", "create-b", "create-self"]);
});

test("topology compiler waits for a created reference before non-create property work", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const owner = node("owner", {
    parentIdentity: identity("root"),
    path: "Workspace/Owner",
    name: "Owner",
  });
  const moved = node("moved", {
    parentIdentity: identity("root"),
    path: "Workspace/Moved",
    name: "Moved",
  });
  const created = create("z-create-reference-target", "created", target("root", "Workspace"));
  const newReference = {
    kind: "instance_ref" as const,
    state: "reference" as const,
    identity: identity("created"),
    path: "Workspace/created",
    className: "Folder",
    expectedClass: "Instance",
  };
  const projection = compileCreatorTransactionTopology({
    initial: [root, owner, moved],
    operations: [
      {
        id: "a-update-reference",
        kind: "update",
        target: target("owner", "Workspace/Owner"),
        properties: { Linked: newReference },
      },
      {
        id: "b-move-reference",
        kind: "move",
        target: target("moved", "Workspace/Moved"),
        parent: target("root", "Workspace"),
        name: "MovedAgain",
        properties: { Linked: newReference },
      },
      created,
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, [
    "z-create-reference-target",
    "a-update-reference",
    "b-move-reference",
  ]);
});

test("topology compiler requires covered inbound instance_ref values to be cleared before delete", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const deleted = node("deleted", { parentIdentity: identity("root") });
  const owner = node("owner", {
    parentIdentity: identity("root"),
    properties: {
      Linked: {
        kind: "instance_ref",
        state: "reference",
        identity: identity("deleted"),
        path: "Workspace/deleted",
        className: "Folder",
        expectedClass: "Instance",
      },
    },
  });
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root, deleted, owner],
        operations: [remove("delete-target", "deleted")],
      }),
    /covered inbound instance_ref/,
  );
  const projection = compileCreatorTransactionTopology({
    initial: [root, deleted, owner],
    operations: [
      remove("a-delete-target", "deleted"),
      {
        id: "z-clear-reference",
        kind: "update",
        target: target("owner"),
        properties: {
          Linked: { kind: "instance_ref", state: "nil", expectedClass: "Instance" },
        },
      },
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, ["z-clear-reference", "a-delete-target"]);
});

test("topology compiler orders a delete before a replacement sibling creation", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const prior = node("prior", { parentIdentity: identity("root"), name: "Shared" });
  const projection = compileCreatorTransactionTopology({
    initial: [root, prior],
    operations: [
      create("create-replacement", "replacement", parent("root"), "Shared"),
      remove("delete-prior", "prior"),
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, ["delete-prior", "create-replacement"]);
});

test("replacement waits for every duplicate sibling even when an occupant has another dependency", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const siblings = ["first", "second"].map((id) =>
    node(id, { parentIdentity: identity("root"), path: "Workspace/Shared", name: "Shared" }),
  );
  const destination = target("destination", "Workspace/Destination");
  const first = {
    ...move("a-free-first", "first", parent("root"), "First"),
    target: target("first", "Workspace/Shared"),
  };
  const second = {
    ...move("z-free-second", "second", destination, "Second"),
    target: target("second", "Workspace/Shared"),
  };
  const createDestination = create(
    "c-create-destination",
    "destination",
    parent("root"),
    "Destination",
  );
  const replacement = create("b-create-replacement", "replacement", parent("root"), "Shared");
  for (const order of [siblings, [...siblings].reverse()]) {
    const initial = [root, ...order];
    const operations = [first, createDestination, replacement, second];
    const topology = compileCreatorTransactionTopology({ initial, operations });
    assert.deepEqual(topology.orderedOperationIds, [
      "a-free-first",
      "c-create-destination",
      "z-free-second",
      "b-create-replacement",
    ]);
    assert.throws(
      () => assertCreatorTransactionTopologyOrder({ initial, operations }),
      /canonical safe topology order/,
    );
  }
});

test("topology compiler recomputes descendant display paths after a parent move", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const moved = node("moved", {
    parentIdentity: identity("root"),
    path: "Workspace/OldParent",
    name: "OldParent",
  });
  const descendant = node("descendant", {
    parentIdentity: identity("moved"),
    path: "Workspace/OldParent/Descendant",
    name: "Descendant",
  });
  const projection = compileCreatorTransactionTopology({
    initial: [root, moved, descendant],
    operations: [
      {
        id: "move-parent",
        kind: "move",
        target: target("moved", "Workspace/OldParent"),
        parent: target("root", "Workspace"),
        name: "NewParent",
        properties: emptyProperties,
      },
      {
        id: "create-under-moved-parent",
        kind: "create",
        target: target("created-descendant", "Workspace/NewParent/CreatedDescendant"),
        // The parent display path remains descriptive pre-transaction data.
        // Its opaque identity determines the final child path.
        parent: target("moved", "Workspace/OldParent"),
        name: "CreatedDescendant",
        properties: emptyProperties,
      },
    ],
  });
  assert.deepEqual(projection.orderedOperationIds, ["create-under-moved-parent", "move-parent"]);
  assert.throws(
    () =>
      assertCreatorTransactionTopologyOrder({
        initial: [root, moved, descendant],
        operations: [
          {
            id: "move-parent",
            kind: "move",
            target: target("moved", "Workspace/OldParent"),
            parent: target("root", "Workspace"),
            name: "NewParent",
            properties: emptyProperties,
          },
          {
            id: "create-under-moved-parent",
            kind: "create",
            target: target("created-descendant", "Workspace/NewParent/CreatedDescendant"),
            parent: target("moved", "Workspace/OldParent"),
            name: "CreatedDescendant",
            properties: emptyProperties,
          },
        ],
      }),
    /canonical safe topology order/,
  );
  assert.deepEqual(
    creatorTransactionFinalTargetForOriginalIdentity(projection, identity("moved")),
    {
      kind: "instance",
      identity: identity("moved"),
      path: "Workspace/NewParent",
      className: "Folder",
    },
  );
  assert.deepEqual(
    creatorTransactionFinalTargetForOriginalIdentity(projection, identity("descendant")),
    {
      kind: "instance",
      identity: identity("descendant"),
      path: "Workspace/NewParent/Descendant",
      className: "Folder",
    },
  );
  assert.equal(
    creatorTransactionFinalTargetForOriginalIdentity(projection, identity("created-descendant"))
      ?.path,
    "Workspace/NewParent/CreatedDescendant",
  );
});

test("topology compiler closes an ancestor move after descendant and reference work", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const moved = node("moved", {
    parentIdentity: identity("root"),
    path: "Workspace/OldParent",
    name: "OldParent",
  });
  const descendant = node("descendant", {
    parentIdentity: identity("moved"),
    path: "Workspace/OldParent/Descendant",
    name: "Descendant",
  });
  const owner = node("owner", {
    parentIdentity: identity("root"),
    path: "Workspace/Owner",
    name: "Owner",
  });
  const operations: CreatorTransactionTopologyOperation[] = [
    {
      id: "move-parent",
      kind: "move",
      target: target("moved", "Workspace/OldParent"),
      parent: target("root", "Workspace"),
      name: "NewParent",
      properties: emptyProperties,
    },
    {
      id: "update-descendant",
      kind: "update",
      target: target("descendant", "Workspace/OldParent/Descendant"),
      properties: {},
    },
    {
      id: "reference-descendant",
      kind: "update",
      target: target("owner", "Workspace/Owner"),
      properties: {
        Linked: {
          kind: "instance_ref",
          state: "reference",
          identity: identity("descendant"),
          path: "Workspace/OldParent/Descendant",
          className: "Folder",
          expectedClass: "Instance",
        },
      },
    },
  ];
  const projection = compileCreatorTransactionTopology({
    initial: [root, moved, descendant, owner],
    operations,
  });
  assert.deepEqual(projection.orderedOperationIds, [
    "reference-descendant",
    "update-descendant",
    "move-parent",
  ]);
});

test("topology compiler validates create paths against a new parent's final path", () => {
  const root = node("root", { path: "Workspace", name: "Workspace" });
  const newParent = create("create-parent", "new-parent", target("root", "Workspace"), "NewParent");
  const newChild = create(
    "create-child",
    "new-child",
    target("new-parent", "Workspace/NewParent"),
    "NewChild",
  );
  const projection = compileCreatorTransactionTopology({
    initial: [root],
    operations: [newChild, newParent],
  });
  assert.deepEqual(projection.orderedOperationIds, ["create-parent", "create-child"]);
  assert.equal(
    creatorTransactionFinalTargetForOriginalIdentity(projection, identity("new-child"))?.path,
    "Workspace/NewParent/NewChild",
  );
  assert.throws(
    () =>
      compileCreatorTransactionTopology({
        initial: [root],
        operations: [
          newParent,
          {
            ...newChild,
            id: "create-child-wrong-path",
            target: target("new-child-wrong-path", "Workspace/Wrong"),
          },
        ],
      }),
    /contradictory create target path/,
  );
});
