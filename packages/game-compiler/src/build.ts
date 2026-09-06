import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  CHANGE_OPERATION_SCHEMA,
  type StudioChangeOperation,
  type CreatorSourceWriteBlobBinding,
} from "../../creator-session/src/index.js";
import {
  compileCreatorTransactionTopology,
  type CreatorTransactionTopologyNode,
} from "../../creator-session/src/transaction-topology.js";
import {
  compileCreatorChangeSetMutationProjection,
  type CreatorChangeSetDeleteSubtree,
  type CreatorChangeSetStructuralParent,
} from "../../creator-session/src/mutation-evidence.js";
import {
  assertStudioValueForProperty,
  canonicalStudioValue,
  STUDIO_CAPABILITY_MANIFEST,
  studioObjectIdentityKey,
  type StudioEvidenceProjection,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import {
  createCreatorSourceWriteBlobCapture,
  type CreatorSourceWriteBlobCapture,
} from "../../studio-evidence/src/project-index.js";
import { gameDataMatchesSchema } from "../../game-ir/src/recipes.js";
import { gameActivationOperations } from "./activation.js";
import type { GameJsonValue } from "../../game-ir/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  assertBoundedGameJson,
} from "../../game-ir/src/primitives.js";
import { assertGamePlan, gameDependencyOrder, gameInventoryOperation, isHash } from "./plan.js";
import type {
  GameBuildArtifact,
  GameBuildGraph,
  GameBuildPartition,
  GameEvidenceTemplate,
  GamePlan,
} from "./types.js";

export interface GameSourceMaterial {
  readonly slotId: string;
  readonly source: string;
}
export interface GameValueMaterial {
  readonly slotId: string;
  readonly value: StudioValue;
}

