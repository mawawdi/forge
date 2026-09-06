import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertBoundedGameJson,
  compareGameStrings,
  entityId,
  hashSchema,
  type GameAdmissionPolicy,
} from "../../game-ir/src/primitives.js";

export const BLENDER_SCENE_SPEC_ABI = "blender-scene-spec@2";
export const BLENDER_COMPILER_PROFILE = "forge-blender-macos-arm64@2";
export const BLENDER_VERSION = "5.2.1";
export const BLENDER_MACOS_ARM64_DMG_SHA256 =
  "6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3";
export const SCENE_PARTITION_ROLES = [
  "WorldStatic",
  "WorldCollision",
  "GameplayAnchors",
  "InteractiveProps",
  "Effects",
] as const;

const finite = z.number().finite();
const coordinate = finite.min(-1_000_000).max(1_000_000);
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const vector2 = z.object({ x: finite, y: finite }).strict();
export const SCENE_VECTOR3_SCHEMA = z
  .object({ x: coordinate, y: coordinate, z: coordinate })
  .strict();
export const SCENE_EULER_SCHEMA = z
  .object({ xDegrees: finite, yDegrees: finite, zDegrees: finite })
  .strict();
export const SCENE_TRANSFORM_SCHEMA = z
  .object({
    position: SCENE_VECTOR3_SCHEMA,
    rotation: SCENE_EULER_SCHEMA,
    scale: SCENE_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Scale axes must be positive",
    ),
  })
  .strict();
export const SCENE_BOUNDS_SCHEMA = z
  .object({ center: SCENE_VECTOR3_SCHEMA, size: SCENE_VECTOR3_SCHEMA })
  .strict()
  .refine(({ size }) => size.x > 0 && size.y > 0 && size.z > 0, "Bounds must be positive");

const identity = entityId;
const string160 = z.string().trim().min(1).max(160);
const string1024 = z.string().trim().min(1).max(1024);
const rgba = z
  .object({
    r: finite.min(0).max(1),
    g: finite.min(0).max(1),
    b: finite.min(0).max(1),
    a: finite.min(0).max(1),
  })
  .strict();
const transform = SCENE_TRANSFORM_SCHEMA;
const bounds = SCENE_BOUNDS_SCHEMA;

const indexedMesh = z
  .object({
    kind: z.literal("indexed_mesh"),
    id: identity,
    vertices: z.array(SCENE_VECTOR3_SCHEMA).min(3).max(65_536),
    triangles: z
      .array(
        z.tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
      )
      .min(1)
      .max(20_000),
    uvs: z.array(vector2).max(65_536),
  })
  .strict();
const solid = z
  .object({
    kind: z.literal("solid"),
    id: identity,
    shape: z.enum(["box", "sphere", "cylinder", "cone", "torus"]),
    size: SCENE_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Solid dimensions must be positive",
    ),
    segments: z.number().int().min(3).max(128),
    minorRadius: positive.optional(),
  })
  .strict();
const profile = z
  .object({
    kind: z.literal("profile"),
    id: identity,
    points: z.array(vector2).min(3).max(512),
    closed: z.boolean(),
  })
  .strict();
const curve = z
  .object({
    kind: z.literal("curve"),
    id: identity,
    interpolation: z.enum(["polyline", "cubic_bezier"]),
    points: z.array(SCENE_VECTOR3_SCHEMA).min(2).max(512),
    samplesPerSegment: z.number().int().min(1).max(64),
    closed: z.boolean(),
  })
  .strict();
const externalMesh = z
  .object({
    kind: z.literal("external_glb"),
    id: identity,
    sourceId: identity,
    expectedBounds: bounds,
  })
  .strict();
const construction = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("extrude"), id: identity, profileId: identity, depth: positive })
    .strict(),
  z
    .object({
      kind: z.literal("revolve"),
      id: identity,
      profileId: identity,
      axis: z.enum(["x", "y", "z"]),
      degrees: finite.min(1).max(360),
      segments: z.number().int().min(3).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("loft"),
      id: identity,
      profileIds: z.array(identity).min(2).max(64),
      offsets: z.array(SCENE_VECTOR3_SCHEMA).min(2).max(64),
    })
    .strict(),
  z
    .object({ kind: z.literal("sweep"), id: identity, profileId: identity, curveId: identity })
    .strict(),
  z
    .object({ kind: z.literal("join"), id: identity, operandIds: z.array(identity).min(2).max(64) })
    .strict(),
]);
const modifier = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bevel"),
      id: identity,
      operandId: identity,
      width: positive,
      segments: z.number().int().min(1).max(16),
    })
    .strict(),
  z
    .object({ kind: z.literal("solidify"), id: identity, operandId: identity, thickness: positive })
    .strict(),
  z
    .object({
      kind: z.literal("mirror"),
      id: identity,
      operandId: identity,
      axis: z.enum(["x", "y", "z"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("subdivide"),
      id: identity,
      operandId: identity,
      levels: z.number().int().min(1).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("boolean"),
      id: identity,
      operation: z.enum(["union", "difference", "intersection"]),
      leftId: identity,
      rightId: identity,
    })
    .strict(),
  z
    .object({ kind: z.literal("transform_geometry"), id: identity, operandId: identity, transform })
    .strict(),
  z
    .object({
      kind: z.literal("deform"),
      id: identity,
      operandId: identity,
      mode: z.enum(["bend", "taper", "twist"]),
      axis: z.enum(["x", "y", "z"]),
      amount: finite.min(-360).max(360),
    })
    .strict(),
]);
export const SCENE_GEOMETRY_SCHEMA = z.discriminatedUnion("kind", [
  indexedMesh,
  solid,
  profile,
  curve,
  externalMesh,
  ...construction.options,
  ...modifier.options,
]);

const zone = z
  .object({
    id: identity,
    name: string160,
    purpose: string1024,
    frameId: identity,
    footprint: z.array(vector2).min(3).max(256),
    verticalRange: z.object({ minimum: finite, maximum: finite }).strict(),
    densityTarget: finite.min(0).max(1),
  })
  .strict();
const frame = z.object({ id: identity, parentId: identity.optional(), transform }).strict();
const route = z
  .object({
    id: identity,
    name: string160,
    zoneIds: z.array(identity).min(1).max(64),
    points: z.array(SCENE_VECTOR3_SCHEMA).min(2).max(512),
    width: positive,
    heightClearance: positive,
    closed: z.boolean(),
  })
  .strict();
const placementIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), frameId: identity, transform }).strict(),
  z
    .object({
      kind: z.literal("solve"),
      frameId: identity,
      zoneIds: z.array(identity).min(1).max(32),
      positionBounds: z
        .object({ minimum: SCENE_VECTOR3_SCHEMA, maximum: SCENE_VECTOR3_SCHEMA })
        .strict()
        .refine(
          ({ minimum, maximum }) =>
            minimum.x <= maximum.x && minimum.y <= maximum.y && minimum.z <= maximum.z,
          "Placement bounds must have ordered axes",
        ),
      yawCandidatesDegrees: z.array(finite).max(24),
      preferredPosition: SCENE_VECTOR3_SCHEMA.optional(),
    })
    .strict(),
]);
const sceneObjectIntent = z
  .object({
    id: identity,
    name: string160,
    geometryId: identity,
    materialIds: z.array(identity).min(1).max(8),
    zoneId: identity,
    partitionId: identity,
    localBounds: bounds,
    pivot: SCENE_VECTOR3_SCHEMA,
    placement: placementIntent,
    semanticRole: string160,
    visible: z.boolean(),
  })
  .strict();
const sceneObject = sceneObjectIntent
  .omit({ placement: true })
  .extend({ frameId: identity, transform });
const resolvedInstance = z
  .object({
    id: identity,
    sourceObjectId: identity,
    partitionId: identity,
    transforms: z.array(transform).min(1).max(4096),
  })
  .strict();
const instanceDistribution = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("explicit"), transforms: z.array(transform).min(1).max(4096) })
    .strict(),
  z
    .object({
      kind: z.literal("linear"),
      origin: transform,
      step: SCENE_VECTOR3_SCHEMA,
      count: z.number().int().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("radial"),
      center: SCENE_VECTOR3_SCHEMA,
      radius: nonnegative,
      startAngleDegrees: finite,
      sweepAngleDegrees: finite.min(-360).max(360),
      count: z.number().int().min(1).max(4096),
      y: finite,
      scale: SCENE_VECTOR3_SCHEMA.refine(
        ({ x, y, z }) => x > 0 && y > 0 && z > 0,
        "Scale axes must be positive",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("along_curve"),
      curveId: identity,
      count: z.number().int().min(1).max(4096),
      scale: SCENE_VECTOR3_SCHEMA.refine(
        ({ x, y, z }) => x > 0 && y > 0 && z > 0,
        "Scale axes must be positive",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("seeded_spatial"),
      zoneId: identity,
      positionBounds: z
        .object({ minimum: SCENE_VECTOR3_SCHEMA, maximum: SCENE_VECTOR3_SCHEMA })
        .strict()
        .refine(
          ({ minimum, maximum }) =>
            minimum.x <= maximum.x && minimum.y <= maximum.y && minimum.z <= maximum.z,
          "Instance placement bounds must have ordered axes",
        ),
      yawCandidatesDegrees: z.array(finite).max(24),
      count: z.number().int().min(1).max(4096),
      minimumSeparation: nonnegative,
      scale: SCENE_VECTOR3_SCHEMA.refine(
        ({ x, y, z }) => x > 0 && y > 0 && z > 0,
        "Scale axes must be positive",
      ),
    })
    .strict(),
]);
const instanceIntent = z
  .object({
    id: identity,
    sourceObjectId: identity,
    partitionId: identity,
    distribution: instanceDistribution,
  })
  .strict();
const collection = z
  .object({
    id: identity,
    name: string160,
    parentId: identity.optional(),
    objectIds: z.array(identity).max(8192),
    instanceIds: z.array(identity).max(8192),
  })
  .strict();
const socket = z
  .object({
    id: identity,
    ownerObjectId: identity,
    type: string160,
    localTransform: transform,
    clearance: nonnegative,
  })
  .strict();
const material = z
  .object({
    id: identity,
    name: string160,
    baseColor: rgba,
    metallic: finite.min(0).max(1),
    roughness: finite.min(0).max(1),
    emissive: rgba,
    alphaMode: z.enum(["opaque", "mask", "blend"]),
    alphaCutoff: finite.min(0).max(1),
    textureIds: z.array(identity).max(5),
  })
  .strict();
const source = z
  .object({
    id: identity,
    kind: z.enum(["creator_glb", "creator_texture", "generated_asset"]),
    sha256: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    licenseId: string160,
    rights: z.enum(["creator_owned", "commercial_use_permitted", "research_only"]),
    attribution: z.string().max(2048),
    localHandle: hashSchema,
  })
  .strict();
const texture = z
  .object({
    id: identity,
    sourceId: identity,
    role: z.enum(["base_color", "normal", "roughness", "metalness", "emissive"]),
    mediaType: z.enum(["image/png", "image/jpeg"]),
    sha256: hashSchema,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
  })
  .strict();
const landmark = z
  .object({
    id: identity,
    objectId: identity,
    hierarchy: z.enum(["primary", "secondary", "tertiary"]),
    requiredViewIds: z.array(identity).max(32),
    silhouette: string1024,
  })
  .strict();
const collision = z
  .object({
    id: identity,
    ownerObjectId: identity.optional(),
    partitionId: identity,
    shape: z.enum(["box", "sphere", "cylinder", "wedge"]),
    transform,
    size: SCENE_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Collision dimensions must be positive",
    ),
    canCollide: z.boolean(),
    canTouch: z.boolean(),
    canQuery: z.boolean(),
  })
  .strict();
const anchor = z
  .object({
    id: identity,
    type: z.enum([
      "spawn",
      "objective",
      "hazard",
      "trigger",
      "route_point",
      "socket",
      "interaction",
    ]),
    partitionId: identity,
    zoneId: identity,
    transform,
    extent: SCENE_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Anchor extents must be positive",
    ).optional(),
    bindingName: string160,
  })
  .strict();
const interactive = z
  .object({
    id: identity,
    objectId: identity,
    visualObjectIds: z.array(identity).min(1).max(256),
    partitionId: identity,
    pivot: transform,
    socketIds: z.array(identity).max(32),
    bindingNames: z.array(string160).max(32),
  })
  .strict();
