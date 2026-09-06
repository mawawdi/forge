import {
  studioObjectIdentityKey,
  type StudioObjectIdentity,
  type StudioObservedPropertyValue,
  type StudioValue,
} from "../../studio-evidence/src/index.js";

/**
 * The structural portion of a complete pre-Prepare project index. Identity is
 * the authority handle; paths are descriptive and intentionally not used to
 * resolve parent edges.
 */
export interface CreatorTransactionTopologyNode {
  readonly identity: StudioObjectIdentity;
  readonly parentIdentity?: StudioObjectIdentity;
  readonly path: string;
  readonly name: string;
  readonly className: string;
  readonly engineContainer?: {
    readonly path: string;
    readonly className: string;
  };
  /** Only captured properties are relevant to inbound Instance references. */
  readonly properties?: Readonly<Record<string, StudioObservedPropertyValue>>;
}

export interface CreatorTransactionTopologyTarget {
  readonly kind: "instance";
  readonly identity: StudioObjectIdentity;
  readonly path: string;
  readonly className: string;
}

export type CreatorTransactionTopologyParent =
  | CreatorTransactionTopologyTarget
  | {
      readonly kind: "engine_container";
      readonly path: string;
      readonly className: string;
    };

/**
 * The minimal sealed-operation surface needed to calculate structural safety.
 * CreatorChangeSet and the mutation projection operation type both satisfy
 * this contract without introducing a runtime dependency on either module.
 */
export type CreatorTransactionTopologyOperation =
  | {
      readonly id: string;
      readonly kind: "create";
      readonly target: CreatorTransactionTopologyTarget;
      readonly parent: CreatorTransactionTopologyParent;
      readonly name: string;
      readonly properties: Readonly<Record<string, StudioValue>>;
    }
  | {
      readonly id: string;
      readonly kind: "update";
      readonly target: CreatorTransactionTopologyTarget;
      readonly properties: Readonly<Record<string, StudioValue>>;
    }
  | {
      readonly id: string;
      readonly kind: "move";
      readonly target: CreatorTransactionTopologyTarget;
      readonly parent: CreatorTransactionTopologyParent;
      readonly name: string;
      readonly properties: Readonly<Record<string, StudioValue>>;
    }
  | {
      readonly id: string;
      readonly kind: "delete";
      readonly target: CreatorTransactionTopologyTarget;
    }
  | {
      readonly id: string;
      readonly kind: "edit_source";
      readonly target: CreatorTransactionTopologyTarget;
    };

export interface CreatorTransactionTopologyInput<
  TOperation extends CreatorTransactionTopologyOperation = CreatorTransactionTopologyOperation,
> {
  /** Complete, identity-keyed project topology captured before Prepare. */
  readonly initial: readonly CreatorTransactionTopologyNode[];
  readonly operations: readonly TOperation[];
}

export interface CreatorTransactionTopologyFinalNode {
  /** The identity used to address this node before the transaction. */
  readonly originalIdentity: StudioObjectIdentity;
  readonly originalIdentityKey: string;
  /** The post-transaction identity, which may reflect an enrollment. */
  readonly identity: StudioObjectIdentity;
  readonly parentIdentity?: StudioObjectIdentity;
  readonly path: string;
  readonly name: string;
  readonly className: string;
  readonly properties: Readonly<Record<string, StudioObservedPropertyValue>>;
}

export interface CreatorTransactionTopologyProjection<
  TOperation extends CreatorTransactionTopologyOperation = CreatorTransactionTopologyOperation,
> {
  /** A deterministic order that never observes a transient invalid topology. */
  readonly orderedOperations: readonly TOperation[];
  readonly orderedOperationIds: readonly string[];
  /** Exact constraints used by the fixed transaction ordering, before canonical tie-breaking. */
  readonly dependencyEdges: readonly {
    readonly operationId: string;
    readonly dependencyId: string;
  }[];
  /** Final live nodes, sorted by identity key. */
  readonly finalNodes: readonly CreatorTransactionTopologyFinalNode[];
  /** Every identity removed by an authored delete, including descendants. */
  readonly deletedIdentityKeys: readonly string[];
}

