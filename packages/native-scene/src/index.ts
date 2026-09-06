import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  APPROVED_SCENE_ASSET_INSPECTION_SCHEMA,
  CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA,
  CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA,
  GAME_PLAN_VISUAL_BINDINGS_SCHEMA,
  NATIVE_ASSET_RECEIPT_SCHEMA,
  NATIVE_UPLOAD_AUTHORIZATION_SCHEMA,
  assertSealedWorkflowArtifact,
  blenderSceneSpecHandle,
  evaluateNativeSceneEligibility,
  validateBlenderSceneSpec,
  type ApprovedSceneAssetInspection,
  type BlenderSceneSpec,
  type CreatorVisualWorldAcceptance,
  type CreatorVisualWorldProposal,
  type GamePlanVisualBindings,
  type NativeAssetReceipt,
  type NativeUploadAuthorization,
} from "../../visual-world/src/index.js";
import {
  assertSceneBundleReview,
  type SceneBundleManifest,
  type SceneBundleReview,
  type SceneRepairDelta,
} from "../../blender-compiler/src/index.js";
import type {
  ApprovedSceneImportBinding,
  ApprovedSceneReplacementBinding,
  StudioInstanceTarget,
  StudioMutationParent,
} from "../../creator-session/src/index.js";
import type {
  GameComponentCompilation,
  GameComponentCompilerInput,
  GameInventoryItem,
} from "../../game-compiler/src/types.js";
import type { GameSceneHandleComponent } from "../../game-ir/src/index.js";
import {
  bool,
  color,
  createItem,
  engineParent,
  enumeration,
  itemId,
  num,
  outputParent,
  vec2,
  vec3,
} from "../../game-composition/src/common.js";
import { sceneEulerXyz } from "../../game-composition/src/scene-geometry.js";

export const APPROVED_SCENE_IMPORT_ABI = "import_approved_scene@2";
export const APPROVED_SCENE_REPLACEMENT_ABI = "replace_approved_scene@2";

export interface ApprovedSceneCompilationAuthorities {
  readonly bindings: GamePlanVisualBindings;
  readonly proposal: CreatorVisualWorldProposal;
  readonly acceptance: CreatorVisualWorldAcceptance;
  readonly manifest: SceneBundleManifest;
  readonly review: SceneBundleReview;
  readonly authorization: NativeUploadAuthorization;
  readonly receipts: readonly NativeAssetReceipt[];
  readonly inspection: ApprovedSceneAssetInspection;
  readonly repairDelta?: SceneRepairDelta;
}

function assertManifest(manifest: SceneBundleManifest, scene: BlenderSceneSpec): void {
  const { hash, ...material } = manifest;
  if (
    manifest.kind !== "SceneBundleManifest" ||
    manifest.abi !== "forge-blender-compiler@2" ||
    contentHash(stableJson(material)) !== hash ||
    stableJson(manifest.scene) !== stableJson(blenderSceneSpecHandle(scene))
  )
    throw new Error("Scene bundle manifest identity or scene binding mismatch");
  const expectedGlbs = scene.expectedOutputs.filter((entry) => entry.kind === "glb");
  const actualGlbs = manifest.outputs.filter((entry) => entry.kind === "glb");
  if (
    expectedGlbs.length !== actualGlbs.length ||
    expectedGlbs.some((expected) => {
      const actual = actualGlbs.find((entry) => entry.id === expected.id);
      return (
        actual === undefined ||
        actual.partitionId !== expected.partitionId ||
        actual.relativePath !== expected.relativePath ||
        actual.mediaType !== "model/gltf-binary"
      );
    })
  )
    throw new Error("Compiled GLB inventory differs from the scene specification");
  const objects = new Map(manifest.objectInventory.map((entry) => [entry.stableId, entry]));
  if (
    objects.size !== manifest.objectInventory.length ||
    scene.objects.some((object) => objects.get(object.id)?.partitionId !== object.partitionId)
  )
    throw new Error("Scene bundle object inventory is incomplete or ambiguous");
}

