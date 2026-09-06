import {
  emptyArrayDefault,
  COMPOSITION_ID_SCHEMA,
  COMPOSITION_NAME_SCHEMA,
} from "./config-schema.js";
import { z } from "zod";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import { STUDIO_CAPABILITY_MANIFEST } from "../../studio-evidence/src/index.js";
import {
  CompositionError,
  bool,
  boundedConfig,
  color,
  createItem,
  engineParent,
  enumeration,
  num,
  outputParent,
  vec3,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";
import { resolveScene } from "./scene-validation.js";

const vector = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
const dimension = z.number().finite().positive().max(2048);
const positiveVector = z.object({ x: dimension, y: dimension, z: dimension }).strict();
const angle = z.number().finite().min(-360).max(360);
const rgb = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();
const materialProperty = STUDIO_CAPABILITY_MANIFEST.classes
  .find((entry) => entry.name === "Part")
  ?.properties.find((property) => property.name === "Material");
if (materialProperty?.codec !== "enum_name" || !materialProperty.allowed?.length)
  throw new CompositionError(
    "missing_capability",
    "Part.Material must have a canonical enum allowlist",
  );
const materialSchema = z
  .enum(materialProperty.allowed as [string, ...string[]])
  .describe("Exact Material values admitted by the current canonical Studio capability manifest.");
const nodeSchema = z
  .object({
    id: COMPOSITION_ID_SCHEMA.describe(
      "Local scene node ID. Its created output alias is node/<id>, usable as a source placement component_output parent.",
    ),
    name: COMPOSITION_NAME_SCHEMA,
    parentId: COMPOSITION_ID_SCHEMA.optional().describe(
      "Optional node ID declared in this scene component. Omit to parent under the generated root Folder. The source-placement output alias root is not an implicit node ID.",
    ),
    shape: z
      .enum(["Block", "Ball", "Cylinder", "Wedge", "CornerWedge"])
      .describe(
        "Block/Ball/Cylinder create Part with that Shape; Wedge creates WedgePart; CornerWedge creates CornerWedgePart. Size describes local bounding-box axes. Cylinder length is along local X; use rotationDegrees to orient it.",
      ),
    size: positiveVector,
    placement: z
      .object({
        relativeTo: COMPOSITION_ID_SCHEMA.optional().describe(
          "Optional node ID declared in this scene component, independent of parentId. Its resolved position and rotation form the local reference frame: rotate offset by that frame, then translate; compose its rotation with rotationDegrees. Omit for the world identity frame. Output alias root has no special meaning; it is valid only if a node with id root is declared.",
        ),
        offset: vector.describe(
          "Translation in the reference frame's axes, or world coordinates when relativeTo is omitted.",
        ),
        rotationDegrees: z
          .object({ x: angle, y: angle, z: angle })
          .strict()
          .optional()
          .describe(
            "Local Euler XYZ angles in degrees, equivalent to CFrame.Angles(rad(x),rad(y),rad(z)) = Rx * Ry * Rz. Omit for local identity rotation. The emitted world frame is referenceFrame * translation(offset) * rotationXYZ; parentId affects hierarchy only.",
          ),
      })
      .strict(),
    color: rgb,
    material: materialSchema,
    transparency: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Optional authored surface transparency: 0 opaque, 1 invisible. Does not change collision.",
      ),
    reflectance: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Optional authored surface reflectance; appearance depends on material and native lighting.",
      ),
    castShadow: z
      .boolean()
      .optional()
      .describe(
        "Optional authored CastShadow setting. Lighting and renderer behavior require native visual review.",
      ),
    anchored: z.boolean(),
    collidable: z.boolean(),
  })
  .strict();
export const SCENE_PRIMITIVES_CONFIG_SCHEMA = z
  .object({
    rootName: COMPOSITION_NAME_SCHEMA.describe(
      "Name of the created Folder. Its source-placement output alias is root.",
    ),
    parentPath: z.string().min(1).max(256),
    nodes: z.array(nodeSchema).min(1).max(512),
    constraints: emptyArrayDefault(
      z
        .array(
          z
            .object({
              kind: z
                .enum(["separation", "containment"])
                .describe(
                  "Conservative bounding-box checks only. separation requires a world-axis gap between rotated Size bounds. containment tests the first rotated Size box inside the second node's oriented Size box, not its physical shape or playable interior.",
                ),
              first: COMPOSITION_ID_SCHEMA.describe(
                "Node ID declared in this scene component; for containment, the inner node.",
              ),
              second: COMPOSITION_ID_SCHEMA.describe(
                "Distinct node ID declared in this scene component; for containment, the outer node.",
              ),
              clearance: z.number().finite().nonnegative(),
            })
            .strict(),
        )
        .max(4096)
        .describe(
          "Optional authored spatial constraints. Omit when none are requested; the host records an empty array before approval.",
        ),
    ),
  })
  .strict();
export type ScenePrimitivesConfig = z.infer<typeof SCENE_PRIMITIVES_CONFIG_SCHEMA>;

/** Deterministic authored primitive geometry, with explicitly requested bounds constraints. */
export function compileScenePrimitives(
  context: CompositionContext,
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = SCENE_PRIMITIVES_CONFIG_SCHEMA.parse(input);
  const { nodes, positions, rotations, parentOrder } = resolveScene(config, context.componentId);
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
  const created = new Map<string, GameInventoryItem>();
  for (const id of parentOrder) {
    const node = nodes.get(id)!;
    const parent = node.parentId ? created.get(node.parentId)! : root;
    const at = positions.get(id)!;
    const className =
      node.shape === "Wedge"
        ? "WedgePart"
        : node.shape === "CornerWedge"
          ? "CornerWedgePart"
          : "Part";
    const item = createItem(
      context,
      "node-" + id,
      node.name,
      className,
      outputParent(context, parent),
      {
        Anchored: bool(node.anchored),
        CanCollide: bool(node.collidable),
        Color: color(node.color),
        Material: enumeration(node.material),
        ...(className === "Part" ? { Shape: enumeration(node.shape) } : {}),
        ...(node.transparency === undefined ? {} : { Transparency: num(node.transparency) }),
        ...(node.reflectance === undefined ? {} : { Reflectance: num(node.reflectance) }),
        ...(node.castShadow === undefined ? {} : { CastShadow: bool(node.castShadow) }),
        Size: vec3(node.size),
        CFrame: {
          kind: "cframe_f32x12",
          components: [at.x, at.y, at.z, ...rotations.get(id)!],
        },
      },
      [parent.id],
      "node/" + id,
    );
    inventory.push(item);
    created.set(id, item);
  }
  return {
    inventory,
    sources: [],
    obligations: [],
    limitations: [
      "Declared constraints use conservative rotated Size boxes: world AABBs for separation and the outer node's oriented box for containment. Bounds may reject geometrically separated curved/wedge shapes; box containment does not prove physical volume containment, collision fidelity, reachable navigation or visual quality. Those require native evidence.",
    ],
  };
}
