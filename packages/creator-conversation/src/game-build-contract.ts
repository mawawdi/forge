/** Browser-safe presentation of sealed inventory and coordinator-verified checkpoints. */
export interface GameBuildControlView {
  readonly planHash: string;
  readonly worldAuthoring:
    | { readonly mode: "persistent"; readonly roots: readonly string[] }
    | { readonly mode: "runtime_generated"; readonly rationale: string }
    | { readonly mode: "none" };
  readonly graphHash?: string;
  readonly status:
    "planned" | "materialized" | "applying" | "complete" | "stopped" | "recovery_required";
  readonly stoppedReason?: string;
  /** Creator-facing system names are declared by the design, never inferred from implementation. */
  readonly architecture?: GameBuildArchitecture;
  readonly nodes: readonly GameBuildControlNode[];
  readonly components: readonly {
    readonly id: string;
    readonly kind: "source_package" | "native_graph" | "ui_graph" | "scene_handle";
    readonly observedSources: number;
  }[];
  /** Explicit artifact edges and cross-component source imports; runtime connections are separate. */
  readonly componentDependencies: readonly { readonly from: string; readonly to: string }[];
  /** from depends on to; arrows in the UI point from prerequisite to dependent. */
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: "dependency" | "parent";
  }[];
  readonly partitions: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly status: "pending" | "applying" | "applied" | "stopped";
    readonly nodeIds: readonly string[];
    readonly receiptHash?: string;
  }[];
  readonly receipts: readonly {
    readonly partitionId: string;
    readonly hash: string;
    readonly status: "verified";
  }[];
}
export interface GameBuildArchitecture {
  readonly name: string;
  readonly icon?: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly name: string;
    readonly icon?: string;
    readonly description: string;
    readonly parentId?: string;
    readonly componentIds: readonly string[];
    /** Includes operations bound to this system and its descendant systems, without duplicates. */
    readonly operationIds: readonly string[];
    readonly status: GameBuildControlNode["status"] | "no_changes";
    readonly appliedOperations: number;
  }[];
  readonly relationships: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly label: string;
  }[];
}
export interface GameBuildControlNode {
  readonly id: string;
  readonly componentId: string;
  readonly label: string;
  readonly path: string;
  readonly className: string;
  readonly operation: "create" | "update" | "move" | "delete" | "edit_source";
  readonly status: "planned" | "ready" | "applying" | "applied" | "pending" | "stopped";
  readonly provenance: {
    readonly componentKind: "source_package" | "native_graph" | "ui_graph" | "scene_handle";
  };
  readonly source?: {
    readonly fileId: string;
    readonly kind: "locked" | "slot";
    readonly sourceHash?: string;
    readonly utf8Bytes?: number;
    readonly maximumUtf8Bytes?: number;
  };
  readonly lockedProperties: Readonly<Record<string, unknown>>;
  readonly valueSlots: readonly {
    readonly id: string;
    readonly propertyName: string;
    readonly schema: unknown;
  }[];
}

