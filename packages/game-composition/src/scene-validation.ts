import { STUDIO_CAPABILITY_MANIFEST } from "../../studio-evidence/src/index.js";
import { CompositionError } from "./config-schema.js";
import type { ScenePrimitivesConfig } from "./scene.js";
import {
  SCENE_IDENTITY_ROTATION,
  sceneEulerXyz,
  sceneMultiply,
  sceneTransformVector,
  type SceneRotation,
} from "./scene-geometry.js";
import { measureSceneBoxConstraint } from "./scene-bounds.js";

type SceneNode = ScenePrimitivesConfig["nodes"][number];
type Position = SceneNode["placement"]["offset"];
type Fact = string | number | null | Fact[] | { [key: string]: Fact };
export interface SceneValidationIssue {
  code: string;
  path: string;
  nodeId?: string;
  actual: Fact;
  expected: Fact;
  detail: string;
}
export interface SceneValidationDiagnostics {
  componentId: string;
  recipeId: "scene-primitives";
  issues: SceneValidationIssue[];
  validIds: { nodes: string[] };
  validParentPaths: string[];
  unresolvedPlacementNodeIds: string[];
}
export interface ResolvedScene {
  nodes: ReadonlyMap<string, SceneNode>;
  positions: ReadonlyMap<string, Position>;
  rotations: ReadonlyMap<string, SceneRotation>;
  /** Parent-first order, independent of declaration order. */
  parentOrder: readonly string[];
}

