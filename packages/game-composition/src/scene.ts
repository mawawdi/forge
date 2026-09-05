import { z } from "zod";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  CompositionError,
  arraySchema,
  booleanSchema,
  bool,
  boundedConfig,
  color,
  colorSchema,
  createItem,
  engineParent,
  enumeration,
  idSchema,
  numberSchema,
  objectSchema,
  outputParent,
  uniqueById,
  vec3,
  vectorSchema,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";

const vector = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
const positiveVector = vector.refine(
  (value) => [value.x, value.y, value.z].every((number) => number > 0 && number <= 2048),
  "Primitive size must be within (0, 2048]",
);
const rgb = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();
const nodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().optional(),
    shape: z.enum(["Block", "Ball", "Cylinder", "Wedge", "CornerWedge"]),
    size: positiveVector,
    placement: z.object({ relativeTo: z.string().optional(), offset: vector }).strict(),
    color: rgb,
    material: z.string(),
    anchored: z.boolean(),
    collidable: z.boolean(),
  })
  .strict();
const configSchema = z
  .object({
    rootName: z.string(),
    parentPath: z.string(),
    nodes: z.array(nodeSchema).min(1).max(512),
    constraints: z
      .array(
        z
          .object({
            kind: z.enum(["separation", "containment"]),
            first: z.string(),
            second: z.string(),
            clearance: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
export type ScenePrimitivesConfig = z.infer<typeof configSchema>;

export const SCENE_PRIMITIVES_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  sourceExports: [],
  id: "scene-primitives",
  abi: "1",
  configSchema: objectSchema({
    rootName: idSchema,
    parentPath: { type: "string", maxLength: 256 },
    nodes: arraySchema(
      objectSchema(
        {
          id: idSchema,
          name: idSchema,
          parentId: idSchema,
          shape: {
            type: "string",
            maxLength: 16,
            enum: ["Block", "Ball", "Cylinder", "Wedge", "CornerWedge"],
          },
          size: vectorSchema,
          placement: objectSchema({ relativeTo: idSchema, offset: vectorSchema }, ["offset"]),
          color: colorSchema,
          material: idSchema,
          anchored: booleanSchema,
          collidable: booleanSchema,
        },
        ["id", "name", "shape", "size", "placement", "color", "material", "anchored", "collidable"],
      ),
      512,
    ),
    constraints: arraySchema(
      objectSchema({
        kind: { type: "string", maxLength: 16, enum: ["separation", "containment"] },
        first: idSchema,
        second: idSchema,
        clearance: numberSchema,
      }),
      4096,
    ),
  }),
  ports: [],
  obligations: [
    {
      id: "native-spatial-review",
      description:
        "Inspect represented geometry, actual collision and any declared navigation in Studio; bounding boxes do not establish traversal.",
      evidence: "studio_play",
    },
  ],
};

/** A deterministic axis-aligned primitive recipe, with only explicitly requested spatial constraints. */
export function compileScenePrimitives(
  context: CompositionContext,
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = configSchema.parse(input);
  const nodes = uniqueById(config.nodes);
  const positions = new Map<string, z.infer<typeof vector>>();
  const visiting = new Set<string>();
  const position = (id: string): z.infer<typeof vector> => {
    const known = positions.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node) throw new CompositionError("invalid_reference", `Unknown placement node: ${id}`);
    if (visiting.has(id))
      throw new CompositionError("placement_cycle", "Relative placements contain a cycle");
    visiting.add(id);
    const parent = node.placement.relativeTo
      ? position(node.placement.relativeTo)
      : { x: 0, y: 0, z: 0 };
    const result = {
      x: Math.fround(parent.x + node.placement.offset.x),
      y: Math.fround(parent.y + node.placement.offset.y),
      z: Math.fround(parent.z + node.placement.offset.z),
    };
    if (
      ![result.x, result.y, result.z].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
      )
    )
      throw new CompositionError(
        "placement_bounds",
        "Resolved placement exceeds admitted transform bounds",
      );
    visiting.delete(id);
    positions.set(id, result);
    return result;
  };
  for (const node of config.nodes) position(node.id);
  for (const constraint of config.constraints) {
    const first = nodes.get(constraint.first);
    const second = nodes.get(constraint.second);
    if (!first || !second || first.id === second.id)
      throw new CompositionError(
        "invalid_reference",
        "Spatial constraints require two distinct existing nodes",
      );
    const a = positions.get(first.id)!;
    const b = positions.get(second.id)!;
    const axes = ["x", "y", "z"] as const;
    // Test the same float32 size/translation values that the canonical writer receives.
    const valid =
      constraint.kind === "separation"
        ? axes.some(
            (axis) =>
              Math.abs(a[axis] - b[axis]) >=
              (Math.fround(first.size[axis]) + Math.fround(second.size[axis])) / 2 +
                constraint.clearance,
          )
        : axes.every(
            (axis) =>
              Math.abs(a[axis] - b[axis]) +
                Math.fround(first.size[axis]) / 2 +
                constraint.clearance <=
              Math.fround(second.size[axis]) / 2,
          );
    if (!valid)
      throw new CompositionError(
        "unsatisfiable_constraint",
        `${constraint.kind} failed for ${first.id} and ${second.id}`,
      );
  }
  const root = createItem(
    context,
    "root",
    config.rootName,
    "Folder",
    engineParent(config.parentPath),
    {},
  );
  const inventory: GameInventoryItem[] = [root];
  const created = new Map<string, GameInventoryItem>();
  const active = new Set<string>();
  const create = (id: string): GameInventoryItem => {
    const known = created.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node) throw new CompositionError("invalid_reference", `Unknown tree parent: ${id}`);
    if (active.has(id))
      throw new CompositionError("parent_cycle", "Scene parent tree contains a cycle");
    active.add(id);
    const parent = node.parentId ? create(node.parentId) : root;
    const at = positions.get(id)!;
    const item = createItem(
      context,
      "node-" + id,
      node.name,
      "Part",
      outputParent(context, parent),
      {
        Anchored: bool(node.anchored),
        CanCollide: bool(node.collidable),
        Color: color(node.color),
        Material: enumeration(node.material),
        Shape: enumeration(node.shape),
        Size: vec3(node.size),
        CFrame: {
          kind: "cframe_f32x12",
          components: [at.x, at.y, at.z, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        },
      },
      [parent.id],
    );
    if (
      inventory.some(
        (existing) =>
          existing.change.kind === "create" &&
          existing.change.path === outputParent(context, parent).path + "/" + node.name,
      )
    )
      throw new CompositionError("duplicate_path", "Sibling names must be unique");
    inventory.push(item);
    created.set(id, item);
    active.delete(id);
    return item;
  };
  for (const id of [...nodes.keys()].sort()) create(id);
  return {
    inventory,
    sources: [],
    obligations: SCENE_PRIMITIVES_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "Only declared axis-aligned bounds were checked; surface shape, collision fidelity, reachable navigation and visual quality require native evidence.",
    ],
  };
}

export const SCENE_PRIMITIVES_EXPANDER = {
  definition: gameRecipeDefinitionLock(SCENE_PRIMITIVES_DEFINITION),
  expand: (input: CompositionContext & { config: unknown }) =>
    compileScenePrimitives(input, input.config).inventory,
};
