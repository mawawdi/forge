import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  PLAN_CHANGE_SCHEMA,
  creatorGeneratedObjectIdentity,
  creatorCompiledIdentity,
  type CreatorPlanChange,
  type CreatorProjectIndexView,
  type StudioChangeOperation,
  type StudioInstanceTarget,
} from "../../creator-session/src/index.js";
import {
  compileCreatorTransactionTopology,
  type CreatorTransactionTopologyNode,
} from "../../creator-session/src/transaction-topology.js";
import {
  assertStudioValueForProperty,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  studioObjectIdentityKey,
  type StudioProjectIdentity,
} from "../../studio-evidence/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  validateGameDesignSpec,
  type GameAdmissionPolicy,
  type GameDefinitionRegistry,
  type GameDesignSpec,
  type GameSourceFile,
} from "../../game-ir/src/index.js";
import { assertBoundedGameJson, compareGameStrings } from "../../game-ir/src/primitives.js";
import { canonicalGameDataSchema, resolveGameDefinition } from "../../game-ir/src/recipes.js";
import type {
  GameCompilerPolicy,
  GameInventoryItem,
  GameObservedSourceArtifact,
  GamePlan,
  GameRecipeExpander,
} from "./types.js";

export const GAME_COMPILER_ABI = "forge-game-compiler@1";
export const DEFAULT_GAME_COMPILER_POLICY: Readonly<GameCompilerPolicy> = Object.freeze({
  maximumOperations: 8192,
  maximumCanonicalBytes: 64 * 1024 * 1024,
  maximumSourceBytes: 32 * 1024 * 1024,
  maximumPartitions: 128,
  maximumPartitionOperations: 128,
  maximumPartitionFacts: 16384,
  maximumPartitionBytes: 2 * 1024 * 1024,
});
const POLICY_SCHEMA = z
  .object({
    maximumOperations: z.number().int().positive().safe(),
    maximumCanonicalBytes: z.number().int().positive().safe(),
    maximumSourceBytes: z.number().int().positive().safe(),
    maximumPartitions: z.number().int().positive().safe(),
    maximumPartitionOperations: z.number().int().positive().max(128),
    maximumPartitionFacts: z.number().int().positive().max(16384),
    maximumPartitionBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
  })
  .strict();

export function gameGeneratedTarget(input: {
  projectId: string;
  designHash?: string;
  operationId: string;
  path: string;
  className: string;
}): StudioInstanceTarget {
  return {
    kind: "instance",
    identity: creatorGeneratedObjectIdentity(input.projectId, input.operationId),
    path: input.path,
    className: input.className,
  };
}

interface DesignInput {
  readonly design: GameDesignSpec;
  readonly registry: GameDefinitionRegistry;
  readonly admissionPolicy?: GameAdmissionPolicy;
  readonly projectId: string;
  readonly project: StudioProjectIdentity;
  readonly initialTopology: readonly CreatorTransactionTopologyNode[];
  readonly observation?: CreatorProjectIndexView;
}

