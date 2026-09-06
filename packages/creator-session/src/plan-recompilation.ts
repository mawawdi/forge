import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { assertArtifactReference, type ArtifactReference } from "../../artifact-store/src/index.js";
import {
  compileGamePlan,
  expandGameDesign,
  gameGeneratedTarget,
  DEFAULT_GAME_COMPILER_POLICY,
  type GamePlan,
} from "../../game-compiler/src/index.js";
import {
  assertStudioProjectIndexCapture,
  studioObjectIdentityKey,
  studioProjectIndexMetadataView,
  projectIndexHash,
  projectIndexMaterial,
  type StudioProjectIndexCapture,
  type StudioObjectIdentity,
} from "../../studio-evidence/src/index.js";
import {
  assertCreatorSourceConsultation,
  type CreatorSourceConsultation,
  type StudioSourceIndex,
} from "../../source-intelligence/src/index.js";
import {
  assertCreatorPlan,
  assertCreatorSession,
  createCreatorPlan,
  prepareCreatorBuildPlan,
  type CreatorPlan,
  type CreatorSession,
  type StudioOwnershipMap,
  type VerificationCharterProposalClause,
} from "./index.js";
import type { CreatorGameCatalog } from "./game-authoring.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";

export interface CreatorPlanObservedAdditions {
  /** Complete comparison facts; afterCaptureHash separately binds native identity handles. */
  nodes: {
    root: string;
    path: string;
    className: string;
    nodeHash: string;
    canonicalFacts: string;
  }[];
  attributes: { path: string; name: string; valueHash: string; canonicalValue: string }[];
}

export interface CreatorPlanRecompilation {
  kind: "CreatorPlanRecompilation";
  id: string;
  hash: string;
  sessionId: string;
  planId: string;
  planHash: string;
  predecessor: { sessionId: string; planId: string; planHash: string; plan: ArtifactReference };
  beforeCaptureHash: string;
  afterCaptureHash: string;
  additions: CreatorPlanObservedAdditions;
  retention: {
    beforeObservationHash: string;
    afterObservationHash: string;
    designHash: string;
    inventoryHash: string;
    charterHash: string;
    stepsHash: string;
    compilerAbi: string;
    manifestHash: string;
    identityComparison: "unique_paths_for_ephemeral_observations_only";
  };
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const schema = z
  .object({
    kind: z.literal("CreatorPlanRecompilation"),
    id,
    hash,
    sessionId: id,
    planId: id,
    planHash: hash,
    predecessor: z
      .object({ sessionId: id, planId: id, planHash: hash, plan: z.unknown() })
      .strict(),
    beforeCaptureHash: hash,
    afterCaptureHash: hash,
    additions: z
      .object({
        nodes: z.array(
          z
            .object({ root: id, path: id, className: id, nodeHash: hash, canonicalFacts: id })
            .strict(),
        ),
        attributes: z.array(
          z.object({ path: id, name: id, valueHash: hash, canonicalValue: id }).strict(),
        ),
      })
      .strict(),
    retention: z
      .object({
        beforeObservationHash: hash,
        afterObservationHash: hash,
        designHash: hash,
        inventoryHash: hash,
        charterHash: hash,
        stepsHash: hash,
        compilerAbi: id,
        manifestHash: hash,
        identityComparison: z.literal("unique_paths_for_ephemeral_observations_only"),
      })
      .strict(),
  })
  .strict();
export function assertCreatorPlanRecompilation(
  value: unknown,
): asserts value is CreatorPlanRecompilation {
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumStringUtf8Bytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
  });
  schema.parse(value);
  const record = value as unknown as CreatorPlanRecompilation;
  assertArtifactReference(record.predecessor.plan);
  const nodes = record.additions.nodes;
  const attributes = record.additions.attributes;
  for (const node of nodes)
    if (node.nodeHash !== contentHash(node.canonicalFacts))
      throw new Error("Recompilation added-node facts hash mismatch");
  for (const attribute of attributes)
    if (attribute.valueHash !== contentHash(attribute.canonicalValue))
      throw new Error("Recompilation added-attribute value hash mismatch");
  if (
    new Set(nodes.map((node) => node.path)).size !== nodes.length ||
    new Set(attributes.map((attribute) => stableJson([attribute.path, attribute.name]))).size !==
      attributes.length ||
    stableJson(nodes) !== stableJson([...nodes].sort((a, b) => compareText(a.path, b.path))) ||
    stableJson(attributes) !==
      stableJson(
        [...attributes].sort((a, b) => compareText(a.path, b.path) || compareText(a.name, b.name)),
      )
  )
    throw new Error("Recompilation additions must be exact, unique and canonically ordered");
  const { id: identifier, hash: digest, ...payload } = record;
  const expected = contentHash(stableJson(payload));
  if (digest !== expected || identifier !== "creator_plan_recompilation_" + expected.slice(0, 24))
    throw new Error("Invalid CreatorPlanRecompilation identity");
  if (
    record.sessionId === record.predecessor.sessionId ||
    record.planHash === record.predecessor.planHash
  )
    throw new Error("Recompilation requires a new session and newly reviewable plan identity");
}

