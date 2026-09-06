import { z } from "zod";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  compositionConfigDataSchema,
  COMPOSITION_ID_SCHEMA,
  COMPOSITION_NAME_SCHEMA,
} from "./config-schema.js";
import {
  CompositionError,
  boundedConfig,
  createItem,
  engineParent,
  outputParent,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";
import {
  compileScenePrimitives,
  SCENE_PRIMITIVES_CONFIG_SCHEMA,
  SCENE_PRIMITIVES_DEFINITION,
  type ScenePrimitivesConfig,
} from "./scene.js";
import {
  SCENE_IDENTITY_ROTATION,
  sceneEulerXyz,
  sceneHalfExtents,
  sceneMultiply,
  sceneTransformVector,
  type SceneRotation,
  type SceneVector,
} from "./scene-geometry.js";
import { measureSceneBoxConstraint, type SceneBox } from "./scene-bounds.js";

const primitive = SCENE_PRIMITIVES_CONFIG_SCHEMA.shape.nodes.element;
const vector = primitive.shape.placement.shape.offset;
const angles = primitive.shape.placement.shape.rotationDegrees.unwrap();
const surface = primitive.pick({
  color: true,
  material: true,
  transparency: true,
  reflectance: true,
  castShadow: true,
});
const motifNode = primitive
  .omit({ color: true, material: true, transparency: true, reflectance: true, castShadow: true })
  .extend({
    id: COMPOSITION_ID_SCHEMA.describe(
      "Motif-local node ID. Each placed output alias is arrangement/<arrangement-id>/member/<member-id>/node/<node-id>.",
    ),
    surfaceId: COMPOSITION_ID_SCHEMA,
  });
const member = z
  .object({
    id: COMPOSITION_ID_SCHEMA.describe("Stable instance ID, independent of its display order."),
    offset: vector,
    rotationDegrees: angles.optional(),
  })
  .strict();
const pattern = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit"), members: z.array(member).min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal("linear"),
      memberIds: z.array(COMPOSITION_ID_SCHEMA).min(1).max(512),
      step: vector.describe(
        "Member i is translated by i * step in the arrangement frame. Array order controls placement; IDs control object identity.",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("radial"),
      memberIds: z.array(COMPOSITION_ID_SCHEMA).min(1).max(512),
      radiusStuds: z.number().finite().positive().max(100000),
      startDegrees: z.number().finite().min(-360).max(360),
      stepDegrees: z.number().finite().min(-360).max(360),
      orientation: z
        .enum(["fixed", "outward", "tangent"])
        .describe(
          "The circle lies in the arrangement's XZ plane: angle zero is +X; positive angles move toward -Z. fixed preserves motif axes; outward points local -Z away from the center; tangent points local -Z along increasing angle. Rotate the arrangement frame for other planes.",
        ),
    })
    .strict(),
]);
const memberReference = z
  .object({ arrangementId: COMPOSITION_ID_SCHEMA, memberId: COMPOSITION_ID_SCHEMA })
  .strict();

export const SCENE_ARRANGEMENT_CONFIG_SCHEMA = z
  .object({
    rootName: COMPOSITION_NAME_SCHEMA,
    parentPath: SCENE_PRIMITIVES_CONFIG_SCHEMA.shape.parentPath,
    surfaces: z
      .array(surface.extend({ id: COMPOSITION_ID_SCHEMA }))
      .min(1)
      .max(128),
    motifs: z
      .array(
        z
          .object({
            id: COMPOSITION_ID_SCHEMA,
            nodes: z.array(motifNode).min(1).max(512),
            constraints: SCENE_PRIMITIVES_CONFIG_SCHEMA.shape.constraints,
          })
          .strict(),
      )
      .min(1)
      .max(64)
      .describe(
        "Author one detailed custom object in local coordinates, then reuse that motif for arches, trim, pipes or any other authored repeated geometry. These are author-defined structures, not predefined kits. Local parent and relativeTo references stay inside the motif; its origin is the placement pivot. Constraints are checked at the authored origin and again in every final float32 world frame. Every motif must be placed.",
      ),
    arrangements: z
      .array(
        z
          .object({
            id: COMPOSITION_ID_SCHEMA,
            name: COMPOSITION_NAME_SCHEMA,
            motifId: COMPOSITION_ID_SCHEMA,
            frame: z
              .object({
                relativeTo: COMPOSITION_ID_SCHEMA.optional().describe(
                  "Another arrangement's frame, not one of its repeated members. This composes transform frames only and does not change instance parenting.",
                ),
                offset: vector,
                rotationDegrees: angles.optional(),
              })
              .strict(),
            pattern,
          })
          .strict(),
      )
      .min(1)
      .max(256)
      .describe(
        "Every repeated member has an explicit stable ID. Linear/radial memberIds order controls placement, while IDs control object identity; explicit member declaration order is canonicalized. Bind individual repeated objects through arrangement/<id>/member/<id>/node/<node-id> output aliases. All instances are expanded and locked before approval, without runtime cloning.",
      ),
    separation: z
      .array(
        z
          .object({
            first: memberReference,
            second: memberReference,
            clearanceStuds: z.number().finite().nonnegative().max(100000),
          })
          .strict(),
      )
      .max(4096)
      .optional()
      .describe(
        "Optional explicit non-overlap obligations between member aggregate world-axis bounds. Deliberate overlap for trim and compound objects is otherwise allowed. These conservative boxes do not prove native collision or traversal.",
      ),
  })
  .strict();
