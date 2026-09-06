import { resolve } from "node:path";
import { z } from "zod";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../game-ir/src/primitives.js";
import {
  BLENDER_COMPILER_PROFILE,
  BLENDER_SCENE_AUTHORITY_SCHEMA,
  BLENDER_SCENE_DECLARATION_SCHEMA,
  BLENDER_SCENE_HANDLE_SCHEMA,
  bindBlenderSceneIntent,
  validateBlenderSceneDeclaration,
  type BlenderSceneAuthority,
  type BlenderSceneDeclaration,
} from "./contracts.js";
import type { InspectedSourceGeometry } from "./geometry-analysis.js";
import { solveBlenderScene } from "./solver.js";
import {
  CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA,
  RetainedBlenderSceneStore,
  assertSealedWorkflowArtifact,
  sealWorkflowArtifact,
  type CreatorVisualWorldProposal,
  type RetainedBlenderSceneBinding,
} from "./workflow.js";
import { VisualWorldWorkflowJournal, type VisualWorldWorkflowEvent } from "./lifecycle.js";

const timestamp = z.string().datetime({ offset: true });
const artifactReferenceSchema = z
  .object({
    locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/u),
    artifactHash: hashSchema,
    bytes: z.number().int().positive(),
  })
  .strict();

export const VISUAL_WORLD_DRAFT_SCHEMA = z
  .object({
    kind: z.literal("VisualWorldDraft"),
    id: entityId,
    hash: hashSchema,
    workflowId: entityId,
    projectId: z.string().min(1).max(256),
    draftRevision: z.number().int().positive().safe(),
    creatorRequestHash: hashSchema,
    declarationHash: hashSchema,
    declaration: BLENDER_SCENE_DECLARATION_SCHEMA,
    authority: BLENDER_SCENE_AUTHORITY_SCHEMA,
    retainedAt: timestamp,
  })
  .strict();
export type VisualWorldDraft = z.infer<typeof VISUAL_WORLD_DRAFT_SCHEMA>;

export interface VisualWorldDraftBinding {
  readonly draftId: string;
  readonly draftHash: string;
  readonly artifact: ArtifactReference;
}

export const VISUAL_WORLD_SOLVED_DRAFT_SCHEMA = z
  .object({
    kind: z.literal("VisualWorldSolvedDraft"),
    id: entityId,
    hash: hashSchema,
    workflowId: entityId,
    projectId: z.string().min(1).max(256),
    draftId: entityId,
    draftHash: hashSchema,
    draftArtifact: artifactReferenceSchema,
    scene: BLENDER_SCENE_HANDLE_SCHEMA,
    sceneRecordId: entityId,
    sceneRecordHash: hashSchema,
    sceneArtifact: artifactReferenceSchema,
    candidateCount: z.number().int().nonnegative().safe(),
    backtrackCount: z.number().int().nonnegative().safe(),
    solvedAt: timestamp,
  })
  .strict();
export type VisualWorldSolvedDraft = z.infer<typeof VISUAL_WORLD_SOLVED_DRAFT_SCHEMA>;

export interface VisualWorldSolvedDraftBinding {
  readonly solvedId: string;
  readonly solvedHash: string;
  readonly artifact: ArtifactReference;
}

export interface QualifiedVisualCompilerIdentity {
  readonly blenderVersion: "5.2.1";
  readonly blenderBinarySha256: string;
  readonly workerSha256: string;
  readonly inspectorSha256: string;
  readonly operationSetSha256: string;
  readonly exportProfileSha256: string;
}

