import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  measureSceneBoxConstraint,
  type SceneBox,
} from "../../game-composition/src/scene-bounds.js";
import {
  sceneEulerXyz,
  sceneHalfExtents,
  sceneInverse,
  sceneMultiply,
  sceneTransformVector,
  type SceneRotation,
  type SceneVector,
} from "../../game-composition/src/scene-geometry.js";
import {
  BLENDER_SCENE_SPEC_SCHEMA,
  validateBlenderSceneIntent,
  validateBlenderSceneSpec,
  type BlenderSceneIntent,
  type BlenderSceneSpec,
  type SceneBounds,
  type SceneConstraint,
  type SceneTransform,
} from "./contracts.js";
import {
  assertIntentBoundsAdmitGeometry,
  deriveSceneGeometryAnalysis,
  type InspectedSourceGeometry,
} from "./geometry-analysis.js";

const GRID_STUDS = 0.25;
const DEFAULT_YAW_STEP = 15;

export interface SceneSolverDiagnostic {
  code: string;
  subject: string;
  detail: string;
}

export type SceneSolverResult =
  | {
      status: "eligible";
      spec: BlenderSceneSpec;
      hash: string;
      candidateCount: number;
      backtrackCount: number;
      diagnostics: readonly [];
    }
  | {
      status: "rejected" | "incomplete";
      candidateCount: number;
      backtrackCount: number;
      diagnostics: readonly SceneSolverDiagnostic[];
    };

interface ResolvedFrame {
  position: SceneVector;
  rotation: SceneRotation;
  scale: SceneVector;
}

interface Placement {
  transform: SceneTransform;
  box: SceneBox;
}

export function solveBlenderScene(
  input: unknown,
  inspectedSources: readonly InspectedSourceGeometry[] = [],
): SceneSolverResult {
  let intent: BlenderSceneIntent;
  let geometryAnalysis: ReturnType<typeof deriveSceneGeometryAnalysis>;
  try {
    intent = validateBlenderSceneIntent(input);
    geometryAnalysis = deriveSceneGeometryAnalysis(intent, inspectedSources);
    assertIntentBoundsAdmitGeometry(intent, geometryAnalysis);
  } catch (error: unknown) {
    return failure("rejected", "scene_spec_invalid", "scene", detail(error), 0, 0);
  }
  let frames: Map<string, ResolvedFrame>;
  try {
    frames = resolveFrames(intent);
  } catch (error: unknown) {
    return failure("rejected", "frame_resolution_failed", intent.sceneId, detail(error), 0, 0);
  }
  const objects = [...intent.objects].sort((a, b) => a.id.localeCompare(b.id));
  for (const object of objects) {
    const cardinality = placementDomainCardinality(object);
    if (cardinality > intent.budgets.maximumSolverCandidates)
      return failure(
        "incomplete",
        "solver_resource_exhausted",
        object.id,
        `Placement domain cardinality ${cardinality} exceeds the admitted solver budget`,
        0,
        0,
      );
  }
  let expandedInstances: BlenderSceneSpec["instances"];
  let expansionCandidateCount = 0;
  try {
    const expansion = expandInstances(intent, intent.budgets.maximumSolverCandidates);
    expansionCandidateCount = expansion.candidateCount;
    if (expansion.status === "incomplete")
      return failure(
        "incomplete",
        "solver_resource_exhausted",
        intent.sceneId,
        expansion.detail,
        expansion.candidateCount,
        0,
      );
    expandedInstances = expansion.instances;
  } catch (error: unknown) {
    return failure("rejected", "instance_expansion_failed", intent.sceneId, detail(error), 0, 0);
  }
  const instancePlacements = resolvedInstancePlacements(intent, expandedInstances);
  const placements = new Map<string, Placement>();
  let candidateCount = expansionCandidateCount;
  let backtrackCount = 0;
  let exhausted = false;
  let lastFailureDiagnostics: SceneSolverDiagnostic[] = [];

  const place = (index: number): boolean => {
    if (index === objects.length)
      return (
        constraintsPass(intent, placements, false, geometryAnalysis, frames, instancePlacements)
          .length === 0
      );
    const object = objects[index]!;
    const frame = frames.get(object.placement.frameId)!;
    for (const transformValue of candidateTransforms(intent, object, frame)) {
      candidateCount += 1;
      if (candidateCount > intent.budgets.maximumSolverCandidates) {
        exhausted = true;
        return false;
      }
      const placement = placementFor(transformValue, object.localBounds);
      placements.set(object.id, placement);
      const diagnostics = constraintsPass(
        intent,
        placements,
        true,
        geometryAnalysis,
        frames,
        instancePlacements,
      );
      if (diagnostics.length === 0 && place(index + 1)) return true;
      if (diagnostics.length > 0) lastFailureDiagnostics = diagnostics;
      placements.delete(object.id);
    }
    if (index > 0) {
      backtrackCount += 1;
      if (backtrackCount > intent.budgets.maximumBacktracks) exhausted = true;
    }
    return false;
  };

  if (!place(0)) {
    if (exhausted)
      return failure(
        "incomplete",
        "solver_resource_exhausted",
        intent.sceneId,
        "The deterministic solver exhausted its admitted candidate or backtrack budget",
        candidateCount,
        backtrackCount,
      );
    const diagnostics = lastFailureDiagnostics.length
      ? lastFailureDiagnostics
      : [
          {
            code: "spatial_constraint_failed",
            subject: intent.sceneId,
            detail:
              "No assignment in the declared finite placement domains satisfies all constraints",
          },
        ];
    return { status: "rejected", candidateCount, backtrackCount, diagnostics };
  }

  const specCandidate = {
    ...intent,
    geometryAnalysis,
    objects: intent.objects.map(({ placement, ...object }) => {
      const solved = placements.get(object.id)!;
      return { ...object, frameId: placement.frameId, transform: solved.transform };
    }),
    instances: expandedInstances,
  };
  try {
    const spec = validateBlenderSceneSpec(BLENDER_SCENE_SPEC_SCHEMA.parse(specCandidate));
    const finalDiagnostics = validateResolvedScene(spec);
    if (finalDiagnostics.length)
      return { status: "rejected", candidateCount, backtrackCount, diagnostics: finalDiagnostics };
    return {
      status: "eligible",
      spec,
      hash: contentHash(stableJson(spec)),
      candidateCount,
      backtrackCount,
      diagnostics: [],
    };
  } catch (error: unknown) {
    return failure(
      "rejected",
      "resolved_scene_invalid",
      intent.sceneId,
      detail(error),
      candidateCount,
      backtrackCount,
    );
  }
}