export function materializeGameBuildGraph(input: {
  readonly plan: GamePlan;
  readonly acceptanceHash: string;
  readonly values: readonly GameValueMaterial[];
  readonly sources: readonly GameSourceMaterial[];
  readonly checks: GameBuildGraph["localChecks"];
}): { graph: GameBuildGraph; sourceWriteBlobs: CreatorSourceWriteBlobCapture[] } {
  assertGamePlan(input.plan);
  if (!isHash(input.acceptanceHash))
    throw new Error("Build requires an exact creator acceptance artifact hash");
  const values = new Map(input.values.map((entry) => [entry.slotId, entry.value]));
  const sources = new Map(input.sources.map((entry) => [entry.slotId, entry.source]));
  if (values.size !== input.values.length || sources.size !== input.sources.length)
    throw new Error("Duplicate build slot material");
  const sourceWriteBlobs = new Map<string, CreatorSourceWriteBlobCapture>();
  const operations: StudioChangeOperation[] = [];
  let sourceBytes = 0;
  for (const item of input.plan.inventory) {
    let operation = gameInventoryOperation(input.plan, item);
    if (operation.kind === "create" || operation.kind === "update" || operation.kind === "move") {
      for (const slot of item.valueSlots) {
        const supplied = values.get(slot.id);
        if (supplied === undefined) throw new Error("Missing required value slot " + slot.id);
        const value = canonicalStudioValue(supplied);
        if (!gameDataMatchesSchema(value as unknown as GameJsonValue, slot.schema))
          throw new Error("Value slot violates its approved schema: " + slot.id);
        const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find(
          (entry) => entry.name === operation.target.className,
        )!;
        const property = manifestClass.properties.find(
          (entry) => entry.name === slot.propertyName,
        )!;
        assertStudioValueForProperty(value, property);
        operation.properties[slot.propertyName] = value;
        values.delete(slot.id);
      }
    }
    if (item.source) {
      const source = sources.get(item.id);
      if (typeof source !== "string") throw new Error("Missing source material for " + item.id);
      const byteCount = Buffer.byteLength(source, "utf8");
      if (Buffer.from(source, "utf8").toString("utf8") !== source)
        throw new Error("Source contains invalid Unicode");
      const content = item.source.content;
      if (
        content.kind === "locked"
          ? contentHash(source) !== content.sourceHash || byteCount !== content.utf8Bytes
          : byteCount > content.maximumUtf8Bytes
      )
        throw new Error("Source differs from its exact lock or exceeds approved source slot");
      sourceBytes += byteCount;
      if (sourceBytes > input.plan.policy.maximumSourceBytes)
        throw new Error("Whole candidate source budget exceeded");
      const capture = createCreatorSourceWriteBlobCapture({ source });
      sourceWriteBlobs.set(capture.manifest.hash, capture);
      const binding: CreatorSourceWriteBlobBinding = {
        manifestId: capture.manifest.id,
        manifestHash: capture.manifest.hash,
        sourceHash: capture.manifest.sourceHash,
        utf8Bytes: capture.manifest.utf8Bytes,
      };
      if (operation.kind === "create") operation.sourceBlob = binding;
      else if (operation.kind === "edit_source")
        operation = {
          ...operation,
          edits: [{ startByte: 0, endByte: item.beforeSourceBytes!, replacementBlob: binding }],
          finalSourceHash: binding.sourceHash,
          finalByteCount: binding.utf8Bytes,
        } as Extract<StudioChangeOperation, { kind: "edit_source" }>;
      else throw new Error("Source material has no exact script operation");
      sources.delete(item.id);
    }
    const parsed = CHANGE_OPERATION_SCHEMA.parse(operation);
    if (stableJson(parsed) !== stableJson(operation))
      throw new Error("Materialized operation is not canonical");
    operations.push(parsed as StudioChangeOperation);
  }
  if (values.size || sources.size)
    throw new Error("Build contains material outside approved slots");
  const ordered = compileCreatorTransactionTopology({
    initial: input.plan.initialTopology,
    operations,
  }).orderedOperations;
  const artifacts = gameBuildArtifacts(input.plan, ordered);
  const graphPayload = {
    kind: "GameBuildGraph" as const,
    planId: input.plan.id,
    planHash: input.plan.hash,
    acceptanceHash: input.acceptanceHash,
    observedRevisionHash: input.plan.observedRevisionHash,
    operations: ordered,
    sourceWriteBlobs: [...sourceWriteBlobs.values()]
      .map((capture) => ({
        manifestId: capture.manifest.id,
        manifestHash: capture.manifest.hash,
        sourceHash: capture.manifest.sourceHash,
        utf8Bytes: capture.manifest.utf8Bytes,
      }))
      .sort((a, b) => (a.manifestHash < b.manifestHash ? -1 : 1)),
    artifacts,
    partitions: compileGameBuildPartitions(input.plan, ordered, input.acceptanceHash),
    localChecks: {
      status: input.checks.status,
      artifactHashes: [...input.checks.artifactHashes].sort(),
    },
  };
  const hash = contentHash(stableJson(graphPayload));
  const graph: GameBuildGraph = {
    ...graphPayload,
    id: "game_build_graph_" + hash.slice(0, 24),
    hash,
  };
  assertGameBuildGraph(graph, input.plan);
  return { graph, sourceWriteBlobs: [...sourceWriteBlobs.values()] };
}

