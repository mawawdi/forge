import {
  compositionConfigDataSchema,
  COMPOSITION_ID_SCHEMA,
  COMPOSITION_NAME_SCHEMA,
  COMPOSITION_MEMBER_SCHEMA,
} from "./config-schema.js";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
} from "../../game-ir/src/index.js";
import { GAME_DATA_SCHEMA, canonicalGameDataSchema } from "../../game-ir/src/recipes.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  assertStudioValue,
  assertStudioValueForProperty,
  canonicalStudioValue,
  sortedStudioMutationPropertyNames,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import type {
  CreatorPlanChange,
  CreatorProjectIndexView,
  StudioMutationParent,
  StudioNonScriptWritableClass,
  StudioWritableClass,
} from "../../creator-session/src/index.js";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  CompositionError,
  boundedConfig,
  createItem,
  engineParent,
  itemId,
  outputParent,
  uniqueById,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";

const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine"), id: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("object"), id: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("generated"), id: COMPOSITION_ID_SCHEMA }).strict(),
]);
const operationFields = {
  id: COMPOSITION_ID_SCHEMA.describe(
    "Local patch operation ID. A create operation exposes this exact ID as a component_output parent alias; the host derives its private inventory identity.",
  ),
  properties: z
    .array(z.object({ name: COMPOSITION_MEMBER_SCHEMA, valueJson: z.string().max(65536) }).strict())
    .max(256),
  valueSlots: z
    .array(
      z
        .object({
          id: COMPOSITION_ID_SCHEMA,
          propertyName: COMPOSITION_MEMBER_SCHEMA,
          schemaJson: z.string().max(65536),
        })
        .strict(),
    )
    .max(256),
  attributes: z
    .array(z.object({ name: COMPOSITION_MEMBER_SCHEMA, valueJson: z.string().max(65536) }).strict())
    .max(64),
  removedAttributes: z.array(COMPOSITION_MEMBER_SCHEMA).max(64),
  dependencies: z.array(COMPOSITION_ID_SCHEMA).max(4096),
};
const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...operationFields,
      kind: z.literal("create"),
      className: z.string().min(1).max(64),
      parent: parentSchema,
      name: COMPOSITION_NAME_SCHEMA,
      removedAttributes: operationFields.removedAttributes.max(0),
    })
    .strict(),
  z
    .object({
      ...operationFields,
      kind: z.literal("update"),
      objectId: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      ...operationFields,
      kind: z.literal("move"),
      objectId: z.string().min(1).max(1024),
      parent: parentSchema,
      name: COMPOSITION_NAME_SCHEMA,
    })
    .strict(),
  z
    .object({
      ...operationFields,
      kind: z.literal("delete"),
      objectId: z.string().min(1).max(1024),
      properties: operationFields.properties.max(0),
      valueSlots: operationFields.valueSlots.max(0),
      attributes: operationFields.attributes.max(0),
      removedAttributes: operationFields.removedAttributes.max(0),
    })
    .strict(),
]);
export const STUDIO_PATCH_CONFIG_SCHEMA = z
  .object({ operations: z.array(operationSchema).min(1).max(4096) })
  .strict();
export type StudioPatchConfig = z.infer<typeof STUDIO_PATCH_CONFIG_SCHEMA>;
export const STUDIO_PATCH_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  sourceExports: [],
  id: "studio-patch",
  abi: "1",
  configSchema: compositionConfigDataSchema(STUDIO_PATCH_CONFIG_SCHEMA),
  ports: [],
  obligations: [
    {
      id: "direct-editor-readback",
      description:
        "Reconcile the exact authorized editor mutation and preserved surrounding state using canonical Studio receipts.",
      evidence: "studio_edit",
    },
  ],
};

