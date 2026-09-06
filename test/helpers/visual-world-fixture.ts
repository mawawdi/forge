import {
  BLENDER_COMPILER_PROFILE,
  BLENDER_MACOS_ARM64_DMG_SHA256,
  BLENDER_SCENE_SPEC_ABI,
  BLENDER_VERSION,
  type BlenderSceneIntent,
} from "../../packages/visual-world/src/index.js";

const HASH = "a".repeat(64);

export function sceneTransform(x = 0, y = 0, z = 0) {
  return {
    position: { x, y, z },
    rotation: { xDegrees: 0, yDegrees: 0, zDegrees: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

/** Small complete scene used only as synthetic contract evidence. */
export function visualWorldIntent(): BlenderSceneIntent {
  return {
    kind: "BlenderSceneSpec",
    abi: BLENDER_SCENE_SPEC_ABI,
    sceneId: "fixture-scene",
    revision: 1,
    projectId: "fixture-project",
    creatorRequestHash: HASH,
    visualBriefHash: HASH,
    referenceHashes: [],
    seed: 42017,
    compiler: {
      profile: BLENDER_COMPILER_PROFILE,
      blenderVersion: BLENDER_VERSION,
      blenderBinarySha256: BLENDER_MACOS_ARM64_DMG_SHA256,
      workerSha256: HASH,
      inspectorSha256: HASH,
      operationSetSha256: HASH,
      exportProfileSha256: HASH,
    },
    visualBrief: "A bounded synthetic world for contract tests.",
    sources: [],
    textures: [],
    frames: [{ id: "world-frame", transform: sceneTransform() }],
    zones: [
      {
        id: "main-zone",
        name: "Main Zone",
        purpose: "Contains the visible fixture.",
        frameId: "world-frame",
        footprint: [
          { x: -20, y: -20 },
          { x: 20, y: -20 },
          { x: 20, y: 20 },
          { x: -20, y: 20 },
        ],
        verticalRange: { minimum: -2, maximum: 20 },
        densityTarget: 0.2,
      },
    ],
    verticalLayers: [{ id: "ground-layer", zoneId: "main-zone", minimum: -2, maximum: 8 }],
    routes: [
      {
        id: "main-route",
        name: "Main Route",
        zoneIds: ["main-zone"],
        points: [
          { x: -10, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
        width: 4,
        heightClearance: 7,
        closed: false,
      },
    ],
    landmarks: [
      {
        id: "fixture-landmark",
        objectId: "fixture-object",
        hierarchy: "primary",
        requiredViewIds: ["opening-view"],
        silhouette: "A tall readable box offset from the route.",
      },
    ],
    geometries: [
      {
        kind: "solid",
        id: "fixture-geometry",
        shape: "box",
        size: { x: 4, y: 8, z: 4 },
        segments: 8,
      },
    ],
    materials: [
      {
        id: "fixture-material",
        name: "Fixture Metal",
        baseColor: { r: 0.15, g: 0.2, b: 0.3, a: 1 },
        metallic: 0.7,
        roughness: 0.35,
        emissive: { r: 0.05, g: 0.1, b: 0.3, a: 1 },
        alphaMode: "opaque",
        alphaCutoff: 0.5,
        textureIds: [],
      },
    ],
    objects: [
      {
        id: "fixture-object",
        name: "Fixture Landmark",
        geometryId: "fixture-geometry",
        materialIds: ["fixture-material"],
        zoneId: "main-zone",
        partitionId: "interactive-partition",
        localBounds: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 8, z: 4 } },
        pivot: { x: 0, y: -4, z: 0 },
        placement: { kind: "fixed", frameId: "world-frame", transform: sceneTransform(0, 4, 8) },
        semanticRole: "landmark",
        visible: true,
      },
    ],
    instances: [
      {
        id: "fixture-instance",
        sourceObjectId: "fixture-object",
        partitionId: "static-chunk",
        distribution: { kind: "explicit", transforms: [sceneTransform(12, 4, 8)] },
      },
    ],
    collections: [
      {
        id: "fixture-collection",
        name: "Fixture collection",
        objectIds: ["fixture-object"],
        instanceIds: ["fixture-instance"],
      },
    ],
    sockets: [
      {
        id: "fixture-socket",
        ownerObjectId: "fixture-object",
        type: "interaction",
        localTransform: sceneTransform(0, 0, -2),
        clearance: 2,
      },
    ],
    partitions: [
      {
        id: "static-chunk",
        role: "WorldStatic",
        localOrigin: { x: 0, y: 0, z: 0 },
        objectIds: [],
        dependencyIds: ["collision-partition"],
      },
      {
        id: "collision-partition",
        role: "WorldCollision",
        localOrigin: { x: 0, y: 0, z: 0 },
        objectIds: [],
        dependencyIds: [],
      },
      {
        id: "anchor-partition",
        role: "GameplayAnchors",
        localOrigin: { x: 0, y: 0, z: 0 },
        objectIds: [],
        dependencyIds: [],
      },
      {
        id: "interactive-partition",
        role: "InteractiveProps",
        localOrigin: { x: 0, y: 0, z: 0 },
        objectIds: ["fixture-object"],
        dependencyIds: ["static-chunk"],
      },
      {
        id: "effects-partition",
        role: "Effects",
        localOrigin: { x: 0, y: 0, z: 0 },
        objectIds: [],
        dependencyIds: [],
      },
    ],
    collisionProxies: [
      {
        id: "fixture-collision",
        ownerObjectId: "fixture-object",
        partitionId: "collision-partition",
        shape: "box",
        transform: sceneTransform(0, 4, 8),
        size: { x: 4, y: 8, z: 4 },
        canCollide: true,
        canTouch: false,
        canQuery: true,
      },
    ],
    gameplayAnchors: [
      {
        id: "objective-anchor",
        type: "objective",
        partitionId: "anchor-partition",
        zoneId: "main-zone",
        transform: sceneTransform(0, 1, 0),
        extent: { x: 2, y: 2, z: 2 },
        bindingName: "Objective",
      },
    ],
    interactiveProps: [
      {
        id: "fixture-interaction",
        objectId: "fixture-object",
        visualObjectIds: ["fixture-object"],
        partitionId: "interactive-partition",
        pivot: sceneTransform(0, 4, 8),
        socketIds: ["fixture-socket"],
        bindingNames: ["UseFixture"],
      },
    ],
    effects: [
      {
        id: "fixture-light",
        partitionId: "effects-partition",
        kind: "point_light",
        transform: sceneTransform(0, 10, 8),
        color: { r: 0.2, g: 0.5, b: 1, a: 1 },
        intensity: 2,
        range: 24,
        shadows: false,
      },
    ],
    reviewViews: [
      {
        id: "opening-view",
        name: "Opening View",
        position: { x: 0, y: 12, z: -24 },
        lookAt: { x: 0, y: 4, z: 8 },
        fieldOfViewDegrees: 60,
        width: 1280,
        height: 720,
        targetIds: ["fixture-object"],
      },
    ],
    constraints: [
      {
        id: "fixture-containment",
        kind: "containment",
        objectId: "fixture-object",
        zoneId: "main-zone",
        clearance: 0,
      },
      {
        id: "fixture-reachability",
        kind: "reachability",
        routeId: "main-route",
        anchorIds: ["objective-anchor"],
        maximumDistance: 1,
      },
      { id: "fixture-budget", kind: "budget", maximumTriangles: 1000, maximumObjects: 16 },
    ],
    provenance: [
      {
        id: "fixture-provenance",
        authority: "creator",
        subjectId: "fixture-object",
        artifactHash: HASH,
        statement: "Synthetic fixture declaration.",
      },
    ],
    budgets: {
      maximumObjects: 16,
      maximumExpandedInstances: 32,
      maximumTriangles: 1000,
      maximumTrianglesPerMesh: 1000,
      maximumMaterials: 8,
      maximumTextures: 0,
      maximumTexturePixels: 1024,
      maximumGlbBytes: 1_000_000,
      maximumSolverCandidates: 1000,
      maximumBacktracks: 100,
    },
    expectedOutputs: [
      { id: "blend-source", kind: "blend", relativePath: "scene.blend" },
      {
        id: "static-glb",
        kind: "glb",
        partitionId: "static-chunk",
        relativePath: "glb/static-chunk.glb",
      },
      {
        id: "interactive-glb",
        kind: "glb",
        partitionId: "interactive-partition",
        relativePath: "glb/interactive-partition.glb",
      },
      { id: "native-semantics", kind: "native_semantics", relativePath: "native-semantics.json" },
      { id: "geometry-report", kind: "geometry_report", relativePath: "geometry-report.json" },
      { id: "material-report", kind: "material_report", relativePath: "material-report.json" },
      { id: "budget-report", kind: "budget_report", relativePath: "budget-report.json" },
      {
        id: "opening-render",
        kind: "review_render",
        viewId: "opening-view",
        relativePath: "renders/opening-view.png",
      },
      { id: "scene-manifest", kind: "manifest", relativePath: "scene-manifest.json" },
    ],
  };
}
