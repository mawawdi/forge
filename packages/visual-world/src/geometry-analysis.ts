import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  sceneEulerXyz,
  sceneTransformVector,
  type SceneVector,
} from "../../game-composition/src/scene-geometry.js";
import {
  SCENE_GEOMETRY_ANALYSIS_SCHEMA,
  type BlenderSceneIntent,
  type SceneBounds,
  type SceneGeometry,
  type SceneGeometryAnalysis,
  type SceneTransform,
} from "./contracts.js";

export interface InspectedSourceGeometry {
  readonly sourceId: string;
  readonly sha256: string;
  readonly bounds: SceneBounds;
  readonly triangles: number;
}

interface Envelope {
  minimum: SceneVector;
  maximum: SceneVector;
  triangles: number;
  dependencyHash: string;
  sourceAssetHash?: string;
}

/**
 * Derives conservative geometry authority from the operation graph. External
 * geometry is admitted only when the host supplies an inspection bound to the
 * exact declared source hash.
 */
export function deriveSceneGeometryAnalysis(
  scene: BlenderSceneIntent,
  inspectedSources: readonly InspectedSourceGeometry[] = [],
): SceneGeometryAnalysis {
  const geometries = new Map(scene.geometries.map((entry) => [entry.id, entry]));
  const sources = new Map(scene.sources.map((entry) => [entry.id, entry]));
  const inspections = new Map(inspectedSources.map((entry) => [entry.sourceId, entry]));
  if (inspections.size !== inspectedSources.length)
    throw new Error("Duplicate inspected source geometry identity");
  const memo = new Map<string, Envelope>();
  const visiting = new Set<string>();

  const evaluate = (id: string): Envelope => {
    const prior = memo.get(id);
    if (prior) return prior;
    if (visiting.has(id)) throw new Error(`Geometry dependency cycle includes ${id}`);
    const geometry = geometries.get(id);
    if (!geometry) throw new Error(`Unknown geometry operand: ${id}`);
    visiting.add(id);
    const envelope = evaluateGeometry(geometry, evaluate, geometries, sources, inspections);
    visiting.delete(id);
    memo.set(id, envelope);
    return envelope;
  };

  const meshIds = scene.geometries
    .filter((entry) => entry.kind !== "profile" && entry.kind !== "curve")
    .map((entry) => entry.id)
    .sort();
  const entries = meshIds.map((geometryId) => {
    const value = evaluate(geometryId);
    const entry = {
      geometryId,
      bounds: envelopeBounds(value),
      estimatedTriangles: value.triangles,
      dependencyHash: value.dependencyHash,
      ...(value.sourceAssetHash ? { sourceAssetHash: value.sourceAssetHash } : {}),
    };
    return entry;
  });
  const material = {
    kind: "SceneGeometryAnalysis" as const,
    version: "forge-scene-geometry-analysis@2" as const,
    entries,
  };
  return SCENE_GEOMETRY_ANALYSIS_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertIntentBoundsAdmitGeometry(
  scene: BlenderSceneIntent,
  analysis: SceneGeometryAnalysis,
): void {
  const entries = new Map(analysis.entries.map((entry) => [entry.geometryId, entry]));
  for (const object of scene.objects) {
    const derived = entries.get(object.geometryId);
    if (!derived) throw new Error(`Object geometry has no host analysis: ${object.id}`);
    if (!boundsContain(object.localBounds, derived.bounds, 1e-5))
      throw new Error(
        `Object ${object.id} geometry exceeds its admitted local bounds (${object.geometryId})`,
      );
  }
}

export function assertSceneGeometryAnalysis(value: SceneGeometryAnalysis): void {
  const parsed = SCENE_GEOMETRY_ANALYSIS_SCHEMA.parse(value);
  const { hash, ...material } = parsed;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Scene geometry analysis hash mismatch");
  if (new Set(parsed.entries.map((entry) => entry.geometryId)).size !== parsed.entries.length)
    throw new Error("Scene geometry analysis has duplicate geometry identities");
}

function evaluateGeometry(
  geometry: SceneGeometry,
  evaluate: (id: string) => Envelope,
  geometries: ReadonlyMap<string, SceneGeometry>,
  sources: ReadonlyMap<string, BlenderSceneIntent["sources"][number]>,
  inspections: ReadonlyMap<string, InspectedSourceGeometry>,
): Envelope {
  let value: Omit<Envelope, "dependencyHash">;
  switch (geometry.kind) {
    case "indexed_mesh":
      value = { ...pointsEnvelope(geometry.vertices), triangles: geometry.triangles.length };
      break;
    case "solid": {
      const half = scaleVector(geometry.size, 0.5);
      value = {
        minimum: scaleVector(half, -1),
        maximum: half,
        triangles: solidTriangleEstimate(geometry.shape, geometry.segments),
      };
      break;
    }
    case "profile":
      value = {
        ...pointsEnvelope(geometry.points.map((point) => ({ x: point.x, y: 0, z: point.y }))),
        triangles: 0,
      };
      break;
    case "curve":
      value = { ...pointsEnvelope(curveSamplePoints(geometry)), triangles: 0 };
      break;
    case "external_glb": {
      const declared = sources.get(geometry.sourceId)!;
      const inspected = inspections.get(geometry.sourceId);
      if (!inspected || inspected.sha256 !== declared.sha256)
        throw new Error(
          `External geometry ${geometry.id} requires host inspection of source ${geometry.sourceId}`,
        );
      value = {
        ...boundsEnvelope(inspected.bounds),
        triangles: inspected.triangles,
        sourceAssetHash: inspected.sha256,
      };
      break;
    }
    case "extrude": {
      const profile = evaluate(geometry.profileId);
      const points = profilePointCount(geometry.profileId, geometries);
      value = {
        minimum: { x: profile.minimum.x, y: -geometry.depth / 2, z: profile.minimum.z },
        maximum: { x: profile.maximum.x, y: geometry.depth / 2, z: profile.maximum.z },
        triangles: Math.max(0, points * 4 - 4),
      };
      break;
    }
    case "revolve": {
      const profile = evaluate(geometry.profileId);
      const radius = Math.max(Math.abs(profile.minimum.x), Math.abs(profile.maximum.x));
      const heightMinimum = profile.minimum.z;
      const heightMaximum = profile.maximum.z;
      const rings = geometry.degrees === 360 ? geometry.segments : geometry.segments + 1;
      const profilePoints = profilePointCount(geometry.profileId, geometries);
      const base = {
        minimum: { x: -radius, y: -radius, z: -radius },
        maximum: { x: radius, y: radius, z: radius },
      };
      if (geometry.axis === "x") {
        base.minimum.x = heightMinimum;
        base.maximum.x = heightMaximum;
      } else if (geometry.axis === "y") {
        base.minimum.y = heightMinimum;
        base.maximum.y = heightMaximum;
      } else {
        base.minimum.z = heightMinimum;
        base.maximum.z = heightMaximum;
      }
      value = { ...base, triangles: Math.max(0, (rings - 1) * (profilePoints - 1) * 2) };
      break;
    }
    case "loft": {
      const envelopes = geometry.profileIds.map((id, index) =>
        translateEnvelope(evaluate(id), geometry.offsets[index]!),
      );
      const points = profilePointCount(geometry.profileIds[0]!, geometries);
      value = {
        ...unionEnvelopes(envelopes),
        triangles: (geometry.profileIds.length - 1) * points * 2,
      };
      break;
    }
    case "sweep": {
      const profile = evaluate(geometry.profileId);
      const curve = evaluate(geometry.curveId);
      const points = profilePointCount(geometry.profileId, geometries);
      const samples = curveSampleCount(geometry.curveId, geometries);
      value = {
        minimum: addVector(curve.minimum, profile.minimum),
        maximum: addVector(curve.maximum, profile.maximum),
        triangles: Math.max(0, (samples - 1) * points * 2),
      };
      break;
    }
    case "join": {
      const operands = geometry.operandIds.map(evaluate);
      value = {
        ...unionEnvelopes(operands),
        triangles: operands.reduce((sum, entry) => sum + entry.triangles, 0),
      };
      break;
    }
    case "bevel": {
      const operand = evaluate(geometry.operandId);
      value = {
        minimum: operand.minimum,
        maximum: operand.maximum,
        triangles: operand.triangles * 4,
      };
      break;
    }
    case "solidify": {
      const operand = evaluate(geometry.operandId);
      value = {
        ...expandEnvelope(operand, geometry.thickness),
        triangles: operand.triangles * 2 + 4,
      };
      break;
    }
    case "mirror": {
      const operand = evaluate(geometry.operandId);
      value = {
        ...unionEnvelopes([operand, mirrorEnvelope(operand, geometry.axis)]),
        triangles: operand.triangles * 2,
      };
      break;
    }
    case "subdivide": {
      const operand = evaluate(geometry.operandId);
      value = {
        minimum: operand.minimum,
        maximum: operand.maximum,
        triangles: operand.triangles * 4 ** geometry.levels,
      };
      break;
    }
    case "boolean": {
      const left = evaluate(geometry.leftId);
      const right = evaluate(geometry.rightId);
      value = {
        ...(geometry.operation === "difference" ? left : unionEnvelopes([left, right])),
        triangles: (left.triangles + right.triangles) * 2,
      };
      break;
    }
    case "transform_geometry": {
      const operand = evaluate(geometry.operandId);
      value = { ...transformEnvelope(operand, geometry.transform), triangles: operand.triangles };
      break;
    }
    case "deform": {
      const operand = evaluate(geometry.operandId);
      if (geometry.mode === "twist") {
        const perpendicular = (["x", "y", "z"] as const).filter((axis) => axis !== geometry.axis);
        const radius = Math.hypot(
          Math.max(
            Math.abs(operand.minimum[perpendicular[0]!]!),
            Math.abs(operand.maximum[perpendicular[0]!]!),
          ),
          Math.max(
            Math.abs(operand.minimum[perpendicular[1]!]!),
            Math.abs(operand.maximum[perpendicular[1]!]!),
          ),
        );
        const minimum = { ...operand.minimum };
        const maximum = { ...operand.maximum };
        for (const axis of perpendicular) {
          minimum[axis] = -radius;
          maximum[axis] = radius;
        }
        value = { minimum, maximum, triangles: operand.triangles };
      } else if (geometry.mode === "taper") {
        const factor = Math.max(1, 1 + geometry.amount / 360);
        const minimum = { ...operand.minimum };
        const maximum = { ...operand.maximum };
        for (const axis of (["x", "y", "z"] as const).filter((axis) => axis !== geometry.axis)) {
          minimum[axis] = Math.min(operand.minimum[axis] * factor, operand.minimum[axis]);
          maximum[axis] = Math.max(operand.maximum[axis] * factor, operand.maximum[axis]);
        }
        value = { minimum, maximum, triangles: operand.triangles };
      } else {
        const diagonal = vectorLength(subtractVector(operand.maximum, operand.minimum));
        const expansion = diagonal * (Math.abs(geometry.amount) / 360);
        value = { ...expandEnvelope(operand, expansion), triangles: operand.triangles };
      }
      break;
    }
  }
  const dependencyHash = contentHash(
    stableJson({
      geometry,
      operands: geometryOperandIds(geometry).map((id) => evaluate(id).dependencyHash),
      ...(value.sourceAssetHash ? { sourceAssetHash: value.sourceAssetHash } : {}),
    }),
  );
  return { ...value, dependencyHash };
}

function profilePointCount(id: string, geometries: ReadonlyMap<string, SceneGeometry>): number {
  const geometry = geometries.get(id);
  if (geometry?.kind !== "profile") throw new Error(`Expected profile geometry ${id}`);
  return geometry.points.length;
}

function curveSampleCount(id: string, geometries: ReadonlyMap<string, SceneGeometry>): number {
  const geometry = geometries.get(id);
  if (geometry?.kind !== "curve") throw new Error(`Expected curve geometry ${id}`);
  if (geometry.interpolation === "polyline") return geometry.points.length;
  return ((geometry.points.length - 1) / 3) * geometry.samplesPerSegment + 1;
}

function curveSamplePoints(geometry: Extract<SceneGeometry, { kind: "curve" }>): SceneVector[] {
  // A cubic Bézier lies inside the convex hull of its control points, so the
  // authored controls provide a conservative envelope independent of sampling.
  return geometry.points;
}

function solidTriangleEstimate(shape: string, segments: number): number {
  if (shape === "box") return 12;
  if (shape === "sphere") return segments * Math.max(3, Math.floor(segments / 2)) * 2;
  if (shape === "torus") return segments * Math.max(3, Math.floor(segments / 4)) * 2;
  return segments * 4;
}

function pointsEnvelope(points: readonly SceneVector[]): Pick<Envelope, "minimum" | "maximum"> {
  if (!points.length) throw new Error("Geometry operation produced no envelope points");
  return {
    minimum: {
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y)),
      z: Math.min(...points.map((point) => point.z)),
    },
    maximum: {
      x: Math.max(...points.map((point) => point.x)),
      y: Math.max(...points.map((point) => point.y)),
      z: Math.max(...points.map((point) => point.z)),
    },
  };
}