export function assertApprovedSceneCompilationAuthorities(
  scene: BlenderSceneSpec,
  authority: ApprovedSceneCompilationAuthorities,
): void {
  const bindings = authority.bindings;
  assertSealedWorkflowArtifact(GAME_PLAN_VISUAL_BINDINGS_SCHEMA, bindings);
  assertSealedWorkflowArtifact(CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA, authority.proposal);
  assertSealedWorkflowArtifact(CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA, authority.acceptance);
  assertSealedWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, authority.authorization);
  assertSealedWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, authority.inspection);
  for (const receipt of authority.receipts)
    assertSealedWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, receipt);
  assertSceneBundleReview(authority.review);
  assertManifest(authority.manifest, scene);
  if (authority.manifest.repairDeltaHash !== undefined) {
    if (!authority.repairDelta)
      throw new Error("Repaired scene authority is missing its retained repair delta");
    const { hash: repairHash, ...repairMaterial } = authority.repairDelta;
    if (
      repairHash !== authority.manifest.repairDeltaHash ||
      contentHash(stableJson(repairMaterial)) !== repairHash ||
      stableJson(authority.repairDelta.nextScene) !== stableJson(blenderSceneSpecHandle(scene))
    )
      throw new Error("Scene repair delta identity or next-scene binding mismatch");
  } else if (authority.repairDelta !== undefined) {
    throw new Error("Unrepaired scene authority cannot attach a repair delta");
  }
  const handle = blenderSceneSpecHandle(scene);
  if (
    stableJson(bindings.scene) !== stableJson(handle) ||
    bindings.proposalHash !== authority.proposal.hash ||
    bindings.proposalAcceptanceHash !== authority.acceptance.hash ||
    bindings.bundleManifestHash !== authority.manifest.hash ||
    bindings.sceneReviewHash !== authority.review.hash ||
    bindings.uploadAuthorizationHash !== authority.authorization.hash ||
    bindings.inspectionHash !== authority.inspection.hash ||
    stableJson(bindings.assetReceiptHashes) !==
      stableJson(authority.receipts.map((receipt) => receipt.hash).sort()) ||
    authority.proposal.solvedScene.hash !== handle.hash ||
    authority.acceptance.proposalHash !== authority.proposal.hash ||
    authority.acceptance.decision !== "accepted" ||
    authority.review.scene.hash !== handle.hash ||
    authority.review.manifestHash !== authority.manifest.hash ||
    authority.review.decision !== "approved" ||
    authority.authorization.scene.hash !== handle.hash ||
    authority.authorization.bundleManifestHash !== authority.manifest.hash ||
    authority.authorization.reviewHash !== authority.review.hash ||
    authority.inspection.hash !== bindings.inspectionHash ||
    authority.inspection.capabilityProfileHash !== bindings.capabilityProfileHash
  )
    throw new Error("Scene import authorities do not bind one exact approved revision");
  const requiredReviewHashes = authority.manifest.outputs
    .filter((output) => output.kind === "glb" || output.kind === "review_render")
    .map((output) => output.artifactHash)
    .sort();
  if (
    stableJson([...authority.review.reviewedOutputHashes].sort()) !==
    stableJson(requiredReviewHashes)
  )
    throw new Error("Scene review does not cover the exact render and GLB inventory");
  const eligibility = evaluateNativeSceneEligibility({
    authorization: authority.authorization,
    receipts: authority.receipts,
    inspection: authority.inspection,
  });
  if (eligibility.status !== "eligible")
    throw new Error(
      `Approved scene import is ${eligibility.status}: ${eligibility.diagnostics.join("; ")}`,
    );
}

function cframe(transform: BlenderSceneSpec["collisionProxies"][number]["transform"]) {
  const rotation = sceneEulerXyz({
    x: transform.rotation.xDegrees,
    y: transform.rotation.yDegrees,
    z: transform.rotation.zDegrees,
  });
  return {
    kind: "cframe_f32x12" as const,
    components: [transform.position.x, transform.position.y, transform.position.z, ...rotation],
  };
}