const effectCommon = {
  id: identity,
  partitionId: identity,
  transform,
};
const lightCommon = {
  ...effectCommon,
  color: rgba,
  intensity: nonnegative.max(100_000),
  range: positive.max(10_000),
  shadows: z.boolean(),
};
const effect = z.discriminatedUnion("kind", [
  z.object({ ...lightCommon, kind: z.literal("point_light") }).strict(),
  z
    .object({
      ...lightCommon,
      kind: z.literal("spot_light"),
      angleDegrees: positive.max(180),
      face: z.enum(["Front", "Back", "Left", "Right", "Top", "Bottom"]),
    })
    .strict(),
  z
    .object({
      ...lightCommon,
      kind: z.literal("surface_light"),
      angleDegrees: positive.max(180),
      face: z.enum(["Front", "Back", "Left", "Right", "Top", "Bottom"]),
    })
    .strict(),
  z
    .object({
      ...effectCommon,
      kind: z.literal("particle"),
      color: rgba,
      rate: nonnegative.max(10_000),
      lifetimeSeconds: z.tuple([nonnegative.max(600), positive.max(600)]),
      speed: z.tuple([nonnegative.max(10_000), nonnegative.max(10_000)]),
      spreadDegrees: z.tuple([finite.min(0).max(180), finite.min(0).max(180)]),
      lightEmission: finite.min(0).max(1),
    })
    .strict()
    .refine(
      (value) =>
        value.lifetimeSeconds[0] <= value.lifetimeSeconds[1] && value.speed[0] <= value.speed[1],
      "Particle ranges must be ordered",
    ),
  z
    .object({
      ...effectCommon,
      kind: z.literal("atmosphere"),
      color: rgba,
      decay: rgba,
      density: finite.min(0).max(1),
      offset: finite.min(0).max(1),
      haze: nonnegative.max(10),
      glare: nonnegative.max(10),
    })
    .strict(),
  z
    .object({
      ...effectCommon,
      kind: z.literal("sound"),
      soundAssetId: z.string().regex(/^[1-9][0-9]{0,19}$/),
      volume: finite.min(0).max(10),
      playbackSpeed: positive.max(4),
      looped: z.boolean(),
      rolloffMinimumDistance: nonnegative.max(100_000),
      rolloffMaximumDistance: positive.max(100_000),
    })
    .strict()
    .refine(
      (value) => value.rolloffMinimumDistance <= value.rolloffMaximumDistance,
      "Sound rolloff distances must be ordered",
    ),
]);
const view = z
  .object({
    id: identity,
    name: string160,
    position: SCENE_VECTOR3_SCHEMA,
    lookAt: SCENE_VECTOR3_SCHEMA,
    fieldOfViewDegrees: finite.min(1).max(120),
    width: z.number().int().min(64).max(8192),
    height: z.number().int().min(64).max(8192),
    targetIds: z.array(identity).min(1).max(64),
  })
  .strict();
const partition = z
  .object({
    id: identity,
    role: z.enum(SCENE_PARTITION_ROLES),
    localOrigin: SCENE_VECTOR3_SCHEMA,
    objectIds: z.array(identity).max(8192),
    dependencyIds: z.array(identity).max(128),
  })
  .strict();
const constraint = z.discriminatedUnion("kind", [
  z
    .object({
      id: identity,
      kind: z.literal("containment"),
      objectId: identity,
      zoneId: identity,
      clearance: nonnegative,
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("separation"),
      firstObjectId: identity,
      secondObjectId: identity,
      clearance: nonnegative,
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("support"),
      objectId: identity,
      supporterId: identity,
      tolerance: nonnegative,
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("clearance"),
      routeId: identity,
      objectIds: z.array(identity).max(8192),
      clearance: nonnegative,
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("reachability"),
      routeId: identity,
      anchorIds: z.array(identity).min(1).max(256),
      maximumDistance: positive,
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("sightline"),
      from: SCENE_VECTOR3_SCHEMA,
      targetObjectId: identity,
      occluderIds: z.array(identity).max(8192),
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("camera_framing"),
      viewId: identity,
      objectIds: z.array(identity).min(1).max(64),
      margin: finite.min(0).max(0.45),
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("density"),
      zoneId: identity,
      minimum: finite.min(0).max(1),
      maximum: finite.min(0).max(1),
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("negative_space"),
      zoneId: identity,
      minimumFraction: finite.min(0).max(1),
    })
    .strict(),
  z
    .object({
      id: identity,
      kind: z.literal("budget"),
      maximumTriangles: z.number().int().positive(),
      maximumObjects: z.number().int().positive(),
    })
    .strict(),
]);

const budget = z
  .object({
    maximumObjects: z.number().int().positive().max(8192),
    maximumExpandedInstances: z.number().int().positive().max(65_536),
    maximumTriangles: z.number().int().positive().max(2_000_000),
    maximumTrianglesPerMesh: z.number().int().positive().max(20_000),
    maximumMaterials: z.number().int().positive().max(512),
    maximumTextures: z.number().int().nonnegative().max(512),
    maximumTexturePixels: z
      .number()
      .int()
      .positive()
      .max(4096 * 4096),
    maximumGlbBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    maximumSolverCandidates: z.number().int().positive().max(2_000_000),
    maximumBacktracks: z.number().int().nonnegative().max(100_000),
  })
  .strict();
const expectedOutput = z
  .object({
    id: identity,
    kind: z.enum([
      "blend",
      "glb",
      "manifest",
      "native_semantics",
      "geometry_report",
      "material_report",
      "budget_report",
      "review_render",
    ]),
    partitionId: identity.optional(),
    viewId: identity.optional(),
    relativePath: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/),
  })
  .strict();