interface MutableTopologyNode {
  readonly originalIdentity: StudioObjectIdentity;
  readonly identity: StudioObjectIdentity;
  readonly identityKey: string;
  path: string;
  readonly className: string;
  parentKey?: string;
  name: string;
  properties: Readonly<Record<string, StudioObservedPropertyValue>>;
}

/**
 * Simulate all structural operations as one transaction. The result has a
 * canonical topological ordering; callers that seal a change set should
 * require that its supplied order already matches this ordering.
 */
export function compileCreatorTransactionTopology<
  TOperation extends CreatorTransactionTopologyOperation,
>(
  input: CreatorTransactionTopologyInput<TOperation>,
): CreatorTransactionTopologyProjection<TOperation> {
  const initial = new Map<string, MutableTopologyNode>();
  const engineParents = new Map<string, string>();
  for (const node of input.initial) {
    const identityKey = identityKeyFor(node.identity, "Initial topology node");
    if (initial.has(identityKey))
      throw new Error(`Creator transaction topology has duplicate initial identity ${identityKey}`);
    const parentKey =
      node.parentIdentity === undefined
        ? undefined
        : identityKeyFor(node.parentIdentity, "Initial topology parent");
    initial.set(identityKey, {
      identity: node.identity,
      originalIdentity: node.identity,
      identityKey,
      path: node.path,
      className: node.className,
      ...(parentKey === undefined ? {} : { parentKey }),
      name: node.name,
      properties: node.properties ?? {},
    });
    if (node.engineContainer !== undefined) {
      const engineKey = engineParentKey(node.engineContainer.path, node.engineContainer.className);
      if (engineParents.has(engineKey))
        throw new Error("Creator transaction topology has duplicate engine-container identities");
      engineParents.set(engineKey, identityKey);
    }
  }
  assertParentsExist(initial, "initial");
  assertAcyclic(initial, "initial");
  // Studio permits duplicate sibling names. Initial topology is addressed by
  // opaque identity, so an already-ambiguous display path is observable but
  // not itself a mutation error. The final-state collision check below still
  // rejects a collision introduced by an approved create or move.

  const operationById = new Map<string, TOperation>();
  const operationByTarget = new Map<string, TOperation>();
  for (const operation of input.operations) {
    if (typeof operation.id !== "string" || operation.id.length === 0)
      throw new Error("Creator transaction topology operation ID is invalid");
    if (operationById.has(operation.id))
      throw new Error(`Creator transaction topology has duplicate operation ID ${operation.id}`);
    const targetKey = targetKeyFor(operation.target, operation.id);
    if (operationByTarget.has(targetKey))
      throw new Error(
        `Creator transaction topology permits only one operation per identity (${targetKey})`,
      );
    operationById.set(operation.id, operation);
    operationByTarget.set(targetKey, operation);
  }

  const nodes = cloneNodes(initial);
  const placementByOperation = new Map<string, { parentKey: string; name: string }>();
  for (const operation of input.operations) {
    const targetKey = targetKeyFor(operation.target, operation.id);
    if (operation.kind === "create") {
      if (nodes.has(targetKey))
        throw new Error(`Creator transaction create identity already exists (${targetKey})`);
      const parentKey = parentKeyFor(operation.parent, engineParents, operation.id);
      nodes.set(targetKey, {
        originalIdentity: operation.target.identity,
        identity: operation.target.identity,
        identityKey: targetKey,
        path: operation.target.path,
        className: operation.target.className,
        parentKey,
        name: operation.name,
        properties: operation.properties,
      });
      placementByOperation.set(operation.id, { parentKey, name: operation.name });
      continue;
    }

    const node = nodes.get(targetKey);
    if (!node)
      throw new Error(
        `Creator transaction target is absent from the pre-Prepare index (${targetKey})`,
      );
    switch (operation.kind) {
      case "update":
        node.properties = { ...node.properties, ...operation.properties };
        break;
      case "move": {
        const parentKey = parentKeyFor(operation.parent, engineParents, operation.id);
        node.parentKey = parentKey;
        node.name = operation.name;
        node.properties = { ...node.properties, ...operation.properties };
        placementByOperation.set(operation.id, { parentKey, name: operation.name });
        break;
      }
      case "delete":
      case "edit_source":
        break;
    }
  }
  assertParentsExist(nodes, "final");
  assertAcyclic(nodes, "final");
  recomputeFinalPaths(nodes);
  assertSuppliedStructuralPaths(input.operations, initial, nodes);
  assertSuppliedStructuralParents(input.operations, initial, nodes);
  assertSuppliedInstanceReferences(input.operations, initial, nodes);

  const deleteOperations = input.operations.filter(
    (operation): operation is Extract<TOperation, { readonly kind: "delete" }> =>
      operation.kind === "delete",
  );
  const deletedByIdentity = new Map<string, string>();
  for (const operation of deleteOperations) {
    const deleteKey = targetKeyFor(operation.target, operation.id);
    for (const candidateKey of descendantKeys(deleteKey, nodes)) {
      const previous = deletedByIdentity.get(candidateKey);
      if (previous !== undefined && previous !== operation.id)
        throw new Error(
          `Creator transaction delete dependencies overlap (${previous} and ${operation.id})`,
        );
      deletedByIdentity.set(candidateKey, operation.id);
    }
  }
  for (const operation of deleteOperations) {
    const deleteKey = targetKeyFor(operation.target, operation.id);
    for (const candidate of input.operations) {
      if (candidate.id === operation.id) continue;
      const candidateKey = targetKeyFor(candidate.target, candidate.id);
      // A single transaction may extract an initial descendant before its
      // former ancestor is deleted. Only final containment makes a separate
      // operation meaningless or unsafe. The dependency below forces every
      // such extraction to finish before this delete runs.
      if (isWithin(candidateKey, deleteKey, nodes))
        throw new Error(
          `Creator transaction operation ${candidate.id} acts inside deleted subtree ${deleteKey}`,
        );
      const placement = placementByOperation.get(candidate.id);
      if (placement !== undefined && isWithin(placement.parentKey, deleteKey, nodes))
        throw new Error(
          `Creator transaction operation ${candidate.id} is placed inside deleted subtree ${deleteKey}`,
        );
    }
  }

  assertFinalPlacementsDoNotCollide(
    nodes,
    new Set(deletedByIdentity.keys()),
    placementByOperation,
    operationById,
  );
  assertNoInboundReferencesToDeletedNodes(nodes, deletedByIdentity);

  const dependencies = new Map<string, Set<string>>(
    input.operations.map((operation) => [operation.id, new Set<string>()]),
  );
  const addDependency = (operationId: string, dependencyId: string): void => {
    if (operationId !== dependencyId) dependencies.get(operationId)!.add(dependencyId);
  };

  for (const operation of input.operations) {
    if (operation.kind === "create" || operation.kind === "move") {
      const parentKey = placementByOperation.get(operation.id)!.parentKey;
      const parentOperation = operationByTarget.get(parentKey);
      if (parentOperation?.kind === "create") addDependency(operation.id, parentOperation.id);
    }
    // StudioAuthoring allocates and registers every created object before it
    // applies create properties, so create-to-create references (including
    // self and mutual references) carry no ordering edge. A later mutation of
    // an existing object still executes in canonical operation order and must
    // wait until its referenced created target has been allocated.
    if (operation.kind !== "create") {
      for (const referenceKey of operationReferenceKeys(operation)) {
        const referencedCreate = operationByTarget.get(referenceKey);
        if (referencedCreate?.kind === "create") addDependency(operation.id, referencedCreate.id);
      }
    }
  }

  // A delete may follow a move that extracts an initially nested subtree. The
  // move is the moment that makes the surviving final topology real, so the
  // delete must wait for it. The ordinary ancestor-move dependencies above
  // already make that extraction move wait for any path-sensitive work in the
  // extracted subtree.
  for (const deleteOperation of deleteOperations) {
    const deleteKey = targetKeyFor(deleteOperation.target, deleteOperation.id);
    for (const candidate of input.operations) {
      if (candidate.kind !== "move") continue;
      const candidateKey = targetKeyFor(candidate.target, candidate.id);
      if (isWithin(candidateKey, deleteKey, initial) && !isWithin(candidateKey, deleteKey, nodes))
        addDependency(deleteOperation.id, candidate.id);
    }
  }

  // Every operation is validated against its exact pre-transaction target and
  // parent path immediately before the recording opens. Once an ancestor move
  // executes, those descriptive preconditions change even though the opaque
  // identities remain the same. Therefore all work in, into, or referring to
  // that subtree must execute first; the ancestor move is the closing step.
  for (const mover of input.operations) {
    if (mover.kind !== "move") continue;
    const moverKey = targetKeyFor(mover.target, mover.id);
    for (const candidate of input.operations) {
      if (candidate.id === mover.id) continue;
      const candidateKey = targetKeyFor(candidate.target, candidate.id);
      const placement = placementByOperation.get(candidate.id);
      const pathSensitive =
        isWithin(candidateKey, moverKey, initial) ||
        isWithin(candidateKey, moverKey, nodes) ||
        (placement !== undefined &&
          (isWithin(placement.parentKey, moverKey, initial) ||
            isWithin(placement.parentKey, moverKey, nodes))) ||
        operationReferenceKeys(candidate).some(
          (referenceKey) =>
            isWithin(referenceKey, moverKey, initial) || isWithin(referenceKey, moverKey, nodes),
        );
      if (pathSensitive) addDependency(mover.id, candidate.id);
    }
  }

  const initialSiblings = indexSiblings(initial);
  for (const [operationId, placement] of placementByOperation) {
    const operation = operationById.get(operationId)!;
    const targetKey = targetKeyFor(operation.target, operation.id);
    // An observed slot may contain several opaque identities. Every occupant
    // must leave before a replacement can be materialized in that slot.
    for (const occupant of initialSiblings.get(placement.parentKey)?.get(placement.name) ?? []) {
      if (occupant === targetKey) continue;
      const freeingOperation = operationThatFreesNode(
        occupant,
        initial,
        nodes,
        operationByTarget,
        deletedByIdentity,
      );
      if (!freeingOperation)
        throw new Error(
          `Creator transaction final sibling name collision at ${placement.parentKey}/${placement.name}`,
        );
      addDependency(operationId, freeingOperation);
    }
  }

  for (const [nodeKey, initialNode] of initial) {
    if (deletedByIdentity.has(nodeKey)) continue;
    for (const [propertyName, value] of Object.entries(initialNode.properties)) {
      const referenceKey = instanceReferenceKey(value);
      if (referenceKey === undefined || !deletedByIdentity.has(referenceKey)) continue;
      const updater = operationByTarget.get(nodeKey);
      if (!updater || (updater.kind !== "update" && updater.kind !== "move"))
        throw new Error(
          `Creator transaction leaves covered inbound instance_ref ${nodeKey}.${propertyName} to deleted identity ${referenceKey}`,
        );
      addDependency(deletedByIdentity.get(referenceKey)!, updater.id);
    }
  }

  const orderedOperationIds = canonicalTopologicalOrder(dependencies);
  const orderedOperations = orderedOperationIds.map((operationId) =>
    operationById.get(operationId)!,
  );
  const finalNodes = [...nodes.values()]
    .filter((node) => !deletedByIdentity.has(node.identityKey))
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
    .map((node) => {
      const parent = node.parentKey === undefined ? undefined : nodes.get(node.parentKey);
      return {
        originalIdentity: node.originalIdentity,
        originalIdentityKey: node.identityKey,
        identity: node.identity,
        ...(parent === undefined ? {} : { parentIdentity: parent.identity }),
        path: node.path,
        name: node.name,
        className: node.className,
        properties: node.properties,
      };
    });
  return Object.freeze({
    orderedOperations: Object.freeze(orderedOperations),
    orderedOperationIds: Object.freeze(orderedOperationIds),
    dependencyEdges: Object.freeze(
      [...dependencies]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([operationId, required]) =>
          [...required].sort().map((dependencyId) => Object.freeze({ operationId, dependencyId })),
        ),
    ),
    finalNodes: Object.freeze(finalNodes),
    deletedIdentityKeys: Object.freeze([...deletedByIdentity.keys()].sort()),
  });
}

