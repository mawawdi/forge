import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { assertBoundedGameJson, entityId, hashSchema } from "../../game-ir/src/primitives.js";
import {
  BLENDER_SCENE_HANDLE_SCHEMA,
  BLENDER_SCENE_INTENT_SCHEMA,
  DEFAULT_VISUAL_WORLD_ADMISSION_POLICY,
  blenderSceneSpecHandle,
  validateBlenderSceneIntent,
  validateBlenderSceneSpec,
  type BlenderSceneSpec,
} from "./contracts.js";
import { solveBlenderScene, type SceneSolverResult } from "./solver.js";

export const SCENE_REPAIR_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("SceneRepairProposal"),
    id: entityId,
    parent: BLENDER_SCENE_HANDLE_SCHEMA,
    observationHashes: z.array(hashSchema).min(1).max(32),
    changedIds: z.array(entityId).min(1).max(512),
    affectedInterfaceIds: z.array(entityId).max(512),
    intendedResult: z.string().trim().min(1).max(4096),
    nextIntent: BLENDER_SCENE_INTENT_SCHEMA,
  })
  .strict();
export type SceneRepairProposal = z.infer<typeof SCENE_REPAIR_PROPOSAL_SCHEMA>;

export interface SceneRepairPlan {
  kind: "SceneRepairPlan";
  id: string;
  hash: string;
  parent: SceneRepairProposal["parent"];
  nextSceneHash: string;
  directlyChangedIds: string[];
  affectedGeometryIds: string[];
  affectedSourceIds: string[];
  affectedTextureIds: string[];
  affectedMaterialIds: string[];
  affectedObjectIds: string[];
  affectedInstanceIds: string[];
  affectedNativeIds: string[];
  affectedPartitionIds: string[];
  affectedViewIds: string[];
  neighboringInterfaceIds: string[];
  reusedPartitionIds: string[];
}

export type SceneRepairResult =
  | {
      status: "eligible";
      proposal: SceneRepairProposal;
      plan: SceneRepairPlan;
      solve: Extract<SceneSolverResult, { status: "eligible" }>;
    }
  | {
      status: "rejected" | "incomplete";
      diagnostics: readonly { code: string; subject: string; detail: string }[];
    };

export function planSceneRepair(parentInput: unknown, proposalInput: unknown): SceneRepairResult {
  let parent: BlenderSceneSpec;
  let proposal: SceneRepairProposal;
  try {
    parent = validateBlenderSceneSpec(parentInput);
    assertBoundedGameJson(proposalInput, DEFAULT_VISUAL_WORLD_ADMISSION_POLICY);
    proposal = SCENE_REPAIR_PROPOSAL_SCHEMA.parse(proposalInput);
    proposal.nextIntent = validateBlenderSceneIntent(proposal.nextIntent);
  } catch (error: unknown) {
    return rejected("repair_invalid", "repair", detail(error));
  }
  const handle = blenderSceneSpecHandle(parent);
  if (stableJson(handle) !== stableJson(proposal.parent))
    return rejected(
      "repair_parent_stale",
      proposal.id,
      "Repair parent does not match the exact current scene revision",
    );
  if (
    proposal.nextIntent.sceneId !== parent.sceneId ||
    proposal.nextIntent.revision !== parent.revision + 1 ||
    proposal.nextIntent.parent?.revision !== parent.revision ||
    proposal.nextIntent.parent.hash !== handle.hash
  )
    return rejected(
      "repair_revision_invalid",
      proposal.id,
      "Repair must produce the next revision and bind the exact parent hash",
    );

  const sharedMutation = sameIdentitySharedGeometryMutation(parent, proposal.nextIntent);
  if (sharedMutation)
    return rejected(
      "repair_shared_geometry_requires_fork",
      sharedMutation,
      "A geometry consumed more than once cannot be edited in place; fork the geometry identity and bind only the intended object",
    );

  const solve = solveBlenderScene(proposal.nextIntent);
  if (solve.status !== "eligible") return { status: solve.status, diagnostics: solve.diagnostics };
  const changed = changedEntityIds(parent, solve.spec);
  const declared = new Set(proposal.changedIds);
  if (
    changed.some((id) => !declared.has(id)) ||
    proposal.changedIds.some((id) => !changed.includes(id))
  )
    return rejected(
      "repair_scope_mismatch",
      proposal.id,
      `Declared changed IDs differ from canonical scene changes: ${changed.join(", ")}`,
    );

  const closure = repairClosure(parent, solve.spec, changed);
  const unfrozen = changedFrozenPlacements(parent, solve.spec, closure);
  if (unfrozen)
    return rejected(
      "repair_frozen_neighbor_moved",
      unfrozen,
      "The proposed repair moves an unaffected solved placement; expand the proposal scope explicitly",
    );
  const missingInterfaces = closure.neighboringInterfaceIds.filter(
    (id) => !proposal.affectedInterfaceIds.includes(id),
  );
  if (missingInterfaces.length)
    return rejected(
      "repair_interface_incomplete",
      proposal.id,
      `Repair omits neighboring interfaces: ${missingInterfaces.join(", ")}`,
    );
  const material = {
    kind: "SceneRepairPlan" as const,
    id: `scene_repair_${contentHash(stableJson([proposal.id, proposal.parent.hash])).slice(0, 24)}`,
    parent: proposal.parent,
    nextSceneHash: solve.hash,
    directlyChangedIds: changed,
    ...closure,
  };
  return {
    status: "eligible",
    proposal,
    plan: { ...material, hash: contentHash(stableJson(material)) },
    solve,
  };
}