function addNativeSemantics(
  context: GameComponentCompilerInput,
  scene: BlenderSceneSpec,
  root: GameInventoryItem,
): GameInventoryItem[] {
  const inventory: GameInventoryItem[] = [];
  for (const proxy of scene.collisionProxies) {
    const item = createItem(
      context,
      `collision-${proxy.id}`,
      proxy.id,
      proxy.shape === "wedge" ? "WedgePart" : "Part",
      outputParent(context, root),
      {
        Anchored: bool(true),
        CanCollide: bool(proxy.canCollide),
        CanTouch: bool(proxy.canTouch),
        CanQuery: bool(proxy.canQuery),
        Transparency: num(1),
        Size: vec3(proxy.size),
        CFrame: cframe(proxy.transform),
        ...(proxy.shape === "wedge"
          ? {}
          : {
              Shape: enumeration(
                proxy.shape === "sphere"
                  ? "Ball"
                  : proxy.shape === "cylinder"
                    ? "Cylinder"
                    : "Block",
              ),
            }),
      },
      [root.id],
      `collision/${proxy.id}`,
    );
    inventory.push(item);
  }
  for (const anchor of scene.gameplayAnchors) {
    const extent = anchor.extent ?? { x: 0.5, y: 0.5, z: 0.5 };
    const item = createItem(
      context,
      `anchor-${anchor.id}`,
      anchor.bindingName,
      "Part",
      outputParent(context, root),
      {
        Anchored: bool(true),
        CanCollide: bool(false),
        CanTouch: bool(false),
        CanQuery: bool(false),
        Transparency: num(1),
        Size: vec3(extent),
        CFrame: cframe(anchor.transform),
      },
      [root.id],
      `anchor/${anchor.id}`,
    );
    inventory.push(item);
  }
  for (const effect of scene.effects) {
    if (effect.kind === "atmosphere") {
      const item = createItem(
        context,
        `effect-${effect.id}`,
        effect.id,
        "Atmosphere",
        engineParent("Lighting"),
        {
          Color: color({
            r: Math.round(effect.color.r * 255),
            g: Math.round(effect.color.g * 255),
            b: Math.round(effect.color.b * 255),
          }),
          Decay: color({
            r: Math.round(effect.decay.r * 255),
            g: Math.round(effect.decay.g * 255),
            b: Math.round(effect.decay.b * 255),
          }),
          Density: num(effect.density),
          Offset: num(effect.offset),
          Haze: num(effect.haze),
          Glare: num(effect.glare),
        },
        [],
        `effect/${effect.id}`,
      );
      inventory.push(item);
      continue;
    }
    const holder = createItem(
      context,
      `effect-holder-${effect.id}`,
      `${effect.id}_Origin`,
      "Part",
      outputParent(context, root),
      {
        Anchored: bool(true),
        CanCollide: bool(false),
        CanTouch: bool(false),
        CanQuery: bool(false),
        Transparency: num(1),
        Size: vec3({ x: 0.25, y: 0.25, z: 0.25 }),
        CFrame: cframe(effect.transform),
      },
      [root.id],
    );
    inventory.push(holder);
    const className =
      effect.kind === "point_light"
        ? "PointLight"
        : effect.kind === "spot_light"
          ? "SpotLight"
          : effect.kind === "surface_light"
            ? "SurfaceLight"
            : effect.kind === "particle"
              ? "ParticleEmitter"
              : "Sound";
    const properties = (() => {
      if (
        effect.kind === "point_light" ||
        effect.kind === "spot_light" ||
        effect.kind === "surface_light"
      )
        return {
          Color: color({
            r: Math.round(effect.color.r * 255),
            g: Math.round(effect.color.g * 255),
            b: Math.round(effect.color.b * 255),
          }),
          Brightness: num(effect.intensity),
          Range: num(effect.range),
          Shadows: bool(effect.shadows),
          ...(effect.kind === "point_light"
            ? {}
            : {
                Angle: num(effect.angleDegrees),
                Face: enumeration(effect.face),
              }),
        };
      if (effect.kind === "particle")
        return {
          Color: {
            kind: "color_sequence" as const,
            keypoints: [
              {
                time: 0,
                color: {
                  r: Math.round(effect.color.r * 255),
                  g: Math.round(effect.color.g * 255),
                  b: Math.round(effect.color.b * 255),
                },
              },
              {
                time: 1,
                color: {
                  r: Math.round(effect.color.r * 255),
                  g: Math.round(effect.color.g * 255),
                  b: Math.round(effect.color.b * 255),
                },
              },
            ],
          },
          Rate: num(effect.rate),
          Lifetime: {
            kind: "number_range" as const,
            min: effect.lifetimeSeconds[0],
            max: effect.lifetimeSeconds[1],
          },
          Speed: {
            kind: "number_range" as const,
            min: effect.speed[0],
            max: effect.speed[1],
          },
          SpreadAngle: vec2(effect.spreadDegrees[0], effect.spreadDegrees[1]),
          LightEmission: num(effect.lightEmission),
        };
      if (effect.kind === "sound")
        return {
          SoundId: { kind: "content" as const, value: `rbxassetid://${effect.soundAssetId}` },
          Volume: num(effect.volume),
          PlaybackSpeed: num(effect.playbackSpeed),
          Looped: bool(effect.looped),
          RollOffMinDistance: num(effect.rolloffMinimumDistance),
          RollOffMaxDistance: num(effect.rolloffMaximumDistance),
        };
      throw new Error("Unsupported native effect declaration");
    })();
    const item = createItem(
      context,
      `effect-${effect.id}`,
      effect.id,
      className,
      outputParent(context, holder),
      properties,
      [holder.id],
      `effect/${effect.id}`,
    );
    inventory.push(item);
  }
  return inventory;
}