/**
 * Resolve an operation's original identity to the exact post-transaction
 * instance target. Deleted identities intentionally have no final target.
 */
export function creatorTransactionFinalTargetForOriginalIdentity(
  projection: Pick<CreatorTransactionTopologyProjection, "finalNodes">,
  originalIdentity: StudioObjectIdentity,
): CreatorTransactionTopologyTarget | undefined {
  const originalIdentityKey = identityKeyFor(
    originalIdentity,
    "Creator transaction final-target lookup",
  );
  const node = projection.finalNodes.find(
    (candidate) => candidate.originalIdentityKey === originalIdentityKey,
  );
  if (!node) return undefined;
  return {
    kind: "instance",
    identity: node.identity,
    path: node.path,
    className: node.className,
  };
}

/** Reject a sealed operation list whose order differs from the canonical safe order. */
export function assertCreatorTransactionTopologyOrder<
  TOperation extends CreatorTransactionTopologyOperation,
>(input: CreatorTransactionTopologyInput<TOperation>): void {
  const projection = compileCreatorTransactionTopology(input);
  const submittedIds = input.operations.map((operation) => operation.id);
  if (submittedIds.join("\u0000") !== projection.orderedOperationIds.join("\u0000"))
    throw new Error("Creator transaction operations are not in canonical safe topology order");
}