/** Concise review copy; the attached receipt retains every exact added fact. */
export function creatorRecompilationReviewSummary(record: CreatorPlanRecompilation): string {
  assertCreatorPlanRecompilation(record);
  const labels = (values: readonly string[]): string => {
    const visible = values.slice(0, 6).map((value) => {
      const characters = Array.from(value);
      return characters.length > 160 ? characters.slice(0, 160).join("") + "…" : value;
    });
    return (
      visible.join(", ") +
      (values.length > visible.length ? `, and ${values.length - visible.length} more` : "")
    );
  };
  const { nodes, attributes } = record.additions;
  const additions = [
    ...(nodes.length
      ? [
          `${nodes.length} added ${nodes.length === 1 ? "object" : "objects"}: ${labels(nodes.map((node) => node.path))}`,
        ]
      : []),
    ...(attributes.length
      ? [
          `${attributes.length} added ${attributes.length === 1 ? "attribute" : "attributes"}: ${labels(attributes.map((attribute) => attribute.path + "." + attribute.name))}`,
        ]
      : []),
  ];
  return (
    "The retained design was recompiled against the refreshed project observations." +
    (additions.length
      ? ` Review the captured additions alongside this plan — ${additions.join("; ")}. The attached recompilation evidence contains every exact added fact.`
      : "")
  );
}