function addInteractiveWrappers(
  context: GameComponentCompilerInput,
  scene: BlenderSceneSpec,
  root: GameInventoryItem,
): {
  inventory: GameInventoryItem[];
  byPartition: Map<string, GameInventoryItem>;
} {
  const inventory: GameInventoryItem[] = [];
  const byPartition = new Map<string, GameInventoryItem>();
  for (const interaction of scene.interactiveProps) {
    if (byPartition.has(interaction.partitionId))
      throw new Error(
        `Interactive partition has multiple native wrappers: ${interaction.partitionId}`,
      );
    const wrapper = createItem(
      context,
      `interaction-${interaction.id}`,
      interaction.id,
      "Part",
      outputParent(context, root),
      {
        Anchored: bool(true),
        CanCollide: bool(false),
        CanTouch: bool(false),
        CanQuery: bool(false),
        Transparency: num(1),
        Size: vec3({ x: 0.25, y: 0.25, z: 0.25 }),
        CFrame: cframe(interaction.pivot),
      },
      [root.id],
      `interaction/${interaction.id}`,
    );
    inventory.push(wrapper);
    byPartition.set(interaction.partitionId, wrapper);
    for (const socketId of interaction.socketIds) {
      const socket = scene.sockets.find((entry) => entry.id === socketId);
      if (!socket) throw new Error(`Interactive socket is absent: ${socketId}`);
      inventory.push(
        createItem(
          context,
          `socket-${socket.id}`,
          socket.id,
          "Attachment",
          outputParent(context, wrapper),
          { CFrame: cframe(socket.localTransform) },
          [wrapper.id],
          `socket/${socket.id}`,
        ),
      );
    }
  }
  const representedSockets = new Set(scene.interactiveProps.flatMap((entry) => entry.socketIds));
  for (const socket of scene.sockets) {
    if (representedSockets.has(socket.id)) continue;
    const owner = scene.objects.find((entry) => entry.id === socket.ownerObjectId);
    if (!owner) throw new Error(`Socket owner is absent: ${socket.ownerObjectId}`);
    const holder = createItem(
      context,
      `socket-holder-${socket.id}`,
      `${socket.id}_Origin`,
      "Part",
      outputParent(context, root),
      {
        Anchored: bool(true),
        CanCollide: bool(false),
        CanTouch: bool(false),
        CanQuery: bool(false),
        Transparency: num(1),
        Size: vec3({ x: 0.25, y: 0.25, z: 0.25 }),
        CFrame: cframe(owner.transform),
      },
      [root.id],
    );
    inventory.push(holder);
    inventory.push(
      createItem(
        context,
        `socket-${socket.id}`,
        socket.id,
        "Attachment",
        outputParent(context, holder),
        { CFrame: cframe(socket.localTransform) },
        [holder.id],
        `socket/${socket.id}`,
      ),
    );
  }
  return { inventory, byPartition };
}

/**
 * Compile one exact, approved scene revision. Native semantics remain direct
 * Studio declarations; each reviewed GLB becomes one closed detached-load
 * operation and never exposes a generic asset loader to model-authored data.
 */
