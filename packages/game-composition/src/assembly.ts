import {
  compositionConfigDataSchema,
  COMPOSITION_NAME_SCHEMA,
  COMPOSITION_MEMBER_SCHEMA,
} from "./config-schema.js";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import { entityId } from "../../game-ir/src/primitives.js";
import {
  gameGeneratedTarget,
  gameDependencyOrder,
  gameInventoryOperation,
  type GameRecipeExpanderInput,
} from "../../game-compiler/src/index.js";
import { compileCreatorTransactionTopology } from "../../creator-session/src/transaction-topology.js";
import type { StudioInstanceTarget } from "../../creator-session/src/index.js";
import { STUDIO_CAPABILITY_MANIFEST } from "../../studio-evidence/src/index.js";
import {
  CompositionError,
  boundedConfig,
  itemId,
  uniqueById,
  type CompositionOutput,
} from "./common.js";
import { compileStudioPatch, type StudioPatchConfig } from "./patch.js";

const property = z
  .object({ name: COMPOSITION_MEMBER_SCHEMA, valueJson: z.string().max(65536) })
  .strict();
const reference = z
  .object({
    propertyName: z.string().min(1).max(100),
    target: z.object({ kind: z.enum(["local", "shared"]), id: entityId.min(1).max(64) }).strict(),
  })
  .strict();
const valueSlot = z
  .object({
    id: entityId.min(1).max(64),
    propertyName: z.string().min(1).max(100),
    schemaJson: z.string().max(65536),
  })
  .strict();
const placedTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine"), id: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("object"), id: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      kind: z.literal("copy"),
      id: entityId.min(1).max(64),
      nodeId: entityId.min(1).max(64),
    })
    .strict(),
]);
const sharedTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object"), id: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      kind: z.literal("copy"),
      id: entityId.min(1).max(64),
      nodeId: entityId.min(1).max(64),
    })
    .strict(),
]);
const node = z
  .object({
    id: entityId.min(1).max(64),
    name: COMPOSITION_NAME_SCHEMA,
    className: z.string().min(1).max(64),
    parentId: entityId.min(1).max(64).optional(),
    properties: z.array(property).max(256),
    references: z.array(reference).max(256),
    valueSlots: z.array(valueSlot).max(256),
    attributes: z.array(property).max(64),
    dependencies: z.array(entityId.min(1).max(64)).max(4096),
  })
  .strict();
const override = z
  .object({
    nodeId: entityId.min(1).max(64),
    name: COMPOSITION_NAME_SCHEMA.optional(),
    properties: z.array(property).max(256).optional(),
    references: z.array(reference).max(256).optional(),
    attributes: z.array(property).max(64).optional(),
  })
  .strict();
export const PROJECT_ASSEMBLY_CONFIG_SCHEMA = z
  .object({
    templates: z
      .array(
        z.object({ id: entityId.min(1).max(64), nodes: z.array(node).min(1).max(4096) }).strict(),
      )
      .min(1)
      .max(128),
    copies: z
      .array(
        z
          .object({
            id: entityId
              .min(1)
              .max(64)
              .describe(
                "Copy ID. Each created node exposes output alias copy/<copy-id>/<node-id> for source placement component_output parents.",
              ),
            templateId: entityId.min(1).max(64),
            name: COMPOSITION_NAME_SCHEMA,
            parent: placedTarget,
            overrides: z.array(override).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    sharedReferences: z
      .array(z.object({ id: entityId.min(1).max(64), target: sharedTarget }).strict())
      .max(4096),
  })
  .strict();
export type GameAssemblyConfig = z.infer<typeof PROJECT_ASSEMBLY_CONFIG_SCHEMA>;

export const PROJECT_ASSEMBLY_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  id: "project-assembly",
  abi: "1",
  sourceExports: [],
  ports: [],
  configSchema: compositionConfigDataSchema(PROJECT_ASSEMBLY_CONFIG_SCHEMA),
  obligations: [
    {
      id: "assembly-readback",
      description:
        "Reconcile every independently placed copy, remapped reference and approved override against exact editor readback.",
      evidence: "studio_edit",
    },
  ],
};

function patchId(copyId: string, nodeId: string): string {
  entityId.parse(copyId);
  entityId.parse(nodeId);
  return "assembly-" + contentHash(stableJson([copyId, nodeId])).slice(0, 40);
}
/** Stable source_package generated-parent anchor; display names and ordering do not affect it. */
export function gameAssemblyOperationId(
  componentId: string,
  copyId: string,
  nodeId: string,
): string {
  entityId.parse(componentId);
  return itemId({ componentId, projectId: "", designHash: "" }, patchId(copyId, nodeId));
}

type AssemblyContext = Pick<
  GameRecipeExpanderInput,
  "componentId" | "projectId" | "designHash" | "initialTopology" | "observation"
>;
type Node = z.infer<typeof node>;
type Reference = z.infer<typeof reference>;

function named<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const name = key(value);
    if (result.has(name))
      throw new CompositionError(
        "duplicate_property",
        "Assembly declarations must be unique: " + name,
      );
    result.set(name, value);
  }
  return result;
}
function validateNode(value: Node): void {
  const fields = [
    ...value.properties.map((entry) => entry.name),
    ...value.references.map((entry) => entry.propertyName),
    ...value.valueSlots.map((entry) => entry.propertyName),
  ];
  named(fields, (name) => name);
  named(value.attributes, (entry) => entry.name);
  uniqueById(value.valueSlots);
  named(value.dependencies, (id) => id);
  for (const entry of value.properties) {
    const parsed: unknown = JSON.parse(entry.valueJson);
    boundedConfig(parsed);
    if (
      parsed &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      parsed.kind === "instance_ref" &&
      "state" in parsed &&
      parsed.state === "reference"
    )
      throw new CompositionError(
        "invalid_reference",
        "Assembly instance references must use named local/shared bindings",
      );
  }
}