function changedEntityIds(parent: BlenderSceneSpec, next: BlenderSceneSpec): string[] {
  const ignored = new Set(["revision", "parent"]);
  const topParent = Object.fromEntries(Object.entries(parent).filter(([key]) => !ignored.has(key)));
  const topNext = Object.fromEntries(Object.entries(next).filter(([key]) => !ignored.has(key)));
  const changed = new Set<string>();
  for (const key of Object.keys(topParent)) {
    const before = topParent[key];
    const after = topNext[key];
    if (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.every(hasId) &&
      after.every(hasId)
    ) {
      const first = new Map((before as Array<{ id: string }>).map((entry) => [entry.id, entry]));
      const second = new Map((after as Array<{ id: string }>).map((entry) => [entry.id, entry]));
      for (const id of new Set([...first.keys(), ...second.keys()]))
        if (stableJson(first.get(id)) !== stableJson(second.get(id))) changed.add(id);
    } else if (stableJson(before) !== stableJson(after)) {
      changed.add(`scene-${key}`);
    }
  }
  return [...changed].sort();
}

function repairClosure(
  parent: BlenderSceneSpec,
  next: BlenderSceneSpec,
  directlyChangedIds: readonly string[],
): Omit<
  SceneRepairPlan,
  "kind" | "id" | "hash" | "parent" | "nextSceneHash" | "directlyChangedIds"