export function expandGameDesign(
  input: DesignInput & {
    readonly recipeExpanders?: readonly GameRecipeExpander[];
    readonly additionalInventory?: readonly GameInventoryItem[];
  },
): {
  inventory: GameInventoryItem[];
  observedSources: GameObservedSourceArtifact[];
  design: GameDesignSpec;
  designHash: string;
} {
  const admitted = validateGameDesignSpec(input.design, {
    registry: input.registry,
    policy: input.admissionPolicy ?? DEFAULT_GAME_ADMISSION_POLICY,
  });
  if (admitted.status !== "eligible")
    throw new Error("Game design admission failed: " + stableJson(admitted.diagnostics));
  const inventory = [...(input.additionalInventory ?? [])];
  const observedSources: GameObservedSourceArtifact[] = [];
  const expanders = new Map<string, GameRecipeExpander>();
  for (const expander of input.recipeExpanders ?? []) {
    const pin = stableJson(expander.definition);
    if (expanders.has(pin)) throw new Error("Duplicate trusted recipe expander");
    expanders.set(pin, expander);
  }
  for (const component of admitted.spec.components) {
    if (component.kind !== "recipe_instance") continue;
    const expander = expanders.get(stableJson(component.definition));
    if (!expander)
      throw new Error(
        "Recipe has no admitted compiler for its exact definition pin: " + component.id,
      );
    const context = {
      componentId: component.id,
      config: component.config,
      projectId: input.projectId,
      project: input.project,
      designHash: admitted.hash,
      initialTopology: input.initialTopology,
      ...(input.observation ? { observation: input.observation } : {}),
    };
    const expanded = expander.expand(context);
    const observed = expander.observedSources?.(context) ?? [];
    if (observed.some((item) => item.componentId !== component.id))
      throw new Error("Recipe compiler emitted another component's source dependencies");
    validateObservedSources(observed, input);
    observedSources.push(...observed);
    if (expanded.some((item) => item.componentId !== component.id))
      throw new Error("Recipe compiler emitted another component's inventory");
    inventory.push(...expanded);
  }
  const byId = new Map(inventory.map((item) => [item.id, item]));
  if (byId.size !== inventory.length) throw new Error("Duplicate compiler inventory ID");
  const sources = new Map<string, { componentId: string; file: GameSourceFile }>();
  for (const component of admitted.spec.components) {
    if (component.kind !== "source_package") continue;
    for (const file of component.files) {
      if (!file.placement)
        throw new Error(
          "Source installation needs an explicit editor placement: " + component.id + "/" + file.id,
        );
      if (file.placement.kind === "observed") {
        if (
          file.content.kind !== "locked" ||
          file.role !== "module" ||
          file.placement.target.className !== "ModuleScript"
        )
          throw new Error("Observed source placement requires an exact locked module");
        const observed = {
          componentId: component.id,
          fileId: file.id,
          target: file.placement.target,
          sourceHash: file.content.sourceHash,
          utf8Bytes: file.content.utf8Bytes,
          imports: file.imports,
        };
        validateObservedSources([observed], input);
        observedSources.push(observed);
        continue;
      }
      const id = file.placement.operationId;
      if (sources.has(id) || byId.has(id))
        throw new Error("Source placement operation ID is duplicated");
      sources.set(id, { componentId: component.id, file });
    }
  }
  const visiting = new Set<string>();
  const resolveSource = (id: string): GameInventoryItem => {
    const prior = byId.get(id);
    if (prior) return prior;
    const source = sources.get(id);
    if (!source || !source.file.placement) throw new Error("Generated parent is undeclared: " + id);
    if (visiting.has(id)) throw new Error("Source placement parent cycle");
    visiting.add(id);
    const placement = source.file.placement;
    if (placement.kind === "observed")
      throw new Error("Observed source dependencies have no allocation operation");
    let change: CreatorPlanChange;
    const dependencies: string[] = [];
    if (placement.kind === "create") {
      let parent = placement.parent;
      if (parent.kind === "generated") {
        const generated = resolveSource(parent.operationId);
        if (generated.change.kind !== "create")
          throw new Error("Generated parent must be a create");
        dependencies.push(generated.id);
        parent = gameGeneratedTarget({
          projectId: input.projectId,
          operationId: generated.id,
          path: generated.change.path,
          className: generated.change.className,
        });
      }
      if (
        source.file.role === "module"
          ? placement.className !== "ModuleScript"
          : placement.className === "ModuleScript"
      )
        throw new Error("Source role and installed script class disagree");
      if (placement.className === "LocalScript" && source.file.context !== "client")
        throw new Error("LocalScript placement requires client context");
      if (placement.className === "Script" && source.file.context !== "server")
        throw new Error("Script placement requires server context");
      change = {
        id,
        kind: "create",
        path: parent.path + "/" + placement.name,
        parent,
        className: placement.className,
        initialization: "inline_source_required",
      };
    } else {
      if (!["Script", "LocalScript", "ModuleScript"].includes(placement.target.className))
        throw new Error("Source edit target is not a script");
      change = {
        id,
        kind: "edit_source",
        target: placement.target,
        expectedClass: placement.target.className as "Script" | "LocalScript" | "ModuleScript",
      };
    }
    const item: GameInventoryItem = {
      id,
      componentId: source.componentId,
      change,
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies,
      source: { fileId: source.file.id, content: source.file.content },
      ...(placement.kind === "edit_source"
        ? {
            beforeSourceHash: placement.beforeSourceHash,
            beforeSourceBytes: placement.beforeSourceBytes,
          }
        : {}),
    };
    visiting.delete(id);
    byId.set(id, item);
    inventory.push(item);
    return item;
  };
  for (const id of sources.keys()) resolveSource(id);
  for (let index = 0; index < inventory.length; index++) {
    const item = inventory[index]!;
    const dependencies = new Set(item.dependencies);
    const component = admitted.spec.components.find((entry) => entry.id === item.componentId)!;
    if (component.kind === "source_package" && item.source)
      for (const imported of component.files.find((file) => file.id === item.source!.fileId)!
        .imports) {
        const dependency = inventory.find(
          (entry) =>
            entry.componentId === imported.componentId && entry.source?.fileId === imported.fileId,
        );
        if (dependency) dependencies.add(dependency.id);
      }
    // Artifact edges are directed dependencies: `from` consumes `to`.
    for (const edge of admitted.spec.artifactDependencies)
      if (edge.from === item.componentId)
        for (const dependency of inventory)
          if (dependency.componentId === edge.to) dependencies.add(dependency.id);
    inventory[index] = { ...item, dependencies: [...dependencies].sort() };
  }
  return {
    inventory: inventory.sort((a, b) => compareGameStrings(a.id, b.id)),
    observedSources,
    design: admitted.spec,
    designHash: admitted.hash,
  };
}