export function compileApprovedSceneComponent(input: {
  readonly context: GameComponentCompilerInput;
  readonly component: GameSceneHandleComponent;
  readonly scene: BlenderSceneSpec;
  readonly authority: ApprovedSceneCompilationAuthorities;
}): GameComponentCompilation {
  const scene = validateBlenderSceneSpec(input.scene);
  if (stableJson(input.component.scene) !== stableJson(blenderSceneSpecHandle(scene)))
    throw new Error("Scene component handle differs from its retained scene authority");
  assertApprovedSceneCompilationAuthorities(scene, input.authority);
  const root = createItem(
    input.context,
    "visual-world-root",
    `ForgeVisualWorld_${scene.sceneId}`,
    "Folder",
    engineParent("Workspace"),
    {},
    [],
    "root",
  );
  const inventory: GameInventoryItem[] = [root];
  const wrappers = addInteractiveWrappers(input.context, scene, root);
  inventory.push(...wrappers.inventory);
  const receipts = new Map(
    input.authority.receipts.map((receipt) => [receipt.sourceArtifactHash, receipt]),
  );
  const partitionItems = new Map<string, GameInventoryItem>();
  for (const output of input.authority.manifest.outputs
    .filter((entry) => entry.kind === "glb")
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const partition = scene.partitions.find((entry) => entry.id === output.partitionId);
    const receipt = receipts.get(output.artifactHash);
    if (!partition || !receipt?.contentHash)
      throw new Error(`Visual partition has no exact approved native receipt: ${output.id}`);
    const expectedNodes = input.authority.inspection.expectedNodes.filter(
      (node) => node.assetId === receipt.assetId && node.sourceArtifactHash === output.artifactHash,
    );
    if (expectedNodes.length === 0)
      throw new Error(`Visual partition detached inspection has no nodes: ${partition.id}`);
    const partitionParent = wrappers.byPartition.get(partition.id) ?? root;
    const item = createItem(
      input.context,
      `partition-${partition.id}`,
      partition.id,
      "Model",
      outputParent(input.context, partitionParent),
      {},
      [partitionParent.id],
      `partition/${partition.id}`,
    );
    const imported: GameInventoryItem = {
      ...item,
      change: {
        id: item.id,
        kind: "create",
        path: item.change.kind === "create" ? item.change.path : "",
        parent:
          item.change.kind === "create"
            ? item.change.parent
            : outputParent(input.context, partitionParent),
        className: "Model",
        initialization: "initial_properties",
        approvedSceneImport: {
          kind: "import_approved_scene",
          abi: APPROVED_SCENE_IMPORT_ABI,
          scene: input.component.scene,
          bundleManifestHash: input.authority.manifest.hash,
          sceneReviewHash: input.authority.review.hash,
          uploadAuthorizationHash: input.authority.authorization.hash,
          capabilityProfileHash: input.authority.bindings.capabilityProfileHash,
          inspectionHash: input.authority.inspection.hash,
          partitionId: partition.id,
          partitionRole: partition.role,
          sourceArtifactHash: output.artifactHash,
          receiptHash: receipt.hash,
          assetId: receipt.assetId,
          versionNumber: receipt.versionNumber,
          contentHash: receipt.contentHash,
          platformEnvelopeHash: input.authority.inspection.platformEnvelope.envelopeHash,
          descendants: expectedNodes.map((node) => ({
            stableId: node.stableId,
            relativePath: node.relativePath,
            name: node.name,
            className: node.className,
            ...(node.parentStableId === undefined ? {} : { parentStableId: node.parentStableId }),
            ...(node.contentIdentity === undefined
              ? {}
              : { contentIdentity: node.contentIdentity }),
            ...(node.materialIdentity === undefined
              ? {}
              : { materialIdentity: node.materialIdentity }),
            pivotHash: node.pivotHash,
            transformHash: node.transformHash,
            boundsHash: node.boundsHash,
          })),
        },
      },
    };
    inventory.push(imported);
    partitionItems.set(partition.id, imported);
  }
  for (let index = 0; index < inventory.length; index++) {
    const item = inventory[index]!;
    if (
      item.change.kind !== "create" ||
      item.change.initialization !== "initial_properties" ||
      !item.change.approvedSceneImport
    )
      continue;
    const importBinding = item.change.approvedSceneImport;
    const partition = scene.partitions.find((entry) => entry.id === importBinding.partitionId)!;
    inventory[index] = {
      ...item,
      dependencies: [
        wrappers.byPartition.get(importBinding.partitionId)?.id ?? root.id,
        ...partition.dependencyIds.flatMap((id) => {
          const dependency = partitionItems.get(id);
          return dependency ? [dependency.id] : [];
        }),
      ].sort(),
    };
  }
  inventory.push(...addNativeSemantics(input.context, scene, root));
  return {
    inventory,
    outputs: inventory.flatMap((item) =>
      item.outputId ? [{ id: item.outputId, operationId: item.id }] : [],
    ),
    observedSources: [],
  };
}