function boundsEnvelope(bounds: SceneBounds): Pick<Envelope, "minimum" | "maximum"> {
  const half = scaleVector(bounds.size, 0.5);
  return {
    minimum: subtractVector(bounds.center, half),
    maximum: addVector(bounds.center, half),
  };
}

function envelopeBounds(value: Pick<Envelope, "minimum" | "maximum">): SceneBounds {
  const size = subtractVector(value.maximum, value.minimum);
  return {
    center: scaleVector(addVector(value.minimum, value.maximum), 0.5),
    size: {
      x: Math.max(size.x, 1e-6),
      y: Math.max(size.y, 1e-6),
      z: Math.max(size.z, 1e-6),
    },
  };
}

function boundsContain(outer: SceneBounds, inner: SceneBounds, tolerance: number): boolean {
  const a = boundsEnvelope(outer);
  const b = boundsEnvelope(inner);
  return (
    b.minimum.x >= a.minimum.x - tolerance &&
    b.minimum.y >= a.minimum.y - tolerance &&
    b.minimum.z >= a.minimum.z - tolerance &&
    b.maximum.x <= a.maximum.x + tolerance &&
    b.maximum.y <= a.maximum.y + tolerance &&
    b.maximum.z <= a.maximum.z + tolerance
  );
}

function unionEnvelopes(
  values: readonly Pick<Envelope, "minimum" | "maximum">[],
): Pick<Envelope, "minimum" | "maximum"> {
  if (!values.length) throw new Error("Geometry union has no operands");
  return {
    minimum: {
      x: Math.min(...values.map((entry) => entry.minimum.x)),
      y: Math.min(...values.map((entry) => entry.minimum.y)),
      z: Math.min(...values.map((entry) => entry.minimum.z)),
    },
    maximum: {
      x: Math.max(...values.map((entry) => entry.maximum.x)),
      y: Math.max(...values.map((entry) => entry.maximum.y)),
      z: Math.max(...values.map((entry) => entry.maximum.z)),
    },
  };
}