/** Comparison material only. These path markers must never become Studio identity/parent authority. */
export function creatorRecompilationObservationHash(capture: StudioProjectIndexCapture): string {
  return projectIndexHash(recompilationObservation(capture));
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function recompilationObservation(capture: StudioProjectIndexCapture) {
  assertStudioProjectIndexCapture(capture);
  const nodes = capture.shards.flatMap((shard) =>
    shard.nodes.map((node) => ({ root: shard.root, node })),
  );
  const paths = new Set<string>();
  const identities = new Map<string, string>();
  for (const { node } of nodes) {
    if (paths.has(node.displayPath))
      throw new Error("Recompilation cannot compare duplicate observed paths");
    paths.add(node.displayPath);
    identities.set(studioObjectIdentityKey(node.identity), node.displayPath);
  }
  const identity = (value: StudioObjectIdentity): unknown => {
    if (value.kind !== "studio_ephemeral") return value;
    const path = identities.get(studioObjectIdentityKey(value));
    if (!path) throw new Error("Recompilation cannot compare an unresolved ephemeral reference");
    return { kind: "ephemeral_comparison_path", path };
  };
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      if ((value as { kind?: unknown }).kind === "studio_ephemeral")
        return identity(value as StudioObjectIdentity);
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  const sources = new Map(
    capture.sourceManifests.map((source) => {
      const { id: _id, hash: _hash, ...facts } = source;
      return [source.hash, normalize(facts)] as const;
    }),
  );
  return {
    projection: {
      manifestHash: capture.projection.manifestHash,
      project: capture.projection.project,
      purpose: capture.projection.purpose,
      roots: capture.projection.roots,
      bounds: capture.projection.bounds,
    },
    nodes: nodes
      .sort((a, b) =>
        Buffer.compare(Buffer.from(a.node.displayPath), Buffer.from(b.node.displayPath)),
      )
      .map(({ root, node }) => ({
        root,
        node: normalize({
          ...node,
          ...(node.sourceManifestHash === undefined
            ? {}
            : { sourceManifestHash: projectIndexHash(sources.get(node.sourceManifestHash)) }),
        }) as Record<string, unknown> & {
          displayPath: string;
          className: string;
          attributes: Record<string, unknown>;
          coveredProperties: Record<string, unknown>;
          sourceManifestHash?: string;
        },
      })),
    sources: [...sources.values()]
      .map((value) => ({ value, key: Buffer.from(projectIndexMaterial(value)) }))
      .sort((a, b) => Buffer.compare(a.key, b.key))
      .map(({ value }) => value),
    chunks: capture.sourceChunks,
  };
}

function retainedObservations(
  beforeCapture: StudioProjectIndexCapture,
  afterCapture: StudioProjectIndexCapture,
) {
  const before = recompilationObservation(beforeCapture);
  const after = recompilationObservation(afterCapture);
  const beforeRest = {
    projection: before.projection,
    sources: before.sources,
    chunks: before.chunks,
  };
  const afterRest = { projection: after.projection, sources: after.sources, chunks: after.chunks };
  if (projectIndexMaterial(beforeRest) !== projectIndexMaterial(afterRest))
    throw new Error(
      "Recompilation requires retained complete observed source and projection facts",
    );
  const afterNodes = new Map(after.nodes.map((entry) => [entry.node.displayPath, entry]));
  const beforePaths = new Set(before.nodes.map((entry) => entry.node.displayPath));
  const additions: CreatorPlanObservedAdditions = { nodes: [], attributes: [] };
  for (const prior of before.nodes) {
    const next = afterNodes.get(prior.node.displayPath);
    if (!next)
      throw new Error("Recompilation cannot retain a plan after observed nodes were removed");
    const { attributes: priorAttributes, ...priorFacts } = prior.node;
    const { attributes: nextAttributes, ...nextFacts } = next.node;
    if (
      prior.root !== next.root ||
      projectIndexMaterial(priorFacts) !== projectIndexMaterial(nextFacts)
    )
      throw new Error(
        "Recompilation requires every prior node, property, tag, source and reference fact to remain exact",
      );
    for (const [name, value] of Object.entries(priorAttributes)) {
      if (
        !Object.hasOwn(nextAttributes, name) ||
        projectIndexMaterial(value) !== projectIndexMaterial(nextAttributes[name])
      )
        throw new Error(
          "Recompilation cannot retain a plan after observed attributes changed or were removed",
        );
    }
    for (const [name, value] of Object.entries(nextAttributes)) {
      if (Object.hasOwn(priorAttributes, name)) continue;
      const canonicalValue = projectIndexMaterial(value);
      additions.attributes.push({
        path: next.node.displayPath,
        name,
        valueHash: contentHash(canonicalValue),
        canonicalValue,
      });
    }
  }
  for (const entry of after.nodes) {
    if (beforePaths.has(entry.node.displayPath)) continue;
    if (
      entry.node.sourceManifestHash !== undefined ||
      ["Script", "LocalScript", "ModuleScript"].includes(entry.node.className)
    )
      throw new Error("Recompilation cannot retain a plan after new observed sources were added");
    if (
      Object.values(entry.node.coveredProperties).some(
        (value) =>
          value &&
          typeof value === "object" &&
          (value as { kind?: unknown }).kind === "instance_ref" &&
          (value as { state?: unknown }).state === "reference",
      )
    )
      throw new Error(
        "Recompilation cannot retain a plan after new observed property references were added",
      );
    const canonicalFacts = projectIndexMaterial(entry);
    additions.nodes.push({
      root: entry.root,
      path: entry.node.displayPath,
      className: entry.node.className,
      nodeHash: contentHash(canonicalFacts),
      canonicalFacts,
    });
  }
  additions.nodes.sort((a, b) => compareText(a.path, b.path));
  additions.attributes.sort((a, b) => compareText(a.path, b.path) || compareText(a.name, b.name));
  return {
    beforeObservationHash: projectIndexHash(before),
    afterObservationHash: projectIndexHash(after),
    additions,
  };
}

function assertIndependentCreates(plan: GamePlan): void {
  if (
    plan.observedSources.length > 0 ||
    plan.inventory.some((item) => item.change.kind !== "create")
  )
    throw new Error("Recompilation requires a pure create graph without observed source imports");
  for (const component of plan.design.components) {
    if (component.kind !== "source_package") continue;
    if (
      component.files.some(
        (file) => file.placement?.kind !== "create" || file.placement.parent.kind === "instance",
      )
    )
      throw new Error("Recompilation cannot reuse observed source or instance placement bindings");
  }
  const generated = new Map(
    plan.inventory.map((item) => {
      if (item.change.kind !== "create") throw new Error("Expected create");
      const target = gameGeneratedTarget({
        projectId: plan.projectId,
        operationId: item.id,
        path: item.change.path,
        className: item.change.className,
      });
      return [studioObjectIdentityKey(target.identity), target] as const;
    }),
  );
  for (const item of plan.inventory) {
    if (item.change.kind !== "create") throw new Error("Expected create");
    const parent = item.change.parent;
    if (
      parent.kind === "instance" &&
      stableJson(generated.get(studioObjectIdentityKey(parent.identity))) !== stableJson(parent)
    )
      throw new Error("Recompilation cannot reuse observed instance parents");
    for (const value of Object.values(item.lockedProperties)) {
      if (value.kind === "instance_ref" && value.state === "reference") {
        const target = generated.get(studioObjectIdentityKey(value.identity));
        if (!target || target.path !== value.path || target.className !== value.className)
          throw new Error("Recompilation cannot reuse observed instance references");
      }
    }
  }
}

/** Recompile existing intent for a NEW creator review. This performs no provider or Studio work. */
export function recompileRetainedCreatorPlan(input: {
  previousPlan: CreatorPlan;
  predecessorPlan: ArtifactReference;
  beforeCapture: StudioProjectIndexCapture;
  afterCapture: StudioProjectIndexCapture;
  session: CreatorSession;
  ownership: StudioOwnershipMap;
  sourceIndex: StudioSourceIndex;
  sourceConsultation: CreatorSourceConsultation;
  creatorPrompt: string;
  catalog: CreatorGameCatalog;
}): { plan: CreatorPlan; recompilation: CreatorPlanRecompilation } {
  const prior = input.previousPlan;
  assertCreatorPlan(prior);
  assertCreatorSession(input.session);
  assertArtifactReference(input.predecessorPlan);
  const predecessorBytes = stableJson(prior) + "\n";
  if (
    input.predecessorPlan.artifactHash !== contentHash(predecessorBytes) ||
    input.predecessorPlan.bytes !== Buffer.byteLength(predecessorBytes)
  )
    throw new Error("Recompilation predecessor artifact does not seal the exact retained plan");
  if (
    prior.projectId !== input.session.projectId ||
    prior.promptHash !== input.session.promptHash ||
    contentHash(input.creatorPrompt) !== prior.promptHash ||
    prior.projectRevisionHash !== input.beforeCapture.revision.hash ||
    prior.projectCaptureHash !== input.beforeCapture.hash ||
    input.session.currentRevisionHash !== input.afterCapture.revision.hash ||
    input.session.currentProjectCaptureHash !== input.afterCapture.hash ||
    input.session.id === prior.sessionId
  )
    throw new Error("Recompilation session, prompt or capture bindings differ");
  if (
    !["indexing", "planning"].includes(input.session.status) ||
    input.session.plan ||
    input.session.planApproval ||
    input.session.changeSet ||
    input.session.changeApproval ||
    input.session.checkpoint ||
    input.session.review ||
    input.session.failure ||
    input.session.repairsUsed !== 0 ||
    input.session.initialRevisionHash !== input.session.currentRevisionHash ||
    input.session.initialProjectCaptureHash !== input.session.currentProjectCaptureHash ||
    input.session.ownershipMapId !== input.ownership.id ||
    input.session.ownershipMapHash !== input.ownership.hash
  )
    throw new Error(
      "Recompilation requires a fresh session without retained execution or approval authority",
    );
  assertIndependentCreates(prior.compiled);
  const observations = retainedObservations(input.beforeCapture, input.afterCapture);
  assertCreatorSourceConsultation(input.sourceConsultation, input.sourceIndex);
  if (input.sourceConsultation.operations.length > 0)
    throw new Error("Fresh recompilation consultation must not claim model inspections");
  const observation = studioProjectIndexMetadataView(input.afterCapture);
  for (const component of prior.compiled.design.components)
    input.catalog.validateComponent?.(component);
  const compilerInput = {
    design: prior.compiled.design,
    registry: input.catalog.registry,
    projectId: input.session.projectId,
    project: observation.project,
    initialTopology: observation.instances,
    observation,
    recipeExpanders: input.catalog.expanders,
  };
  const expanded = expandGameDesign(compilerInput);
  const compiled = compileGamePlan({
    ...compilerInput,
    design: expanded.design,
    inventory: expanded.inventory,
    observedSources: expanded.observedSources,
    sessionId: input.session.id,
    observedRevisionHash: input.session.currentRevisionHash,
    policy: DEFAULT_GAME_COMPILER_POLICY,
  });
  assertIndependentCreates(compiled);
  for (const item of compiled.inventory) {
    if (item.source?.content.kind !== "locked") continue;
    const locked = item.source.content;
    const source = input.catalog.lockedSources.get(locked.sourceHash);
    if (
      source === undefined ||
      contentHash(source) !== locked.sourceHash ||
      Buffer.byteLength(source) !== locked.utf8Bytes
    )
      throw new Error("Recompilation requires the exact installed bytes for every locked source");
  }
  if (
    stableJson(compiled.design) !== stableJson(prior.compiled.design) ||
    stableJson(compiled.inventory) !== stableJson(prior.compiled.inventory) ||
    stableJson(compiled.policy) !== stableJson(prior.compiled.policy) ||
    compiled.compilerAbi !== prior.compiled.compilerAbi ||
    compiled.manifestHash !== prior.compiled.manifestHash
  )
    throw new Error(
      "Recompilation changed the exact design, inventory, slots or locked compiler authority",
    );
  const createdPaths = new Set(
    compiled.inventory.map((item) => (item.change.kind === "create" ? item.change.path : "")),
  );
  const clauses: VerificationCharterProposalClause[] = prior.charter.clauses.map((clause) => {
    if (clause.kind === "creator_review") return clause;
    if (clause.kind === "snapshot_check" || ("path" in clause && !createdPaths.has(clause.path)))
      throw new Error("Recompilation cannot carry observed-target verification authority");
    const { statement: _statement, ...proposal } = clause;
    return proposal;
  });
  const plan = createCreatorPlan(
    {
      sessionId: input.session.id,
      promptHash: input.session.promptHash,
      creatorPrompt: input.creatorPrompt,
      projectRevisionHash: input.session.currentRevisionHash,
      projectCaptureHash: input.afterCapture.hash,
      ownershipMapId: input.ownership.id,
      ownershipMapHash: input.ownership.hash,
      sourceIndex: input.sourceIndex,
      sourceConsultation: input.sourceConsultation,
      compiled,
      changes: compiled.inventory.map((item) => item.change),
      inspectionPaths: prior.inspectionPaths,
      steps: prior.steps,
      charter: { clauses },
    },
    observation,
    input.ownership,
  );
  if (
    stableJson(plan.charter) !== stableJson(prior.charter) ||
    stableJson(plan.steps) !== stableJson(prior.steps)
  )
    throw new Error("Recompilation changed creator-visible verification or semantic steps");
  prepareCreatorBuildPlan(plan, observation);
  const payload = {
    kind: "CreatorPlanRecompilation" as const,
    sessionId: input.session.id,
    planId: plan.id,
    planHash: plan.hash,
    predecessor: {
      sessionId: prior.sessionId,
      planId: prior.id,
      planHash: prior.hash,
      plan: input.predecessorPlan,
    },
    beforeCaptureHash: input.beforeCapture.hash,
    afterCaptureHash: input.afterCapture.hash,
    additions: observations.additions,
    retention: {
      beforeObservationHash: observations.beforeObservationHash,
      afterObservationHash: observations.afterObservationHash,
      designHash: compiled.designHash,
      inventoryHash: contentHash(stableJson(compiled.inventory)),
      charterHash: plan.charter.hash,
      stepsHash: contentHash(stableJson(plan.steps)),
      compilerAbi: compiled.compilerAbi,
      manifestHash: compiled.manifestHash,
      identityComparison: "unique_paths_for_ephemeral_observations_only" as const,
    },
  };
  const digest = contentHash(stableJson(payload));
  const recompilation = {
    ...payload,
    id: "creator_plan_recompilation_" + digest.slice(0, 24),
    hash: digest,
  };
  assertCreatorPlanRecompilation(recompilation);
  return { plan, recompilation };
}
