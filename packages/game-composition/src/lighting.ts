import { z } from "zod";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import { STUDIO_CAPABILITY_MANIFEST } from "../../studio-evidence/src/index.js";
import {
  bool,
  boundedConfig,
  color,
  CompositionError,
  createItem,
  engineParent,
  enumeration,
  num,
  outputParent,
  uniqueById,
  vec3,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";
import {
  COMPOSITION_ID_SCHEMA,
  COMPOSITION_NAME_SCHEMA,
  compositionConfigDataSchema,
} from "./config-schema.js";
import { sceneEulerXyz } from "./scene-geometry.js";

/** Authored resource bounds, not frame-time predictions or a visual-quality score. */
export const SCENE_LIGHTING_LIMITS = Object.freeze({
  fixtures: 128,
  range: 60,
  position: 100_000,
  fixtureSize: 2048,
  bloomIntensity: 10,
  bloomSize: 56,
  atmosphereHaze: 10,
  atmosphereGlare: 10,
  colorContrast: 4,
  colorSaturation: 4,
});
const finite = z.number().finite();
const rgb = z
  .object({
    r: finite.int().min(0).max(255),
    g: finite.int().min(0).max(255),
    b: finite.int().min(0).max(255),
  })
  .strict();
function admittedNumber(className: string, name: string) {
  const property = STUDIO_CAPABILITY_MANIFEST.classes
    .find((entry) => entry.name === className)
    ?.properties.find((entry) => entry.name === name);
  if (property?.codec !== "number_f32")
    throw new CompositionError("missing_capability", `${className}.${name} must admit float32`);
  let schema = z.number().finite();
  if (property.minimum !== undefined) schema = schema.min(property.minimum);
  if (property.maximum !== undefined) schema = schema.max(property.maximum);
  return schema;
}
const faceProperty = STUDIO_CAPABILITY_MANIFEST.classes
  .find((entry) => entry.name === "SpotLight")
  ?.properties.find((entry) => entry.name === "Face");
if (faceProperty?.codec !== "enum_name" || !faceProperty.allowed?.length)
  throw new CompositionError("missing_capability", "SpotLight.Face must have an admitted enum");
const face = z.enum(faceProperty.allowed as [string, ...string[]]);
const lightFields = {
  color: rgb,
  brightness: admittedNumber("PointLight", "Brightness"),
  range: admittedNumber("PointLight", "Range")
    .max(SCENE_LIGHTING_LIMITS.range)
    .describe("Authored illumination range in studs, bounded to 60 by this recipe profile."),
  enabled: z.boolean(),
  shadows: z.boolean().describe("Explicit shadow cost choice; review actual client frame cost."),
};
const light = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), ...lightFields }).strict(),
  z
    .object({
      kind: z.literal("spot"),
      ...lightFields,
      face,
      angle: admittedNumber("SpotLight", "Angle"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface"),
      ...lightFields,
      face,
      angle: admittedNumber("SurfaceLight", "Angle"),
    })
    .strict(),
]);
const coordinate = finite.min(-SCENE_LIGHTING_LIMITS.position).max(SCENE_LIGHTING_LIMITS.position);
const dimension = finite.min(0.05).max(SCENE_LIGHTING_LIMITS.fixtureSize);
const angle = finite.min(-360).max(360);
export const SCENE_LIGHTING_CONFIG_SCHEMA = z
  .object({
    rootName: COMPOSITION_NAME_SCHEMA.describe(
      "Name of the owned Workspace Folder when fixtures are declared. Output alias root. Effects are direct children of Lighting, outside this Folder.",
    ),
    fixtures: z
      .array(
        z
          .object({
            id: COMPOSITION_ID_SCHEMA,
            name: COMPOSITION_NAME_SCHEMA,
            position: z.object({ x: coordinate, y: coordinate, z: coordinate }).strict(),
            rotationDegrees: z
              .object({ x: angle, y: angle, z: angle })
              .strict()
              .optional()
              .describe(
                "World Euler XYZ degrees, Rx * Ry * Rz as CFrame.Angles. Omit for identity. Spot and surface face directions follow this frame.",
              ),
            size: z
              .object({ x: dimension, y: dimension, z: dimension })
              .strict()
              .describe(
                "Invisible fixture Part size in studs; SurfaceLight uses the selected face extent. The Part is anchored, transparent, noncolliding, untouchable, unqueryable and casts no shadow.",
              ),
            light,
          })
          .strict(),
      )
      .max(SCENE_LIGHTING_LIMITS.fixtures),
    atmosphere: z
      .object({
        name: COMPOSITION_NAME_SCHEMA,
        color: rgb,
        decay: rgb,
        density: admittedNumber("Atmosphere", "Density").min(0).max(1),
        offset: admittedNumber("Atmosphere", "Offset").min(-1).max(1),
        haze: admittedNumber("Atmosphere", "Haze").min(0).max(SCENE_LIGHTING_LIMITS.atmosphereHaze),
        glare: admittedNumber("Atmosphere", "Glare")
          .min(0)
          .max(SCENE_LIGHTING_LIMITS.atmosphereGlare),
      })
      .strict()
      .optional()
      .describe(
        "Creates one owned Atmosphere directly under Lighting. Review existing atmosphere and fog interactions; no service properties are changed.",
      ),
    bloom: z
      .object({
        name: COMPOSITION_NAME_SCHEMA,
        enabled: z.boolean(),
        intensity: admittedNumber("BloomEffect", "Intensity")
          .min(0)
          .max(SCENE_LIGHTING_LIMITS.bloomIntensity),
        size: admittedNumber("BloomEffect", "Size").min(0).max(SCENE_LIGHTING_LIMITS.bloomSize),
        threshold: admittedNumber("BloomEffect", "Threshold").min(0).max(1),
      })
      .strict()
      .optional(),
    colorCorrection: z
      .object({
        name: COMPOSITION_NAME_SCHEMA,
        enabled: z.boolean(),
        brightness: admittedNumber("ColorCorrectionEffect", "Brightness").min(-1).max(1),
        contrast: admittedNumber("ColorCorrectionEffect", "Contrast")
          .min(-1)
          .max(SCENE_LIGHTING_LIMITS.colorContrast),
        saturation: admittedNumber("ColorCorrectionEffect", "Saturation")
          .min(-1)
          .max(SCENE_LIGHTING_LIMITS.colorSaturation),
        tintColor: rgb,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SceneLightingConfig = z.infer<typeof SCENE_LIGHTING_CONFIG_SCHEMA>;

export const SCENE_LIGHTING_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  id: "scene-lighting",
  abi: "1",
  configSchema: compositionConfigDataSchema(SCENE_LIGHTING_CONFIG_SCHEMA),
  sourceExports: [],
  ports: [],
  obligations: [
    {
      id: "lighting-visual-review",
      evidence: "creator_review",
      description:
        "Inspect the requested views for intended light direction, material readability, atmosphere visibility and combined existing effects at target graphics quality levels. Local declarations do not observe rendering.",
    },
    {
      id: "lighting-client-performance",
      evidence: "studio_play",
      description:
        "Measure client frame cost in the intended camera views and device/quality profiles; counts, ranges and shadow flags do not prove performance.",
    },
  ],
};

/** The draft and compiler share semantic admission before emitting any inventory. */
export function validateSceneLightingConfig(input: unknown): SceneLightingConfig {
  boundedConfig(input);
  const config = SCENE_LIGHTING_CONFIG_SCHEMA.parse(input);
  uniqueById(config.fixtures);
  const names = new Set<string>();
  for (const fixture of config.fixtures) {
    if (names.has(fixture.name))
      throw new CompositionError(
        "duplicate_name",
        `Lighting fixture name is repeated: ${fixture.name}`,
      );
    names.add(fixture.name);
  }
  const effects = [config.atmosphere, config.bloom, config.colorCorrection].filter(
    (entry) => entry !== undefined,
  );
  if (config.fixtures.length === 0 && effects.length === 0)
    throw new CompositionError(
      "empty_lighting",
      "Declare at least one fixture or effect, or omit this component.",
    );
  names.clear();
  for (const effect of effects) {
    if (names.has(effect.name))
      throw new CompositionError(
        "duplicate_name",
        `Lighting effect name is repeated: ${effect.name}`,
      );
    names.add(effect.name);
  }
  return config;
}

export function compileSceneLighting(
  context: CompositionContext,
  input: unknown,
): CompositionOutput {
  const config = validateSceneLightingConfig(input);
  const inventory: CompositionOutput["inventory"] = [];
  if (config.fixtures.length > 0) {
    const root = createItem(
      context,
      "root",
      config.rootName,
      "Folder",
      engineParent("Workspace"),
      {},
      [],
      "root",
    );
    inventory.push(root);
    for (const fixture of [...config.fixtures].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const carrier = createItem(
        context,
        "fixture-" + fixture.id,
        fixture.name,
        "Part",
        outputParent(context, root),
        {
          Anchored: bool(true),
          CanCollide: bool(false),
          CanTouch: bool(false),
          CanQuery: bool(false),
          CastShadow: bool(false),
          Transparency: num(1),
          Size: vec3(fixture.size),
          CFrame: {
            kind: "cframe_f32x12",
            components: [
              fixture.position.x,
              fixture.position.y,
              fixture.position.z,
              ...sceneEulerXyz(fixture.rotationDegrees ?? { x: 0, y: 0, z: 0 }),
            ],
          },
        },
        [root.id],
        "fixture/" + fixture.id,
      );
      const light = fixture.light;
      inventory.push(
        carrier,
        createItem(
          context,
          "light-" + fixture.id,
          "Light",
          light.kind === "point"
            ? "PointLight"
            : light.kind === "spot"
              ? "SpotLight"
              : "SurfaceLight",
          outputParent(context, carrier),
          {
            Color: color(light.color),
            Brightness: num(light.brightness),
            Range: num(light.range),
            Enabled: bool(light.enabled),
            Shadows: bool(light.shadows),
            ...(light.kind === "point"
              ? {}
              : { Face: enumeration(light.face), Angle: num(light.angle) }),
          },
          [carrier.id],
          "light/" + fixture.id,
        ),
      );
    }
  }
  const parent = engineParent("Lighting");
  const atmosphere = config.atmosphere;
  if (atmosphere)
    inventory.push(
      createItem(
        context,
        "atmosphere",
        atmosphere.name,
        "Atmosphere",
        parent,
        {
          Color: color(atmosphere.color),
          Decay: color(atmosphere.decay),
          Density: num(atmosphere.density),
          Offset: num(atmosphere.offset),
          Haze: num(atmosphere.haze),
          Glare: num(atmosphere.glare),
        },
        [],
        "atmosphere",
      ),
    );
  const bloom = config.bloom;
  if (bloom)
    inventory.push(
      createItem(
        context,
        "bloom",
        bloom.name,
        "BloomEffect",
        parent,
        {
          Enabled: bool(bloom.enabled),
          Intensity: num(bloom.intensity),
          Size: num(bloom.size),
          Threshold: num(bloom.threshold),
        },
        [],
        "bloom",
      ),
    );
  const correction = config.colorCorrection;
  if (correction)
    inventory.push(
      createItem(
        context,
        "color-correction",
        correction.name,
        "ColorCorrectionEffect",
        parent,
        {
          Enabled: bool(correction.enabled),
          Brightness: num(correction.brightness),
          Contrast: num(correction.contrast),
          Saturation: num(correction.saturation),
          TintColor: color(correction.tintColor),
        },
        [],
        "color-correction",
      ),
    );
  return {
    inventory,
    sources: [],
    obligations: SCENE_LIGHTING_DEFINITION.obligations.map((entry) => ({
      componentId: context.componentId,
      ...entry,
    })),
    limitations: [
      "Owned fixtures and effects only. Lighting service properties, existing effects, camera state and art direction are not rewritten.",
      "At most 128 fixtures (each one invisible Part and one light), one Folder and three effects: 260 editor objects. Each light range is at most 60 studs. These are authored resource bounds, not GPU, draw-call, lighting coverage or frame-rate guarantees.",
      "Existing or separately declared Atmosphere and post-effects can interact with these effects. Inspect the combined native appearance, graphics-quality behavior and client frame cost in the requested views.",
    ],
  };
}

export const SCENE_LIGHTING_EXPANDER = {
  definition: gameRecipeDefinitionLock(SCENE_LIGHTING_DEFINITION),
  expand: (input: CompositionContext & { config: unknown }) =>
    compileSceneLighting(input, input.config).inventory,
};