export function assertGameBuildGraph(
  value: unknown,
  plan: GamePlan,
): asserts value is GameBuildGraph {
  assertGamePlan(plan);
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: plan.policy.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
    maximumStringUtf8Bytes: plan.policy.maximumCanonicalBytes,
  });
  const graph = value as unknown as GameBuildGraph;
  if (
    !graph ||
    graph.kind !== "GameBuildGraph" ||
    graph.planId !== plan.id ||
    graph.planHash !== plan.hash ||
    graph.observedRevisionHash !== plan.observedRevisionHash ||
    !isHash(graph.acceptanceHash)
  )
    throw new Error("GameBuildGraph plan binding mismatch");
  const { id, hash, ...payload } = graph;
  const expected = contentHash(stableJson(payload));
  if (hash !== expected || id !== "game_build_graph_" + hash.slice(0, 24))
    throw new Error("GameBuildGraph identity mismatch");
  if (
    !["eligible", "rejected", "incomplete"].includes(graph.localChecks.status) ||
    !graph.localChecks.artifactHashes.every(isHash) ||
    new Set(graph.localChecks.artifactHashes).size !== graph.localChecks.artifactHashes.length
  )
    throw new Error("Invalid graph local-check evidence bindings");
  if (Buffer.byteLength(stableJson(graph), "utf8") > plan.policy.maximumCanonicalBytes)
    throw new Error("GameBuildGraph byte admission exceeded");
  if (
    graph.operations.length !== plan.inventory.length ||
    new Set(graph.operations.map((operation) => operation.planChangeId)).size !==
      graph.operations.length
  )
    throw new Error("Graph must cover the exact accepted inventory once");
  for (const operation of graph.operations) {
    CHANGE_OPERATION_SCHEMA.parse(operation);
    const item = plan.inventory.find((entry) => entry.id === operation.planChangeId);
    if (!item) throw new Error("Graph operation is outside accepted inventory");
    const base = gameInventoryOperation(plan, item);
    const operationHead = { ...operation } as Record<string, unknown>;
    const baseHead = { ...base } as Record<string, unknown>;
    for (const key of ["properties", "sourceBlob", "edits", "finalSourceHash", "finalByteCount"]) {
      delete operationHead[key];
      delete baseHead[key];
    }
    if (stableJson(operationHead) !== stableJson(baseHead))
      throw new Error("Graph changed an approved operation head");
    if (operation.kind === "create" || operation.kind === "update" || operation.kind === "move") {
      const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find(
        (entry) => entry.name === operation.target.className,
      )!;
      for (const [name, value] of Object.entries(operation.properties)) {
        const property = manifestClass.properties.find((entry) => entry.name === name);
        if (!property) throw new Error("Graph property is outside the manifest");
        assertStudioValueForProperty(value, property);
      }
      const allowed = new Set([
        ...Object.keys(item.lockedProperties),
        ...item.valueSlots.map((slot) => slot.propertyName),
      ]);
      if (
        Object.keys(operation.properties).length !== allowed.size ||
        Object.keys(operation.properties).some((name) => !allowed.has(name))
      )
        throw new Error("Graph changed approved value-slot coverage");
      for (const [name, locked] of Object.entries(item.lockedProperties))
        if (stableJson(operation.properties[name]) !== stableJson(locked))
          throw new Error("Graph changed locked property");
      for (const slot of item.valueSlots)
        if (
          !gameDataMatchesSchema(
            operation.properties[slot.propertyName] as unknown as GameJsonValue,
            slot.schema,
          )
        )
          throw new Error("Graph violates approved value slot");
    }
    if (item.source) {
      const binding =
        operation.kind === "create"
          ? operation.sourceBlob
          : operation.kind === "edit_source"
            ? operation.edits[0]?.replacementBlob
            : undefined;
      if (
        !binding ||
        !graph.sourceWriteBlobs.some((entry) => stableJson(entry) === stableJson(binding))
      )
        throw new Error("Graph source artifact closure is incomplete");
      if (
        item.source.content.kind === "locked"
          ? binding.sourceHash !== item.source.content.sourceHash ||
            binding.utf8Bytes !== item.source.content.utf8Bytes
          : binding.utf8Bytes > item.source.content.maximumUtf8Bytes
      )
        throw new Error("Graph source violates approved content authority");
      if (
        operation.kind === "edit_source" &&
        (operation.edits.length !== 1 ||
          operation.edits[0]!.startByte !== 0 ||
          operation.edits[0]!.endByte !== item.beforeSourceBytes ||
          operation.finalSourceHash !== binding.sourceHash ||
          operation.finalByteCount !== binding.utf8Bytes)
      )
        throw new Error("Graph source replacement is not exact");
    }
  }
  const usedBindings = new Map(
    graph.operations.flatMap((operation) => {
      const binding =
        operation.kind === "create"
          ? operation.sourceBlob
          : operation.kind === "edit_source"
            ? operation.edits[0]?.replacementBlob
            : undefined;
      return binding ? [[binding.manifestHash, binding] as const] : [];
    }),
  );
  if (
    usedBindings.size !== graph.sourceWriteBlobs.length ||
    graph.sourceWriteBlobs.some(
      (binding) => stableJson(usedBindings.get(binding.manifestHash)) !== stableJson(binding),
    )
  )
    throw new Error("Graph source closure contains duplicate or unreferenced blobs");
  if (stableJson(gameBuildArtifacts(plan, graph.operations)) !== stableJson(graph.artifacts))
    throw new Error("Graph content/provenance artifacts do not reproduce");
  const partitions = compileGameBuildPartitions(plan, graph.operations, graph.acceptanceHash);
  if (stableJson(partitions) !== stableJson(graph.partitions))
    throw new Error("Graph partition/evidence templates do not reproduce");
}