/** Host-only authority derivation for procedural visual worlds. */
export function createProceduralSceneAuthority(input: {
  declaration: unknown;
  projectId: string;
  creatorRequestHash: string;
  referenceHashes: readonly string[];
  revision: number;
  compiler: QualifiedVisualCompilerIdentity;
}): BlenderSceneAuthority {
  const declaration = validateBlenderSceneDeclaration(input.declaration);
  if (
    declaration.geometries.some((geometry) => geometry.kind === "external_glb") ||
    declaration.materials.some((material) => material.textureIds.length > 0)
  )
    throw new Error(
      "External geometry and textures require a hash-verified host source catalog binding",
    );
  const referenceHashes = [...new Set(input.referenceHashes)].sort();
  if (
    referenceHashes.length !== input.referenceHashes.length ||
    referenceHashes.length > 4 ||
    referenceHashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash))
  )
    throw new Error("Visual reference bindings must be unique retained artifact hashes");
  const visualPartitions = declaration.partitions.filter(
    (partition) =>
      (partition.role === "WorldStatic" || partition.role === "InteractiveProps") &&
      (partition.objectIds.length > 0 ||
        declaration.instances.some((instance) => instance.partitionId === partition.id)),
  );
  const expectedOutputs: BlenderSceneAuthority["expectedOutputs"] = [
    { id: "forge-blend-source", kind: "blend", relativePath: "scene.blend" },
    ...visualPartitions.map((partition) => ({
      id: `forge-glb-${partition.id}`,
      kind: "glb" as const,
      partitionId: partition.id,
      relativePath: `glb/${partition.id}.glb`,
    })),
    {
      id: "forge-native-semantics",
      kind: "native_semantics",
      relativePath: "native-semantics.json",
    },
    {
      id: "forge-geometry-report",
      kind: "geometry_report",
      relativePath: "geometry-report.json",
    },
    {
      id: "forge-material-report",
      kind: "material_report",
      relativePath: "material-report.json",
    },
    {
      id: "forge-budget-report",
      kind: "budget_report",
      relativePath: "budget-report.json",
    },
    ...declaration.reviewViews.map((view) => ({
      id: `forge-render-${view.id}`,
      kind: "review_render" as const,
      viewId: view.id,
      relativePath: `renders/${view.id}.png`,
    })),
    { id: "forge-scene-manifest", kind: "manifest", relativePath: "scene-manifest.json" },
  ];
  return BLENDER_SCENE_AUTHORITY_SCHEMA.parse({
    revision: input.revision,
    projectId: input.projectId,
    creatorRequestHash: input.creatorRequestHash,
    visualBriefHash: contentHash(stableJson(declaration.visualBrief)),
    referenceHashes,
    compiler: {
      profile: BLENDER_COMPILER_PROFILE,
      ...input.compiler,
    },
    sources: [],
    textures: [],
    provenance: [
      {
        id: `forge-request-${input.creatorRequestHash.slice(0, 20)}`,
        authority: "creator",
        subjectId: declaration.sceneId,
        artifactHash: input.creatorRequestHash,
        statement: "Creator request retained by the Forge conversation authority.",
      },
    ],
    budgets: {
      maximumObjects: 8192,
      maximumExpandedInstances: 16_384,
      maximumTriangles: 2_000_000,
      maximumTrianglesPerMesh: 20_000,
      maximumMaterials: 256,
      maximumTextures: 256,
      maximumTexturePixels: 4096 * 4096,
      maximumGlbBytes: 20 * 1024 * 1024,
      maximumSolverCandidates: 250_000,
      maximumBacktracks: 50_000,
    },
    expectedOutputs,
  });
}

/**
 * Durable scene authoring for the ordinary creator control plane. Model input
 * is limited to BlenderSceneDeclaration. The caller must supply host-produced
 * authority separately; this class never copies authority fields out of a
 * model-authored document.
 */
export class VisualWorldAuthoringStore {
  readonly artifacts: ImmutableJsonArtifactStore;
  readonly scenes: RetainedBlenderSceneStore;
  readonly workflow: VisualWorldWorkflowJournal;

  constructor(root: string) {
    const resolved = resolve(root);
    this.artifacts = new ImmutableJsonArtifactStore(resolved);
    this.scenes = new RetainedBlenderSceneStore(this.artifacts);
    this.workflow = new VisualWorldWorkflowJournal(resolve(resolved, "visual-workflows-v2"));
  }

  async createDraft(input: {
    workflowId: string;
    projectId: string;
    actionInstanceId: string;
    creatorRequestHash: string;
    declaration: unknown;
    authority: BlenderSceneAuthority;
    retainedAt: string;
  }): Promise<{
    draft: VisualWorldDraft;
    binding: VisualWorldDraftBinding;
    event: VisualWorldWorkflowEvent;
  }> {
    const declaration = validateBlenderSceneDeclaration(input.declaration);
    const authority = BLENDER_SCENE_AUTHORITY_SCHEMA.parse(input.authority);
    if (
      authority.projectId !== input.projectId ||
      authority.creatorRequestHash !== input.creatorRequestHash ||
      declaration.sceneId.length === 0
    )
      throw new Error("Visual draft host authority does not bind the creator request and project");
    const draft = sealWorkflowArtifact(VISUAL_WORLD_DRAFT_SCHEMA, {
      kind: "VisualWorldDraft",
      workflowId: input.workflowId,
      projectId: input.projectId,
      draftRevision: 1,
      creatorRequestHash: input.creatorRequestHash,
      declarationHash: hashDeclaration(declaration),
      declaration,
      authority,
      retainedAt: input.retainedAt,
    });
    const binding = await this.retainDraft(draft);
    const event = await this.workflow.create({
      workflowId: input.workflowId,
      projectId: input.projectId,
      actionInstanceId: input.actionInstanceId,
      actor: "forge_host",
      artifacts: {
        creatorRequestHash: input.creatorRequestHash,
        sceneDeclarationHash: draft.hash,
      },
      detail: "Retained one bounded visual-world declaration with separate host authority.",
      occurredAt: input.retainedAt,
    });
    return { draft, binding, event };
  }

