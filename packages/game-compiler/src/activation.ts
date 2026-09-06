import { studioObjectIdentityKey } from "../../studio-evidence/src/index.js";
import type { GamePendingOperation } from "./plan.js";
import type { GameInventoryItem } from "./types.js";

/** Structural admission shared by plan approval and materialized partitioning. */
export function gameActivationOperations(input: {
  inventory: readonly GameInventoryItem[];
  operations: readonly GamePendingOperation[];
  maximumPartitionOperations: number;
}): ReadonlySet<string> {
  const byChange = new Map(
    input.operations.map((operation) => [operation.planChangeId, operation]),
  );
  const inventoryById = new Map(input.inventory.map((item) => [item.id, item]));
  const creates = new Map(
    input.operations
      .filter((operation) => operation.kind === "create")
      .map((operation) => [studioObjectIdentityKey(operation.target.identity), operation]),
  );
  const isEntrypoint = (operation: GamePendingOperation) =>
    ["create", "edit_source"].includes(operation.kind) &&
    ["Script", "LocalScript"].includes(operation.target.className);
  const activation = new Set(
    input.operations.filter(isEntrypoint).map((operation) => operation.id),
  );
  let extended = true;
  while (extended) {
    extended = false;
    const activeGroups = new Set(
      input.inventory
        .filter((item) => item.atomicGroup && activation.has(byChange.get(item.id)!.id))
        .map((item) => item.atomicGroup),
    );
    for (const operation of input.operations) {
      if (activation.has(operation.id)) continue;
      const item = inventoryById.get(operation.planChangeId)!;
      const parent =
        (operation.kind === "create" || operation.kind === "move") &&
        operation.parent.kind === "instance"
          ? creates.get(studioObjectIdentityKey(operation.parent.identity))
          : undefined;
      const references =
        operation.kind === "create" || operation.kind === "move" || operation.kind === "update"
          ? Object.values(operation.properties).flatMap((value) =>
              value.kind === "instance_ref" && value.state === "reference"
                ? [creates.get(studioObjectIdentityKey(value.identity))]
                : [],
            )
          : [];
      if (
        (parent && activation.has(parent.id)) ||
        references.some((reference) => reference && activation.has(reference.id)) ||
        item.dependencies.some((id) => activation.has(byChange.get(id)!.id)) ||
        (item.atomicGroup && activeGroups.has(item.atomicGroup))
      ) {
        activation.add(operation.id);
        extended = true;
      }
    }
  }
  if (activation.size > input.maximumPartitionOperations)
    throw new Error(
      "Entrypoint activation component exceeds one bounded transaction; approve explicit inactive staging first",
    );
  if (
    input.operations.some((operation) => activation.has(operation.id) && !isEntrypoint(operation))
  )
    throw new Error(
      "Entrypoint activation includes dependent allocations; approve explicit inactive staging before activation",
    );
  return activation;
}