/** JSON strings carry exact canonical StudioValue / GameDataSchema data, never expressions or source. */
export function compileStudioPatch(
  context: CompositionContext & { observation?: CreatorProjectIndexView },
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = STUDIO_PATCH_CONFIG_SCHEMA.parse(input);
  const operations = uniqueById(config.operations);
  const observed = new Map(
    context.observation?.instances.map((instance) => [instance.objectId, instance]) ?? [],
  );
  if (context.observation && observed.size !== context.observation.instances.length)
    throw new CompositionError("invalid_observation", "Observed object IDs must be unique");
  const lookup = (id: string) => {
    const instance = observed.get(id);
    if (!instance)
      throw new CompositionError(
        "invalid_reference",
        "Object ID was not supplied by the current host observation",
      );
    return instance;
  };
  const inventory: GameInventoryItem[] = [];
  const created = new Map<string, GameInventoryItem>();
  const active = new Set<string>();
  const expand = (id: string): GameInventoryItem => {
    const known = created.get(id);
    if (known) return known;
    const op = operations.get(id);
    if (!op) throw new CompositionError("invalid_reference", `Unknown patch operation: ${id}`);
    if (active.has(id))
      throw new CompositionError(
        "dependency_cycle",
        "Patch dependencies or generated parents form a cycle",
      );
    active.add(id);
    if (
      new Set(op.dependencies).size !== op.dependencies.length ||
      new Set(op.removedAttributes).size !== op.removedAttributes.length
    )
      throw new CompositionError(
        "duplicate_id",
        "Patch dependency and removal declarations must be unique",
      );
    const dependencies = op.dependencies.map((dependency) => expand(dependency).id);
    const parent = (): StudioMutationParent => {
      if (!("parent" in op))
        throw new CompositionError("invalid_parent", "Create/move requires an explicit parent");
      if (op.parent.kind === "engine") return engineParent(op.parent.id);
      if (op.parent.kind === "generated") {
        const generated = expand(op.parent.id);
        dependencies.push(generated.id);
        return outputParent(context, generated);
      }
      const instance = lookup(op.parent.id);
      if (instance.engineContainer) return engineParent(instance.engineContainer.path);
      return {
        kind: "instance",
        identity: instance.identity,
        path: instance.path,
        className: instance.className,
      };
    };
    const target = op.kind === "create" ? undefined : lookup(op.objectId);
    if (target?.engineContainer)
      throw new CompositionError(
        "unsupported_target",
        "Engine-owned containers are structural parents, not patch mutation targets",
      );
    const className = op.kind === "create" ? op.className! : target!.className;
    const definition = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
    if (!definition)
      throw new CompositionError(
        "unsupported_class",
        "Patch class has no lawful detached authoring strategy",
      );
    if (op.kind === "create" && definition.source !== "forbidden")
      throw new CompositionError(
        "source_required",
        "Script creation and source editing use source_package declarations",
      );
    const properties: Record<string, StudioValue> = {};
    for (const property of op.properties) {
      if (Object.hasOwn(properties, property.name))
        throw new CompositionError("duplicate_property", "A property cannot have two locks");
      const descriptor = definition.properties.find((entry) => entry.name === property.name);
      if (!descriptor)
        throw new CompositionError(
          "unsupported_property",
          "Property is outside the current authoring manifest",
        );
      const value: unknown = JSON.parse(property.valueJson);
      boundedConfig(value);
      assertStudioValue(value);
      const canonical = canonicalStudioValue(value, descriptor);
      assertStudioValueForProperty(canonical, descriptor);
      properties[property.name] = canonical;
    }
    sortedStudioMutationPropertyNames(definition, properties);
    const valueSlots = op.valueSlots.map((slot) => {
      const schema: unknown = JSON.parse(slot.schemaJson);
      boundedConfig(schema);
      return {
        id: itemId(context, "slot-" + id + "-" + slot.id),
        propertyName: slot.propertyName,
        schema: canonicalGameDataSchema(
          GAME_DATA_SCHEMA.parse(schema),
          DEFAULT_GAME_ADMISSION_POLICY,
        ),
      };
    });
    const attributes: Record<string, string | number | boolean> = {};
    for (const attribute of op.attributes) {
      if (
        Object.hasOwn(attributes, attribute.name) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(attribute.name) ||
        attribute.name.startsWith(STUDIO_CAPABILITY_MANIFEST.attributes.reservedPrefix)
      )
        throw new CompositionError(
          "invalid_attribute",
          "Attribute name is duplicated, reserved, or invalid",
        );
      const value: unknown = JSON.parse(attribute.valueJson);
      boundedConfig(value);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        throw new CompositionError(
          "invalid_attribute",
          "Patch attributes require primitive JSON values",
        );
      attributes[attribute.name] = value;
    }
    for (const name of op.removedAttributes)
      if (
        Object.hasOwn(attributes, name) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name) ||
        name.startsWith(STUDIO_CAPABILITY_MANIFEST.attributes.reservedPrefix)
      )
        throw new CompositionError(
          "invalid_attribute",
          "Removed attributes cannot overlap writes or reserved names",
        );
    let item: GameInventoryItem;
    if (op.kind === "create")
      item = createItem(
        context,
        id,
        op.name!,
        className as StudioNonScriptWritableClass,
        parent(),
        properties,
        dependencies,
      );
    else {
      const changeId = itemId(context, id);
      const instanceTarget = {
        kind: "instance" as const,
        identity: target!.identity,
        path: target!.path,
        className,
      };
      let change: CreatorPlanChange;
      if (op.kind === "move") {
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,95}$/.test(op.name!))
          throw new CompositionError(
            "invalid_name",
            "Move names must be safe single path segments",
          );
        const destination = parent();
        change = {
          id: changeId,
          kind: "move",
          target: instanceTarget,
          expectedClass: className as StudioWritableClass,
          parent: destination,
          toPath: destination.path + "/" + op.name!,
        };
      } else if (op.kind === "delete")
        change = {
          id: changeId,
          kind: "delete",
          target: instanceTarget,
          expectedClass: className as StudioWritableClass,
        };
      else
        change = {
          id: changeId,
          kind: "update",
          target: instanceTarget,
          expectedClass: className as StudioWritableClass,
        };
      item = {
        id: changeId,
        componentId: context.componentId,
        change,
        lockedProperties: properties,
        valueSlots: [],
        attributes: {},
        removedAttributes: [],
        dependencies,
        beforeHash: contentHash(stableJson(target)),
      };
    }
    item = {
      ...item,
      ...(op.kind === "create" ? { outputId: op.id } : {}),
      valueSlots,
      attributes,
      removedAttributes: [...op.removedAttributes],
      dependencies: [...new Set(dependencies)].sort(),
    };
    created.set(id, item);
    inventory.push(item);
    active.delete(id);
    return item;
  };
  for (const id of [...operations.keys()].sort()) expand(id);
  return {
    inventory,
    sources: [],
    obligations: STUDIO_PATCH_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "Patch expansion uses host-supplied observed identities. It grants no approval and performs no mutation; the shared compiler, ownership checks and native preflight/readback remain authoritative.",
    ],
  };
}
export const STUDIO_PATCH_EXPANDER = {
  definition: gameRecipeDefinitionLock(STUDIO_PATCH_DEFINITION),
  expand: (
    input: CompositionContext & { config: unknown; observation?: CreatorProjectIndexView },
  ) => compileStudioPatch(input, input.config).inventory,
};