function gameBuildArtifacts(
  plan: GamePlan,
  operations: readonly StudioChangeOperation[],
): GameBuildArtifact[] {
  const operationHashes = new Map(
    operations.map((operation) => [operation.planChangeId, contentHash(stableJson(operation))]),
  );
  const sourceBindings = new Map<string, { sourceHash: string; utf8Bytes: number }>(
    operations.flatMap((operation) => {
      const binding =
        operation.kind === "create"
          ? operation.sourceBlob
          : operation.kind === "edit_source"
            ? operation.edits[0]?.replacementBlob
            : undefined;
      const item = plan.inventory.find((entry) => entry.id === operation.planChangeId)!;
      return binding && item.source
        ? [[item.componentId + "/" + item.source.fileId, binding] as const]
        : [];
    }),
  );
  const nodes: Array<{
    key: string;
    dependencies: string[];
    artifact: Omit<GameBuildArtifact, "inputHash">;
  }> = plan.observedSources.map((source) => {
    sourceBindings.set(source.componentId + "/" + source.fileId, source);
    return {
      key: "source:" + source.componentId + "/" + source.fileId,
      dependencies: source.imports.map(
        (imported) => "source:" + imported.componentId + "/" + imported.fileId,
      ),
      artifact: {
        kind: "dependency_source",
        hash: source.sourceHash,
        componentId: source.componentId,
        fileId: source.fileId,
        dependencyHashes: [],
        utf8Bytes: source.utf8Bytes,
      },
    };
  });
  for (const operation of operations) {
    const item = plan.inventory.find((entry) => entry.id === operation.planChangeId)!;
    const source = item.source
      ? sourceBindings.get(item.componentId + "/" + item.source.fileId)
      : undefined;
    if (source) {
      const component = plan.design.components.find((entry) => entry.id === item.componentId)!;
      const imports =
        component.kind === "source_package"
          ? component.files.find((file) => file.id === item.source!.fileId)!.imports
          : [];
      const dependencyHashes = imports
        .map((entry) => {
          const dependency = sourceBindings.get(entry.componentId + "/" + entry.fileId);
          if (!dependency) throw new Error("Built source dependency artifact is missing");
          return dependency.sourceHash;
        })
        .sort();
      nodes.push({
        key: "source:" + item.componentId + "/" + item.source!.fileId,
        dependencies: imports.map((entry) => "source:" + entry.componentId + "/" + entry.fileId),
        artifact: {
          kind: "source",
          hash: source.sourceHash,
          componentId: item.componentId,
          operationId: operation.id,
          fileId: item.source!.fileId,
          dependencyHashes,
          utf8Bytes: source.utf8Bytes,
        },
      });
    }
    nodes.push({
      key: "operation:" + item.id,
      dependencies: [
        ...item.dependencies.map((id) => "operation:" + id),
        ...(source ? ["source:" + item.componentId + "/" + item.source!.fileId] : []),
      ],
      artifact: {
        kind: "operation",
        hash: operationHashes.get(item.id)!,
        componentId: item.componentId,
        operationId: operation.id,
        dependencyHashes: [
          ...item.dependencies.map((id) => operationHashes.get(id)!),
          ...(source ? [source.sourceHash] : []),
        ].sort(),
        utf8Bytes: Buffer.byteLength(stableJson(operation), "utf8"),
      },
    });
  }
  for (const node of nodes)
    for (const edge of plan.design.artifactDependencies)
      if (edge.from === node.artifact.componentId)
        for (const dependency of nodes)
          if (dependency.artifact.componentId === edge.to) node.dependencies.push(dependency.key);
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const order = gameDependencyOrder(
    new Map(nodes.map((node) => [node.key, new Set(node.dependencies)])),
  );
  const inputHashes = new Map<string, string>();
  for (const key of order) {
    const node = byKey.get(key)!;
    const component = plan.design.components.find(
      (entry) => entry.id === node.artifact.componentId,
    )!;
    inputHashes.set(
      key,
      contentHash(
        stableJson({
          contentHash: node.artifact.hash,
          component,
          dependencyInputs: [...new Set(node.dependencies)]
            .map((dependency) => inputHashes.get(dependency)!)
            .sort(),
        }),
      ),
    );
  }
  return nodes.map((node) => ({
    ...node.artifact,
    dependencyHashes: [
      ...new Set(node.dependencies.map((key) => byKey.get(key)!.artifact.hash)),
    ].sort(),
    inputHash: inputHashes.get(node.key)!,
  }));
}