export function compileGamePlan(
  input: DesignInput & {
    readonly sessionId: string;
    readonly observedRevisionHash: string;
    readonly inventory: readonly GameInventoryItem[];
    readonly observedSources?: readonly GameObservedSourceArtifact[];
    readonly policy?: GameCompilerPolicy;
  },
): GamePlan {
  assertBoundedGameJson(input.inventory, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
  });
  assertBoundedGameJson(input.initialTopology, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
  });
  const admitted = validateGameDesignSpec(input.design, {
    registry: input.registry,
    policy: input.admissionPolicy ?? DEFAULT_GAME_ADMISSION_POLICY,
  });
  if (admitted.status !== "eligible")
    throw new Error("Game design is not eligible for compilation");
  validateObservedSources(input.observedSources ?? [], input);
  if (
    input.observedSources?.length &&
    input.observation?.revision.hash !== input.observedRevisionHash
  )
    throw new Error("Source dependency observation revision differs from the compiled plan");
  const payload = {
    kind: "GamePlan" as const,
    design: admitted.spec,
    designHash: admitted.hash,
    projectId: input.projectId,
    project: input.project,
    sessionId: input.sessionId,
    observedRevisionHash: input.observedRevisionHash,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    compilerAbi: GAME_COMPILER_ABI,
    policy: POLICY_SCHEMA.parse(input.policy ?? DEFAULT_GAME_COMPILER_POLICY),
    initialTopology: [...input.initialTopology].sort((a, b) =>
      compareGameStrings(studioObjectIdentityKey(a.identity), studioObjectIdentityKey(b.identity)),
    ),
    observedSources: [...(input.observedSources ?? [])]
      .map((source) => ({
        ...source,
        imports: [...source.imports].sort((a, b) =>
          compareGameStrings(a.componentId + "/" + a.fileId, b.componentId + "/" + b.fileId),
        ),
      }))
      .sort((a, b) =>
        compareGameStrings(a.componentId + "/" + a.fileId, b.componentId + "/" + b.fileId),
      ),
    inventory: input.inventory
      .map((item) => ({
        ...item,
        valueSlots: item.valueSlots
          .map((slot) => ({
            ...slot,
            schema: canonicalGameDataSchema(
              slot.schema,
              input.admissionPolicy ?? DEFAULT_GAME_ADMISSION_POLICY,
            ),
          }))
          .sort((a, b) => compareGameStrings(a.id, b.id)),
        dependencies: [...item.dependencies].sort(),
        removedAttributes: [...item.removedAttributes].sort(),
      }))
      .sort((a, b) => compareGameStrings(a.id, b.id)),
  };
  const hash = contentHash(stableJson(payload));
  const plan: GamePlan = JSON.parse(
    stableJson({ ...payload, id: "game_plan_" + hash.slice(0, 24), hash }),
  ) as GamePlan;
  assertGamePlan(plan);
  return plan;
}