  async reviseDraft(input: {
    workflowId: string;
    expectedEventHash: string;
    actionInstanceId: string;
    prior: VisualWorldDraftBinding;
    declaration: unknown;
    authority: BlenderSceneAuthority;
    retainedAt: string;
  }): Promise<{
    draft: VisualWorldDraft;
    binding: VisualWorldDraftBinding;
    event: VisualWorldWorkflowEvent;
  }> {
    const prior = await this.readDraft(input.prior);
    if (prior.workflowId !== input.workflowId)
      throw new Error("Visual draft revision belongs to another workflow");
    const declaration = validateBlenderSceneDeclaration(input.declaration);
    const authority = BLENDER_SCENE_AUTHORITY_SCHEMA.parse(input.authority);
    if (
      authority.projectId !== prior.projectId ||
      authority.creatorRequestHash !== prior.creatorRequestHash ||
      declaration.sceneId !== prior.declaration.sceneId
    )
      throw new Error("Visual draft revision changed immutable creator or scene identity");
    const draft = sealWorkflowArtifact(VISUAL_WORLD_DRAFT_SCHEMA, {
      kind: "VisualWorldDraft",
      workflowId: prior.workflowId,
      projectId: prior.projectId,
      draftRevision: prior.draftRevision + 1,
      creatorRequestHash: prior.creatorRequestHash,
      declarationHash: hashDeclaration(declaration),
      declaration,
      authority,
      retainedAt: input.retainedAt,
    });
    const binding = await this.retainDraft(draft);
    const event = await this.workflow.advance({
      workflowId: input.workflowId,
      expectedEventHash: input.expectedEventHash,
      action: "revise_draft",
      actionInstanceId: input.actionInstanceId,
      actor: "forge_host",
      artifacts: { sceneDeclarationHash: draft.hash },
      detail: "Retained a new visual-world draft revision; the prior draft remains immutable.",
      occurredAt: input.retainedAt,
    });
    return { draft, binding, event };
  }

  async solveDraft(input: {
    workflowId: string;
    expectedEventHash: string;
    actionInstanceId: string;
    draft: VisualWorldDraftBinding;
    inspectedSources?: readonly InspectedSourceGeometry[];
    solvedAt: string;
  }): Promise<
    | {
        status: "eligible";
        solved: VisualWorldSolvedDraft;
        binding: VisualWorldSolvedDraftBinding;
        scene: RetainedBlenderSceneBinding;
        event: VisualWorldWorkflowEvent;
      }
    | {
        status: "rejected" | "incomplete";
        diagnostics: readonly { code: string; subject: string; detail: string }[];
      }
  > {
    const draft = await this.readDraft(input.draft);
    if (draft.workflowId !== input.workflowId)
      throw new Error("Visual solve draft belongs to another workflow");
    const intent = bindBlenderSceneIntent(draft.declaration, draft.authority);
    const result = solveBlenderScene(intent, input.inspectedSources ?? []);
    if (result.status !== "eligible") return result;
    const scene = await this.scenes.retain(result.spec, input.solvedAt);
    const solved = sealWorkflowArtifact(VISUAL_WORLD_SOLVED_DRAFT_SCHEMA, {
      kind: "VisualWorldSolvedDraft",
      workflowId: input.workflowId,
      projectId: draft.projectId,
      draftId: draft.id,
      draftHash: draft.hash,
      draftArtifact: input.draft.artifact,
      scene: scene.scene,
      sceneRecordId: scene.recordId,
      sceneRecordHash: scene.recordHash,
      sceneArtifact: scene.artifact,
      candidateCount: result.candidateCount,
      backtrackCount: result.backtrackCount,
      solvedAt: input.solvedAt,
    });
    const binding = {
      solvedId: solved.id,
      solvedHash: solved.hash,
      artifact: await this.artifacts.write(solved),
    };
    const event = await this.workflow.advance({
      workflowId: input.workflowId,
      expectedEventHash: input.expectedEventHash,
      action: "solve_draft",
      actionInstanceId: input.actionInstanceId,
      actor: "forge_host",
      artifacts: {
        sceneDeclarationHash: draft.hash,
        solvedSceneHash: scene.scene.hash,
        geometryAnalysisHash: result.spec.geometryAnalysis.hash,
      },
      detail: "Solved the retained declaration using the deterministic bounded spatial solver.",
      occurredAt: input.solvedAt,
    });
    return { status: "eligible", solved, binding, scene, event };
  }