/** Pure recipe-local checks. No inventory, editor reads, or native geometry claims. */
function analyzeScene(config: ScenePrimitivesConfig, componentId: string) {
  const issues: SceneValidationIssue[] = [];
  const counts = new Map<string, number>();
  for (const node of config.nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  const nodes = new Map<string, SceneNode>();
  const indices = new Map<string, number>();
  config.nodes.forEach((node, index) => {
    if (counts.get(node.id) === 1) {
      nodes.set(node.id, node);
      indices.set(node.id, index);
    } else
      issues.push({
        code: "duplicate_id",
        path: `nodes[${index}].id`,
        nodeId: node.id,
        actual: node.id,
        expected: "unique local node ID",
        detail: "Scene node IDs must be unique within this component.",
      });
  });
  const validIds = { nodes: [...nodes.keys()].sort() };
  const validParentPaths = STUDIO_CAPABILITY_MANIFEST.authoringContainers
    .map((entry) => entry.path)
    .sort();
  if (!validParentPaths.includes(config.parentPath))
    issues.push({
      code: "unsupported_parent",
      path: "parentPath",
      actual: config.parentPath,
      expected: "one of validParentPaths",
      detail: "The scene root requires an admitted engine authoring container.",
    });
  const reference = (value: string, path: string, nodeId?: string): void => {
    const count = counts.get(value) ?? 0;
    if (count !== 1)
      issues.push({
        code: count === 0 ? "unknown_reference" : "ambiguous_reference",
        path,
        ...(nodeId === undefined ? {} : { nodeId }),
        actual: value,
        expected: "one of validIds.nodes",
        detail:
          "References name nodes declared in this scene component. Source-placement output aliases are not node IDs. Omit parentId for the root Folder; omit placement.relativeTo for world origin.",
      });
  };
  config.nodes.forEach((node, index) => {
    if (node.parentId !== undefined) reference(node.parentId, `nodes[${index}].parentId`, node.id);
    if (node.placement.relativeTo !== undefined)
      reference(node.placement.relativeTo, `nodes[${index}].placement.relativeTo`, node.id);
  });
  config.constraints.forEach((constraint, index) => {
    reference(constraint.first, `constraints[${index}].first`);
    reference(constraint.second, `constraints[${index}].second`);
    if (constraint.first === constraint.second)
      issues.push({
        code: "identical_constraint_nodes",
        path: `constraints[${index}].second`,
        actual: constraint.second,
        expected: "a node distinct from constraints[" + index + "].first",
        detail: "Spatial constraints require two distinct existing nodes.",
      });
  });

  // Functional graphs have one outgoing edge per node. Report only cycle edges,
  // then exclude unresolved chains from dependent measurements without guessing.
  const order = (field: "parentId" | "placement.relativeTo", code: string): string[] => {
    const edge = (node: SceneNode) =>
      field === "parentId" ? node.parentId : node.placement.relativeTo;
    const resolved = new Map<string, boolean>();
    const result: string[] = [];
    for (const start of validIds.nodes) {
      if (resolved.has(start)) continue;
      const walk: string[] = [];
      const at = new Map<string, number>();
      let current: string | undefined = start;
      let valid = true;
      while (current !== undefined) {
        if (resolved.has(current)) {
          valid = resolved.get(current)!;
          break;
        }
        const cycleStart = at.get(current);
        if (cycleStart !== undefined) {
          const cycle = walk.slice(cycleStart);
          for (const id of cycle)
            issues.push({
              code,
              path: `nodes[${indices.get(id)!}].${field}`,
              nodeId: id,
              actual: edge(nodes.get(id)!)!,
              expected: "acyclic local node references",
              detail: `${field} cycle contains: ${cycle.join(", ")}.`,
            });
          valid = false;
          break;
        }
        const node = nodes.get(current);
        if (!node) {
          valid = false;
          break;
        }
        at.set(current, walk.length);
        walk.push(current);
        current = edge(node);
      }
      for (const id of walk.reverse()) {
        resolved.set(id, valid);
        if (valid) result.push(id);
      }
    }
    return result;
  };
  const placementOrder = order("placement.relativeTo", "placement_cycle");
  const parentOrder = order("parentId", "parent_cycle");
  const positions = new Map<string, Position>();
  const rotations = new Map<string, SceneRotation>();
  for (const id of placementOrder) {
    const node = nodes.get(id)!;
    const parent =
      node.placement.relativeTo === undefined
        ? { x: 0, y: 0, z: 0 }
        : positions.get(node.placement.relativeTo);
    if (!parent) continue;
    const parentRotation =
      node.placement.relativeTo === undefined
        ? SCENE_IDENTITY_ROTATION
        : rotations.get(node.placement.relativeTo)!;
    const offset = sceneTransformVector(parentRotation, node.placement.offset);
    const result = {
      x: Math.fround(parent.x + offset.x),
      y: Math.fround(parent.y + offset.y),
      z: Math.fround(parent.z + offset.z),
    };
    if (
      ![result.x, result.y, result.z].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
      )
    ) {
      issues.push({
        code: "placement_bounds",
        path: `nodes[${indices.get(id)!}].placement`,
        nodeId: id,
        actual: {
          x: Number.isFinite(result.x) ? result.x : null,
          y: Number.isFinite(result.y) ? result.y : null,
          z: Number.isFinite(result.z) ? result.z : null,
        },
        expected: "finite float32 world coordinates within [-100000, 100000] on every axis",
        detail: "Resolved placement exceeds admitted transform bounds; null denotes overflow.",
      });
    } else {
      positions.set(id, result);
      rotations.set(
        id,
        sceneMultiply(
          parentRotation,
          sceneEulerXyz(node.placement.rotationDegrees ?? { x: 0, y: 0, z: 0 }),
          true,
        ),
      );
    }
  }
  config.constraints.forEach((constraint, index) => {
    const first = nodes.get(constraint.first);
    const second = nodes.get(constraint.second);
    if (!first || !second || first.id === second.id) return;
    const a = positions.get(first.id);
    const b = positions.get(second.id);
    if (!a || !b) return;
    const measurement = measureSceneBoxConstraint(
      constraint.kind,
      { position: a, rotation: rotations.get(first.id)!, size: first.size },
      { position: b, rotation: rotations.get(second.id)!, size: second.size },
      constraint.clearance,
    );
    if (!measurement.valid)
      issues.push({
        code: "unsatisfiable_constraint",
        path: `constraints[${index}]`,
        actual: {
          first: first.id,
          second: second.id,
          clearance: constraint.clearance,
          margins: { ...measurement.margins },
          numericalSafety: { ...measurement.numericalSafety },
          boundsFrame: measurement.boundsFrame,
        },
        expected:
          constraint.kind === "separation"
            ? "rotated Size bounds separated along at least one world axis with the declared clearance"
            : "first rotated Size box contained by second oriented Size box on every local axis with the declared clearance",
        detail: `${constraint.kind} failed for ${first.id} and ${second.id}; margins describe conservative bounding boxes, not physical shape or gameplay space.`,
      });
  });
  const siblings = new Map<string, SceneNode[]>();
  for (const node of nodes.values()) {
    const key = JSON.stringify([node.parentId ?? null, node.name]);
    const group = siblings.get(key) ?? [];
    group.push(node);
    siblings.set(key, group);
  }
  for (const group of siblings.values())
    if (group.length > 1)
      for (const node of group)
        issues.push({
          code: "duplicate_path",
          path: `nodes[${indices.get(node.id)!}].name`,
          nodeId: node.id,
          actual: node.name,
          expected: "unique name among nodes with the same parentId",
          detail: "Sibling names must be unique.",
        });
  return {
    diagnostics: {
      componentId,
      recipeId: "scene-primitives" as const,
      issues,
      validIds,
      validParentPaths,
      unresolvedPlacementNodeIds: config.nodes
        .filter((node) => !positions.has(node.id))
        .map((node) => node.id)
        .filter((id, index, values) => values.indexOf(id) === index)
        .sort(),
    },
    resolved: { nodes, positions, rotations, parentOrder },
  };
}

export function collectSceneValidationIssues(
  config: ScenePrimitivesConfig,
  componentId: string,
): SceneValidationDiagnostics {
  return analyzeScene(config, componentId).diagnostics;
}

/** The compiler and early declaration validator use this same semantic pass. */
export function resolveScene(config: ScenePrimitivesConfig, componentId: string): ResolvedScene {
  const { diagnostics, resolved } = analyzeScene(config, componentId);
  if (diagnostics.issues.length)
    throw new CompositionError("invalid_scene", JSON.stringify(diagnostics));
  return resolved;
}