function identityKeyFor(identity: StudioObjectIdentity, label: string): string {
  try {
    return studioObjectIdentityKey(identity);
  } catch {
    throw new Error(`${label} has an invalid Studio identity`);
  }
}

function targetKeyFor(target: CreatorTransactionTopologyTarget, operationId: string): string {
  if (target.kind !== "instance")
    throw new Error(`Creator transaction operation ${operationId} has a non-instance target`);
  return identityKeyFor(target.identity, `Creator transaction operation ${operationId}`);
}

function engineParentKey(path: string, className: string): string {
  return `${path}\u0000${className}`;
}

function parentKeyFor(
  parent: CreatorTransactionTopologyParent,
  engineParents: ReadonlyMap<string, string>,
  operationId: string,
): string {
  if (parent.kind === "instance") return targetKeyFor(parent, operationId);
  const parentKey = engineParents.get(engineParentKey(parent.path, parent.className));
  if (!parentKey)
    throw new Error(`Creator transaction engine parent is missing for operation ${operationId}`);
  return parentKey;
}

function cloneNodes(
  nodes: ReadonlyMap<string, MutableTopologyNode>,
): Map<string, MutableTopologyNode> {
  return new Map(
    [...nodes].map(([identityKey, node]) => [
      identityKey,
      { ...node, properties: { ...node.properties } },
    ]),
  );
}