export function assertGameBuildControlView(value: unknown): asserts value is GameBuildControlView {
  const record = object(value);
  if (
    !hash(record.planHash) ||
    (record.graphHash !== undefined && !hash(record.graphHash)) ||
    !oneOf(record.status, [
      "planned",
      "materialized",
      "applying",
      "complete",
      "stopped",
      "recovery_required",
    ]) ||
    (record.stoppedReason !== undefined && !text(record.stoppedReason, 16384))
  )
    fail();
  const worldAuthoring = object(record.worldAuthoring);
  if (worldAuthoring.mode === "persistent") {
    const roots = array(worldAuthoring.roots, 32);
    if (
      roots.length === 0 ||
      new Set(roots).size !== roots.length ||
      roots.some(
        (root) =>
          typeof root !== "string" ||
          !/^Workspace\/[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+)*$/u.test(root),
      )
    )
      fail();
  } else if (
    worldAuthoring.mode === "runtime_generated"
      ? !text(worldAuthoring.rationale, 512) || String(worldAuthoring.rationale).length < 24
      : worldAuthoring.mode !== "none"
  )
    fail();
  const nodes = array(record.nodes, 8192);
  const componentIds = new Set<string>();
  for (const value of array(record.components, 256)) {
    const component = object(value);
    if (
      !text(component.id, 4096) ||
      componentIds.has(String(component.id)) ||
      !oneOf(component.kind, ["source_package", "native_graph", "ui_graph", "scene_handle"]) ||
      !integer(component.observedSources)
    )
      fail();
    componentIds.add(String(component.id));
  }
  for (const value of array(record.componentDependencies, 4096)) {
    const edge = object(value);
    if (
      !componentIds.has(String(edge.from)) ||
      !componentIds.has(String(edge.to)) ||
      edge.from === edge.to
    )
      fail();
  }
  const ids = new Set<string>();
  for (const value of nodes) {
    const node = object(value);
    if (
      ![node.id, node.componentId, node.label, node.path, node.className].every((value) =>
        text(value, 4096),
      ) ||
      ids.has(String(node.id)) ||
      !componentIds.has(String(node.componentId)) ||
      !oneOf(node.operation, ["create", "update", "move", "delete", "edit_source"]) ||
      !oneOf(node.status, ["planned", "ready", "applying", "applied", "pending", "stopped"])
    )
      fail();
    ids.add(String(node.id));
    const provenance = object(node.provenance);
    if (
      !oneOf(provenance.componentKind, [
        "source_package",
        "native_graph",
        "ui_graph",
        "scene_handle",
      ])
    )
      fail();
    object(node.lockedProperties);
    for (const value of array(node.valueSlots, 512)) {
      const slot = object(value);
      if (!text(slot.id, 256) || !text(slot.propertyName, 256) || slot.schema === undefined) fail();
    }
    if (node.source !== undefined) {
      const source = object(node.source);
      if (
        !text(source.fileId, 256) ||
        !oneOf(source.kind, ["locked", "slot"]) ||
        (source.kind === "locked"
          ? !hash(source.sourceHash) || !integer(source.utf8Bytes)
          : !integer(source.maximumUtf8Bytes))
      )
        fail();
    }
  }
  for (const value of array(record.edges, 65536)) {
    const edge = object(value);
    if (
      !ids.has(String(edge.from)) ||
      !ids.has(String(edge.to)) ||
      !oneOf(edge.kind, ["dependency", "parent"])
    )
      fail();
  }
  const partitionIds = new Set<string>();
  for (const [ordinal, value] of array(record.partitions, 128).entries()) {
    const partition = object(value);
    if (
      !text(partition.id, 256) ||
      partitionIds.has(String(partition.id)) ||
      partition.ordinal !== ordinal ||
      !oneOf(partition.status, ["pending", "applying", "applied", "stopped"]) ||
      (partition.receiptHash !== undefined && !hash(partition.receiptHash))
    )
      fail();
    partitionIds.add(String(partition.id));
    for (const id of array(partition.nodeIds, 8192)) if (!ids.has(String(id))) fail();
  }
  for (const value of array(record.receipts, 128)) {
    const receipt = object(value);
    if (
      !partitionIds.has(String(receipt.partitionId)) ||
      !hash(receipt.hash) ||
      receipt.status !== "verified"
    )
      fail();
  }
  if (record.architecture !== undefined) {
    const architecture = object(record.architecture);
    if (
      !text(architecture.name, 160) ||
      (architecture.icon !== undefined && !text(architecture.icon, 32))
    )
      fail();
    const systemIds = new Set<string>();
    const systems = array(architecture.nodes, 256).map(object);
    for (const system of systems) {
      if (
        !text(system.id, 128) ||
        !text(system.name, 160) ||
        !text(system.description, 2048) ||
        (system.icon !== undefined && !text(system.icon, 32)) ||
        systemIds.has(system.id) ||
        !oneOf(system.status, [
          "planned",
          "ready",
          "applying",
          "applied",
          "pending",
          "stopped",
          "no_changes",
        ]) ||
        !integer(system.appliedOperations)
      )
        fail();
      systemIds.add(system.id);
      const operations = array(system.operationIds, 8192);
      if (
        new Set(operations).size !== operations.length ||
        Number(system.appliedOperations) > operations.length
      )
        fail();
      for (const id of operations) if (!ids.has(String(id))) fail();
      const components = array(system.componentIds, 256);
      if (new Set(components).size !== components.length) fail();
      for (const id of components) if (!componentIds.has(String(id))) fail();
    }
    const parents = new Map(systems.map((system) => [String(system.id), system.parentId]));
    for (const system of systems) {
      const visited = new Set([system.id]);
      let parent = system.parentId;
      while (parent !== undefined) {
        if (!systemIds.has(String(parent)) || visited.has(parent)) fail();
        visited.add(parent);
        parent = parents.get(String(parent));
      }
    }
    const relations = new Set<string>();
    for (const value of array(architecture.relationships, 4096)) {
      const relation = object(value);
      if (
        !text(relation.id, 128) ||
        relations.has(relation.id) ||
        !text(relation.label, 256) ||
        !systemIds.has(String(relation.from)) ||
        !systemIds.has(String(relation.to))
      )
        fail();
      relations.add(relation.id);
    }
  }
}
function fail(): never {
  throw new Error("Invalid game build presentation");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function hash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