export function assertGamePlan(value: unknown): asserts value is GamePlan {
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
    maximumStringUtf8Bytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
  });
  const plan = value as unknown as GamePlan;
  if (
    plan.kind !== "GamePlan" ||
    plan.compilerAbi !== GAME_COMPILER_ABI ||
    plan.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
    !isHash(plan.hash) ||
    !isHash(plan.observedRevisionHash) ||
    !isHash(plan.designHash) ||
    !plan.projectId ||
    !plan.sessionId ||
    !Array.isArray(plan.inventory) ||
    !Array.isArray(plan.initialTopology) ||
    !Array.isArray(plan.observedSources)
  )
    throw new Error("Invalid GamePlan envelope");
  const policy = POLICY_SCHEMA.parse(plan.policy);
  if (
    plan.inventory.length < 1 ||
    plan.inventory.length > policy.maximumOperations ||
    Buffer.byteLength(stableJson(plan), "utf8") > policy.maximumCanonicalBytes
  )
    throw new Error("GamePlan exceeds compiler admission policy");
  if (contentHash(stableJson(plan.design)) !== plan.designHash)
    throw new Error("GamePlan design identity mismatch");
  const { id, hash, ...payload } = plan;
  const expected = contentHash(stableJson(payload));
  if (hash !== expected || id !== "game_plan_" + expected.slice(0, 24))
    throw new Error("GamePlan identity mismatch");
  const ids = new Set<string>();
  const slots = new Set<string>();
  const components = new Map(plan.design.components.map((component) => [component.id, component]));
  const sourcePlacements = new Map<string, { componentId: string; file: GameSourceFile }>();
  for (const component of plan.design.components)
    if (component.kind === "source_package")
      for (const file of component.files) {
        if (!file.placement) throw new Error("Compiled source package contains an unplaced file");
        if (file.placement.kind === "observed") {
          const observed = plan.observedSources.filter(
            (entry) => entry.componentId === component.id && entry.fileId === file.id,
          );
          if (
            observed.length !== 1 ||
            file.content.kind !== "locked" ||
            stableJson(observed[0]) !==
              stableJson({
                componentId: component.id,
                fileId: file.id,
                target: file.placement.target,
                sourceHash: file.content.sourceHash,
                utf8Bytes: file.content.utf8Bytes,
                imports: file.imports,
              })
          )
            throw new Error("Compiled observed source differs from its exact package declaration");
        } else
          sourcePlacements.set(file.placement.operationId, { componentId: component.id, file });
      }
  for (const item of plan.inventory as readonly GameInventoryItem[]) {
    if (
      !item ||
      ids.has(item.id) ||
      item.id !== item.change.id ||
      !components.has(item.componentId)
    )
      throw new Error("Invalid inventory identity or provenance");
    ids.add(item.id);
    const parsed = PLAN_CHANGE_SCHEMA.parse(item.change);
    if (stableJson(parsed) !== stableJson(item.change))
      throw new Error("Inventory change is not canonical creator authority");
    const className =
      item.change.kind === "create" ? item.change.className : item.change.target.className;
    const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find(
      (entry) => entry.name === className,
    );
    if (!manifestClass || (item.change.kind === "create" && !manifestClass.creatable))
      throw new Error("Inventory class lacks an admitted authoring strategy");
    const propertyNames = new Set<string>();
    const families = new Set<string>();
    for (const [name, value] of Object.entries(item.lockedProperties)) {
      const property = manifestClass.properties.find((entry) => entry.name === name);
      if (!property) throw new Error("Locked property is outside the authoring manifest");
      assertStudioValueForProperty(value, property);
      propertyNames.add(name);
      if (property.setterFamily) {
        if (families.has(property.setterFamily))
          throw new Error("Coupled property setters conflict");
        families.add(property.setterFamily);
      }
    }
    for (const slot of item.valueSlots) {
      const property = manifestClass.properties.find((entry) => entry.name === slot.propertyName);
      if (!property || slots.has(slot.id) || propertyNames.has(slot.propertyName))
        throw new Error("Value slot conflicts with exact inventory");
      slots.add(slot.id);
      propertyNames.add(slot.propertyName);
      canonicalGameDataSchema(slot.schema, DEFAULT_GAME_ADMISSION_POLICY);
      if (property.setterFamily) {
        if (families.has(property.setterFamily)) throw new Error("Coupled property slots conflict");
        families.add(property.setterFamily);
      }
    }
    if (
      !["create", "update", "move"].includes(item.change.kind) &&
      (propertyNames.size || Object.keys(item.attributes).length || item.removedAttributes.length)
    )
      throw new Error("Operation has incompatible property payload");
    const sourceBearing =
      item.change.kind === "edit_source" ||
      (item.change.kind === "create" &&
        ["Script", "LocalScript", "ModuleScript"].includes(className));
    if (sourceBearing !== (item.source !== undefined))
      throw new Error("Exact script inventory requires exactly one source slot");
    if (
      item.change.kind === "edit_source" &&
      (!isHash(item.beforeSourceHash) ||
        !Number.isSafeInteger(item.beforeSourceBytes) ||
        item.beforeSourceBytes! < 0)
    )
      throw new Error("Source edit requires observed source hash and byte count");
    if (["update", "move", "delete"].includes(item.change.kind) && !isHash(item.beforeHash))
      throw new Error("Existing mutation requires exact observed object hash");
    const placement = sourcePlacements.get(item.id);
    if (
      components.get(item.componentId)?.kind === "source_package" &&
      item.source &&
      (!placement ||
        placement.componentId !== item.componentId ||
        placement.file.id !== item.source.fileId ||
        stableJson(placement.file.content) !== stableJson(item.source.content))
    )
      throw new Error("Source inventory is not bound to its declared package file");
    sourcePlacements.delete(item.id);
    if (
      new Set(item.dependencies).size !== item.dependencies.length ||
      new Set(item.removedAttributes).size !== item.removedAttributes.length
    )
      throw new Error("Duplicate inventory dependencies or removed attributes");
  }
  if (sourcePlacements.size)
    throw new Error("Compiled inventory omitted declared source placements");
  const materializedSources = new Set(
    plan.inventory.flatMap((item) =>
      item.source ? [item.componentId + "/" + item.source.fileId] : [],
    ),
  );
  for (const source of plan.observedSources) {
    const key = source.componentId + "/" + source.fileId;
    if (
      materializedSources.has(key) ||
      !components.has(source.componentId) ||
      !isHash(source.sourceHash) ||
      !Number.isSafeInteger(source.utf8Bytes) ||
      source.utf8Bytes < 0 ||
      source.target.className !== "ModuleScript"
    )
      throw new Error("Invalid or ambiguous observed source dependency");
    const nodes = plan.initialTopology.filter(
      (node) =>
        studioObjectIdentityKey(node.identity) === studioObjectIdentityKey(source.target.identity),
    );
    if (
      nodes.length !== 1 ||
      nodes[0]!.path !== source.target.path ||
      nodes[0]!.className !== source.target.className
    )
      throw new Error("Observed source dependency target is absent from exact topology");
    if (
      plan.inventory.some(
        (item) =>
          item.change.kind !== "create" &&
          studioObjectIdentityKey(item.change.target.identity) ===
            studioObjectIdentityKey(source.target.identity),
      )
    )
      throw new Error("Observed source dependency is also mutated by the candidate");
    materializedSources.add(key);
  }
  for (const source of plan.observedSources) {
    if (!Array.isArray(source.imports))
      throw new Error("Observed source dependency requires its declared import closure");
    const seen = new Set<string>();
    for (const imported of source.imports) {
      const key = imported.componentId + "/" + imported.fileId;
      if (!materializedSources.has(key) || seen.has(key))
        throw new Error("Observed source import closure is missing or duplicated");
      seen.add(key);
    }
  }
  const sourceDependencies = new Map(
    [...materializedSources].map((key) => [key, new Set<string>()]),
  );
  for (const source of plan.observedSources)
    sourceDependencies.set(
      source.componentId + "/" + source.fileId,
      new Set(
        source.imports.map(
          (entry: GameObservedSourceArtifact["imports"][number]) =>
            entry.componentId + "/" + entry.fileId,
        ),
      ),
    );
  for (const component of plan.design.components)
    if (component.kind === "source_package")
      for (const file of component.files)
        sourceDependencies.set(
          component.id + "/" + file.id,
          new Set(file.imports.map((entry) => entry.componentId + "/" + entry.fileId)),
        );
  gameDependencyOrder(sourceDependencies);
  for (const component of plan.design.components)
    if (component.kind === "source_package")
      for (const file of component.files)
        for (const imported of file.imports)
          if (!materializedSources.has(imported.componentId + "/" + imported.fileId))
            throw new Error(
              "Requested source export was not materialized by its exact recipe/package",
            );
  const dependencies = new Map<string, Set<string>>(
    plan.inventory.map((item: GameInventoryItem) => [item.id, new Set(item.dependencies)]),
  );
  for (const item of plan.inventory)
    for (const dependency of item.dependencies)
      if (!ids.has(dependency)) throw new Error("Inventory dependency is undeclared");
  gameDependencyOrder(dependencies);
  const topology = compileCreatorTransactionTopology({
    initial: plan.initialTopology,
    operations: plan.inventory.map((item) => gameInventoryOperation(plan, item)),
  });
  for (const source of plan.observedSources) {
    const node = topology.finalNodes.find(
      (candidate) =>
        studioObjectIdentityKey(candidate.identity) ===
        studioObjectIdentityKey(source.target.identity),
    );
    if (!node || node.path !== source.target.path || node.className !== source.target.className)
      throw new Error("Candidate moves or deletes an observed source dependency");
  }
}