function recomputeFinalPaths(nodes: ReadonlyMap<string, MutableTopologyNode>): void {
  const resolved = new Set<string>();
  const resolvePath = (identityKey: string): string => {
    const node = nodes.get(identityKey);
    if (!node) throw new Error(`Creator transaction final topology lost ${identityKey}`);
    if (resolved.has(identityKey)) return node.path;
    if (node.parentKey !== undefined) node.path = `${resolvePath(node.parentKey)}/${node.name}`;
    resolved.add(identityKey);
    return node.path;
  };
  for (const identityKey of [...nodes.keys()].sort()) resolvePath(identityKey);
}

function assertSuppliedStructuralPaths<TOperation extends CreatorTransactionTopologyOperation>(
  operations: readonly TOperation[],
  initial: ReadonlyMap<string, MutableTopologyNode>,
  final: ReadonlyMap<string, MutableTopologyNode>,
): void {
  for (const operation of operations) {
    const targetKey = targetKeyFor(operation.target, operation.id);
    if (operation.kind === "create") {
      const finalTarget = final.get(targetKey);
      if (!finalTarget || operation.target.path !== finalTarget.path)
        throw new Error(
          `Creator transaction has a contradictory create target path for ${operation.id}`,
        );
      continue;
    }
    const initialTarget = initial.get(targetKey);
    if (
      !initialTarget ||
      operation.target.path !== initialTarget.path ||
      operation.target.className !== initialTarget.className
    )
      throw new Error(
        `Creator transaction has a contradictory ${operation.kind} target path for ${operation.id}`,
      );
  }
}

/**
 * A parent is an exact structural precondition, not a convenient identity
 * lookup. Existing parents retain their immutable pre-Apply path/class;
 * virtual created parents use their calculated final path/class. This mirrors
 * the two host resolution branches and keeps display paths descriptive without
 * allowing a forged path or class to cross the transaction boundary.
 */