export function validateResolvedScene(spec: BlenderSceneSpec): SceneSolverDiagnostic[] {
  const placements = new Map(
    spec.objects.map((object) => [object.id, placementFor(object.transform, object.localBounds)]),
  );
  return constraintsPass(
    spec,
    placements,
    false,
    spec.geometryAnalysis,
    resolveFrames(spec),
    resolvedInstancePlacements(spec, spec.instances),
  );
}

export interface MeasuredSceneObjectBounds {
  readonly stableId: string;
  readonly sourceObjectId?: string;
  readonly bounds: SceneBounds;
}

/** Re-evaluates spatial constraints from independently measured compiled world AABBs. */
export function validateMeasuredScene(
  spec: BlenderSceneSpec,
  measurements: readonly MeasuredSceneObjectBounds[],
): SceneSolverDiagnostic[] {
  const byStableId = new Map(measurements.map((entry) => [entry.stableId, entry]));
  if (byStableId.size !== measurements.length)
    return [
      {
        code: "measured_geometry_invalid",
        subject: spec.sceneId,
        detail: "Duplicate measured stable ID",
      },
    ];
  const basePlacements = new Map<string, Placement>();
  const instancePlacements = new Map<string, Placement[]>();
  const identity = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { xDegrees: 0, yDegrees: 0, zDegrees: 0 },
    scale: { x: 1, y: 1, z: 1 },
  } satisfies SceneTransform;
  for (const object of spec.objects) {
    const measured = byStableId.get(object.id);
    if (!measured)
      return [
        {
          code: "measured_geometry_invalid",
          subject: object.id,
          detail: "Missing compiled bounds",
        },
      ];
    basePlacements.set(object.id, placementFor(identity, measured.bounds));
  }
  for (const measured of measurements.filter((entry) => entry.sourceObjectId !== undefined)) {
    const entries = instancePlacements.get(measured.sourceObjectId!) ?? [];
    entries.push(placementFor(identity, measured.bounds));
    instancePlacements.set(measured.sourceObjectId!, entries);
  }
  return constraintsPass(
    spec,
    basePlacements,
    false,
    spec.geometryAnalysis,
    resolveFrames(spec),
    instancePlacements,
  );
}

function resolvedInstancePlacements(
  scene: BlenderSceneIntent | BlenderSceneSpec,
  instances: BlenderSceneSpec["instances"],
): ReadonlyMap<string, readonly Placement[]> {
  const objects = new Map(scene.objects.map((entry) => [entry.id, entry]));
  const result = new Map<string, Placement[]>();
  for (const instance of instances) {
    const source = objects.get(instance.sourceObjectId)!;
    const placements = result.get(instance.sourceObjectId) ?? [];
    placements.push(
      ...instance.transforms.map((transform) => placementFor(transform, source.localBounds)),
    );
    result.set(instance.sourceObjectId, placements);
  }
  return result;
}

export function robloxToBlender(value: SceneVector): SceneVector {
  return { x: value.x, y: -value.z, z: value.y };
}

export function blenderToRoblox(value: SceneVector): SceneVector {
  return { x: value.x, y: value.z, z: -value.y };
}