function validateObservedSources(
  sources: readonly GameObservedSourceArtifact[],
  input: DesignInput,
): void {
  assertBoundedGameJson(sources, DEFAULT_GAME_ADMISSION_POLICY);
  for (const source of sources) {
    const component = input.design.components.find((entry) => entry.id === source.componentId);
    let expectedContext: "shared" | "server" | "client";
    if (component?.kind === "recipe_instance") {
      const exported = resolveGameDefinition(
        input.registry,
        component.definition,
        input.admissionPolicy ?? DEFAULT_GAME_ADMISSION_POLICY,
      ).sourceExports.find((entry) => entry.id === source.fileId);
      if (!exported)
        throw new Error("Observed source is not an export of its exact trusted recipe definition");
      expectedContext = exported.context;
    } else if (component?.kind === "source_package") {
      const file = component.files.find((entry) => entry.id === source.fileId);
      if (
        !file ||
        file.placement?.kind !== "observed" ||
        file.content.kind !== "locked" ||
        file.content.sourceHash !== source.sourceHash ||
        file.content.utf8Bytes !== source.utf8Bytes ||
        stableJson(file.placement.target) !== stableJson(source.target) ||
        stableJson(file.imports.map((entry) => entry.componentId + "/" + entry.fileId).sort()) !==
          stableJson(source.imports.map((entry) => entry.componentId + "/" + entry.fileId).sort())
      )
        throw new Error("Observed source differs from the exact locked source package file");
      expectedContext = file.context;
    } else throw new Error("Observed source component is undeclared");
    const instances =
      input.observation?.instances.filter(
        (instance) =>
          instance.path === source.target.path &&
          instance.className === "ModuleScript" &&
          stableJson(instance.identity) === stableJson(source.target.identity),
      ) ?? [];
    const scripts =
      input.observation?.scripts.filter(
        (script) =>
          script.documentId === instances[0]?.objectId &&
          script.path === source.target.path &&
          script.className === "ModuleScript",
      ) ?? [];
    if (
      instances.length !== 1 ||
      scripts.length !== 1 ||
      scripts[0]!.sourceHash !== source.sourceHash ||
      scripts[0]!.executionContext !== expectedContext ||
      scripts[0]!.utf8Bytes !== source.utf8Bytes
    )
      throw new Error("Observed source dependency lacks exact captured hash and byte evidence");
  }
}