export const SCENE_GEOMETRY_ANALYSIS_SCHEMA = z
  .object({
    kind: z.literal("SceneGeometryAnalysis"),
    version: z.literal("forge-scene-geometry-analysis@2"),
    hash: hashSchema,
    entries: z
      .array(
        z
          .object({
            geometryId: identity,
            bounds,
            estimatedTriangles: z.number().int().nonnegative().max(20_000_000),
            dependencyHash: hashSchema,
            sourceAssetHash: hashSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8192),
  })
  .strict();

const commonSceneFields = {
  kind: z.literal("BlenderSceneSpec"),
  abi: z.literal(BLENDER_SCENE_SPEC_ABI),
  sceneId: identity,
  revision: z.number().int().positive(),
  parent: z.object({ revision: z.number().int().positive(), hash: hashSchema }).strict().optional(),
  projectId: z.string().min(1).max(256),
  creatorRequestHash: hashSchema,
  visualBriefHash: hashSchema,
  referenceHashes: z.array(hashSchema).max(4),
  seed: z.number().int().min(0).max(0xffff_ffff),
  compiler: z
    .object({
      profile: z.literal(BLENDER_COMPILER_PROFILE),
      blenderVersion: z.literal(BLENDER_VERSION),
      blenderBinarySha256: hashSchema,
      workerSha256: hashSchema,
      inspectorSha256: hashSchema,
      operationSetSha256: hashSchema,
      exportProfileSha256: hashSchema,
    })
    .strict(),
  visualBrief: z.string().trim().min(1).max(16_384),
  sources: z.array(source).max(512),
  textures: z.array(texture).max(512),
  frames: z.array(frame).min(1).max(8192),
  zones: z.array(zone).min(1).max(256),
  verticalLayers: z
    .array(z.object({ id: identity, zoneId: identity, minimum: finite, maximum: finite }).strict())
    .max(512),
  routes: z.array(route).min(1).max(256),
  landmarks: z.array(landmark).max(256),
  geometries: z.array(SCENE_GEOMETRY_SCHEMA).min(1).max(8192),
  materials: z.array(material).min(1).max(512),
  sockets: z.array(socket).max(8192),
  collections: z.array(collection).max(8192),
  partitions: z.array(partition).min(5).max(512),
  collisionProxies: z.array(collision).max(8192),
  gameplayAnchors: z.array(anchor).max(8192),
  interactiveProps: z.array(interactive).max(2048),
  effects: z.array(effect).max(1024),
  reviewViews: z.array(view).min(1).max(32),
  constraints: z.array(constraint).max(65_536),
  provenance: z
    .array(
      z
        .object({
          id: identity,
          authority: z.enum(["creator", "forge", "platform", "compiler"]),
          subjectId: identity,
          artifactHash: hashSchema,
          statement: string1024,
        })
        .strict(),
    )
    .max(4096),
  budgets: budget,
  expectedOutputs: z.array(expectedOutput).min(2).max(1024),
};

export const BLENDER_SCENE_INTENT_SCHEMA = z
  .object({
    ...commonSceneFields,
    objects: z.array(sceneObjectIntent).min(1).max(8192),
    instances: z.array(instanceIntent).max(8192),
  })
  .strict();
export const BLENDER_SCENE_SPEC_SCHEMA = z
  .object({
    ...commonSceneFields,
    objects: z.array(sceneObject).min(1).max(8192),
    instances: z.array(resolvedInstance).max(8192),
    geometryAnalysis: SCENE_GEOMETRY_ANALYSIS_SCHEMA,
  })
  .strict();
export const BLENDER_SCENE_DECLARATION_SCHEMA = BLENDER_SCENE_INTENT_SCHEMA.omit({
  kind: true,
  revision: true,
  parent: true,
  projectId: true,
  creatorRequestHash: true,
  visualBriefHash: true,
  referenceHashes: true,
  compiler: true,
  sources: true,
  textures: true,
  provenance: true,
  budgets: true,
  expectedOutputs: true,
})
  .extend({ kind: z.literal("BlenderSceneDeclaration") })
  .strict();
export const BLENDER_SCENE_AUTHORITY_SCHEMA = BLENDER_SCENE_INTENT_SCHEMA.pick({
  revision: true,
  parent: true,
  projectId: true,
  creatorRequestHash: true,
  visualBriefHash: true,
  referenceHashes: true,
  compiler: true,
  sources: true,
  textures: true,
  provenance: true,
  budgets: true,
  expectedOutputs: true,
}).strict();
export const BLENDER_SCENE_HANDLE_SCHEMA = z
  .object({ sceneId: identity, revision: z.number().int().positive(), hash: hashSchema })
  .strict();

export type BlenderSceneIntent = z.infer<typeof BLENDER_SCENE_INTENT_SCHEMA>;
export type BlenderSceneSpec = z.infer<typeof BLENDER_SCENE_SPEC_SCHEMA>;
export type BlenderSceneDeclaration = z.infer<typeof BLENDER_SCENE_DECLARATION_SCHEMA>;
export type BlenderSceneAuthority = z.infer<typeof BLENDER_SCENE_AUTHORITY_SCHEMA>;
export type BlenderSceneHandle = z.infer<typeof BLENDER_SCENE_HANDLE_SCHEMA>;
export type SceneTransform = z.infer<typeof SCENE_TRANSFORM_SCHEMA>;
export type SceneBounds = z.infer<typeof SCENE_BOUNDS_SCHEMA>;
export type SceneConstraint = z.infer<typeof constraint>;
export type SceneGeometry = z.infer<typeof SCENE_GEOMETRY_SCHEMA>;
export type SceneInstanceIntent = z.infer<typeof instanceIntent>;
export type SceneGeometryAnalysis = z.infer<typeof SCENE_GEOMETRY_ANALYSIS_SCHEMA>;

export const DEFAULT_VISUAL_WORLD_ADMISSION_POLICY: Readonly<GameAdmissionPolicy> = Object.freeze({
  maximumJsonBytes: 64 * 1024 * 1024,
  maximumJsonDepth: 64,
  maximumJsonNodes: 1_000_000,
  maximumStringUtf8Bytes: 16 * 1024 * 1024,
  maximumComponents: 8192,
  maximumFiles: 8192,
  maximumDeclaredSourceBytes: 64 * 1024 * 1024,
  maximumFileSourceBytes: 20 * 1024 * 1024,
  maximumConnections: 65_536,
  maximumArtifactDependencies: 65_536,
  maximumDefinitions: 1,
});

export function validateBlenderSceneIntent(input: unknown): BlenderSceneIntent {
  assertBoundedGameJson(input, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const intent = BLENDER_SCENE_INTENT_SCHEMA.parse(input);
  validateSceneGraph(intent);
  return canonicalScene(intent);
}

export function validateBlenderSceneDeclaration(input: unknown): BlenderSceneDeclaration {
  assertBoundedGameJson(input, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const declaration = BLENDER_SCENE_DECLARATION_SCHEMA.parse(input);
  const identityArrays: Array<readonly { id: string }[]> = [
    declaration.frames,
    declaration.zones,
    declaration.verticalLayers,
    declaration.routes,
    declaration.landmarks,
    declaration.geometries,
    declaration.materials,
    declaration.objects,
    declaration.instances,
    declaration.sockets,
    declaration.collections,
    declaration.partitions,
    declaration.collisionProxies,
    declaration.gameplayAnchors,
    declaration.interactiveProps,
    declaration.effects,
    declaration.reviewViews,
    declaration.constraints,
  ];
  for (const entries of identityArrays) unique(entries, "scene declaration");
  assertGlobalIdentities(identityArrays, "scene declaration");
  assertAcyclic(
    declaration.frames.map((entry) => [entry.id, entry.parentId ? [entry.parentId] : []]),
    "frame",
  );
  const geometries = unique(declaration.geometries, "geometry");
  const geometryDependencies = declaration.geometries.map(
    (geometry) => [geometry.id, geometryOperandIds(geometry)] as const,
  );
  for (const [, dependencies] of geometryDependencies)
    for (const dependency of dependencies) requiredRef(geometries, dependency, "geometry operand");
  assertAcyclic(geometryDependencies, "geometry");
  assertAcyclic(
    declaration.partitions.map((entry) => [entry.id, entry.dependencyIds]),
    "partition",
  );
  return canonicalDeclaration(declaration);
}

export function bindBlenderSceneIntent(
  declarationInput: unknown,
  authorityInput: unknown,
): BlenderSceneIntent {
  assertBoundedGameJson(authorityInput, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const declaration = validateBlenderSceneDeclaration(declarationInput);
  const authority = BLENDER_SCENE_AUTHORITY_SCHEMA.parse(authorityInput);
  const { kind: _kind, ...semantic } = declaration;
  return validateBlenderSceneIntent({
    kind: "BlenderSceneSpec",
    ...authority,
    ...semantic,
  });
}

export function validateBlenderSceneSpec(input: unknown): BlenderSceneSpec {
  assertBoundedGameJson(input, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
  const spec = BLENDER_SCENE_SPEC_SCHEMA.parse(input);
  validateSceneGraph(spec);
  const { hash, ...analysisMaterial } = spec.geometryAnalysis;
  if (contentHash(stableJson(analysisMaterial)) !== hash)
    throw new Error("Scene geometry analysis hash mismatch");
  const analyzed = unique(
    spec.geometryAnalysis.entries.map((entry) => ({ id: entry.geometryId, ...entry })),
    "geometry analysis",
  );
  const meshGeometryIds = spec.geometries
    .filter((entry) => geometryOutputKind(entry) === "mesh")
    .map((entry) => entry.id);
  if (analyzed.size !== meshGeometryIds.length || meshGeometryIds.some((id) => !analyzed.has(id)))
    throw new Error("Scene geometry analysis does not cover the exact mesh geometry inventory");
  for (const geometry of spec.geometries)
    if (geometry.kind === "external_glb") {
      const sourceHash = spec.sources.find((entry) => entry.id === geometry.sourceId)!.sha256;
      if (analyzed.get(geometry.id)!.sourceAssetHash !== sourceHash)
        throw new Error(`External geometry analysis source hash mismatch: ${geometry.id}`);
    }
  return canonicalScene(spec);
}

export function blenderSceneSpecHandle(spec: BlenderSceneSpec): BlenderSceneHandle {
  const canonical = validateBlenderSceneSpec(spec);
  return {
    sceneId: canonical.sceneId,
    revision: canonical.revision,
    hash: contentHash(stableJson(canonical)),
  };
}

function canonicalScene<T extends BlenderSceneIntent | BlenderSceneSpec>(scene: T): T {
  const copy = structuredClone(scene);
  const arrays: Array<Array<{ id: string }>> = [
    copy.sources,
    copy.textures,
    copy.frames,
    copy.zones,
    copy.verticalLayers,
    copy.routes,
    copy.landmarks,
    copy.geometries,
    copy.materials,
    copy.objects,
    copy.instances,
    copy.sockets,
    copy.collections,
    copy.partitions,
    copy.collisionProxies,
    copy.gameplayAnchors,
    copy.interactiveProps,
    copy.effects,
    copy.reviewViews,
    copy.constraints,
    copy.provenance,
    copy.expectedOutputs,
  ] as unknown as Array<Array<{ id: string }>>;
  for (const entries of arrays) entries.sort((a, b) => compareGameStrings(a.id, b.id));
  copy.referenceHashes.sort(compareGameStrings);
  for (const partitionValue of copy.partitions) {
    partitionValue.objectIds.sort(compareGameStrings);
    partitionValue.dependencyIds.sort(compareGameStrings);
  }
  return copy;
}

function canonicalDeclaration(scene: BlenderSceneDeclaration): BlenderSceneDeclaration {
  const copy = structuredClone(scene);
  const arrays: Array<Array<{ id: string }>> = [
    copy.frames,
    copy.zones,
    copy.verticalLayers,
    copy.routes,
    copy.landmarks,
    copy.geometries,
    copy.materials,
    copy.objects,
    copy.instances,
    copy.sockets,
    copy.collections,
    copy.partitions,
    copy.collisionProxies,
    copy.gameplayAnchors,
    copy.interactiveProps,
    copy.effects,
    copy.reviewViews,
    copy.constraints,
  ] as unknown as Array<Array<{ id: string }>>;
  for (const entries of arrays)
    entries.sort((left, right) => compareGameStrings(left.id, right.id));
  for (const partitionValue of copy.partitions) {
    partitionValue.objectIds.sort(compareGameStrings);
    partitionValue.dependencyIds.sort(compareGameStrings);
  }
  return copy;
}

function validateSceneGraph(scene: BlenderSceneIntent | BlenderSceneSpec): void {
  const maps = {
    sources: unique(scene.sources, "source"),
    textures: unique(scene.textures, "texture"),
    frames: unique(scene.frames, "frame"),
    zones: unique(scene.zones, "zone"),
    layers: unique(scene.verticalLayers, "vertical layer"),
    routes: unique(scene.routes, "route"),
    landmarks: unique(scene.landmarks, "landmark"),
    geometries: unique(scene.geometries, "geometry"),
    materials: unique(scene.materials, "material"),
    objects: unique(scene.objects as readonly { id: string }[], "object"),
    instances: unique(scene.instances as readonly { id: string }[], "instance"),
    sockets: unique(scene.sockets, "socket"),
    collections: unique(scene.collections, "collection"),
    partitions: unique(scene.partitions, "partition"),
    collisions: unique(scene.collisionProxies, "collision proxy"),
    anchors: unique(scene.gameplayAnchors, "gameplay anchor"),
    interactives: unique(scene.interactiveProps, "interactive prop"),
    effects: unique(scene.effects, "effect"),
    views: unique(scene.reviewViews, "review view"),
    constraints: unique(scene.constraints, "constraint"),
    outputs: unique(scene.expectedOutputs, "expected output"),
  };
  assertGlobalIdentities(
    [
      scene.sources,
      scene.textures,
      scene.frames,
      scene.zones,
      scene.verticalLayers,
      scene.routes,
      scene.landmarks,
      scene.geometries,
      scene.materials,
      scene.objects,
      scene.instances,
      scene.sockets,
      scene.collections,
      scene.partitions,
      scene.collisionProxies,
      scene.gameplayAnchors,
      scene.interactiveProps,
      scene.effects,
      scene.reviewViews,
      scene.constraints,
      scene.provenance,
      scene.expectedOutputs,
    ],
    "scene",
  );
  for (const frameValue of scene.frames)
    optionalRef(maps.frames, frameValue.parentId, "frame parent");
  assertAcyclic(
    scene.frames.map((entry) => [entry.id, entry.parentId ? [entry.parentId] : []]),
    "frame",
  );
  for (const zoneValue of scene.zones) {
    requiredRef(maps.frames, zoneValue.frameId, "zone frame");
    if (zoneValue.verticalRange.minimum >= zoneValue.verticalRange.maximum)
      throw new Error(`Zone vertical range is empty: ${zoneValue.id}`);
    if (polygonArea(zoneValue.footprint) <= 1e-6)
      throw new Error(`Zone footprint is degenerate: ${zoneValue.id}`);
  }
  for (const layer of scene.verticalLayers) {
    requiredRef(maps.zones, layer.zoneId, "layer zone");
    if (layer.minimum >= layer.maximum)
      throw new Error(`Vertical layer range is empty: ${layer.id}`);
    const owner = maps.zones.get(layer.zoneId)!;
    if (layer.minimum < owner.verticalRange.minimum || layer.maximum > owner.verticalRange.maximum)
      throw new Error(`Vertical layer exceeds its zone range: ${layer.id}`);
  }
  for (const zoneValue of scene.zones) {
    const layers = scene.verticalLayers
      .filter((entry) => entry.zoneId === zoneValue.id)
      .sort((left, right) => left.minimum - right.minimum);
    for (let index = 1; index < layers.length; index += 1)
      if (layers[index]!.minimum < layers[index - 1]!.maximum)
        throw new Error(`Vertical layers overlap in zone ${zoneValue.id}`);
  }
  for (const routeValue of scene.routes)
    for (const zoneId of routeValue.zoneIds) requiredRef(maps.zones, zoneId, "route zone");
  const geometryDependencies = scene.geometries.map(
    (geometry) => [geometry.id, geometryOperandIds(geometry)] as const,
  );
  for (const [, dependencies] of geometryDependencies)
    for (const id of dependencies) requiredRef(maps.geometries, id, "geometry operand");
  assertAcyclic(geometryDependencies, "geometry");
  for (const geometry of scene.geometries) {
    if (geometry.kind === "indexed_mesh") {
      for (const triangle of geometry.triangles)
        if (triangle.some((index) => index >= geometry.vertices.length))
          throw new Error(`Indexed mesh triangle is out of range: ${geometry.id}`);
        else if (new Set(triangle).size !== 3)
          throw new Error(`Indexed mesh triangle is degenerate: ${geometry.id}`);
      if (geometry.uvs.length !== 0 && geometry.uvs.length !== geometry.vertices.length)
        throw new Error(`Indexed mesh UV count must be zero or equal vertex count: ${geometry.id}`);
    }
    if (geometry.kind === "profile" && polygonArea(geometry.points) <= 1e-9)
      throw new Error(`Geometry profile is degenerate: ${geometry.id}`);
    if (
      geometry.kind === "curve" &&
      geometry.interpolation === "cubic_bezier" &&
      (geometry.points.length < 4 || (geometry.points.length - 1) % 3 !== 0)
    )
      throw new Error(`Cubic Bézier curve requires 3n+1 control points: ${geometry.id}`);
    if (geometry.kind === "loft" && geometry.profileIds.length !== geometry.offsets.length)
      throw new Error(`Loft profile/offset counts differ: ${geometry.id}`);
    if (geometry.kind === "external_glb")
      requiredRef(maps.sources, geometry.sourceId, "external geometry source");
    if (
      geometry.kind === "external_glb" &&
      maps.sources.get(geometry.sourceId)!.kind === "creator_texture"
    )
      throw new Error(`External GLB geometry refers to a texture source: ${geometry.id}`);
    validateGeometryOperandTypes(geometry, maps.geometries);
  }
  for (const textureValue of scene.textures) {
    requiredRef(maps.sources, textureValue.sourceId, "texture source");
    if (maps.sources.get(textureValue.sourceId)!.kind === "creator_glb")
      throw new Error(`Texture refers to a GLB source: ${textureValue.id}`);
  }
  for (const materialValue of scene.materials) {
    assertDistinctStrings(materialValue.textureIds, `material textures ${materialValue.id}`);
    for (const textureId of materialValue.textureIds)
      requiredRef(maps.textures, textureId, "material texture");
    const roles = materialValue.textureIds.map((id) => maps.textures.get(id)!.role);
    assertDistinctStrings(roles, `material texture roles ${materialValue.id}`);
  }
  for (const object of scene.objects) {
    requiredRef(maps.geometries, object.geometryId, "object geometry");
    requiredRef(maps.zones, object.zoneId, "object zone");
    requiredRef(maps.partitions, object.partitionId, "object partition");
    for (const materialId of object.materialIds)
      requiredRef(maps.materials, materialId, "object material");
    if (geometryOutputKind(maps.geometries.get(object.geometryId)!) !== "mesh")
      throw new Error(`Object geometry must produce a mesh: ${object.id}`);
    const frameId = "frameId" in object ? object.frameId : object.placement.frameId;
    requiredRef(maps.frames, frameId, "object frame");
    if (!(
      object.localBounds.size.x > 0 &&
      object.localBounds.size.y > 0 &&
      object.localBounds.size.z > 0
    ))
      throw new Error(`Object bounds must be positive: ${object.id}`);
  }
  for (const instanceValue of scene.instances) {
    requiredRef(maps.objects, instanceValue.sourceObjectId, "instance source");
    requiredRef(maps.partitions, instanceValue.partitionId, "instance partition");
    if ("distribution" in instanceValue) {
      if (instanceValue.distribution.kind === "along_curve") {
        const curveValue = maps.geometries.get(instanceValue.distribution.curveId);
        if (curveValue?.kind !== "curve")
          throw new Error(`Along-curve instance requires curve geometry: ${instanceValue.id}`);
      }
      if (instanceValue.distribution.kind === "seeded_spatial")
        requiredRef(maps.zones, instanceValue.distribution.zoneId, "instance distribution zone");
    }
  }
  for (const socketValue of scene.sockets)
    requiredRef(maps.objects, socketValue.ownerObjectId, "socket owner");
  for (const collectionValue of scene.collections) {
    optionalRef(maps.collections, collectionValue.parentId, "collection parent");
    for (const objectId of collectionValue.objectIds)
      requiredRef(maps.objects, objectId, "collection object");
    for (const instanceId of collectionValue.instanceIds)
      requiredRef(maps.instances, instanceId, "collection instance");
  }
  assertAcyclic(
    scene.collections.map((entry) => [entry.id, entry.parentId ? [entry.parentId] : []]),
    "collection",
  );
  for (const partitionValue of scene.partitions) {
    assertDistinctStrings(partitionValue.objectIds, `partition objects ${partitionValue.id}`);
    assertDistinctStrings(
      partitionValue.dependencyIds,
      `partition dependencies ${partitionValue.id}`,
    );
    for (const objectId of partitionValue.objectIds)
      requiredRef(maps.objects, objectId, "partition object");
    for (const dependencyId of partitionValue.dependencyIds)
      requiredRef(maps.partitions, dependencyId, "partition dependency");
  }
  assertAcyclic(
    scene.partitions.map((entry) => [entry.id, entry.dependencyIds]),
    "partition",
  );
  for (const role of SCENE_PARTITION_ROLES)
    if (!scene.partitions.some((entry) => entry.role === role))
      throw new Error(`Scene requires partition role ${role}`);
  const partitionOwners = new Map<string, string>();
  for (const partitionValue of scene.partitions)
    for (const objectId of partitionValue.objectIds) {
      if (partitionOwners.has(objectId))
        throw new Error(`Object appears in multiple partitions: ${objectId}`);
      partitionOwners.set(objectId, partitionValue.id);
    }
  for (const object of scene.objects)
    if (partitionOwners.get(object.id) !== object.partitionId)
      throw new Error(`Object partition coverage mismatch: ${object.id}`);
    else if (
      !(["WorldStatic", "InteractiveProps"] as const).includes(
        maps.partitions.get(object.partitionId)!.role as "WorldStatic" | "InteractiveProps",
      )
    )
      throw new Error(`Visual object uses a non-visual partition: ${object.id}`);
  for (const collisionValue of scene.collisionProxies) {
    optionalRef(maps.objects, collisionValue.ownerObjectId, "collision owner");
    requiredRef(maps.partitions, collisionValue.partitionId, "collision partition");
    if (maps.partitions.get(collisionValue.partitionId)!.role !== "WorldCollision")
      throw new Error(`Collision proxy uses the wrong partition role: ${collisionValue.id}`);
  }
  for (const anchorValue of scene.gameplayAnchors) {
    requiredRef(maps.zones, anchorValue.zoneId, "anchor zone");
    requiredRef(maps.partitions, anchorValue.partitionId, "anchor partition");
    if (maps.partitions.get(anchorValue.partitionId)!.role !== "GameplayAnchors")
      throw new Error(`Gameplay anchor uses the wrong partition role: ${anchorValue.id}`);
  }
  for (const interactiveValue of scene.interactiveProps) {
    requiredRef(maps.objects, interactiveValue.objectId, "interactive object");
    assertDistinctStrings(
      interactiveValue.visualObjectIds,
      `interactive visual objects ${interactiveValue.id}`,
    );
    if (!interactiveValue.visualObjectIds.includes(interactiveValue.objectId))
      throw new Error(
        `Interactive visual inventory omits its owner object: ${interactiveValue.id}`,
      );
    for (const objectId of interactiveValue.visualObjectIds)
      requiredRef(maps.objects, objectId, "interactive visual object");
    requiredRef(maps.partitions, interactiveValue.partitionId, "interactive partition");
    const interactivePartition = maps.partitions.get(interactiveValue.partitionId)!;
    if (interactivePartition.role !== "InteractiveProps")
      throw new Error(`Interactive prop uses the wrong partition role: ${interactiveValue.id}`);
    if (
      stableJson([...interactivePartition.objectIds].sort(compareGameStrings)) !==
      stableJson([...interactiveValue.visualObjectIds].sort(compareGameStrings))
    )
      throw new Error(
        `Interactive partition must contain exactly one wrapper's visual inventory: ${interactiveValue.id}`,
      );
    for (const socketId of interactiveValue.socketIds) {
      requiredRef(maps.sockets, socketId, "interactive socket");
      if (!interactiveValue.visualObjectIds.includes(maps.sockets.get(socketId)!.ownerObjectId))
        throw new Error(`Interactive socket belongs to another visual wrapper: ${socketId}`);
    }
  }
  for (const partitionValue of scene.partitions.filter(
    (entry) => entry.role === "InteractiveProps" && entry.objectIds.length > 0,
  ))
    if (
      scene.interactiveProps.filter((entry) => entry.partitionId === partitionValue.id).length !== 1
    )
      throw new Error(
        `Interactive visual partition requires exactly one stable native wrapper: ${partitionValue.id}`,
      );
  for (const effectValue of scene.effects) {
    requiredRef(maps.partitions, effectValue.partitionId, "effect partition");
    if (maps.partitions.get(effectValue.partitionId)!.role !== "Effects")
      throw new Error(`Effect uses the wrong partition role: ${effectValue.id}`);
  }
  for (const landmarkValue of scene.landmarks) {
    requiredRef(maps.objects, landmarkValue.objectId, "landmark object");
    for (const viewId of landmarkValue.requiredViewIds)
      requiredRef(maps.views, viewId, "landmark view");
  }
  for (const viewValue of scene.reviewViews) {
    if (distance(viewValue.position, viewValue.lookAt) < 0.001)
      throw new Error(`Review camera position and target coincide: ${viewValue.id}`);
    for (const objectId of viewValue.targetIds)
      requiredRef(maps.objects, objectId, "review target");
  }
  for (const constraintValue of scene.constraints)
    validateConstraintReferences(constraintValue, maps);
  for (const output of scene.expectedOutputs) {
    optionalRef(maps.partitions, output.partitionId, "output partition");
    optionalRef(maps.views, output.viewId, "output view");
    if (output.kind === "glb" && output.partitionId === undefined)
      throw new Error(`GLB output needs a partition: ${output.id}`);
    if (output.kind === "review_render" && output.viewId === undefined)
      throw new Error(`Review render needs a view: ${output.id}`);
    if (output.kind !== "glb" && output.partitionId !== undefined)
      throw new Error(`Only GLB outputs may bind a partition: ${output.id}`);
    if (output.kind !== "review_render" && output.viewId !== undefined)
      throw new Error(`Only review renders may bind a view: ${output.id}`);
  }
  if (scene.expectedOutputs.filter((entry) => entry.kind === "blend").length !== 1)
    throw new Error("Scene requires exactly one .blend output");
  if (scene.expectedOutputs.filter((entry) => entry.kind === "manifest").length !== 1)
    throw new Error("Scene requires exactly one manifest output");
  for (const kind of [
    "native_semantics",
    "geometry_report",
    "material_report",
    "budget_report",
  ] as const)
    if (scene.expectedOutputs.filter((entry) => entry.kind === kind).length !== 1)
      throw new Error(`Scene requires exactly one ${kind} output`);
  for (const viewValue of scene.reviewViews)
    if (
      !scene.expectedOutputs.some(
        (entry) => entry.kind === "review_render" && entry.viewId === viewValue.id,
      )
    )
      throw new Error(`Scene requires a review render for ${viewValue.id}`);
  const visualPartitionIds = scene.partitions
    .filter(
      (entry) =>
        (entry.role === "WorldStatic" || entry.role === "InteractiveProps") &&
        (entry.objectIds.length > 0 ||
          scene.instances.some((instance) => instance.partitionId === entry.id)),
    )
    .map((entry) => entry.id);
  for (const partitionId of visualPartitionIds)
    if (
      scene.expectedOutputs.filter(
        (entry) => entry.kind === "glb" && entry.partitionId === partitionId,
      ).length !== 1
    )
      throw new Error(`Scene requires exactly one GLB output for visual partition ${partitionId}`);
  for (const output of scene.expectedOutputs.filter((entry) => entry.kind === "glb"))
    if (!visualPartitionIds.includes(output.partitionId!))
      throw new Error(
        `GLB output does not correspond to a populated visual partition: ${output.id}`,
      );
  const outputPaths = new Set<string>();
  for (const output of scene.expectedOutputs) {
    if (outputPaths.has(output.relativePath))
      throw new Error(`Duplicate output path: ${output.relativePath}`);
    outputPaths.add(output.relativePath);
  }
  for (const sourceValue of scene.sources)
    if (sourceValue.rights === "research_only")
      throw new Error(
        `Research-only source is ineligible for production compilation: ${sourceValue.id}`,
      );
}

function validateConstraintReferences(
  value: SceneConstraint,
  maps: Record<string, Map<string, { id: string }>>,
): void {
  switch (value.kind) {
    case "containment":
      requiredRef(maps.objects!, value.objectId, "containment object");
      requiredRef(maps.zones!, value.zoneId, "containment zone");
      break;
    case "separation":
      requiredRef(maps.objects!, value.firstObjectId, "separation object");
      requiredRef(maps.objects!, value.secondObjectId, "separation object");
      break;
    case "support":
      requiredRef(maps.objects!, value.objectId, "supported object");
      requiredRef(maps.objects!, value.supporterId, "supporter object");
      break;
    case "clearance":
      requiredRef(maps.routes!, value.routeId, "clearance route");
      for (const id of value.objectIds) requiredRef(maps.objects!, id, "clearance object");
      break;
    case "reachability":
      requiredRef(maps.routes!, value.routeId, "reachability route");
      for (const id of value.anchorIds) requiredRef(maps.anchors!, id, "reachable anchor");
      break;
    case "sightline":
      requiredRef(maps.objects!, value.targetObjectId, "sightline target");
      for (const id of value.occluderIds) requiredRef(maps.objects!, id, "sightline occluder");
      break;
    case "camera_framing":
      requiredRef(maps.views!, value.viewId, "camera view");
      for (const id of value.objectIds) requiredRef(maps.objects!, id, "camera object");
      break;
    case "density":
      requiredRef(maps.zones!, value.zoneId, "density zone");
      if (value.minimum > value.maximum) throw new Error(`Density range is empty: ${value.id}`);
      break;
    case "negative_space":
      requiredRef(maps.zones!, value.zoneId, "negative-space zone");
      break;
    case "budget":
      break;
  }
}

function geometryOperandIds(geometry: SceneGeometry): string[] {
  switch (geometry.kind) {
    case "extrude":
    case "revolve":
      return [geometry.profileId];
    case "loft":
      return geometry.profileIds;
    case "sweep":
      return [geometry.profileId, geometry.curveId];
    case "join":
      return geometry.operandIds;
    case "bevel":
    case "solidify":
    case "mirror":
    case "subdivide":
    case "transform_geometry":
    case "deform":
      return [geometry.operandId];
    case "boolean":
      return [geometry.leftId, geometry.rightId];
    case "indexed_mesh":
    case "solid":
    case "profile":
    case "curve":
    case "external_glb":
      return [];
  }
}

function geometryOutputKind(geometry: SceneGeometry): "mesh" | "profile" | "curve" {
  if (geometry.kind === "profile") return "profile";
  if (geometry.kind === "curve") return "curve";
  return "mesh";
}

function validateGeometryOperandTypes(
  geometry: SceneGeometry,
  geometries: Map<string, SceneGeometry>,
): void {
  const expect = (id: string, kind: "mesh" | "profile" | "curve", label: string): void => {
    const operand = geometries.get(id)!;
    if (geometryOutputKind(operand) !== kind)
      throw new Error(`${geometry.kind} ${geometry.id} requires ${label} ${kind} operand ${id}`);
  };
  switch (geometry.kind) {
    case "extrude":
    case "revolve":
      expect(geometry.profileId, "profile", "a");
      break;
    case "loft":
      for (const id of geometry.profileIds) expect(id, "profile", "a");
      if (
        new Set(
          geometry.profileIds.map((id) => {
            const entry = geometries.get(id)!;
            return entry.kind === "profile" ? `${entry.points.length}:${entry.closed}` : "invalid";
          }),
        ).size !== 1
      )
        throw new Error(`Loft profiles must have equal point counts and closure: ${geometry.id}`);
      break;
    case "sweep":
      expect(geometry.profileId, "profile", "a");
      expect(geometry.curveId, "curve", "a");
      break;
    case "join":
      for (const id of geometry.operandIds) expect(id, "mesh", "a");
      break;
    case "bevel":
    case "solidify":
    case "mirror":
    case "subdivide":
    case "transform_geometry":
    case "deform":
      expect(geometry.operandId, "mesh", "a");
      break;
    case "boolean":
      expect(geometry.leftId, "mesh", "a left");
      expect(geometry.rightId, "mesh", "a right");
      break;
    case "indexed_mesh":
    case "solid":
    case "profile":
    case "curve":
    case "external_glb":
      break;
  }
}

function assertGlobalIdentities(
  arrays: readonly (readonly { id: string }[])[],
  subject: string,
): void {
  const seen = new Set<string>();
  for (const values of arrays)
    for (const value of values) {
      if (seen.has(value.id)) throw new Error(`Duplicate global ${subject} ID: ${value.id}`);
      seen.add(value.id);
    }
}

function assertDistinctStrings(values: readonly string[], subject: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${subject}`);
}

function unique<T extends { id: string }>(values: readonly T[], subject: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`Duplicate ${subject} ID: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function requiredRef<T extends { id: string }>(
  values: Map<string, T>,
  id: string,
  subject: string,
): void {
  if (!values.has(id)) throw new Error(`Unknown ${subject}: ${id}`);
}

function optionalRef<T extends { id: string }>(
  values: Map<string, T>,
  id: string | undefined,
  subject: string,
): void {
  if (id !== undefined) requiredRef(values, id, subject);
}

function assertAcyclic(
  edges: readonly (readonly [string, readonly string[]])[],
  subject: string,
): void {
  const dependencies = new Map(edges);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`${subject} dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function polygonArea(points: readonly { x: number; y: number }[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twice) / 2;
}