function assertSuppliedStructuralParents<TOperation extends CreatorTransactionTopologyOperation>(
  operations: readonly TOperation[],
  initial: ReadonlyMap<string, MutableTopologyNode>,
  final: ReadonlyMap<string, MutableTopologyNode>,
): void {
  for (const operation of operations) {
    if (
      (operation.kind !== "create" && operation.kind !== "move") ||
      operation.parent.kind !== "instance"
    )
      continue;
    const parentKey = targetKeyFor(operation.parent, operation.id);
    const expected = initial.get(parentKey) ?? final.get(parentKey);
    if (
      expected === undefined ||
      operation.parent.path !== expected.path ||
      operation.parent.className !== expected.className
    )
      throw new Error(
        `Creator transaction has a contradictory ${operation.kind} parent path for ${operation.id}`,
      );
  }
}

/**
 * Instance references are similarly exact handles. Initial objects are named
 * by their pre-Apply target (even if another operation later moves or enrolls
 * them); a transaction-created object is named by its calculated final target.
 */
function assertSuppliedInstanceReferences<TOperation extends CreatorTransactionTopologyOperation>(
  operations: readonly TOperation[],
  initial: ReadonlyMap<string, MutableTopologyNode>,
  final: ReadonlyMap<string, MutableTopologyNode>,
): void {
  for (const operation of operations) {
    for (const value of operationPropertyValues(operation)) {
      if (value.kind !== "instance_ref" || value.state !== "reference") continue;
      const referenceKey = identityKeyFor(value.identity, "Creator transaction instance_ref");
      const expected = initial.get(referenceKey) ?? final.get(referenceKey);
      if (
        expected === undefined ||
        value.path !== expected.path ||
        value.className !== expected.className
      )
        throw new Error(
          `Creator transaction instance_ref has a contradictory target for ${operation.id}`,
        );
    }
  }
}

function assertParentsExist(nodes: ReadonlyMap<string, MutableTopologyNode>, phase: string): void {
  for (const node of nodes.values()) {
    if (node.parentKey !== undefined && !nodes.has(node.parentKey))
      throw new Error(
        `Creator transaction ${phase} topology has an unresolved parent for ${node.identityKey}`,
      );
  }
}

function assertAcyclic(nodes: ReadonlyMap<string, MutableTopologyNode>, phase: string): void {
  const complete = new Set<string>();
  for (const start of nodes.keys()) {
    if (complete.has(start)) continue;
    const visiting = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !complete.has(cursor)) {
      if (visiting.has(cursor))
        throw new Error(
          `Creator transaction ${phase} topology contains a parent cycle at ${cursor}`,
        );
      visiting.add(cursor);
      cursor = nodes.get(cursor)?.parentKey;
    }
    for (const key of visiting) complete.add(key);
  }
}

/**
 * Existing Studio documents may already contain duplicate sibling names. A
 * transaction may preserve them because every target is identity-addressed,
 * but it may not create or move a target into any occupied final slot.
 */
function assertFinalPlacementsDoNotCollide<TOperation extends CreatorTransactionTopologyOperation>(
  nodes: ReadonlyMap<string, MutableTopologyNode>,
  deleted: ReadonlySet<string>,
  placements: ReadonlyMap<string, { readonly parentKey: string; readonly name: string }>,
  operationsById: ReadonlyMap<string, TOperation>,
): void {
  const siblings = indexSiblings(nodes, deleted);
  for (const [operationId, placement] of placements) {
    const operation = operationsById.get(operationId);
    if (!operation) throw new Error(`Creator transaction lost placement operation ${operationId}`);
    const targetKey = targetKeyFor(operation.target, operation.id);
    const collision = findSibling(siblings, placement.parentKey, placement.name, targetKey);
    if (collision !== undefined)
      throw new Error(
        `Creator transaction final sibling name collision (${targetKey} and ${collision})`,
      );
  }
}

function descendantKeys(
  rootKey: string,
  nodes: ReadonlyMap<string, MutableTopologyNode>,
): readonly string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentKey === undefined) continue;
    children.set(node.parentKey, [...(children.get(node.parentKey) ?? []), node.identityKey]);
  }
  const result: string[] = [];
  const queue = [rootKey];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    queue.push(...(children.get(current) ?? []).sort());
  }
  return result;
}

function isDescendantOf(
  nodeKey: string,
  ancestorKey: string,
  nodes: ReadonlyMap<string, MutableTopologyNode>,
): boolean {
  let cursor = nodes.get(nodeKey)?.parentKey;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === ancestorKey) return true;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.parentKey;
  }
  return false;
}