/** Source fields are filled only by materialization, never by the structural compiler. */
export type GamePendingOperation =
  | Exclude<StudioChangeOperation, { kind: "edit_source" }>
  | Omit<
      Extract<StudioChangeOperation, { kind: "edit_source" }>,
      "edits" | "finalSourceHash" | "finalByteCount"
    >;
export function gameInventoryOperation(
  plan: Pick<GamePlan, "projectId">,
  item: GameInventoryItem,
): GamePendingOperation {
  const change = item.change;
  const operationId = creatorCompiledIdentity(plan.projectId, item.id, "creator_operation");
  if (change.kind === "create")
    return {
      id: operationId,
      planChangeId: item.id,
      kind: "create",
      tempId: creatorCompiledIdentity(plan.projectId, item.id, "creator_temp"),
      target: gameGeneratedTarget({
        projectId: plan.projectId,
        operationId: item.id,
        path: change.path,
        className: change.className,
      }),
      parent: change.parent,
      className: change.className,
      name: change.path.split("/").at(-1)!,
      properties: { ...item.lockedProperties },
      attributes: { ...item.attributes },
    };
  const common = {
    id: operationId,
    planChangeId: item.id,
    target: change.target,
    ...(change.target.identity.kind === "studio_ephemeral"
      ? {
          enrollment: {
            identity: change.target.identity,
            stableId: creatorCompiledIdentity(plan.projectId, item.id, "creator_enrollment"),
          },
        }
      : {}),
  };
  if (change.kind === "edit_source")
    return {
      ...common,
      kind: "edit_source",
      target: change.target as Extract<StudioChangeOperation, { kind: "edit_source" }>["target"],
      beforeSourceHash: item.beforeSourceHash!,
    };
  if (change.kind === "delete") return { ...common, kind: "delete", beforeHash: item.beforeHash! };
  const values = {
    ...common,
    beforeHash: item.beforeHash!,
    properties: { ...item.lockedProperties },
    attributes: { ...item.attributes },
    removedAttributes: [...item.removedAttributes],
  };
  if (change.kind === "update") return { ...values, kind: "update" };
  return { ...values, kind: "move", parent: change.parent, name: change.toPath.split("/").at(-1)! };
}

export function gameDependencyOrder(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const remaining = new Map([...edges].map(([id, deps]) => [id, new Set(deps)]));
  const result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length) throw new Error("Compiler artifact dependency cycle");
    for (const id of ready) {
      result.push(id);
      remaining.delete(id);
    }
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return result;
}
export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