function expandEnvelope(
  value: Pick<Envelope, "minimum" | "maximum">,
  amount: number,
): Pick<Envelope, "minimum" | "maximum"> {
  const delta = { x: amount, y: amount, z: amount };
  return {
    minimum: subtractVector(value.minimum, delta),
    maximum: addVector(value.maximum, delta),
  };
}

function translateEnvelope(
  value: Pick<Envelope, "minimum" | "maximum">,
  offset: SceneVector,
): Pick<Envelope, "minimum" | "maximum"> {
  return { minimum: addVector(value.minimum, offset), maximum: addVector(value.maximum, offset) };
}

function mirrorEnvelope(
  value: Pick<Envelope, "minimum" | "maximum">,
  axis: "x" | "y" | "z",
): Pick<Envelope, "minimum" | "maximum"> {
  return {
    minimum: { ...value.minimum, [axis]: -value.maximum[axis] },
    maximum: { ...value.maximum, [axis]: -value.minimum[axis] },
  };
}

function transformEnvelope(
  value: Pick<Envelope, "minimum" | "maximum">,
  transform: SceneTransform,
): Pick<Envelope, "minimum" | "maximum"> {
  const rotation = sceneEulerXyz({
    x: transform.rotation.xDegrees,
    y: transform.rotation.yDegrees,
    z: transform.rotation.zDegrees,
  });
  const corners: SceneVector[] = [];
  for (const x of [value.minimum.x, value.maximum.x])
    for (const y of [value.minimum.y, value.maximum.y])
      for (const z of [value.minimum.z, value.maximum.z]) {
        const rotated = sceneTransformVector(rotation, {
          x: x * transform.scale.x,
          y: y * transform.scale.y,
          z: z * transform.scale.z,
        });
        corners.push(addVector(transform.position, rotated));
      }
  return pointsEnvelope(corners);
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
    default:
      return [];
  }
}

function addVector(left: SceneVector, right: SceneVector): SceneVector {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}
function subtractVector(left: SceneVector, right: SceneVector): SceneVector {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function scaleVector(value: SceneVector, amount: number): SceneVector {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}
function vectorLength(value: SceneVector): number {
  return Math.hypot(value.x, value.y, value.z);
}