/** Expands reusable data into the existing patch and transaction-topology paths; performs no writes. */
export function compileProjectAssembly(
  context: AssemblyContext,
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = PROJECT_ASSEMBLY_CONFIG_SCHEMA.parse(input);
  const templates = uniqueById(config.templates);
  const copies = uniqueById(config.copies);
  const shared = uniqueById(config.sharedReferences);
  const templateNodes = new Map(
    [...templates].map(([id, template]) => [id, uniqueById(template.nodes)]),
  );
  for (const template of templates.values()) {
    const nodes = templateNodes.get(template.id)!;
    if (template.nodes.filter((entry) => entry.parentId === undefined).length !== 1)
      throw new CompositionError(
        "invalid_parent",
        "Every assembly template requires one explicit root",
      );
    const dependencies = new Map<string, Set<string>>();
    for (const entry of template.nodes) {
      validateNode(entry);
      for (const dependency of entry.dependencies)
        if (!nodes.has(dependency))
          throw new CompositionError(
            "invalid_reference",
            "Unknown template dependency: " + dependency,
          );
      for (const reference of entry.references)
        if (
          reference.target.kind === "local"
            ? !nodes.has(reference.target.id)
            : !shared.has(reference.target.id)
        )
          throw new CompositionError(
            "invalid_reference",
            "Unknown local reference: " + reference.target.id,
          );
      if (entry.parentId !== undefined && !nodes.has(entry.parentId))
        throw new CompositionError(
          "invalid_reference",
          "Unknown template parent: " + entry.parentId,
        );
      dependencies.set(
        entry.id,
        new Set([...entry.dependencies, ...(entry.parentId ? [entry.parentId] : [])]),
      );
    }
    gameDependencyOrder(dependencies);
  }
  const copyNode = (copyId: string, nodeId: string): string => {
    const copy = copies.get(copyId);
    if (!copy || !templateNodes.get(copy.templateId)?.has(nodeId))
      throw new CompositionError(
        "invalid_reference",
        "Unknown assembly copy/node: " + copyId + "/" + nodeId,
      );
    return patchId(copyId, nodeId);
  };
  const observed = new Map(
    context.observation?.instances.map((entry) => [entry.objectId, entry]) ?? [],
  );
  const observedTarget = (id: string): StudioInstanceTarget => {
    const entry = observed.get(id);
    if (!entry)
      throw new CompositionError(
        "invalid_reference",
        "Shared object was not supplied by the current observation",
      );
    return {
      kind: "instance",
      identity: entry.identity,
      path: entry.path,
      className: entry.className,
    };
  };
  for (const reference of shared.values()) {
    if (reference.target.kind === "copy") copyNode(reference.target.id, reference.target.nodeId);
    else observedTarget(reference.target.id);
  }
  const operations: Array<Extract<StudioPatchConfig["operations"][number], { kind: "create" }>> =
    [];
  const outputIds = new Map<string, string>();
  const references = new Map<
    string,
    Array<{ propertyName: string; generatedId?: string; target?: StudioInstanceTarget }>
  >();
  for (const copy of [...copies.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const nodes = templateNodes.get(copy.templateId);
    if (!nodes)
      throw new CompositionError(
        "invalid_reference",
        "Unknown assembly template: " + copy.templateId,
      );
    if (operations.length + nodes.size > 4096)
      throw new CompositionError(
        "resource_exhausted",
        "Assembly expansion exceeds the 4096-operation patch profile",
      );
    const overrides = named(copy.overrides, (entry) => entry.nodeId);
    for (const id of overrides.keys())
      if (!nodes.has(id))
        throw new CompositionError(
          "invalid_reference",
          "Override references an unknown template node",
        );
    for (const template of [...nodes.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const edit = overrides.get(template.id);
      if (template.parentId === undefined && edit?.name !== undefined)
        throw new CompositionError(
          "invalid_name",
          "Set a copy's root name in its placement, not a node override",
        );
      const properties = named(template.properties, (entry) => entry.name);
      const refs = named(template.references, (entry) => entry.propertyName);
      const slots = named(template.valueSlots, (entry) => entry.propertyName);
      const attrs = named(template.attributes, (entry) => entry.name);
      named(
        [
          ...(edit?.properties ?? []).map((entry) => entry.name),
          ...(edit?.references ?? []).map((entry) => entry.propertyName),
        ],
        (name) => name,
      );
      for (const entry of edit?.properties ?? []) {
        properties.set(entry.name, entry);
        refs.delete(entry.name);
        slots.delete(entry.name);
      }
      for (const entry of edit?.references ?? []) {
        refs.set(entry.propertyName, entry);
        properties.delete(entry.propertyName);
        slots.delete(entry.propertyName);
      }
      for (const entry of named(edit?.attributes ?? [], (entry) => entry.name).values())
        attrs.set(entry.name, entry);
      const expanded = {
        ...template,
        properties: [...properties.values()],
        references: [...refs.values()],
        valueSlots: [...slots.values()],
        attributes: [...attrs.values()],
      };
      validateNode(expanded);
      const id = patchId(copy.id, template.id);
      outputIds.set(itemId(context, id), "copy/" + copy.id + "/" + template.id);
      const bindReference = (reference: Reference) => {
        if (reference.target.kind === "local")
          return {
            propertyName: reference.propertyName,
            generatedId: copyNode(copy.id, reference.target.id),
          };
        const namedReference = shared.get(reference.target.id);
        if (!namedReference)
          throw new CompositionError(
            "invalid_reference",
            "Unknown shared reference: " + reference.target.id,
          );
        return namedReference.target.kind === "copy"
          ? {
              propertyName: reference.propertyName,
              generatedId: copyNode(namedReference.target.id, namedReference.target.nodeId),
            }
          : {
              propertyName: reference.propertyName,
              target: observedTarget(namedReference.target.id),
            };
      };
      references.set(id, expanded.references.map(bindReference));
      const parent =
        template.parentId !== undefined
          ? { kind: "generated" as const, id: copyNode(copy.id, template.parentId) }
          : copy.parent.kind === "copy"
            ? { kind: "generated" as const, id: copyNode(copy.parent.id, copy.parent.nodeId) }
            : copy.parent;
      operations.push({
        id,
        kind: "create",
        className: template.className,
        name: template.parentId === undefined ? copy.name : (edit?.name ?? template.name),
        parent,
        properties: expanded.properties,
        valueSlots: expanded.valueSlots,
        attributes: expanded.attributes,
        removedAttributes: [],
        dependencies: expanded.dependencies
          .map((dependency) => copyNode(copy.id, dependency))
          .sort(),
      });
    }
  }
  // Resolve exact generated identities and paths with the same patch lowerer before filling references.
  const skeleton = compileStudioPatch(context, { operations });
  const generated = new Map(skeleton.inventory.map((item) => [item.id, item]));
  for (const operation of operations) {
    for (const reference of references.get(operation.id)!) {
      let target = reference.target;
      if (reference.generatedId) {
        const item = generated.get(itemId(context, reference.generatedId))!;
        if (item.change.kind !== "create")
          throw new CompositionError(
            "invalid_reference",
            "Assembly reference target must be allocated",
          );
        target = gameGeneratedTarget({
          projectId: context.projectId,
          operationId: item.id,
          path: item.change.path,
          className: item.change.className,
        });
      }
      if (!target)
        throw new CompositionError("invalid_reference", "Assembly reference has no exact target");
      const descriptor = STUDIO_CAPABILITY_MANIFEST.classes
        .find((entry) => entry.name === operation.className)
        ?.properties.find((entry) => entry.name === reference.propertyName);
      if (!descriptor?.referenceClass)
        throw new CompositionError(
          "unsupported_property",
          "Named references require an admitted instance-reference property",
        );
      operation.properties.push({
        name: reference.propertyName,
        valueJson: stableJson({
          kind: "instance_ref",
          state: "reference",
          identity: target.identity,
          path: target.path,
          className: target.className,
          expectedClass: descriptor.referenceClass,
        }),
      });
    }
  }
  const result = compileStudioPatch(context, { operations });
  compileCreatorTransactionTopology({
    initial: context.initialTopology,
    operations: result.inventory.map((item) => gameInventoryOperation(context, item)),
  });
  return {
    ...result,
    inventory: result.inventory
      .map((item) => ({
        ...item,
        outputId: outputIds.get(item.id)!,
        valueSlots: [...item.valueSlots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    obligations: PROJECT_ASSEMBLY_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "Copies are independently owned editor allocations; later template changes do not propagate into installed copies automatically.",
      "Sources remain ordinary source_package declarations placed under gameAssemblyOperationId anchors; source text and imports are never rewritten.",
      "Expansion grants no mutation authority or runtime proof. Existing compiler, ownership, preflight and readback checks remain authoritative.",
    ],
  };
}

export const PROJECT_ASSEMBLY_EXPANDER = {
  definition: gameRecipeDefinitionLock(PROJECT_ASSEMBLY_DEFINITION),
  expand: (input: GameRecipeExpanderInput) => compileProjectAssembly(input, input.config).inventory,
};