  async propose(input: {
    workflowId: string;
    expectedEventHash: string;
    actionInstanceId: string;
    solved: VisualWorldSolvedDraftBinding;
    projectRevisionHash: string;
    agentRunId: string;
    agentRunHash: string;
    sourceConsultationHash: string;
    intendedImplementation: string;
    proposedAt: string;
  }): Promise<{
    proposal: CreatorVisualWorldProposal;
    artifact: ArtifactReference;
    event: VisualWorldWorkflowEvent;
  }> {
    const solved = await this.readSolved(input.solved);
    if (solved.workflowId !== input.workflowId)
      throw new Error("Solved scene belongs to another visual workflow");
    const draft = await this.readDraft({
      draftId: solved.draftId,
      draftHash: solved.draftHash,
      artifact: solved.draftArtifact,
    });
    const scene = await this.scenes.resolve(
      {
        scene: solved.scene,
        recordId: solved.sceneRecordId,
        recordHash: solved.sceneRecordHash,
        artifact: solved.sceneArtifact,
      },
      solved.scene,
    );
    const proposal = sealWorkflowArtifact(CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA, {
      kind: "CreatorVisualWorldProposal",
      projectId: solved.projectId,
      projectRevisionHash: input.projectRevisionHash,
      creatorRequestHash: draft.creatorRequestHash,
      referenceHashes: scene.referenceHashes,
      agentRunId: input.agentRunId,
      agentRunHash: input.agentRunHash,
      semanticDesignHash: draft.declarationHash,
      solvedScene: solved.scene,
      sourceConsultationHash: input.sourceConsultationHash,
      intendedImplementation: input.intendedImplementation,
      proposedAt: input.proposedAt,
    });
    const artifact = await this.artifacts.write(proposal);
    const event = await this.workflow.advance({
      workflowId: input.workflowId,
      expectedEventHash: input.expectedEventHash,
      action: "propose",
      actionInstanceId: input.actionInstanceId,
      actor: "forge_host",
      artifacts: {
        proposalHash: proposal.hash,
        solvedSceneHash: solved.scene.hash,
        agentRunHash: input.agentRunHash,
        sourceConsultationHash: input.sourceConsultationHash,
      },
      detail: "Published a visual-world proposal bound to the actual planner run and solved scene.",
      occurredAt: input.proposedAt,
    });
    return { proposal, artifact, event };
  }

  async readDraft(binding: VisualWorldDraftBinding): Promise<VisualWorldDraft> {
    assertArtifactReference(binding.artifact);
    const draft = await this.artifacts.read<VisualWorldDraft>(binding.artifact, (value) =>
      assertSealedWorkflowArtifact(VISUAL_WORLD_DRAFT_SCHEMA, value),
    );
    if (draft.id !== binding.draftId || draft.hash !== binding.draftHash)
      throw new Error("Visual draft artifact binding mismatch");
    return draft;
  }

  async readSolved(binding: VisualWorldSolvedDraftBinding): Promise<VisualWorldSolvedDraft> {
    assertArtifactReference(binding.artifact);
    const solved = await this.artifacts.read<VisualWorldSolvedDraft>(binding.artifact, (value) =>
      assertSealedWorkflowArtifact(VISUAL_WORLD_SOLVED_DRAFT_SCHEMA, value),
    );
    if (solved.id !== binding.solvedId || solved.hash !== binding.solvedHash)
      throw new Error("Solved visual draft artifact binding mismatch");
    return solved;
  }

  private async retainDraft(draft: VisualWorldDraft): Promise<VisualWorldDraftBinding> {
    return {
      draftId: draft.id,
      draftHash: draft.hash,
      artifact: await this.artifacts.write(draft),
    };
  }
}

function hashDeclaration(declaration: BlenderSceneDeclaration): string {
  return contentHash(stableJson(declaration));
}