export interface ApprovedScenePartitionReplacementTarget {
  readonly partitionId: string;
  readonly previousImport: ApprovedSceneImportBinding;
  readonly previousTarget: StudioInstanceTarget & { readonly className: "Model" };
  readonly previousBeforeHash: string;
  /** Existing Forge-owned root or interaction wrapper that remains in place. */
  readonly stableWrapper: StudioMutationParent;
}

/**
 * Compile the visual portion of one reviewed repair. The old subtree and the
 * detached next asset are one topology atom: the exact old target is deleted,
 * the unchanged wrapper survives, and the replacement create depends on the
 * delete that frees its path. Native semantic edits require their own ordinary
 * reviewed component changes and therefore fail closed here.
 */
export function compileApprovedSceneReplacement(input: {
  readonly context: GameComponentCompilerInput;
  readonly component: GameSceneHandleComponent;
  readonly scene: BlenderSceneSpec;
  readonly authority: ApprovedSceneCompilationAuthorities;
  readonly previous: readonly ApprovedScenePartitionReplacementTarget[];
}): GameComponentCompilation {
  const delta = input.authority.repairDelta;
  if (!delta || input.authority.manifest.repairDeltaHash !== delta.hash)
    throw new Error("Approved scene replacement requires the exact retained repair delta");
  if (delta.changedNativeStableIds.length > 0)
    throw new Error(
      "Approved scene replacement cannot synthesize native semantic edits; compile them as reviewed direct component changes",
    );
  const next = compileApprovedSceneComponent(input);
  const affected = [...delta.changedPartitionIds].sort();
  if (
    affected.length === 0 ||
    stableJson(input.previous.map((entry) => entry.partitionId).sort()) !== stableJson(affected)
  )
    throw new Error("Approved scene replacement target coverage differs from the repair delta");
  const inventory: GameInventoryItem[] = [];
  for (const previous of [...input.previous].sort((left, right) =>
    left.partitionId.localeCompare(right.partitionId),
  )) {
    const nextItem = next.inventory.find(
      (item) =>
        item.change.kind === "create" &&
        item.change.initialization === "initial_properties" &&
        item.change.approvedSceneImport?.partitionId === previous.partitionId,
    );
    if (
      !nextItem ||
      nextItem.change.kind !== "create" ||
      nextItem.change.initialization !== "initial_properties" ||
      !nextItem.change.approvedSceneImport
    )
      throw new Error(
        `Repaired visual partition has no next approved import: ${previous.partitionId}`,
      );
    const nextImport = nextItem.change.approvedSceneImport;
    if (
      stableJson(previous.previousImport.scene) !== stableJson(delta.parentScene) ||
      previous.previousImport.partitionId !== previous.partitionId ||
      previous.previousImport.partitionRole !== nextImport.partitionRole ||
      !/^[0-9a-f]{64}$/u.test(previous.previousBeforeHash) ||
      previous.previousTarget.className !== "Model" ||
      previous.previousTarget.path !== `${previous.stableWrapper.path}/${previous.partitionId}`
    )
      throw new Error(`Previous visual partition authority is stale: ${previous.partitionId}`);
    const deleteId = itemId(input.context, `replace-delete-${previous.partitionId}`);
    const deleteItem: GameInventoryItem = {
      id: deleteId,
      componentId: input.context.componentId,
      change: {
        id: deleteId,
        kind: "delete",
        target: previous.previousTarget,
        expectedClass: "Model",
      },
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies: [],
      beforeHash: previous.previousBeforeHash,
      atomicGroup: `scene-replacement/${delta.hash}`,
    };
    const replacement: ApprovedSceneReplacementBinding = {
      kind: "replace_approved_scene",
      abi: APPROVED_SCENE_REPLACEMENT_ABI,
      previous: previous.previousImport,
      next: nextImport,
      previousTarget: previous.previousTarget,
      previousBeforeHash: previous.previousBeforeHash,
      repairDeltaHash: delta.hash,
    };
    const { approvedSceneImport: _approvedSceneImport, ...nextChange } = nextItem.change;
    inventory.push(deleteItem, {
      ...nextItem,
      change: {
        ...nextChange,
        path: previous.previousTarget.path,
        parent: previous.stableWrapper,
        approvedSceneReplacement: replacement,
      },
      dependencies: [deleteId],
      atomicGroup: `scene-replacement/${delta.hash}`,
    });
  }
  return {
    inventory,
    outputs: inventory.flatMap((item) =>
      item.outputId ? [{ id: item.outputId, operationId: item.id }] : [],
    ),
    observedSources: [],
  };
}

export * from "./authority.js";