> {
  const affected = new Set(directlyChangedIds);
  const geometryIds = new Set<string>();
  const sourceIds = new Set<string>();
  const textureIds = new Set<string>();
  const materialIds = new Set<string>();
  const objectIds = new Set<string>();
  const instanceIds = new Set<string>();
  const nativeIds = new Set<string>();
  const partitionIds = new Set<string>();
  const viewIds = new Set<string>();
  const interfaceIds = new Set<string>();
  const geometryVariants = [...parent.geometries, ...next.geometries];
  const allGeometries = new Map(geometryVariants.map((entry) => [entry.id, entry]));
  const allSources = [...parent.sources, ...next.sources];
  const allTextures = [...parent.textures, ...next.textures];
  const allMaterials = [...parent.materials, ...next.materials];
  const allObjects = [...parent.objects, ...next.objects];
  const allInstances = [...parent.instances, ...next.instances];
  const allCollisions = [...parent.collisionProxies, ...next.collisionProxies];
  const allAnchors = [...parent.gameplayAnchors, ...next.gameplayAnchors];
  const allInteractives = [...parent.interactiveProps, ...next.interactiveProps];
  const allEffects = [...parent.effects, ...next.effects];
  const compilerChanged = affected.has("scene-compiler");
  if (compilerChanged) {
    for (const id of allGeometries.keys()) geometryIds.add(id);
    for (const object of [...parent.objects, ...next.objects]) objectIds.add(object.id);
    for (const partition of [...parent.partitions, ...next.partitions])
      partitionIds.add(partition.id);
    for (const view of [...parent.reviewViews, ...next.reviewViews]) viewIds.add(view.id);
    for (const constraint of [...parent.constraints, ...next.constraints])
      interfaceIds.add(constraint.id);
    for (const socket of [...parent.sockets, ...next.sockets]) interfaceIds.add(socket.id);
  }
  let progress = true;
  while (progress) {
    progress = false;
    const mark = (id: string): void => {
      if (!affected.has(id)) {
        affected.add(id);
        progress = true;
      }
    };
    for (const source of allSources) if (affected.has(source.id)) sourceIds.add(source.id);
    for (const texture of allTextures)
      if (affected.has(texture.id) || affected.has(texture.sourceId)) {
        textureIds.add(texture.id);
        mark(texture.id);
      }
    for (const material of allMaterials)
      if (affected.has(material.id) || material.textureIds.some((id) => affected.has(id))) {
        materialIds.add(material.id);
        mark(material.id);
      }
    for (const geometry of geometryVariants) {
      const dependencies = geometryDependencies(geometry);
      const sourceAffected = geometry.kind === "external_glb" && affected.has(geometry.sourceId);
      if (
        affected.has(geometry.id) ||
        dependencies.some((id) => affected.has(id)) ||
        sourceAffected
      )
        mark(geometry.id);
    }
    for (const object of allObjects)
      if (
        affected.has(object.id) ||
        affected.has(object.geometryId) ||
        object.materialIds.some((id) => affected.has(id))
      ) {
        objectIds.add(object.id);
        mark(object.id);
      }
    for (const instance of allInstances)
      if (affected.has(instance.id) || affected.has(instance.sourceObjectId)) {
        instanceIds.add(instance.id);
        mark(instance.id);
      }
  }
  for (const id of affected) if (allGeometries.has(id)) geometryIds.add(id);
  for (const object of allObjects)
    if (
      affected.has(object.id) ||
      affected.has(object.geometryId) ||
      object.materialIds.some((id) => affected.has(id))
    ) {
      objectIds.add(object.id);
      partitionIds.add(object.partitionId);
    }
  for (const instance of [...parent.instances, ...next.instances])
    if (affected.has(instance.id) || objectIds.has(instance.sourceObjectId)) {
      instanceIds.add(instance.id);
      partitionIds.add(instance.partitionId);
    }
  for (const collision of allCollisions)
    if (
      affected.has(collision.id) ||
      (collision.ownerObjectId && objectIds.has(collision.ownerObjectId))
    ) {
      nativeIds.add(collision.id);
      partitionIds.add(collision.partitionId);
    }
  for (const anchor of allAnchors)
    if (affected.has(anchor.id) || affected.has(anchor.zoneId)) {
      nativeIds.add(anchor.id);
      partitionIds.add(anchor.partitionId);
    }
  for (const interactive of allInteractives)
    if (
      affected.has(interactive.id) ||
      objectIds.has(interactive.objectId) ||
      interactive.socketIds.some((id) => affected.has(id))
    ) {
      nativeIds.add(interactive.id);
      partitionIds.add(interactive.partitionId);
    }
  let changedEffect = false;
  for (const effect of allEffects)
    if (affected.has(effect.id)) {
      nativeIds.add(effect.id);
      partitionIds.add(effect.partitionId);
      changedEffect = true;
    }
  for (const partition of [...parent.partitions, ...next.partitions])
    if (affected.has(partition.id) || partition.objectIds.some((id) => objectIds.has(id)))
      partitionIds.add(partition.id);
  for (const constraint of [...parent.constraints, ...next.constraints])
    if (
      constraintIds(constraint).some(
        (id) => objectIds.has(id) || partitionIds.has(id) || affected.has(id),
      )
    )
      interfaceIds.add(constraint.id);
  for (const socket of [...parent.sockets, ...next.sockets])
    if (objectIds.has(socket.ownerObjectId) || affected.has(socket.id)) interfaceIds.add(socket.id);
  for (const view of [...parent.reviewViews, ...next.reviewViews])
    if (changedEffect || affected.has(view.id) || view.targetIds.some((id) => objectIds.has(id)))
      viewIds.add(view.id);
  const allPartitionIds = new Set(
    [...parent.partitions, ...next.partitions].map((entry) => entry.id),
  );
  return {
    affectedGeometryIds: [...geometryIds].sort(),
    affectedSourceIds: [...sourceIds].sort(),
    affectedTextureIds: [...textureIds].sort(),
    affectedMaterialIds: [...materialIds].sort(),
    affectedObjectIds: [...objectIds].sort(),
    affectedInstanceIds: [...instanceIds].sort(),
    affectedNativeIds: [...nativeIds].sort(),
    affectedPartitionIds: [...partitionIds].sort(),
    affectedViewIds: [...viewIds].sort(),
    neighboringInterfaceIds: [...interfaceIds].sort(),
    reusedPartitionIds: [...allPartitionIds].filter((id) => !partitionIds.has(id)).sort(),
  };
}