function* candidateTransforms(
  scene: BlenderSceneIntent,
  object: BlenderSceneIntent["objects"][number],
  frame: ResolvedFrame,
): Generator<SceneTransform, void> {
  if (object.placement.kind === "fixed") {
    yield composeTransform(frame, object.placement.transform);
    return;
  }
  const domain = object.placement.positionBounds;
  const yaws = object.placement.yawCandidatesDegrees.length
    ? [...new Set(object.placement.yawCandidatesDegrees.map((value) => Math.fround(value)))].sort(
        (a, b) => a - b,
      )
    : Array.from({ length: 360 / DEFAULT_YAW_STEP }, (_, index) => index * DEFAULT_YAW_STEP);
  const seed = seededScore(scene.seed, object.id, domain.minimum);
  const axes = [
    integerAxis(domain.minimum.x, domain.maximum.x, (seed & 1) !== 0),
    integerAxis(domain.minimum.y, domain.maximum.y, (seed & 2) !== 0),
    integerAxis(domain.minimum.z, domain.maximum.z, (seed & 4) !== 0),
  ] as const;
  const preferred = object.placement.preferredPosition
    ? snapPointToDomain(object.placement.preferredPosition, domain)
    : undefined;
  const emit = function* (position: SceneVector): Generator<SceneTransform, void> {
    const yawOffset = yaws.length ? seed % yaws.length : 0;
    for (let index = 0; index < yaws.length; index += 1) {
      const yaw = yaws[(index + yawOffset) % yaws.length]!;
      yield composeTransform(frame, {
        position,
        rotation: { xDegrees: 0, yDegrees: yaw, zDegrees: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
    }
  };
  if (preferred) yield* emit(preferred);
  for (const xIndex of axes[0])
    for (const yIndex of axes[1])
      for (const zIndex of axes[2]) {
        const position = {
          x: Math.fround(xIndex * GRID_STUDS),
          y: Math.fround(yIndex * GRID_STUDS),
          z: Math.fround(zIndex * GRID_STUDS),
        };
        if (preferred && squaredDistance(position, preferred) < 1e-12) continue;
        yield* emit(position);
      }
}

function placementDomainCardinality(object: BlenderSceneIntent["objects"][number]): number {
  if (object.placement.kind === "fixed") return 1;
  const { minimum, maximum } = object.placement.positionBounds;
  const axisCount = (low: number, high: number): number =>
    Math.max(0, Math.floor(high / GRID_STUDS) - Math.ceil(low / GRID_STUDS) + 1);
  const positions =
    axisCount(minimum.x, maximum.x) *
    axisCount(minimum.y, maximum.y) *
    axisCount(minimum.z, maximum.z);
  const yaws = object.placement.yawCandidatesDegrees.length || 360 / DEFAULT_YAW_STEP;
  const cardinality = positions * yaws;
  return Number.isSafeInteger(cardinality) ? cardinality : Number.POSITIVE_INFINITY;
}

function integerAxis(minimum: number, maximum: number, reverse: boolean): Iterable<number> {
  return {
    *[Symbol.iterator](): Generator<number, void> {
      const first = Math.ceil(minimum / GRID_STUDS);
      const last = Math.floor(maximum / GRID_STUDS);
      if (reverse) {
        for (let value = last; value >= first; value -= 1) yield value;
      } else {
        for (let value = first; value <= last; value += 1) yield value;
      }
    },
  };
}

function snapPointToDomain(
  point: SceneVector,
  domain: { minimum: SceneVector; maximum: SceneVector },
): SceneVector {
  const snap = (value: number, minimum: number, maximum: number): number =>
    Math.fround(
      Math.max(
        Math.ceil(minimum / GRID_STUDS),
        Math.min(Math.floor(maximum / GRID_STUDS), Math.round(value / GRID_STUDS)),
      ) * GRID_STUDS,
    );
  return {
    x: snap(point.x, domain.minimum.x, domain.maximum.x),
    y: snap(point.y, domain.minimum.y, domain.maximum.y),
    z: snap(point.z, domain.minimum.z, domain.maximum.z),
  };
}

function expandInstances(
  scene: BlenderSceneIntent,
  maximumCandidates: number,
):
  | { status: "eligible"; instances: BlenderSceneSpec["instances"]; candidateCount: number }
  | { status: "incomplete"; detail: string; candidateCount: number } {
  const instances: BlenderSceneSpec["instances"] = [];
  let candidateCount = 0;
  const countCandidate = (): boolean => {
    candidateCount += 1;
    return candidateCount <= maximumCandidates;
  };
  for (const definition of [...scene.instances].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const distribution = definition.distribution;
    const transforms: SceneTransform[] = [];
    if (distribution.kind === "explicit") {
      for (const transform of distribution.transforms) transforms.push(float32Transform(transform));
    } else if (distribution.kind === "linear") {
      for (let index = 0; index < distribution.count; index += 1) {
        if (!countCandidate())
          return {
            status: "incomplete",
            detail: "Instance expansion exhausted its admitted candidate budget",
            candidateCount,
          };
        transforms.push(
          float32Transform({
            ...distribution.origin,
            position: {
              x: distribution.origin.position.x + distribution.step.x * index,
              y: distribution.origin.position.y + distribution.step.y * index,
              z: distribution.origin.position.z + distribution.step.z * index,
            },
          }),
        );
      }
    } else if (distribution.kind === "radial") {
      for (let index = 0; index < distribution.count; index += 1) {
        if (!countCandidate())
          return {
            status: "incomplete",
            detail: "Instance expansion exhausted its admitted candidate budget",
            candidateCount,
          };
        const ratio = distribution.count === 1 ? 0 : index / (distribution.count - 1);
        const angle = distribution.startAngleDegrees + distribution.sweepAngleDegrees * ratio;
        const radians = (angle * Math.PI) / 180;
        transforms.push(
          float32Transform({
            position: {
              x: distribution.center.x + Math.cos(radians) * distribution.radius,
              y: distribution.y,
              z: distribution.center.z + Math.sin(radians) * distribution.radius,
            },
            rotation: { xDegrees: 0, yDegrees: 90 - angle, zDegrees: 0 },
            scale: distribution.scale,
          }),
        );
      }
    } else if (distribution.kind === "along_curve") {
      const curve = scene.geometries.find(
        (geometry) => geometry.id === distribution.curveId && geometry.kind === "curve",
      );
      if (!curve || curve.kind !== "curve")
        throw new Error(`Unknown instance curve: ${distribution.curveId}`);
      const curvePoints = evaluatedCurvePoints(curve);
      const segmentLengths = curvePoints
        .slice(1)
        .map((point, index) => length(subtract(point, curvePoints[index]!)));
      const totalLength = segmentLengths.reduce((sum, value) => sum + value, 0);
      if (totalLength <= 1e-8)
        throw new Error(`Instance curve has no traversable length: ${distribution.curveId}`);
      for (let index = 0; index < distribution.count; index += 1) {
        if (!countCandidate())
          return {
            status: "incomplete",
            detail: "Instance expansion exhausted its admitted candidate budget",
            candidateCount,
          };
        const targetDistance =
          totalLength * (distribution.count === 1 ? 0 : index / (distribution.count - 1));
        let traversed = 0;
        let segment = 0;
        while (
          segment < segmentLengths.length - 1 &&
          traversed + segmentLengths[segment]! < targetDistance
        ) {
          traversed += segmentLengths[segment]!;
          segment += 1;
        }
        const start = curvePoints[segment]!;
        const end = curvePoints[segment + 1]!;
        const localRatio =
          segmentLengths[segment]! <= 1e-8
            ? 0
            : (targetDistance - traversed) / segmentLengths[segment]!;
        const position = {
          x: start.x + (end.x - start.x) * localRatio,
          y: start.y + (end.y - start.y) * localRatio,
          z: start.z + (end.z - start.z) * localRatio,
        };
        transforms.push(
          float32Transform({
            position,
            rotation: {
              xDegrees: 0,
              yDegrees: (Math.atan2(end.x - start.x, end.z - start.z) * 180) / Math.PI,
              zDegrees: 0,
            },
            scale: distribution.scale,
          }),
        );
      }
    } else {
      const zone = scene.zones.find((entry) => entry.id === distribution.zoneId)!;
      const domain = distribution.positionBounds;
      const distributionSeed = seededScore(scene.seed, definition.id, domain.minimum);
      const axes = [
        integerAxis(domain.minimum.x, domain.maximum.x, (distributionSeed & 1) !== 0),
        integerAxis(domain.minimum.y, domain.maximum.y, (distributionSeed & 2) !== 0),
        integerAxis(domain.minimum.z, domain.maximum.z, (distributionSeed & 4) !== 0),
      ] as const;
      const selected: SceneVector[] = [];
      outer: for (const x of axes[0])
        for (const y of axes[1])
          for (const z of axes[2]) {
            if (!countCandidate())
              return {
                status: "incomplete",
                detail: "Seeded instance distribution exhausted its admitted candidate budget",
                candidateCount,
              };
            const point = {
              x: Math.fround(x * GRID_STUDS),
              y: Math.fround(y * GRID_STUDS),
              z: Math.fround(z * GRID_STUDS),
            };
            if (
              point.y >= zone.verticalRange.minimum &&
              point.y <= zone.verticalRange.maximum &&
              pointInsidePolygon({ x: point.x, y: point.z }, zone.footprint) &&
              !selected.some(
                (prior) =>
                  Math.sqrt(squaredDistance(prior, point)) < distribution.minimumSeparation,
              )
            )
              selected.push(point);
            if (selected.length === distribution.count) break outer;
          }
      if (selected.length !== distribution.count)
        throw new Error(`Seeded instance distribution has no valid assignment: ${definition.id}`);
      const yaws = distribution.yawCandidatesDegrees.length
        ? [...distribution.yawCandidatesDegrees].sort((left, right) => left - right)
        : Array.from({ length: 360 / DEFAULT_YAW_STEP }, (_, index) => index * DEFAULT_YAW_STEP);
      for (const [index, position] of selected.entries()) {
        const yawIndex =
          seededScore(scene.seed, `${definition.id}:${index}`, position) % yaws.length;
        transforms.push(
          float32Transform({
            position,
            rotation: { xDegrees: 0, yDegrees: yaws[yawIndex]!, zDegrees: 0 },
            scale: distribution.scale,
          }),
        );
      }
    }
    instances.push({
      id: definition.id,
      sourceObjectId: definition.sourceObjectId,
      partitionId: definition.partitionId,
      transforms,
    });
  }
  return { status: "eligible", instances, candidateCount };
}

function evaluatedCurvePoints(
  curve: Extract<BlenderSceneIntent["geometries"][number], { kind: "curve" }>,
): SceneVector[] {
  let result: SceneVector[];
  if (curve.interpolation === "polyline") result = [...curve.points];
  else {
    result = [];
    for (let index = 0; index + 3 < curve.points.length; index += 3) {
      const a = curve.points[index]!;
      const b = curve.points[index + 1]!;
      const c = curve.points[index + 2]!;
      const d = curve.points[index + 3]!;
      for (let sample = 0; sample <= curve.samplesPerSegment; sample += 1) {
        if (result.length && sample === 0) continue;
        const t = sample / curve.samplesPerSegment;
        const u = 1 - t;
        result.push({
          x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
          y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y,
          z: u ** 3 * a.z + 3 * u ** 2 * t * b.z + 3 * u * t ** 2 * c.z + t ** 3 * d.z,
        });
      }
    }
  }
  if (curve.closed && squaredDistance(result[0]!, result.at(-1)!) > 1e-12) result.push(result[0]!);
  return result;
}

function float32Transform(value: SceneTransform): SceneTransform {
  const scalar = (number: number): number => {
    const rounded = Math.fround(number);
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  return {
    position: {
      x: scalar(value.position.x),
      y: scalar(value.position.y),
      z: scalar(value.position.z),
    },
    rotation: {
      xDegrees: scalar(value.rotation.xDegrees),
      yDegrees: scalar(value.rotation.yDegrees),
      zDegrees: scalar(value.rotation.zDegrees),
    },
    scale: { x: scalar(value.scale.x), y: scalar(value.scale.y), z: scalar(value.scale.z) },
  };
}

function resolveFrames(scene: BlenderSceneIntent | BlenderSceneSpec): Map<string, ResolvedFrame> {
  const definitions = new Map(scene.frames.map((frame) => [frame.id, frame]));
  const resolved = new Map<string, ResolvedFrame>();
  const resolve = (id: string): ResolvedFrame => {
    const existing = resolved.get(id);
    if (existing) return existing;
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown frame: ${id}`);
    const local = transformToFrame(definition.transform);
    const value = definition.parentId ? composeFrame(resolve(definition.parentId), local) : local;
    resolved.set(id, value);
    return value;
  };
  for (const id of definitions.keys()) resolve(id);
  return resolved;
}

function composeTransform(parent: ResolvedFrame, local: SceneTransform): SceneTransform {
  const localPosition = sceneTransformVector(parent.rotation, {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
    z: local.position.z * parent.scale.z,
  });
  const rotation = sceneMultiply(
    parent.rotation,
    sceneEulerXyz(toEulerVector(local.rotation)),
    true,
  );
  return {
    position: {
      x: Math.fround(parent.position.x + localPosition.x),
      y: Math.fround(parent.position.y + localPosition.y),
      z: Math.fround(parent.position.z + localPosition.z),
    },
    rotation: matrixToEulerXyz(rotation),
    scale: {
      x: Math.fround(parent.scale.x * local.scale.x),
      y: Math.fround(parent.scale.y * local.scale.y),
      z: Math.fround(parent.scale.z * local.scale.z),
    },
  };
}

function transformToFrame(value: SceneTransform): ResolvedFrame {
  return {
    position: value.position,
    rotation: sceneEulerXyz(toEulerVector(value.rotation)),
    scale: value.scale,
  };
}

function composeFrame(parent: ResolvedFrame, local: ResolvedFrame): ResolvedFrame {
  const parentNonUniform =
    Math.abs(parent.scale.x - parent.scale.y) > 1e-6 ||
    Math.abs(parent.scale.y - parent.scale.z) > 1e-6;
  const localRotated = local.rotation.some(
    (value, index) => Math.abs(value - ([1, 0, 0, 0, 1, 0, 0, 0, 1] as const)[index]!) > 1e-6,
  );
  if (parentNonUniform && localRotated)
    throw new Error(
      "Frame composition introduces shear that the resolved transform ABI cannot preserve",
    );
  return transformToFrame(
    composeTransform(parent, {
      position: local.position,
      rotation: matrixToEulerXyz(local.rotation),
      scale: local.scale,
    }),
  );
}

function placementFor(transformValue: SceneTransform, localBounds: SceneBounds): Placement {
  const rotation = sceneEulerXyz(toEulerVector(transformValue.rotation));
  const scaledCenter = {
    x: localBounds.center.x * transformValue.scale.x,
    y: localBounds.center.y * transformValue.scale.y,
    z: localBounds.center.z * transformValue.scale.z,
  };
  const offset = sceneTransformVector(rotation, scaledCenter);
  const box = {
    position: {
      x: Math.fround(transformValue.position.x + offset.x),
      y: Math.fround(transformValue.position.y + offset.y),
      z: Math.fround(transformValue.position.z + offset.z),
    },
    rotation,
    size: {
      x: Math.fround(localBounds.size.x * transformValue.scale.x),
      y: Math.fround(localBounds.size.y * transformValue.scale.y),
      z: Math.fround(localBounds.size.z * transformValue.scale.z),
    },
  };
  return { transform: canonicalTransform(transformValue), box };
}

function constraintsPass(
  scene: BlenderSceneIntent | BlenderSceneSpec,
  placements: ReadonlyMap<string, Placement>,
  partial = false,
  geometryAnalysis?: ReturnType<typeof deriveSceneGeometryAnalysis>,
  resolvedFrames: ReadonlyMap<string, ResolvedFrame> = resolveFrames(scene),
  instancePlacements: ReadonlyMap<string, readonly Placement[]> = new Map(),
): SceneSolverDiagnostic[] {
  const diagnostics: SceneSolverDiagnostic[] = [];
  const objects = new Map(scene.objects.map((object) => [object.id, object]));
  const zones = new Map(scene.zones.map((zone) => [zone.id, zone]));
  const routes = new Map(scene.routes.map((route) => [route.id, route]));
  const anchors = new Map(scene.gameplayAnchors.map((anchor) => [anchor.id, anchor]));
  const views = new Map(scene.reviewViews.map((view) => [view.id, view]));
  for (const constraint of scene.constraints) {
    const issue = evaluateConstraint(constraint, {
      placements,
      objects,
      zones,
      routes,
      anchors,
      views,
      partial,
      frames: resolvedFrames,
      instancePlacements,
    });
    if (issue && !(partial && issue.code === "constraint_pending")) diagnostics.push(issue);
  }
  if (!partial) diagnostics.push(...budgetDiagnostics(scene, placements, geometryAnalysis));
  return diagnostics;
}

function evaluateConstraint(
  constraint: SceneConstraint,
  context: {
    placements: ReadonlyMap<string, Placement>;
    objects: Map<
      string,
      BlenderSceneIntent["objects"][number] | BlenderSceneSpec["objects"][number]
    >;
    zones: Map<string, BlenderSceneIntent["zones"][number]>;
    routes: Map<string, BlenderSceneIntent["routes"][number]>;
    anchors: Map<string, BlenderSceneIntent["gameplayAnchors"][number]>;
    views: Map<string, BlenderSceneIntent["reviewViews"][number]>;
    partial: boolean;
    frames: ReadonlyMap<string, ResolvedFrame>;
    instancePlacements: ReadonlyMap<string, readonly Placement[]>;
  },
): SceneSolverDiagnostic | undefined {
  const pending = (subject: string): SceneSolverDiagnostic => ({
    code: "constraint_pending",
    subject,
    detail: "Constraint operands are not placed yet",
  });
  const failed = (detailText: string): SceneSolverDiagnostic => ({
    code: "spatial_constraint_failed",
    subject: constraint.id,
    detail: detailText,
  });
  const variants = (id: string): readonly Placement[] => {
    const base = context.placements.get(id);
    return [...(base ? [base] : []), ...(context.instancePlacements.get(id) ?? [])];
  };
  switch (constraint.kind) {
    case "containment": {
      if (!context.placements.has(constraint.objectId)) return pending(constraint.id);
      const zone = context.zones.get(constraint.zoneId)!;
      for (const placed of variants(constraint.objectId))
        if (
          !boxInsideZone(placed.box, zone, context.frames.get(zone.frameId)!, constraint.clearance)
        )
          return failed(
            `Object or instance ${constraint.objectId} is outside zone ${constraint.zoneId}`,
          );
      return undefined;
    }
    case "separation": {
      if (
        !context.placements.has(constraint.firstObjectId) ||
        !context.placements.has(constraint.secondObjectId)
      )
        return pending(constraint.id);
      const first = variants(constraint.firstObjectId);
      const second = variants(constraint.secondObjectId);
      for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1)
        for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
          if (constraint.firstObjectId === constraint.secondObjectId && firstIndex >= secondIndex)
            continue;
          if (
            !measureSceneBoxConstraint(
              "separation",
              first[firstIndex]!.box,
              second[secondIndex]!.box,
              constraint.clearance,
            ).valid
          )
            return failed(
              `Objects or instances ${constraint.firstObjectId} and ${constraint.secondObjectId} overlap`,
            );
        }
      return undefined;
    }
    case "support": {
      if (
        !context.placements.has(constraint.objectId) ||
        !context.placements.has(constraint.supporterId)
      )
        return pending(constraint.id);
      for (const object of variants(constraint.objectId)) {
        const first = axisAlignedBox(object.box);
        const supported = variants(constraint.supporterId).some((supporter) => {
          const second = axisAlignedBox(supporter.box);
          const vertical = Math.abs(first.minimum.y - second.maximum.y);
          const overlapX =
            first.maximum.x >= second.minimum.x && first.minimum.x <= second.maximum.x;
          const overlapZ =
            first.maximum.z >= second.minimum.z && first.minimum.z <= second.maximum.z;
          return vertical <= constraint.tolerance && overlapX && overlapZ;
        });
        if (!supported)
          return failed(
            `Object ${constraint.objectId} lacks declared support from ${constraint.supporterId}`,
          );
      }
      return undefined;
    }
    case "clearance": {
      const route = context.routes.get(constraint.routeId)!;
      for (const id of constraint.objectIds) {
        if (!context.placements.has(id)) return pending(constraint.id);
        for (const placed of variants(id))
          if (
            routeIntersectsBox(
              route.points,
              route.width / 2 + constraint.clearance,
              route.heightClearance,
              placed.box,
            )
          )
            return failed(`Object or instance ${id} blocks route ${route.id}`);
      }
      return undefined;
    }
    case "reachability": {
      const route = context.routes.get(constraint.routeId)!;
      for (const id of constraint.anchorIds) {
        const anchor = context.anchors.get(id)!;
        if (polylineDistance(route.points, anchor.transform.position) > constraint.maximumDistance)
          return failed(`Anchor ${id} is not reachable from route ${route.id}`);
      }
      return undefined;
    }
    case "sightline": {
      if (!context.placements.has(constraint.targetObjectId)) return pending(constraint.id);
      for (const id of constraint.occluderIds) {
        if (!context.placements.has(id)) return pending(constraint.id);
        for (const target of variants(constraint.targetObjectId))
          for (const occluder of variants(id))
            if (
              segmentIntersectsAabb(
                constraint.from,
                target.box.position,
                axisAlignedBox(occluder.box),
              )
            )
              return failed(`Object ${id} occludes sightline to ${constraint.targetObjectId}`);
      }
      return undefined;
    }
    case "camera_framing": {
      const view = context.views.get(constraint.viewId)!;
      for (const id of constraint.objectIds) {
        if (!context.placements.has(id)) return pending(constraint.id);
        for (const placed of variants(id))
          if (!cameraContainsBox(view, placed.box, constraint.margin))
            return failed(`Object or instance ${id} is outside camera frame ${view.id}`);
      }
      return undefined;
    }
    case "density":
    case "negative_space": {
      const zone = context.zones.get(constraint.zoneId)!;
      const area = polygonArea(zone.footprint);
      const zoneFrame = context.frames.get(zone.frameId)!;
      const occupied = [...context.objects.values()]
        .filter((object) => object.zoneId === zone.id)
        .reduce((sum, object) => {
          return (
            sum +
            variants(object.id).reduce((objectSum, placed) => {
              const localCorners = orientedBoxCorners(placed.box).map((corner) =>
                frameWorldToLocal(zoneFrame, corner),
              );
              const width =
                Math.max(...localCorners.map((corner) => corner.x)) -
                Math.min(...localCorners.map((corner) => corner.x));
              const depth =
                Math.max(...localCorners.map((corner) => corner.z)) -
                Math.min(...localCorners.map((corner) => corner.z));
              return objectSum + width * depth;
            }, 0)
          );
        }, 0);
      const ratio = area > 0 ? Math.min(1, occupied / area) : 1;
      if (constraint.kind === "density")
        if (ratio > constraint.maximum)
          return failed(`Zone ${zone.id} density ${ratio} exceeds the declared maximum`);
        else if (context.partial && ratio < constraint.minimum) return pending(constraint.id);
        else
          return ratio >= constraint.minimum
            ? undefined
            : failed(`Zone ${zone.id} density ${ratio} is below the declared minimum`);
      if (1 - ratio < constraint.minimumFraction)
        return failed(`Zone ${zone.id} lacks required negative space`);
      return context.partial ? pending(constraint.id) : undefined;
    }
    case "budget":
      return undefined;
  }
}

function budgetDiagnostics(
  scene: BlenderSceneIntent | BlenderSceneSpec,
  placements: ReadonlyMap<string, Placement>,
  suppliedAnalysis?: ReturnType<typeof deriveSceneGeometryAnalysis>,
): SceneSolverDiagnostic[] {
  const diagnostics: SceneSolverDiagnostic[] = [];
  const analysis =
    suppliedAnalysis ??
    ("geometryAnalysis" in scene ? scene.geometryAnalysis : deriveSceneGeometryAnalysis(scene));
  const analyzedTriangles = new Map(
    analysis.entries.map((entry) => [entry.geometryId, entry.estimatedTriangles]),
  );
  const explicitTriangles =
    scene.objects.reduce(
      (sum, object) => sum + (analyzedTriangles.get(object.geometryId) ?? 0),
      0,
    ) +
    scene.instances.reduce((sum, instance) => {
      const sourceId = instance.sourceObjectId;
      const source = scene.objects.find((object) => object.id === sourceId)!;
      const count =
        "transforms" in instance
          ? instance.transforms.length
          : instance.distribution.kind === "explicit"
            ? instance.distribution.transforms.length
            : instance.distribution.count;
      return sum + (analyzedTriangles.get(source.geometryId) ?? 0) * count;
    }, 0);
  const expanded = scene.instances.reduce(
    (sum, instance) =>
      sum +
      ("transforms" in instance
        ? instance.transforms.length
        : instance.distribution.kind === "explicit"
          ? instance.distribution.transforms.length
          : instance.distribution.count),
    0,
  );
  if (placements.size > scene.budgets.maximumObjects)
    diagnostics.push({
      code: "budget_failure",
      subject: scene.sceneId,
      detail: "Object budget exceeded",
    });
  if (expanded > scene.budgets.maximumExpandedInstances)
    diagnostics.push({
      code: "budget_failure",
      subject: scene.sceneId,
      detail: "Expanded instance budget exceeded",
    });
  for (const entry of analysis.entries)
    if (entry.estimatedTriangles > scene.budgets.maximumTrianglesPerMesh)
      diagnostics.push({
        code: "budget_failure",
        subject: entry.geometryId,
        detail: "Per-mesh triangle budget exceeded",
      });
  if (explicitTriangles > scene.budgets.maximumTriangles)
    diagnostics.push({
      code: "budget_failure",
      subject: scene.sceneId,
      detail: "Triangle budget exceeded",
    });
  if (scene.materials.length > scene.budgets.maximumMaterials)
    diagnostics.push({
      code: "budget_failure",
      subject: scene.sceneId,
      detail: "Material budget exceeded",
    });
  if (scene.textures.length > scene.budgets.maximumTextures)
    diagnostics.push({
      code: "budget_failure",
      subject: scene.sceneId,
      detail: "Texture budget exceeded",
    });
  for (const texture of scene.textures)
    if (texture.width * texture.height > scene.budgets.maximumTexturePixels)
      diagnostics.push({
        code: "budget_failure",
        subject: texture.id,
        detail: "Texture pixel budget exceeded",
      });
  for (const constraint of scene.constraints)
    if (
      constraint.kind === "budget" &&
      (placements.size > constraint.maximumObjects ||
        explicitTriangles > constraint.maximumTriangles)
    )
      diagnostics.push({
        code: "budget_failure",
        subject: constraint.id,
        detail: "Declared budget constraint failed",
      });
  return diagnostics;
}

function boxInsideZone(
  box: SceneBox,
  zone: BlenderSceneIntent["zones"][number],
  frame: ResolvedFrame,
  clearance: number,
): boolean {
  for (const corner of orientedBoxCorners(box)) {
    const local = frameWorldToLocal(frame, corner);
    if (
      local.y < zone.verticalRange.minimum + clearance ||
      local.y > zone.verticalRange.maximum - clearance ||
      !pointInsidePolygon({ x: local.x, y: local.z }, zone.footprint)
    )
      return false;
  }
  return true;
}

function orientedBoxCorners(box: SceneBox): SceneVector[] {
  const result: SceneVector[] = [];
  for (const x of [-box.size.x / 2, box.size.x / 2])
    for (const y of [-box.size.y / 2, box.size.y / 2])
      for (const z of [-box.size.z / 2, box.size.z / 2])
        result.push(add(box.position, sceneTransformVector(box.rotation, { x, y, z })));
  return result;
}

function frameWorldToLocal(frame: ResolvedFrame, world: SceneVector): SceneVector {
  const rotated = sceneTransformVector(
    sceneInverse(frame.rotation),
    subtract(world, frame.position),
  );
  return {
    x: rotated.x / frame.scale.x,
    y: rotated.y / frame.scale.y,
    z: rotated.z / frame.scale.z,
  };
}

function routeIntersectsBox(
  points: readonly SceneVector[],
  radius: number,
  heightClearance: number,
  box: SceneBox,
): boolean {
  const aabb = axisAlignedBox(box);
  const expanded = {
    minimum: {
      x: aabb.minimum.x - radius,
      y: aabb.minimum.y - heightClearance,
      z: aabb.minimum.z - radius,
    },
    maximum: { x: aabb.maximum.x + radius, y: aabb.maximum.y, z: aabb.maximum.z + radius },
  };
  for (let index = 1; index < points.length; index += 1)
    if (segmentIntersectsAabb(points[index - 1]!, points[index]!, expanded)) return true;
  return false;
}

function cameraContainsBox(
  view: BlenderSceneIntent["reviewViews"][number],
  box: SceneBox,
  margin: number,
): boolean {
  const forward = normalize(subtract(view.lookAt, view.position));
  if (length(forward) === 0) return false;
  const referenceUp = Math.abs(forward.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, referenceUp));
  const up = normalize(cross(right, forward));
  const halfVertical = (view.fieldOfViewDegrees * Math.PI) / 360;
  const aspect = view.width / view.height;
  const verticalLimit = Math.tan(halfVertical) * (1 - margin * 2);
  const horizontalLimit = verticalLimit * aspect;
  return orientedBoxCorners(box).every((corner) => {
    const relative = subtract(corner, view.position);
    const depth = dot(relative, forward);
    return (
      depth > 1e-5 &&
      Math.abs(dot(relative, right) / depth) <= horizontalLimit &&
      Math.abs(dot(relative, up) / depth) <= verticalLimit
    );
  });
}

function segmentIntersectsAabb(
  start: SceneVector,
  end: SceneVector,
  box: { minimum: SceneVector; maximum: SceneVector },
): boolean {
  let minimum = 0;
  let maximum = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-12) {
      if (start[axis] < box.minimum[axis] || start[axis] > box.maximum[axis]) return false;
      continue;
    }
    const first = (box.minimum[axis] - start[axis]) / delta;
    const second = (box.maximum[axis] - start[axis]) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return true;
}

function axisAlignedBox(box: SceneBox): { minimum: SceneVector; maximum: SceneVector } {
  const extent = sceneHalfExtents(box.rotation, box.size);
  return {
    minimum: {
      x: box.position.x - extent.x,
      y: box.position.y - extent.y,
      z: box.position.z - extent.z,
    },
    maximum: {
      x: box.position.x + extent.x,
      y: box.position.y + extent.y,
      z: box.position.z + extent.z,
    },
  };
}

function polylineDistance(points: readonly SceneVector[], target: SceneVector): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const direction = subtract(end, start);
    const denominator = dot(direction, direction);
    const amount =
      denominator === 0 ? 0 : clamp(dot(subtract(target, start), direction) / denominator, 0, 1);
    best = Math.min(best, length(subtract(target, add(start, scale(direction, amount)))));
  }
  return best;
}

function pointInsidePolygon(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function polygonArea(points: readonly { x: number; y: number }[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function matrixToEulerXyz(matrix: SceneRotation): SceneTransform["rotation"] {
  const y = Math.asin(clamp(matrix[2], -1, 1));
  const cy = Math.cos(y);
  const x =
    Math.abs(cy) > 1e-6 ? Math.atan2(-matrix[5], matrix[8]) : Math.atan2(matrix[7], matrix[4]);
  const z = Math.abs(cy) > 1e-6 ? Math.atan2(-matrix[1], matrix[0]) : 0;
  const degrees = 180 / Math.PI;
  return {
    xDegrees: canonicalFloat(x * degrees),
    yDegrees: canonicalFloat(y * degrees),
    zDegrees: canonicalFloat(z * degrees),
  };
}

function canonicalTransform(value: SceneTransform): SceneTransform {
  return {
    position: mapVector(value.position, canonicalFloat),
    rotation: {
      xDegrees: canonicalFloat(value.rotation.xDegrees),
      yDegrees: canonicalFloat(value.rotation.yDegrees),
      zDegrees: canonicalFloat(value.rotation.zDegrees),
    },
    scale: mapVector(value.scale, canonicalFloat),
  };
}

function canonicalFloat(value: number): number {
  const rounded = Math.fround(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toEulerVector(value: SceneTransform["rotation"]): SceneVector {
  return { x: value.xDegrees, y: value.yDegrees, z: value.zDegrees };
}
function mapVector(value: SceneVector, map: (entry: number) => number): SceneVector {
  return { x: map(value.x), y: map(value.y), z: map(value.z) };
}
function squaredDistance(left: SceneVector, right: SceneVector): number {
  const delta = subtract(left, right);
  return dot(delta, delta);
}
function seededScore(seed: number, id: string, point: SceneVector): number {
  let state = seed ^ 0x9e3779b9;
  for (const character of `${id}:${point.x}:${point.y}:${point.z}`) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 0x01000193);
  }
  return state >>> 0;
}
function subtract(left: SceneVector, right: SceneVector): SceneVector {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function add(left: SceneVector, right: SceneVector): SceneVector {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}
function scale(value: SceneVector, amount: number): SceneVector {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}
function dot(left: SceneVector, right: SceneVector): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
function cross(left: SceneVector, right: SceneVector): SceneVector {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}
function length(value: SceneVector): number {
  return Math.hypot(value.x, value.y, value.z);
}
function normalize(value: SceneVector): SceneVector {
  const magnitude = length(value);
  return magnitude === 0 ? { x: 0, y: 0, z: 0 } : scale(value, 1 / magnitude);
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(
  status: "rejected" | "incomplete",
  code: string,
  subject: string,
  detailText: string,
  candidateCount: number,
  backtrackCount: number,
): SceneSolverResult {
  return {
    status,
    candidateCount,
    backtrackCount,
    diagnostics: [{ code, subject, detail: detailText }],
  };
}

export const SCENE_SOLVER_IDENTITY = contentHash(
  stableJson({
    abi: "forge-spatial-solver@2",
    gridStuds: GRID_STUDS,
    defaultYawStepDegrees: DEFAULT_YAW_STEP,
    coordinateSystem: "roblox-y-up-studs",
    blenderMapping: "x,-z,y",
  }),
);