export type SceneArrangementConfig = z.infer<typeof SCENE_ARRANGEMENT_CONFIG_SCHEMA>;

/** Resource admission for expanded operations, independent of any scene style or genre. */
export const MAXIMUM_SCENE_ARRANGEMENT_OPERATIONS = 8192;
export const MAXIMUM_SCENE_ARRANGEMENT_CONSTRAINT_CHECKS = 65536;
export const SCENE_ARRANGEMENT_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  id: "scene-arrangement",
  abi: "2",
  sourceExports: [],
  configSchema: compositionConfigDataSchema(SCENE_ARRANGEMENT_CONFIG_SCHEMA),
  ports: [],
  obligations: SCENE_PRIMITIVES_DEFINITION.obligations,
};

export interface SceneArrangementProvenance {
  operationId: string;
  outputId: string;
  arrangementId?: string;
  memberId?: string;
  motifId?: string;
  nodeId?: string;
  surfaceId?: string;
}
export interface SceneArrangementOutput extends CompositionOutput {
  provenance: SceneArrangementProvenance[];
}
interface Frame {
  position: SceneVector;
  rotation: SceneRotation;
}
interface Bounds {
  minimum: SceneVector;
  maximum: SceneVector;
  axisAligned: boolean;
}
const zero = { x: 0, y: 0, z: 0 };
const identity: Frame = { position: zero, rotation: SCENE_IDENTITY_ROTATION };
const axes = ["x", "y", "z"] as const;

function fail(code: string, detail: string): never {
  throw new CompositionError(code, detail);
}
function unique<T extends { id: string }>(items: readonly T[], subject: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id))
      fail("duplicate_id", `${subject}/${item.id} is declared more than once`);
    result.set(item.id, item);
  }
  return result;
}
function compose(parent: Frame, local: Frame, subject: string): Frame {
  const offset = sceneTransformVector(parent.rotation, local.position);
  const position = Object.fromEntries(
    axes.map((axis) => {
      const value = Math.fround(parent.position[axis] + offset[axis]);
      if (!Number.isFinite(value) || Math.abs(value) > 100000)
        fail(
          "placement_bounds",
          `${subject} resolves outside finite +/-100000 stud bounds on ${axis}`,
        );
      return [axis, Object.is(value, -0) ? 0 : value];
    }),
  ) as unknown as SceneVector;
  return { position, rotation: sceneMultiply(parent.rotation, local.rotation, true) };
}
function localFrame(offset: SceneVector, rotation?: SceneVector): Frame {
  return { position: offset, rotation: sceneEulerXyz(rotation ?? zero) };
}
function members(
  config: SceneArrangementConfig["arrangements"][number],
): Array<{ id: string; frame: Frame }> {
  const input = config.pattern;
  const result =
    input.kind === "explicit"
      ? input.members.map((entry) => ({
          id: entry.id,
          frame: localFrame(entry.offset, entry.rotationDegrees),
        }))
      : input.memberIds.map((id, index) => {
          if (input.kind === "linear")
            return {
              id,
              frame: localFrame({
                x: input.step.x * index,
                y: input.step.y * index,
                z: input.step.z * index,
              }),
            };
          const degrees = input.startDegrees + input.stepDegrees * index;
          const radians = (degrees * Math.PI) / 180;
          const rotation =
            input.orientation === "fixed"
              ? 0
              : degrees + (input.orientation === "outward" ? -90 : 0);
          return {
            id,
            frame: localFrame(
              {
                x: input.radiusStuds * Math.cos(radians),
                y: 0,
                z: -input.radiusStuds * Math.sin(radians),
              },
              { x: 0, y: rotation, z: 0 },
            ),
          };
        });
  unique(result, `arrangements/${config.id}/members`);
  return result;
}
function include(bounds: Bounds | undefined, frame: Frame, size: SceneVector): Bounds {
  const half = sceneHalfExtents(frame.rotation, size);
  const minimum = {} as SceneVector;
  const maximum = {} as SceneVector;
  for (const axis of axes) {
    minimum[axis] = Math.min(bounds?.minimum[axis] ?? Infinity, frame.position[axis] - half[axis]);
    maximum[axis] = Math.max(bounds?.maximum[axis] ?? -Infinity, frame.position[axis] + half[axis]);
  }
  return {
    minimum,
    maximum,
    axisAligned:
      (bounds?.axisAligned ?? true) &&
      frame.rotation.every((value) => value === 0 || Math.abs(value) === 1),
  };
}
function memberKey(arrangementId: string, memberId: string): string {
  return `arrangement/${arrangementId}/member/${memberId}`;
}

