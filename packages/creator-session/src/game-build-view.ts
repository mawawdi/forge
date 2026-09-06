import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertGameBuildControlView,
  type GameBuildControlNode,
  type GameBuildControlView,
} from "../../creator-conversation/src/game-build-contract.js";
import type {
  CreatorChangeSet,
  CreatorPlan,
  CreatorSessionBundle,
  CreatorSessionStatus,
} from "./index.js";
export type { GameBuildControlView } from "../../creator-conversation/src/game-build-contract.js";

/** The supplied build comes from the coordinator's durable, replay-verified receipt ledger. */
export function createGameBuildControlView(input: {
  plan: Pick<CreatorPlan, "compiled">;
  build?: NonNullable<CreatorSessionBundle["gameBuilds"]>[number];
  sessionStatus: CreatorSessionStatus;
  activeChangeSet?: { partition: Pick<CreatorChangeSet["partition"], "graphHash" | "ordinal"> };
  stoppedReason?: string;
}): GameBuildControlView {
  const { plan, build } = input;
  const compiled = plan.compiled;
  if (build && (build.graph.planHash !== compiled.hash || build.graph.planId !== compiled.id))
    throw new Error("Build presentation is bound to a different sealed plan");
  const graph = build?.graph;
  let invalidReceipt = false;
  let prefix = 0;
  for (const receipt of build?.receipts ?? []) {
    const partition = graph!.partitions[prefix];
    const { hash, ...payload } = receipt;
    if (
      !partition ||
      !["GameCheckpointReceipt", "GameRojoCheckpointReceipt"].includes(receipt.kind) ||
      receipt.ordinal !== prefix ||
      receipt.graphHash !== graph!.hash ||
      receipt.partitionHash !== partition.hash ||
      hash !== contentHash(stableJson(payload)) ||
      (prefix === 0
        ? receipt.previousReceiptHash !== undefined ||
          receipt.beforeRevisionHash !== graph!.observedRevisionHash
        : receipt.previousReceiptHash !== build!.receipts[prefix - 1]!.hash ||
          receipt.beforeRevisionHash !== build!.receipts[prefix - 1]!.afterRevisionHash)
    ) {
      invalidReceipt = true;
      break;
    }
    prefix += 1;
  }
  // Do not paint any unbound prefix as applied if its retained ledger is malformed.
  if (invalidReceipt) prefix = 0;
  const recovery = invalidReceipt || input.sessionStatus === "recovery_required";
  const stopped =
    build?.status === "incomplete" ||
    ["incomplete", "rolled_back", "superseded", "creator_rejected", "refresh_required"].includes(
      input.sessionStatus,
    );
  const activeOrdinal =
    input.activeChangeSet?.partition.graphHash === graph?.hash
      ? input.activeChangeSet?.partition.ordinal
      : undefined;
  const applying =
    !recovery &&
    !stopped &&
    activeOrdinal === prefix &&
    ["preflighting", "applying", "committing", "cancelling"].includes(input.sessionStatus);
  const complete =
    graph !== undefined && graph.partitions.length > 0 && prefix === graph.partitions.length;
  const status: GameBuildControlView["status"] = recovery
    ? "recovery_required"
    : stopped
      ? "stopped"
      : complete
        ? "complete"
        : applying
          ? "applying"
          : graph
            ? "materialized"
            : "planned";
  const byOperationId = new Map(
    graph?.operations.map((operation) => [operation.id, operation.planChangeId]) ?? [],
  );
  const partitions: GameBuildControlView["partitions"] =
    graph?.partitions.map((partition) => ({
      id: partition.id,
      ordinal: partition.ordinal,
      status:
        partition.ordinal < prefix
          ? "applied"
          : partition.ordinal === prefix && (stopped || recovery)
            ? "stopped"
            : partition.ordinal === activeOrdinal && applying
              ? "applying"
              : "pending",
      nodeIds: partition.operationIds.map((id) => byOperationId.get(id)!).filter(Boolean),
      ...(partition.ordinal < prefix
        ? { receiptHash: build!.receipts[partition.ordinal]!.hash }
        : {}),
    })) ?? [];
  const nodePartitions = new Map(
    partitions.flatMap((partition) => partition.nodeIds.map((id) => [id, partition] as const)),
  );
  const components = new Map(
    compiled.design.components.map((component) => [component.id, component]),
  );
  const nodes: GameBuildControlNode[] = compiled.inventory.map((item) => {
    const change = item.change;
    const component = components.get(item.componentId);
    if (!component) throw new Error("Build inventory component provenance is missing");
    const path =
      change.kind === "create"
        ? change.path
        : change.kind === "move"
          ? change.toPath
          : change.target.path;
    const partition = nodePartitions.get(item.id);
    return {
      id: item.id,
      componentId: item.componentId,
      label: path.split("/").at(-1)!,
      path,
      className: change.kind === "create" ? change.className : change.target.className,
      operation: change.kind,
      status:
        partition?.status === "applied"
          ? "applied"
          : partition?.status === "applying"
            ? "applying"
            : partition?.status === "stopped"
              ? "stopped"
              : !graph
                ? "planned"
                : stopped || recovery
                  ? "pending"
                  : "ready",
      provenance: {
        componentKind: component.kind,
        ...(component.kind === "recipe_instance"
          ? { definitionId: component.definition.id, definitionHash: component.definition.hash }
          : {}),
      },
      ...(item.source ? { source: { fileId: item.source.fileId, ...item.source.content } } : {}),
      lockedProperties: item.lockedProperties,
      valueSlots: item.valueSlots,
    };
  });
  const edges: Array<GameBuildControlView["edges"][number]> = [];
  const createPaths = new Map(
    compiled.inventory.flatMap((item) =>
      item.change.kind === "create" ? [[item.change.path, item.id] as const] : [],
    ),
  );
  for (const item of compiled.inventory) {
    const parentId =
      item.change.kind === "create" || item.change.kind === "move"
        ? createPaths.get(item.change.parent.path)
        : undefined;
    for (const dependency of item.dependencies)
      edges.push({
        from: item.id,
        to: dependency,
        kind: dependency === parentId ? "parent" : "dependency",
      });
    if (parentId && !item.dependencies.includes(parentId))
      edges.push({ from: item.id, to: parentId, kind: "parent" });
  }
  const view: GameBuildControlView = {
    planHash: compiled.hash,
    worldAuthoring: structuredClone(compiled.design.worldAuthoring),
    ...(graph ? { graphHash: graph.hash } : {}),
    status,
    ...(stopped || recovery
      ? {
          stoppedReason: invalidReceipt
            ? "The retained checkpoint ledger does not match this build. Reconcile its exact receipts before continuing."
            : (input.stoppedReason ??
              `Build paused after ${prefix} acknowledged checkpoint${prefix === 1 ? "" : "s"}; session state is ${input.sessionStatus.replaceAll("_", " ")}.`),
        }
      : {}),
    nodes,
    ...(compiled.design.architecture
      ? {
          architecture: {
            name: compiled.design.architecture.name,
            ...(compiled.design.architecture.icon === undefined
              ? {}
              : { icon: compiled.design.architecture.icon }),
            nodes: compiled.design.architecture.nodes.map((system) => {
              const included = new Set([system.id]);
              const bound = new Set(system.componentIds);
              // The admitted hierarchy is acyclic; take its transitive component closure.
              for (let previous = -1; previous !== included.size;) {
                previous = included.size;
                for (const child of compiled.design.architecture!.nodes) {
                  if (child.parentId && included.has(child.parentId)) {
                    included.add(child.id);
                    for (const id of child.componentIds) bound.add(id);
                  }
                }
              }
              const operations = nodes.filter((node) => bound.has(node.componentId));
              const appliedOperations = operations.filter(
                (node) => node.status === "applied",
              ).length;
              const systemStatus =
                operations.length === 0
                  ? ("no_changes" as const)
                  : appliedOperations === operations.length
                    ? ("applied" as const)
                    : operations.some((node) => node.status === "applying")
                      ? ("applying" as const)
                      : operations.some((node) => node.status === "stopped")
                        ? ("stopped" as const)
                        : operations.some((node) => node.status === "pending")
                          ? ("pending" as const)
                          : operations.some((node) => node.status === "ready")
                            ? ("ready" as const)
                            : ("planned" as const);
              return {
                id: system.id,
                name: system.name,
                ...(system.icon === undefined ? {} : { icon: system.icon }),
                description: system.description,
                componentIds: system.componentIds,
                ...(system.parentId === undefined ? {} : { parentId: system.parentId }),
                operationIds: operations.map((node) => node.id),
                status: systemStatus,
                appliedOperations,
              };
            }),
            relationships: compiled.design.architecture.relationships,
          },
        }
      : {}),
    components: compiled.design.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      observedSources: compiled.observedSources.filter(
        (source) => source.componentId === component.id,
      ).length,
    })),
    componentDependencies: [
      ...new Map(
        [
          ...compiled.design.artifactDependencies,
          ...compiled.design.components.flatMap((component) =>
            component.kind === "source_package"
              ? component.files.flatMap((file) =>
                  file.imports
                    .filter((entry) => entry.componentId !== component.id)
                    .map((entry) => ({ from: component.id, to: entry.componentId })),
                )
              : [],
          ),
        ].map((edge) => [JSON.stringify([edge.from, edge.to]), edge]),
      ).values(),
    ].sort((left, right) =>
      left.from < right.from
        ? -1
        : left.from > right.from
          ? 1
          : left.to < right.to
            ? -1
            : left.to > right.to
              ? 1
              : 0,
    ),
    edges,
    partitions,
    receipts: (build?.receipts.slice(0, prefix) ?? []).map((receipt) => ({
      partitionId: graph!.partitions[receipt.ordinal]!.id,
      hash: receipt.hash,
      status: "verified",
    })),
  };
  assertGameBuildControlView(view);
  return view;
}
