import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertGamePlan,
  gameInventoryOperation,
  type GamePlan,
} from "../../game-compiler/src/index.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { compareGameStrings } from "../../game-ir/src/primitives.js";
import { studioObjectIdentityKey } from "../../studio-evidence/src/index.js";
import { compileCreatorTransactionTopology } from "./transaction-topology.js";

type HierarchyRow =
  [path: string, className: string] | [path: string, className: string, outputId: string];

/** Complete navigation for accepted operation targets, without fabricating property observations. */
export function createCreatorBuilderNavigation(
  plan: GamePlan,
  creatorPlanHash: string,
  maximumBytes = DEFAULT_GAME_ADMISSION_POLICY.maximumJsonBytes,
) {
  assertGamePlan(plan);
  if (!/^[a-f0-9]{64}$/.test(creatorPlanHash)) throw new Error("Invalid creator plan hash");
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DEFAULT_GAME_ADMISSION_POLICY.maximumJsonBytes
  )
    throw new Error("Invalid builder hierarchy byte bound");
  const operations = plan.inventory.map((item) => gameInventoryOperation(plan, item));
  const topology = compileCreatorTransactionTopology({ initial: plan.initialTopology, operations });
  const finalNodes = new Map(
    topology.finalNodes.map((node) => [studioObjectIdentityKey(node.identity), node]),
  );
  const groups = new Map<
    string,
    { instances: Map<string, HierarchyRow>; removed: Map<string, HierarchyRow> }
  >();
  const sourcePaths = new Map<string, string>();
  for (const [index, item] of plan.inventory.entries()) {
    let group = groups.get(item.componentId);
    if (!group) {
      group = { instances: new Map(), removed: new Map() };
      groups.set(item.componentId, group);
    }
    const operation = operations[index]!;
    const identity = studioObjectIdentityKey(operation.target.identity);
    if (operation.kind === "delete") {
      group.removed.set(identity, [operation.target.path, operation.target.className]);
      continue;
    }
    const node = finalNodes.get(identity);
    if (!node) throw new Error("Accepted inventory target is missing from final topology");
    if (item.source) sourcePaths.set(item.id, node.path);
    group.instances.set(
      identity,
      item.outputId === undefined
        ? [node.path, node.className]
        : [node.path, node.className, item.outputId],
    );
  }
  const sorted = (rows: Map<string, HierarchyRow>) =>
    [...rows.values()].sort(
      (a, b) =>
        compareGameStrings(a[0], b[0]) ||
        compareGameStrings(a[1], b[1]) ||
        compareGameStrings(a[2] ?? "", b[2] ?? ""),
    );
  const components = [...groups]
    .sort(([a], [b]) => compareGameStrings(a, b))
    .map(([componentId, rows]) => ({
      componentId,
      instances: sorted(rows.instances),
      removed: sorted(rows.removed),
    }));
  const binding = {
    creatorPlanHash,
    planHash: plan.hash,
    operationCount: plan.inventory.length,
    scope: "accepted_inventory_targets" as const,
  };
  const payload = {
    ...binding,
    available: true as const,
    columns: ["path", "className", "outputId (when declared)"] as const,
    components,
  };
  const projection = { ...payload, hash: contentHash(stableJson(payload)) };
  const requiredBytes = Buffer.byteLength(stableJson(projection));
  if (requiredBytes <= maximumBytes) return { hierarchy: projection, sourcePaths };
  return {
    hierarchy: {
      ...binding,
      available: false as const,
      requiredBytes,
      maximumBytes,
      projectionHash: projection.hash,
      reason:
        "Complete hierarchy exceeds the context bound; no rows were included. Use game.inspect_inventory with this planHash and exact componentId to inspect bounded pages.",
    },
    sourcePaths,
  };
}