/**
 * Expand authored geometry before approval. Local motifs go through the existing
 * primitive compiler; repeated objects reuse its parent order, property codecs
 * and float32 geometry lowering. No runtime cloning or generated constructors.
 */
export function compileSceneArrangement(
  context: CompositionContext,
  input: unknown,
): SceneArrangementOutput {
  boundedConfig(input);
  const config = SCENE_ARRANGEMENT_CONFIG_SCHEMA.parse(input);
  const surfaces = unique(config.surfaces, "surfaces");
  const motifs = unique(config.motifs, "motifs");
  const arrangements = unique(config.arrangements, "arrangements");
  const memberFrames = new Map<string, ReturnType<typeof members>>();
  const usedMotifs = new Set<string>();
  const names = new Set<string>();
  let operationCount = 1 + arrangements.size;
  let constraintCount = config.separation?.length ?? 0;
  for (const arrangement of arrangements.values()) {
    if (names.has(arrangement.name))
      fail(
        "duplicate_path",
        `arrangements/${arrangement.id} repeats sibling name ${arrangement.name}`,
      );
    names.add(arrangement.name);
    const motif = motifs.get(arrangement.motifId);
    if (!motif)
      fail(
        "unknown_reference",
        `arrangements/${arrangement.id}/motifId names missing motif ${arrangement.motifId}`,
      );
    usedMotifs.add(motif.id);
    const entries = members(arrangement);
    memberFrames.set(arrangement.id, entries);
    operationCount += entries.length * (1 + motif.nodes.length);
    constraintCount += entries.length * motif.constraints.length;
    if (operationCount > MAXIMUM_SCENE_ARRANGEMENT_OPERATIONS)
      fail(
        "resource_limit",
        `arrangements/${arrangement.id} expands the component to at least ${operationCount} operations; maximum ${MAXIMUM_SCENE_ARRANGEMENT_OPERATIONS}, including all folders and primitives`,
      );
    if (constraintCount > MAXIMUM_SCENE_ARRANGEMENT_CONSTRAINT_CHECKS)
      fail(
        "resource_limit",
        `arrangements/${arrangement.id} requires at least ${constraintCount} expanded constraint checks; maximum ${MAXIMUM_SCENE_ARRANGEMENT_CONSTRAINT_CHECKS}`,
      );
  }
  for (const id of motifs.keys())
    if (!usedMotifs.has(id))
      fail("unused_motif", `motifs/${id} has no arrangement; remove it or explicitly place it`);

  const frames = new Map<string, Frame>();
  const resolving: string[] = [];
  const resolveFrame = (id: string): Frame => {
    const existing = frames.get(id);
    if (existing) return existing;
    const cycle = resolving.indexOf(id);
    if (cycle >= 0)
      fail(
        "placement_cycle",
        `Arrangement frame cycle: ${[...resolving.slice(cycle), id].join(" -> ")}`,
      );
    const arrangement = arrangements.get(id);
    if (!arrangement)
      fail(
        "unknown_reference",
        `arrangements/${resolving.at(-1)}/frame/relativeTo names missing arrangement ${id}`,
      );
    resolving.push(id);
    const parent =
      arrangement.frame.relativeTo === undefined
        ? identity
        : resolveFrame(arrangement.frame.relativeTo);
    const frame = compose(
      parent,
      localFrame(arrangement.frame.offset, arrangement.frame.rotationDegrees),
      `arrangements/${id}/frame`,
    );
    resolving.pop();
    frames.set(id, frame);
    return frame;
  };
  for (const id of [...arrangements.keys()].sort()) resolveFrame(id);

  const compiledMotifs = new Map<string, CompositionOutput>();
  for (const id of [...motifs.keys()].sort()) {
    const motif = motifs.get(id)!;
    const nodes: ScenePrimitivesConfig["nodes"] = motif.nodes.map(({ surfaceId, ...node }) => {
      const chosen = surfaces.get(surfaceId);
      if (!chosen)
        fail(
          "unknown_reference",
          `motifs/${id}/nodes/${node.id}/surfaceId names missing surface ${surfaceId}`,
        );
      const { id: _surfaceId, ...properties } = chosen;
      return { ...node, ...properties };
    });
    try {
      compiledMotifs.set(
        id,
        compileScenePrimitives(context, {
          rootName: "Motif",
          parentPath: config.parentPath,
          nodes,
          constraints: motif.constraints,
        }),
      );
    } catch (error) {
      if (error instanceof CompositionError) fail(error.code, `motifs/${id}: ${error.message}`);
      throw error;
    }
  }
  const root = createItem(
    context,
    "root",
    config.rootName,
    "Folder",
    engineParent(config.parentPath),
    {},
    [],
    "root",
  );
  const inventory: GameInventoryItem[] = [root];
  const provenance: SceneArrangementProvenance[] = [{ operationId: root.id, outputId: "root" }];
  const bounds = new Map<string, Bounds>();
  for (const id of [...arrangements.keys()].sort()) {
    const arrangement = arrangements.get(id)!;
    const motif = motifs.get(arrangement.motifId)!;
    const source = compiledMotifs.get(motif.id)!;
    const motifNodes = new Map(motif.nodes.map((node) => [node.id, node]));
    const groupAlias = `arrangement/${id}`;
    const group = createItem(
      context,
      groupAlias,
      arrangement.name,
      "Folder",
      outputParent(context, root),
      {},
      [root.id],
      groupAlias,
    );
    inventory.push(group);
    provenance.push({
      operationId: group.id,
      outputId: groupAlias,
      arrangementId: id,
      motifId: motif.id,
    });
    for (const entry of memberFrames
      .get(id)!
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const alias = memberKey(id, entry.id);
      const memberFrame = compose(frames.get(id)!, entry.frame, alias);
      const parent = createItem(
        context,
        alias,
        entry.id,
        "Folder",
        outputParent(context, group),
        {},
        [group.id],
        alias,
      );
      inventory.push(parent);
      provenance.push({
        operationId: parent.id,
        outputId: alias,
        arrangementId: id,
        memberId: entry.id,
        motifId: motif.id,
      });
      const remapped = new Map([[source.inventory[0]!.id, parent]]);
      const finalBoxes = new Map<string, SceneBox>();
      let memberBounds: Bounds | undefined;
      for (const item of source.inventory.slice(1)) {
        if (item.change.kind !== "create" || !item.outputId?.startsWith("node/"))
          fail(
            "invalid_inventory",
            `motifs/${motif.id} did not compile to fixed primitive creates`,
          );
        const className = item.change.className;
        if (className !== "Part" && className !== "WedgePart" && className !== "CornerWedgePart")
          fail(
            "invalid_inventory",
            `motifs/${motif.id} did not compile to an admitted primitive class`,
          );
        const nodeId = item.outputId.slice(5);
        const cframe = item.lockedProperties.CFrame!;
        const size = item.lockedProperties.Size!;
        if (cframe.kind !== "cframe_f32x12" || size.kind !== "vector3_f32")
          fail(
            "invalid_inventory",
            `motifs/${motif.id}/nodes/${nodeId} lacks canonical primitive geometry`,
          );
        const world = compose(
          memberFrame,
          {
            position: {
              x: cframe.components[0]!,
              y: cframe.components[1]!,
              z: cframe.components[2]!,
            },
            rotation: cframe.components.slice(3) as unknown as SceneRotation,
          },
          `${alias}/node/${nodeId}`,
        );
        const mappedParent = remapped.get(item.dependencies[0]!);
        if (!mappedParent)
          fail(
            "invalid_inventory",
            `motifs/${motif.id}/nodes/${nodeId} lacks a compiled parent-first dependency`,
          );
        const outputId = `${alias}/node/${nodeId}`;
        const placed = createItem(
          context,
          outputId,
          motifNodes.get(nodeId)!.name,
          className,
          outputParent(context, mappedParent),
          {
            ...item.lockedProperties,
            CFrame: {
              kind: "cframe_f32x12",
              components: [world.position.x, world.position.y, world.position.z, ...world.rotation],
            },
          },
          [mappedParent.id],
          outputId,
        );
        inventory.push(placed);
        remapped.set(item.id, placed);
        memberBounds = include(memberBounds, world, size);
        finalBoxes.set(nodeId, { ...world, size });
        provenance.push({
          operationId: placed.id,
          outputId,
          arrangementId: id,
          memberId: entry.id,
          motifId: motif.id,
          nodeId,
          surfaceId: motifNodes.get(nodeId)!.surfaceId,
        });
      }
      for (const constraint of motif.constraints) {
        const measured = measureSceneBoxConstraint(
          constraint.kind,
          finalBoxes.get(constraint.first)!,
          finalBoxes.get(constraint.second)!,
          constraint.clearance,
        );
        if (!measured.valid)
          fail(
            "unsatisfiable_constraint",
            `${alias}/motif/${motif.id}: ${constraint.kind} failed after float32 placement for nodes ${constraint.first} and ${constraint.second}; ${JSON.stringify(measured)}`,
          );
      }
      bounds.set(alias, memberBounds!);
    }
  }
  for (const [index, constraint] of (config.separation ?? []).entries()) {
    const first = memberKey(constraint.first.arrangementId, constraint.first.memberId);
    const second = memberKey(constraint.second.arrangementId, constraint.second.memberId);
    if (first === second)
      fail("invalid_constraint", `separation/${index} names the same member ${first} twice`);
    const a = bounds.get(first);
    const b = bounds.get(second);
    if (!a || !b)
      fail("unknown_reference", `separation/${index} names missing member ${!a ? first : second}`);
    const margins = axes.map(
      (axis) =>
        Math.max(b.minimum[axis] - a.maximum[axis], a.minimum[axis] - b.maximum[axis]) -
        constraint.clearanceStuds,
    );
    const safety = axes.map((axis) =>
      a.axisAligned && b.axisAligned
        ? 0
        : 64 *
          Number.EPSILON *
          (Math.abs(a.minimum[axis]) +
            Math.abs(a.maximum[axis]) +
            Math.abs(b.minimum[axis]) +
            Math.abs(b.maximum[axis]) +
            constraint.clearanceStuds +
            1),
    );
    if (!margins.some((margin, axis) => margin >= safety[axis]!))
      fail(
        "unsatisfiable_constraint",
        `separation/${index}: ${first} and ${second} require ${constraint.clearanceStuds} studs between aggregate world-axis bounds; margins ${JSON.stringify(margins)}`,
      );
  }
  if (inventory.length !== operationCount)
    fail(
      "invalid_inventory",
      "Scene arrangement expansion diverged from its exact admitted operation count",
    );
  return {
    inventory,
    sources: [],
    provenance,
    obligations: SCENE_ARRANGEMENT_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "All repeated objects and transforms are expanded and locked before acceptance. Motifs and shared surfaces are authored inputs, with no runtime cloning or generated instance constructors.",
      "Member separation uses conservative aggregate world-axis bounds, including noncollidable decoration. Native shape collision, navigation, rendering costs and visual quality require Studio evidence.",
    ],
  };
}

export const SCENE_ARRANGEMENT_EXPANDER = {
  definition: gameRecipeDefinitionLock(SCENE_ARRANGEMENT_DEFINITION),
  expand: (input: CompositionContext & { config: unknown }) =>
    compileSceneArrangement(input, input.config).inventory,
};