function isWithin(
  nodeKey: string,
  ancestorKey: string,
  nodes: ReadonlyMap<string, MutableTopologyNode>,
): boolean {
  return nodeKey === ancestorKey || isDescendantOf(nodeKey, ancestorKey, nodes);
}

function instanceReferenceKey(value: StudioObservedPropertyValue): string | undefined {
  if (value.kind !== "instance_ref" || value.state !== "reference") return undefined;
  return identityKeyFor(value.identity, "Creator transaction instance_ref");
}

function assertNoInboundReferencesToDeletedNodes(
  nodes: ReadonlyMap<string, MutableTopologyNode>,
  deletedByIdentity: ReadonlyMap<string, string>,
): void {
  for (const node of nodes.values()) {
    if (deletedByIdentity.has(node.identityKey)) continue;
    for (const [propertyName, value] of Object.entries(node.properties)) {
      const referenceKey = instanceReferenceKey(value);
      if (referenceKey !== undefined && deletedByIdentity.has(referenceKey))
        throw new Error(
          `Creator transaction leaves covered inbound instance_ref ${node.identityKey}.${propertyName} to deleted identity ${referenceKey}`,
        );
    }
  }
}

function operationReferenceKeys(operation: CreatorTransactionTopologyOperation): readonly string[] {
  return operationPropertyValues(operation).flatMap((value) => {
    const referenceKey = instanceReferenceKey(value);
    return referenceKey === undefined ? [] : [referenceKey];
  });
}

function operationPropertyValues(
  operation: CreatorTransactionTopologyOperation,
): readonly StudioValue[] {
  if (operation.kind === "delete" || operation.kind === "edit_source") return [];
  return Object.values(operation.properties);
}

type SiblingIndex = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

/** Preserve every identity in an occupied slot, including pre-existing duplicate names. */
function indexSiblings(
  nodes: ReadonlyMap<string, MutableTopologyNode>,
  excluded?: ReadonlySet<string>,
): SiblingIndex {
  const parents = new Map<string, Map<string, string[]>>();
  for (const node of nodes.values()) {
    if (node.parentKey === undefined || excluded?.has(node.identityKey)) continue;
    let names = parents.get(node.parentKey);
    if (!names) {
      names = new Map();
      parents.set(node.parentKey, names);
    }
    const occupants = names.get(node.name);
    if (occupants) occupants.push(node.identityKey);
    else names.set(node.name, [node.identityKey]);
  }
  return parents;
}

function findSibling(
  siblings: SiblingIndex,
  parentKey: string,
  name: string,
  exceptKey: string,
): string | undefined {
  return siblings
    .get(parentKey)
    ?.get(name)
    ?.find((key) => key !== exceptKey);
}

function operationThatFreesNode<TOperation extends CreatorTransactionTopologyOperation>(
  nodeKey: string,
  initial: ReadonlyMap<string, MutableTopologyNode>,
  final: ReadonlyMap<string, MutableTopologyNode>,
  operationByTarget: ReadonlyMap<string, TOperation>,
  deletedByIdentity: ReadonlyMap<string, string>,
): string | undefined {
  const deleteOperationId = deletedByIdentity.get(nodeKey);
  if (deleteOperationId !== undefined) return deleteOperationId;
  const operation = operationByTarget.get(nodeKey);
  if (operation?.kind !== "move") return undefined;
  const before = initial.get(nodeKey);
  const after = final.get(nodeKey);
  if (!before || !after || (before.parentKey === after.parentKey && before.name === after.name))
    return undefined;
  return operation.id;
}

function canonicalTopologicalOrder(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const remaining = new Map(
    [...dependencies].map(([operationId, operationDependencies]) => [
      operationId,
      new Set(operationDependencies),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const available = [...remaining]
      .filter(([, operationDependencies]) => operationDependencies.size === 0)
      .map(([operationId]) => operationId)
      .sort();
    if (available.length === 0)
      throw new Error("Creator transaction has no safe deterministic operation order");
    for (const operationId of available) {
      remaining.delete(operationId);
      ordered.push(operationId);
    }
    for (const operationDependencies of remaining.values()) {
      for (const operationId of available) operationDependencies.delete(operationId);
    }
  }
  return ordered;
}