function sameIdentitySharedGeometryMutation(
  parent: BlenderSceneSpec,
  next: z.infer<typeof BLENDER_SCENE_INTENT_SCHEMA>,
): string | undefined {
  const nextGeometries = new Map(next.geometries.map((entry) => [entry.id, entry]));
  for (const geometry of parent.geometries) {
    const replacement = nextGeometries.get(geometry.id);
    if (!replacement || stableJson(replacement) === stableJson(geometry)) continue;
    const objectIds = parent.objects
      .filter((object) => object.geometryId === geometry.id)
      .map((object) => object.id);
    let consumers = objectIds.length;
    for (const instance of parent.instances)
      if (objectIds.includes(instance.sourceObjectId)) consumers += instance.transforms.length;
    if (consumers > 1) return geometry.id;
  }
  return undefined;
}

function changedFrozenPlacements(
  parent: BlenderSceneSpec,
  next: BlenderSceneSpec,
  closure: ReturnType<typeof repairClosure>,
): string | undefined {
  const affectedObjects = new Set(closure.affectedObjectIds);
  const nextObjects = new Map(next.objects.map((entry) => [entry.id, entry]));
  for (const object of parent.objects) {
    const replacement = nextObjects.get(object.id);
    if (
      replacement &&
      !affectedObjects.has(object.id) &&
      stableJson(replacement.transform) !== stableJson(object.transform)
    )
      return object.id;
  }
  const affectedInstances = new Set(closure.affectedInstanceIds);
  const nextInstances = new Map(next.instances.map((entry) => [entry.id, entry]));
  for (const instance of parent.instances) {
    const replacement = nextInstances.get(instance.id);
    if (
      replacement &&
      !affectedInstances.has(instance.id) &&
      stableJson(replacement.transforms) !== stableJson(instance.transforms)
    )
      return instance.id;
  }
  return undefined;
}

function geometryDependencies(value: BlenderSceneSpec["geometries"][number]): string[] {
  switch (value.kind) {
    case "extrude":
    case "revolve":
      return [value.profileId];
    case "loft":
      return value.profileIds;
    case "sweep":
      return [value.profileId, value.curveId];
    case "join":
      return value.operandIds;
    case "bevel":
    case "solidify":
    case "mirror":
    case "subdivide":
    case "transform_geometry":
    case "deform":
      return [value.operandId];
    case "boolean":
      return [value.leftId, value.rightId];
    default:
      return [];
  }
}

function constraintIds(value: BlenderSceneSpec["constraints"][number]): string[] {
  switch (value.kind) {
    case "containment":
      return [value.objectId, value.zoneId];
    case "separation":
      return [value.firstObjectId, value.secondObjectId];
    case "support":
      return [value.objectId, value.supporterId];
    case "clearance":
      return [value.routeId, ...value.objectIds];
    case "reachability":
      return [value.routeId, ...value.anchorIds];
    case "sightline":
      return [value.targetObjectId, ...value.occluderIds];
    case "camera_framing":
      return [value.viewId, ...value.objectIds];
    case "density":
    case "negative_space":
      return [value.zoneId];
    case "budget":
      return [];
  }
}

function hasId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function rejected(code: string, subject: string, detailText: string): SceneRepairResult {
  return { status: "rejected", diagnostics: [{ code, subject, detail: detailText }] };
}