/** Pure content comparison. It does not run or transfer source and grants no gate result. */
export function compareGameBuildArtifactReuse(
  previous: GameBuildGraph,
  current: GameBuildGraph,
): {
  reusableInputHashes: string[];
  changedInputHashes: string[];
  reusableSourceBytes: number;
  changedSourceBytes: number;
} {
  const prior = new Set(previous.artifacts.map((artifact) => artifact.inputHash));
  const reusable = current.artifacts.filter((artifact) => prior.has(artifact.inputHash));
  const changed = current.artifacts.filter((artifact) => !prior.has(artifact.inputHash));
  const sourceBytes = (artifacts: readonly GameBuildArtifact[]) =>
    artifacts
      .filter((artifact) => artifact.kind !== "operation")
      .reduce((total, artifact) => total + artifact.utf8Bytes, 0);
  return {
    reusableInputHashes: [...new Set(reusable.map((artifact) => artifact.inputHash))].sort(),
    changedInputHashes: [...new Set(changed.map((artifact) => artifact.inputHash))].sort(),
    reusableSourceBytes: sourceBytes(reusable),
    changedSourceBytes: sourceBytes(changed),
  };
}

function compileGameBuildPartitions(
  plan: GamePlan,
  operations: readonly StudioChangeOperation[],
  acceptanceHash: string,
): GameBuildPartition[] {
  const topology = compileCreatorTransactionTopology({ initial: plan.initialTopology, operations });
  const byChange = new Map(operations.map((operation) => [operation.planChangeId, operation]));
  const creates = new Map(
    operations
      .filter((operation) => operation.kind === "create")
      .map((operation) => [studioObjectIdentityKey(operation.target.identity), operation]),
  );
  const activation = gameActivationOperations({
    inventory: plan.inventory,
    operations,
    maximumPartitionOperations: plan.policy.maximumPartitionOperations,
  });
  const dependencies = new Map(operations.map((operation) => [operation.id, new Set<string>()]));
  for (const edge of topology.dependencyEdges)
    dependencies.get(edge.operationId)!.add(edge.dependencyId);
  for (const item of plan.inventory)
    for (const dependency of item.dependencies)
      dependencies.get(byChange.get(item.id)!.id)!.add(byChange.get(dependency)!.id);
  const byOperation = new Map(operations.map((operation) => [operation.id, operation]));
  const dependencyOrdered = gameDependencyOrder(dependencies).map((id) => byOperation.get(id)!);
  const orderedOperations = [
    ...dependencyOrdered.filter((operation) => !activation.has(operation.id)),
    ...dependencyOrdered.filter((operation) => activation.has(operation.id)),
  ];
  const positions = new Map(orderedOperations.map((operation, index) => [operation.id, index]));
  // Intervals conservatively preserve every explicitly inseparable component and
  // forward/mutual allocation reference without silently slicing it across recordings.
  const intervals: Array<[number, number]> = [];
  const groups = new Map<string, number[]>();
  for (const item of plan.inventory) {
    const operation = byChange.get(item.id)!;
    const position = positions.get(operation.id)!;
    if (item.atomicGroup)
      groups.set(item.atomicGroup, [...(groups.get(item.atomicGroup) ?? []), position]);
    for (const dependency of item.dependencies) {
      const before = positions.get(byChange.get(dependency)!.id)!;
      if (before > position) intervals.push([position, before]);
    }
    if (operation.kind === "create" || operation.kind === "update" || operation.kind === "move")
      for (const value of Object.values(operation.properties))
        if (value.kind === "instance_ref" && value.state === "reference") {
          const target = creates.get(studioObjectIdentityKey(value.identity));
          if (target) {
            const targetPosition = positions.get(target.id)!;
            if (targetPosition > position) intervals.push([position, targetPosition]);
          }
        }
  }
  for (const group of groups.values()) intervals.push([Math.min(...group), Math.max(...group)]);
  if (activation.size)
    intervals.push([orderedOperations.length - activation.size, orderedOperations.length - 1]);
  const boundaries = new Set<number>();
  for (const [start, end] of intervals)
    for (let index = start; index < end; index++) boundaries.add(index);
  const atoms: StudioChangeOperation[][] = [];
  let atom: StudioChangeOperation[] = [];
  for (let index = 0; index < orderedOperations.length; index++) {
    atom.push(orderedOperations[index]!);
    if (!boundaries.has(index)) {
      atoms.push(atom);
      atom = [];
    }
  }
  const partitions: GameBuildPartition[] = [];
  let before = [...plan.initialTopology];
  let pending: StudioChangeOperation[] = [];
  let pendingTemplates:
    { preflight: GameEvidenceTemplate; readback: GameEvidenceTemplate } | undefined;
  const seal = (): void => {
    if (!pending.length) return;
    pending = [
      ...compileCreatorTransactionTopology({ initial: before, operations: pending })
        .orderedOperations,
    ];
    const ordinal = partitions.length;
    const after = gameTopologyAfter(before, pending);
    const templates =
      pendingTemplates ?? gamePartitionEvidence(plan, pending, before, acceptanceHash);
    const payload = {
      id: "game_partition_" + ordinal,
      ordinal,
      operationIds: pending.map((operation) => operation.id),
      expectedBeforeTopologyHash: gameTopologyHash(before),
      expectedAfterTopologyHash: gameTopologyHash(after),
      ...(partitions.length ? { previousPartitionHash: partitions.at(-1)!.hash } : {}),
      ...templates,
    };
    partitions.push({ ...payload, hash: contentHash(stableJson(payload)) });
    if (partitions.length > plan.policy.maximumPartitions)
      throw new Error("Candidate exceeds partition admission profile");
    before = after;
    pending = [];
    pendingTemplates = undefined;
  };
  for (let start = 0; start < atoms.length;) {
    if (atoms[start]!.length > plan.policy.maximumPartitionOperations)
      throw new Error(
        "Inseparable component exceeds one bounded transaction; revise its staging plan",
      );
    let end = start;
    let count = 0;
    while (
      end < atoms.length &&
      count + atoms[end]!.length <= plan.policy.maximumPartitionOperations
    ) {
      // Complete ordinary allocations before opening the activation recording.
      // Canonical native ordering inside a transaction may otherwise place a
      // Script before a remaining module or object in that same partition.
      if (end > start && atoms[end]!.some((operation) => activation.has(operation.id))) break;
      count += atoms[end++]!.length;
    }
    // Cost the largest operation-bounded prefix once. Only unusually large
    // evidence payloads need a smaller-prefix search; avoid quadratic costing.
    let low = start + 1;
    let high = end;
    let accepted = start;
    while (low <= high) {
      const candidateEnd = accepted === start && high === end ? high : Math.floor((low + high) / 2);
      const candidate = atoms.slice(start, candidateEnd).flat();
      try {
        const templates = gamePartitionEvidence(plan, candidate, before, acceptanceHash);
        accepted = candidateEnd;
        pending = candidate;
        pendingTemplates = templates;
        low = candidateEnd + 1;
      } catch (error) {
        if (candidateEnd === start + 1) throw error;
        high = candidateEnd - 1;
      }
    }
    if (accepted === start) throw new Error("Partition has no admissible evidence prefix");
    seal();
    start = accepted;
  }
  return partitions;
}

export function gameTopologyHash(nodes: readonly CreatorTransactionTopologyNode[]): string {
  return contentHash(
    stableJson(
      [...nodes].sort((a, b) =>
        studioObjectIdentityKey(a.identity) < studioObjectIdentityKey(b.identity) ? -1 : 1,
      ),
    ),
  );
}
export function gameTopologyAfter(
  before: readonly CreatorTransactionTopologyNode[],
  operations: readonly StudioChangeOperation[],
): CreatorTransactionTopologyNode[] {
  const final = compileCreatorTransactionTopology({ initial: before, operations }).finalNodes;
  const originals = new Map(
    before.map((entry) => [studioObjectIdentityKey(entry.identity), entry]),
  );
  return final.map((node) => {
    const original = originals.get(node.originalIdentityKey);
    return {
      identity: node.identity,
      ...(node.parentIdentity ? { parentIdentity: node.parentIdentity } : {}),
      path: node.path,
      name: node.name,
      className: node.className,
      properties: node.properties,
      ...(original?.engineContainer ? { engineContainer: original.engineContainer } : {}),
    };
  });
}

function projectionContext(
  plan: GamePlan,
  operations: readonly StudioChangeOperation[],
  initial: readonly CreatorTransactionTopologyNode[],
) {
  const structuralParents: CreatorChangeSetStructuralParent[] = [];
  const deletedSubtrees: CreatorChangeSetDeleteSubtree[] = [];
  for (const operation of operations) {
    if (
      (operation.kind === "create" || operation.kind === "move") &&
      operation.parent.kind === "engine_container"
    ) {
      const parent = operation.parent;
      const node = initial.find(
        (entry) =>
          entry.engineContainer?.path === parent.path &&
          entry.engineContainer.className === parent.className,
      );
      if (!node) throw new Error("Partition engine parent is absent from exact topology");
      structuralParents.push({
        operationId: operation.id,
        target: {
          kind: "instance",
          identity: node.identity,
          path: node.path,
          className: node.className,
        },
      });
    }
    if (operation.kind === "delete") {
      const removed = new Set(
        compileCreatorTransactionTopology({ initial, operations }).deletedIdentityKeys,
      );
      const descendants = initial.filter(
        (node) =>
          studioObjectIdentityKey(node.identity) !==
            studioObjectIdentityKey(operation.target.identity) &&
          removed.has(studioObjectIdentityKey(node.identity)) &&
          node.path.startsWith(operation.target.path + "/"),
      );
      deletedSubtrees.push({
        operationId: operation.id,
        descendants: descendants.map((node) => ({
          kind: "instance" as const,
          identity: node.identity,
          path: node.path,
          className: node.className,
        })),
      });
    }
  }
  return { project: plan.project, initialTopology: initial, structuralParents, deletedSubtrees };
}

function gamePartitionEvidence(
  plan: GamePlan,
  operations: readonly StudioChangeOperation[],
  initial: readonly CreatorTransactionTopologyNode[],
  acceptanceHash: string,
): { preflight: GameEvidenceTemplate; readback: GameEvidenceTemplate } {
  operations = compileCreatorTransactionTopology({ initial, operations }).orderedOperations;
  const hash = contentHash(stableJson(operations));
  const changeSet = {
    id: "game_partition_cost_" + hash.slice(0, 24),
    hash,
    sessionId: plan.sessionId,
    expectedRevisionHash: plan.observedRevisionHash,
    buildContractHash: plan.hash,
    operations,
  };
  const binding = {
    sessionId: plan.sessionId,
    changeSetHash: hash,
    approvalHash: acceptanceHash,
    revisionHash: plan.observedRevisionHash,
    buildHash: plan.hash,
    dashboardReviewHash: acceptanceHash,
  };
  const context = projectionContext(plan, operations, initial);
  const template = (projection: StudioEvidenceProjection): GameEvidenceTemplate => {
    const canonicalBytes = Buffer.byteLength(stableJson(projection), "utf8") + 4096;
    if (
      projection.requirements.length > plan.policy.maximumPartitionFacts ||
      canonicalBytes > plan.policy.maximumPartitionBytes
    )
      throw new Error("Partition evidence exceeds encoded admission budget");
    return {
      kind: "GameEvidenceTemplate",
      purpose: projection.purpose,
      requirements: projection.requirements,
      scope: projection.scope,
      factCount: projection.requirements.length,
      canonicalBytes,
    };
  };
  return {
    preflight: template(
      compileCreatorChangeSetMutationProjection(changeSet, {
        ...context,
        binding,
        purpose: "mutation_preflight",
      }),
    ),
    readback: template(
      compileCreatorChangeSetMutationProjection(changeSet, {
        ...context,
        binding,
        purpose: "mutation_direct_readback",
      }),
    ),
  };
}

export function gameBuildPartitionOperations(
  graph: GameBuildGraph,
  ordinal: number,
): StudioChangeOperation[] {
  const partition = graph.partitions[ordinal];
  if (!partition) throw new Error("Graph partition is absent");
  const operations = new Map(graph.operations.map((operation) => [operation.id, operation]));
  return partition.operationIds.map((id) => {
    const operation = operations.get(id);
    if (!operation) throw new Error("Partition operation is absent from immutable graph");
    return operation;
  });
}
