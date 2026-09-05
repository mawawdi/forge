import {
  STUDIO_CAPABILITY_MANIFEST,
  assertEvidenceAgainstProjection,
  assertStudioCapabilityManifest,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceProjection,
  assertStudioValue,
  compileMutationEvidenceProjection,
  compileMutationEvidenceProjectionForManifest,
  derivedStudioMutationPropertyNames,
  isStudioCreatorMutationBinding,
  matchesStudioCreatorMutationBinding,
  studioValuesEqual,
  type MutationEvidenceOperation,
  type MutationEvidenceProjectionInput,
  type StudioCapabilityManifest,
  type StudioCreatorMutationBinding,
  type StudioEvidenceBinding,
  type StudioEvidenceEnvelope,
  type StudioEvidenceFact,
  type StudioEvidenceProjection,
  type StudioEvidenceTarget,
  type StudioProjectIdentity,
  type StudioRequirementValue,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import {
  assertStudioProjectIndexCapture,
  studioObjectIdentityKey,
  type StudioProjectIndexCapture,
  type StudioProjectIndexNode,
  type StudioIdentityEnrollment,
} from "../../studio-evidence/src/project-index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  creatorProjectIndexArtifactReferences,
  readCreatorProjectIndexArtifacts,
  type CreatorProjectIndexArtifactBinding,
} from "./project-refresh.js";
import {
  assertCreatorTransactionTopologyOrder,
  compileCreatorTransactionTopology,
  type CreatorTransactionTopologyNode,
} from "./transaction-topology.js";
import type { CreatorSourceEdit, CreatorSourceWriteBlobBinding } from "./index.js";

/**
 * The small sealed-change-set surface needed to derive readback projections.
 * This deliberately avoids coupling replay to the coordinator runtime.
 */
export interface CreatorMutationSealedChangeSet {
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly expectedRevisionHash: string;
  readonly buildContractHash: string;
  readonly operations: readonly CreatorMutationStudioOperation[];
}

export type CreatorMutationStudioOperation =
  | {
      readonly id: string;
      readonly kind: "create";
      readonly target: StudioInstanceEvidenceTarget;
      readonly parent: CreatorMutationParent;
      readonly className: string;
      readonly name: string;
      readonly properties: Readonly<Record<string, StudioValue>>;
      readonly attributes: Readonly<Record<string, string | number | boolean>>;
      readonly sourceBlob?: CreatorSourceWriteBlobBinding;
    }
  | {
      readonly id: string;
      readonly kind: "update";
      readonly target: StudioInstanceEvidenceTarget;
      readonly enrollment?: StudioIdentityEnrollment;
      readonly properties: Readonly<Record<string, StudioValue>>;
      readonly attributes: Readonly<Record<string, string | number | boolean>>;
      readonly removedAttributes: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "move";
      readonly target: StudioInstanceEvidenceTarget;
      readonly enrollment?: StudioIdentityEnrollment;
      readonly parent: CreatorMutationParent;
      readonly name: string;
      readonly properties: Readonly<Record<string, StudioValue>>;
      readonly attributes: Readonly<Record<string, string | number | boolean>>;
      readonly removedAttributes: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "delete";
      readonly target: StudioInstanceEvidenceTarget;
      readonly enrollment?: StudioIdentityEnrollment;
    }
  | {
      readonly id: string;
      readonly kind: "edit_source";
      readonly target: StudioInstanceEvidenceTarget;
      readonly enrollment?: StudioIdentityEnrollment;
      readonly beforeSourceHash: string;
      readonly edits: readonly CreatorSourceEdit[];
      readonly finalSourceHash: string;
      readonly finalByteCount: number;
    };

type CreatorMutationParent =
  | StudioInstanceEvidenceTarget
  | {
      readonly kind: "engine_container";
      readonly path: string;
      readonly className: string;
    };

/** The only statuses a mutation reconciler can produce. */
export type CreatorMutationReconciliationStatus = "matched" | "mismatched" | "incomplete";

export interface CreatorMutationFailureFact {
  readonly code: string;
  readonly detail: string;
  readonly hash: string;
}

export type CreatorMutationFailureInput =
  string | { readonly code: string; readonly detail: string };

/**
 * The mutation's direct-readback contract. Project-wide change authority is
 * derived from `operations` during reconciliation; it is never supplied as a
 * project-state fact-key allowlist.
 */
export interface CreatorMutationChangeSetLike {
  readonly kind: "CreatorChangeSet";
  readonly id: string;
  readonly hash: string;
  readonly project: StudioEvidenceProjection["project"];
  readonly binding: StudioEvidenceBinding;
  readonly projectionId: string;
  readonly operations: readonly MutationEvidenceOperation[];
}

export type StudioInstanceEvidenceTarget = Extract<
  StudioEvidenceTarget,
  { readonly kind: "instance" }
>;

export interface CreatorChangeSetDeleteSubtree {
  readonly operationId: string;
  readonly descendants: readonly StudioInstanceEvidenceTarget[];
}

/**
 * An engine-container parent is named by the approved change set but its
 * actual identity comes only from the immutable pre-Apply index. Carry that
 * exact captured target into the projection so structure readback has the
 * same shape as StudioEvidenceCollector's observed fact.
 */
export interface CreatorChangeSetStructuralParent {
  readonly operationId: string;
  readonly target: StudioInstanceEvidenceTarget;
}

export interface CreatorChangeSetProjectionContext {
  readonly project: StudioProjectIdentity;
  readonly binding: StudioEvidenceBinding;
  /** Complete pre-Prepare topology; final paths derive only from this authority. */
  readonly initialTopology: readonly CreatorTransactionTopologyNode[];
  readonly purpose?: MutationEvidenceProjectionInput["purpose"];
  readonly projectionId?: string;
  readonly deletedSubtrees?: readonly CreatorChangeSetDeleteSubtree[];
  readonly structuralParents?: readonly CreatorChangeSetStructuralParent[];
}

/**
 * Resolve every engine-owned create/move parent to its exact identity from the
 * immutable pre-Apply index. Instance parents already carry their identity in
 * the sealed operation, so they require no additional projection input.
 */
export function creatorStructuralParentsFromProjectIndex(
  changeSet: CreatorMutationSealedChangeSet,
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): readonly CreatorChangeSetStructuralParent[] {
  assertStudioCapabilityManifest(manifest);
  assertStudioProjectIndexCapture(capture, manifest);
  const authoringContainers = new Map(
    manifest.authoringContainers.map((entry) => [entry.path, entry.className] as const),
  );
  const engineContainers = new Map<string, StudioProjectIndexNode>();
  for (const node of capture.shards.flatMap((shard) => shard.nodes)) {
    if (!node.engineContainer) continue;
    if (authoringContainers.get(node.engineContainer.path) !== node.engineContainer.className)
      throw new Error("Project index engine container is outside the Studio capability manifest");
    if (node.className !== node.engineContainer.className)
      throw new Error("Project index engine container class is inconsistent");
    const key = `${node.engineContainer.path}\u0000${node.engineContainer.className}`;
    if (engineContainers.has(key)) throw new Error("Project index has duplicate engine containers");
    engineContainers.set(key, node);
  }
  const structuralParents: CreatorChangeSetStructuralParent[] = [];
  for (const operation of changeSet.operations) {
    if (
      (operation.kind !== "create" && operation.kind !== "move") ||
      operation.parent.kind !== "engine_container"
    )
      continue;
    if (authoringContainers.get(operation.parent.path) !== operation.parent.className)
      throw new Error("Approved engine parent is not an exact generated authoring container");
    const parent = engineContainers.get(
      `${operation.parent.path}\u0000${operation.parent.className}`,
    );
    if (!parent) throw new Error("Approved engine parent is missing from the bound project index");
    structuralParents.push({
      operationId: operation.id,
      target: {
        kind: "instance",
        identity: parent.identity,
        path: parent.displayPath,
        className: parent.className,
      },
    });
  }
  return Object.freeze(structuralParents);
}

/**
 * Derive every consequentially deleted identity from opaque project-index
 * parent edges. Display paths are descriptive only and duplicate-named
 * objects remain distinct. Unsupported descendant classes receive only a
 * structural-absence proof obligation; they never gain a writable surface.
 */
export function creatorDeleteSubtreesFromProjectIndex(
  changeSet: CreatorMutationSealedChangeSet,
  capture: StudioProjectIndexCapture,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): readonly CreatorChangeSetDeleteSubtree[] {
  assertStudioCapabilityManifest(manifest);
  assertStudioProjectIndexCapture(capture, manifest);
  const nodes = capture.shards.flatMap((shard) => shard.nodes);
  const byIdentity = new Map(
    nodes.map((node) => [studioObjectIdentityKey(node.identity), node] as const),
  );
  const children = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!node.parentIdentity) continue;
    const parentKey = studioObjectIdentityKey(node.parentIdentity);
    children.set(parentKey, [...(children.get(parentKey) ?? []), node]);
  }
  const authorableClasses = new Set(manifest.classes.map((entry) => entry.name));
  // The final path of a create or move can depend on another move in this
  // same recording. Validate the complete graph once rather than comparing
  // individual operations against stale pre-transaction display paths. Its
  // delete closure is also authoritative: an initially nested subtree may be
  // moved out before its former ancestor is destroyed.
  const topology = compileCreatorTransactionTopology({
    initial: nodes.map((node) => ({
      identity: node.identity,
      ...(node.parentIdentity === undefined ? {} : { parentIdentity: node.parentIdentity }),
      path: node.displayPath,
      name: node.name,
      className: node.className,
      ...(node.engineContainer === undefined ? {} : { engineContainer: node.engineContainer }),
      properties: node.coveredProperties as Readonly<Record<string, StudioValue>>,
    })),
    operations: changeSet.operations,
  });
  const deletedIdentityKeys = new Set(topology.deletedIdentityKeys);
  for (const operation of changeSet.operations) {
    if (!authorableClasses.has(operation.target.className))
      throw new Error("Approved mutation target is outside the Studio capability manifest");
    if (operation.kind === "create" && operation.target.className !== operation.className)
      throw new Error("Approved create target class is inconsistent");
  }
  const result: CreatorChangeSetDeleteSubtree[] = [];
  for (const operation of changeSet.operations) {
    if (operation.kind !== "delete") continue;
    const rootKey = studioObjectIdentityKey(operation.target.identity);
    const root = byIdentity.get(rootKey);
    if (
      !root ||
      root.displayPath !== operation.target.path ||
      root.className !== operation.target.className
    )
      throw new Error("Approved delete target is missing from the bound project index");
    if (!authorableClasses.has(root.className))
      throw new Error("Approved delete target is outside the Studio capability manifest");
    const descendants: CreatorChangeSetDeleteSubtree["descendants"][number][] = [];
    const queue = [...(children.get(rootKey) ?? [])];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      const nodeKey = studioObjectIdentityKey(node.identity);
      if (visited.has(nodeKey)) throw new Error("Project index contains a cyclic delete subtree");
      visited.add(nodeKey);
      if (deletedIdentityKeys.has(nodeKey))
        descendants.push({
          kind: "instance",
          identity: node.identity,
          path: node.displayPath,
          className: node.className,
        });
      queue.push(...(children.get(nodeKey) ?? []));
    }
    descendants.sort((left, right) =>
      studioObjectIdentityKey(left.identity).localeCompare(studioObjectIdentityKey(right.identity)),
    );
    result.push({ operationId: operation.id, descendants });
  }
  return Object.freeze(result);
}

export function creatorChangeSetMutationProjectionId(
  changeSet: Pick<CreatorMutationSealedChangeSet, "hash">,
  purpose: NonNullable<MutationEvidenceProjectionInput["purpose"]> = "mutation_direct_readback",
): string {
  if (!isHash(changeSet.hash))
    throw new Error("Creator mutation projection requires a sealed change-set hash");
  return `creator_mutation_${purpose}_${changeSet.hash.slice(0, 24)}`;
}

/** Convert sealed Studio operations to direct-readback evidence operations. */
export function adaptCreatorChangeSetMutationOperations(
  changeSet: CreatorMutationSealedChangeSet,
  initialTopology: readonly CreatorTransactionTopologyNode[],
  deletedSubtrees: readonly CreatorChangeSetDeleteSubtree[] = [],
  structuralParents: readonly CreatorChangeSetStructuralParent[] = [],
): readonly MutationEvidenceOperation[] {
  // Identity enrollment is a transaction-wide post-state transition, not an
  // operation-local presentation detail. Build it before deriving any proof
  // obligation so a property or structural edge can refer to another object
  // enrolled by this same recording.
  const postStateTargets = collectPostStateTargets(changeSet.operations, initialTopology);
  const subtreeByOperation = new Map<string, readonly StudioInstanceEvidenceTarget[]>();
  const deleteOperationIds = new Set(
    changeSet.operations
      .filter((operation) => operation.kind === "delete")
      .map((operation) => operation.id),
  );
  for (const subtree of deletedSubtrees) {
    if (!isNonEmpty(subtree.operationId) || subtreeByOperation.has(subtree.operationId))
      throw new Error("Deleted subtree entries must have unique operation IDs");
    if (!deleteOperationIds.has(subtree.operationId))
      throw new Error("Deleted subtree evidence must bind an approved delete operation");
    if (subtree.descendants.length > STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionFacts)
      throw new Error("Deleted subtree exceeds the bounded evidence limit");
    const seen = new Set<string>();
    for (const descendant of subtree.descendants) {
      const identity = studioObjectIdentityKey(descendant.identity);
      if (
        descendant.kind !== "instance" ||
        !isStudioPath(descendant.path) ||
        !isNonEmpty(descendant.className) ||
        seen.has(identity)
      )
        throw new Error("Deleted subtree contains an invalid or duplicate identity");
      seen.add(identity);
    }
    subtreeByOperation.set(subtree.operationId, subtree.descendants);
  }
  const structuralParentByOperation = new Map<string, StudioInstanceEvidenceTarget>();
  for (const parent of structuralParents) {
    if (
      !isNonEmpty(parent.operationId) ||
      parent.target.kind !== "instance" ||
      !isStudioPath(parent.target.path) ||
      !isNonEmpty(parent.target.className) ||
      structuralParentByOperation.has(parent.operationId)
    )
      throw new Error("Structural parent bindings must be unique exact instance targets");
    structuralParentByOperation.set(parent.operationId, parent.target);
  }

  const operations: MutationEvidenceOperation[] = [];
  for (const operation of changeSet.operations) {
    operations.push(
      adaptStudioChangeOperation(
        operation,
        structuralParentByOperation.get(operation.id),
        postStateTargets,
      ),
    );
    if (operation.kind !== "delete") continue;
    for (const descendant of subtreeByOperation.get(operation.id) ?? []) {
      if (
        studioObjectIdentityKey(descendant.identity) ===
          studioObjectIdentityKey(operation.target.identity) ||
        !isDescendantPath(descendant.path, operation.target.path)
      )
        throw new Error("Deleted subtree identity is not a proper descendant of its delete target");
      operations.push({
        id: `${operation.id}:delete:${studioObjectIdentityKey(descendant.identity)}`,
        kind: "delete",
        target: descendant,
        structureStatus: "absent",
        consequentialStructureOnly: true,
      });
    }
  }
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
    throw new Error("Mutation evidence operation IDs must be unique");
  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

export function compileCreatorChangeSetMutationProjection(
  changeSet: CreatorMutationSealedChangeSet,
  context: CreatorChangeSetProjectionContext,
): StudioEvidenceProjection {
  assertCreatorChangeSetProjectionContext(changeSet, context);
  assertCreatorTransactionTopologyOrder({
    initial: context.initialTopology,
    operations: changeSet.operations,
  });
  const purpose = context.purpose ?? "mutation_direct_readback";
  return compileMutationEvidenceProjection({
    id: context.projectionId ?? creatorChangeSetMutationProjectionId(changeSet, purpose),
    project: context.project,
    binding: context.binding,
    operations: adaptCreatorChangeSetMutationOperations(
      changeSet,
      context.initialTopology,
      context.deletedSubtrees,
      context.structuralParents,
    ),
    purpose,
  });
}

export interface CreatorMutationEvidence {
  readonly projection: StudioEvidenceProjection;
  readonly envelope: StudioEvidenceEnvelope;
}

export interface CreatorMutationReconciliationInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly manifest: StudioCapabilityManifest;
  readonly manifestHash: string;
  readonly changeSet: CreatorMutationChangeSetLike;
  readonly projection: StudioEvidenceProjection;
  readonly preflight: CreatorMutationEvidence;
  readonly directReadback: StudioEvidenceEnvelope;
  /** Complete, immutable capture immediately before provisional mutation. */
  readonly beforeIndexCapture: StudioProjectIndexCapture;
  /** Complete, immutable capture immediately after direct engine readback. */
  readonly afterIndexCapture: StudioProjectIndexCapture;
}

export interface CreatorMutationReconciliation {
  readonly kind: "CreatorMutationReconciliation";
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly status: CreatorMutationReconciliationStatus;
  readonly manifestHash: string;
  readonly changeSetHash: string;
  readonly projectionHash: string;
  readonly bindingHash: string;
  readonly preflightProjectionHash: string;
  readonly preflightBindingHash: string;
  readonly preflightEnvelopeHash: string;
  readonly directReadbackHash: string;
  readonly beforeIndexCaptureHash: string;
  readonly beforeIndexRevisionHash: string;
  readonly beforeIndexMerkleRoot: string;
  readonly afterIndexCaptureHash: string;
  readonly afterIndexRevisionHash: string;
  readonly afterIndexMerkleRoot: string;
  readonly failureFacts: readonly CreatorMutationFailureFact[];
}

/** A hash-bound immutable artifact. `hash` is the evidence object's hash. */
export interface CreatorMutationArtifactBinding {
  readonly artifact: ArtifactReference;
  readonly hash: string;
}

export interface CreatorMutationArtifactEvidence {
  readonly projection: CreatorMutationArtifactBinding;
  readonly envelope: CreatorMutationArtifactBinding;
}

/** A complete, independently verified graph of bounded project-index leaves. */
export type CreatorMutationArtifactIndexCapture = CreatorProjectIndexArtifactBinding;

export interface CreatorMutationFinalization {
  readonly kind: "CreatorMutationFinalization";
  readonly id: string;
  readonly hash: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly changeSetId: string;
  readonly changeSetHash: string;
  readonly projectionId: string;
  readonly projectionHash: string;
  readonly manifestHash: string;
  readonly beforeIndexCaptureHash: string;
  readonly beforeIndexRevisionHash: string;
  readonly afterIndexCaptureHash: string;
  readonly afterIndexRevisionHash: string;
  readonly finalIndexCaptureHash: string;
  readonly finalIndexRevisionHash: string;
  readonly recordingId: string;
  readonly reconciliationHash?: string;
  readonly action: "commit" | "cancel" | "recovery_cancel";
  readonly status: "committed" | "cancelled" | "recovery_cancelled" | "recovery_required";
}

export interface CreatorSettledMutationAttempt {
  readonly kind: "CreatorMutationAttempt";
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly completion: "settled";
  readonly manifest: CreatorMutationArtifactBinding;
  readonly attestation: CreatorMutationArtifactEvidence;
  readonly changeSet: CreatorMutationArtifactBinding;
  readonly projection: CreatorMutationArtifactBinding;
  readonly preflight: CreatorMutationArtifactEvidence;
  readonly directReadback: CreatorMutationArtifactBinding;
  readonly beforeIndexCapture: CreatorMutationArtifactIndexCapture;
  readonly afterIndexCapture: CreatorMutationArtifactIndexCapture;
  readonly finalIndexCapture: CreatorMutationArtifactIndexCapture;
  readonly reconciliation: CreatorMutationArtifactBinding;
  readonly finalization: CreatorMutationArtifactBinding;
}

interface CreatorIncompleteMutationAttemptBase {
  readonly kind: "CreatorMutationAttempt";
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly completion: "incomplete";
  readonly manifest: CreatorMutationArtifactBinding;
  readonly attestation: CreatorMutationArtifactEvidence;
  readonly changeSet: CreatorMutationArtifactBinding;
  readonly projection: CreatorMutationArtifactBinding;
  readonly preflightProjection: CreatorMutationArtifactBinding;
  readonly preflight?: CreatorMutationArtifactEvidence;
  readonly beforeIndexCapture: CreatorMutationArtifactIndexCapture;
  readonly failureFacts: readonly CreatorMutationFailureFact[];
}

export interface CreatorIncompletePreflightMutationAttempt extends CreatorIncompleteMutationAttemptBase {
  readonly phase: "preflight";
}

export interface CreatorIncompleteDurableIntentMutationAttempt extends CreatorIncompleteMutationAttemptBase {
  readonly phase: "durable_intent";
  readonly preflight: CreatorMutationArtifactEvidence;
}

export interface CreatorIncompleteApplyMutationAttempt extends CreatorIncompleteMutationAttemptBase {
  readonly phase: "apply";
  readonly preflight: CreatorMutationArtifactEvidence;
  readonly finalIndexCapture: CreatorMutationArtifactIndexCapture;
  readonly finalization: CreatorMutationArtifactBinding;
}

export type CreatorIncompleteMutationAttempt =
  | CreatorIncompletePreflightMutationAttempt
  | CreatorIncompleteDurableIntentMutationAttempt
  | CreatorIncompleteApplyMutationAttempt;
export type CreatorMutationAttempt =
  CreatorSettledMutationAttempt | CreatorIncompleteMutationAttempt;

export interface CreatorMutationReplay {
  readonly kind: "CreatorMutationReplay";
  readonly attemptId: string;
  readonly recordedStatus: CreatorMutationReconciliationStatus;
  readonly result: "exact_match" | "mismatch" | "missing_or_incomplete";
  readonly recordedFailureFactHashes: readonly string[];
  readonly replayedStatus?: CreatorMutationReconciliationStatus;
  readonly replayedFailureFactHashes?: readonly string[];
  readonly detail: string;
}

export function createCreatorMutationFinalization(
  input: Omit<CreatorMutationFinalization, "kind" | "id" | "hash">,
): CreatorMutationFinalization {
  const base = { kind: "CreatorMutationFinalization" as const, ...input };
  const id = `creator_mutation_finalization_${contentHash(stableJson(base)).slice(0, 24)}`;
  const finalization = Object.freeze({
    ...base,
    id,
    hash: contentHash(stableJson({ ...base, id })),
  });
  assertCreatorMutationFinalization(finalization);
  return finalization;
}

export function assertCreatorMutationFinalization(
  value: unknown,
): asserts value is CreatorMutationFinalization {
  if (!isFinalization(value) || !hasCanonicalHash(value))
    throw new Error("Invalid CreatorMutationFinalization");
}

export function createCreatorMutationAttempt(
  id: string,
  input: Omit<CreatorSettledMutationAttempt, "kind" | "id" | "hash" | "completion">,
): CreatorSettledMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "settled" as const,
    ...input,
  };
  const attempt = Object.freeze({
    ...payload,
    hash: contentHash(stableJson(payload)),
  });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createIncompleteCreatorMutationAttempt(
  id: string,
  input: Omit<
    CreatorIncompletePreflightMutationAttempt,
    "kind" | "id" | "hash" | "completion" | "phase"
  >,
): CreatorIncompletePreflightMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "incomplete" as const,
    phase: "preflight" as const,
    ...input,
  };
  const attempt = Object.freeze({
    ...payload,
    hash: contentHash(stableJson(payload)),
  });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createIncompleteApplyMutationAttempt(
  id: string,
  input: Omit<
    CreatorIncompleteApplyMutationAttempt,
    "kind" | "id" | "hash" | "completion" | "phase"
  >,
): CreatorIncompleteApplyMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "incomplete" as const,
    phase: "apply" as const,
    ...input,
  };
  const attempt = Object.freeze({
    ...payload,
    hash: contentHash(stableJson(payload)),
  });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createIncompleteDurableIntentMutationAttempt(
  id: string,
  input: Omit<
    CreatorIncompleteDurableIntentMutationAttempt,
    "kind" | "id" | "hash" | "completion" | "phase"
  >,
): CreatorIncompleteDurableIntentMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "incomplete" as const,
    phase: "durable_intent" as const,
    ...input,
  };
  const attempt = Object.freeze({
    ...payload,
    hash: contentHash(stableJson(payload)),
  });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createMutationFailureFacts(
  inputs: readonly CreatorMutationFailureInput[],
): readonly CreatorMutationFailureFact[] {
  const facts = inputs.map((input) => {
    const candidate =
      typeof input === "string"
        ? { code: "mutation_evidence", detail: input }
        : { code: input.code, detail: input.detail };
    if (!isNonEmpty(candidate.code) || !isNonEmpty(candidate.detail))
      throw new Error("Creator mutation failure facts must be non-empty");
    const detail = candidate.detail.slice(0, 4096);
    return Object.freeze({
      code: candidate.code,
      detail,
      hash: contentHash(stableJson({ code: candidate.code, detail })),
    });
  });
  const unique = new Map(facts.map((fact) => [fact.hash, fact]));
  return Object.freeze([...unique.values()].sort(compareFailureFacts));
}

/**
 * Pure reconciliation. A valid complete project-index capture is the only
 * project-wide evidence accepted here. There is no project-state projection,
 * project-state envelope, or StudioStateRevision fallback.
 */
export function reconcileCreatorMutation(
  input: CreatorMutationReconciliationInput,
): CreatorMutationReconciliation {
  const incomplete: CreatorMutationFailureInput[] = [];
  const mismatched: CreatorMutationFailureInput[] = [];
  const addIncomplete = (code: string, detail: string) => incomplete.push({ code, detail });
  const addMismatch = (code: string, detail: string) => mismatched.push({ code, detail });

  if (!isNonEmpty(input.sessionId) || !isNonEmpty(input.attemptId))
    addIncomplete("mutation_binding_invalid", "Mutation session or attempt identity is missing.");
  try {
    assertStudioCapabilityManifest(input.manifest);
  } catch (error) {
    addIncomplete(
      "manifest_invalid",
      `Stored capability manifest is invalid: ${errorMessage(error)}`,
    );
  }
  if (contentHash(stableJson(input.manifest)) !== input.manifestHash)
    addIncomplete(
      "manifest_binding_invalid",
      "Stored capability manifest does not match its immutable hash binding.",
    );

  const changeSet = input.changeSet;
  if (!isChangeSet(changeSet)) {
    addIncomplete("change_set_invalid", "The sealed creator change set is invalid.");
  }
  const projection = input.projection;
  validateStoredMutationProjection(
    changeSet,
    projection,
    input.manifest,
    input.manifestHash,
    addIncomplete,
  );
  validatePreflight(input.preflight, input.manifest, input.manifestHash, changeSet, addIncomplete);
  validateExactEvidence(
    input.directReadback,
    projection,
    input.manifest,
    "direct_readback",
    addIncomplete,
    addMismatch,
  );

  const before = validateIndexCapture(
    input.beforeIndexCapture,
    "before_index",
    input.manifest,
    input.manifestHash,
    changeSet.project,
    addIncomplete,
  );
  const after = validateIndexCapture(
    input.afterIndexCapture,
    "after_index",
    input.manifest,
    input.manifestHash,
    changeSet.project,
    addIncomplete,
  );
  if (before && after && before.revision.connectorEpoch !== after.revision.connectorEpoch)
    addIncomplete(
      "index_capture_epoch_changed",
      "Before and after index captures use different connector epochs.",
    );

  if (incomplete.length === 0 && before && after && isChangeSet(changeSet)) {
    const transitions = mutationObjectTransitions(changeSet.operations);
    if (validateObjectTransitionsInCaptures(transitions, before, after, addMismatch)) {
      const difference = indexDifference(before, after, transitions);
      const allowed = new Set(approvedIndexDelta(changeSet.operations, before, after, transitions));
      const afterNodes = captureNodes(after);
      for (const operation of changeSet.operations) {
        if (operation.target.kind !== "instance" || operation.kind === "delete") continue;
        const className = operation.target.className;
        const classDefinition = input.manifest.classes.find((entry) => entry.name === className)!;
        for (const name of derivedStudioMutationPropertyNames(
          classDefinition,
          operation.properties ?? {},
        )) {
          const canary = input.preflight.envelope.facts.find(
            (fact) =>
              fact.kind === "property" &&
              fact.propertyName === name &&
              sameTarget(fact.target, operation.target),
          );
          const actual = input.directReadback.facts.find(
            (fact) =>
              fact.kind === "property" &&
              fact.propertyName === name &&
              sameTarget(fact.target, operation.target),
          );
          const objectId = mutationTargetObjectId(operation.target);
          const indexed = afterNodes.get(objectId)?.node.coveredProperties[name];
          if (
            canary?.result.status !== "observed" ||
            actual?.result.status !== "observed" ||
            indexed === undefined ||
            stableJson(canary.result.value) !== stableJson(actual.result.value) ||
            stableJson(canary.result.value) !== stableJson(indexed)
          ) {
            addMismatch(
              "derived_property_not_reflected",
              `Final detached, direct and complete-index values differ for ${objectId}.${name}.`,
            );
          } else allowed.add(`node:${objectId}:property:${name}`);
        }
      }
      for (const change of difference.changes) {
        if (!allowed.has(change.key))
          addMismatch(
            "unapproved_index_delta",
            `Project index changed outside approved operations: ${change.key}.`,
          );
      }
      if (
        before.revision.merkleRoot !== after.revision.merkleRoot &&
        difference.changes.length === 0
      )
        addMismatch(
          "unexplained_merkle_delta",
          "Project index Merkle root changed without a node, source, or identity difference.",
        );
      if (before.revision.merkleRoot === after.revision.merkleRoot && difference.changes.length > 0)
        addMismatch(
          "unexplained_index_difference",
          "Project index nodes, source, or identity changed without a Merkle-root change.",
        );
    }
    validateOperationsInAfterCapture(changeSet.operations, after, addMismatch);
  }

  const status: CreatorMutationReconciliationStatus =
    incomplete.length > 0 ? "incomplete" : mismatched.length > 0 ? "mismatched" : "matched";
  const failureFacts = createMutationFailureFacts(
    status === "incomplete" ? incomplete : mismatched,
  );
  const base = {
    kind: "CreatorMutationReconciliation" as const,
    id: `creator_mutation_reconciliation_${input.attemptId}`,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    status,
    manifestHash: safeHash(input.manifestHash),
    changeSetHash: recordHash(changeSet, "hash"),
    projectionHash: recordHash(projection, "contentHash"),
    bindingHash: recordHash(projection, "bindingHash"),
    preflightProjectionHash: recordHash(input.preflight?.projection, "contentHash"),
    preflightBindingHash: recordHash(input.preflight?.projection, "bindingHash"),
    preflightEnvelopeHash: recordHash(input.preflight?.envelope, "contentHash"),
    directReadbackHash: recordHash(input.directReadback, "contentHash"),
    beforeIndexCaptureHash: recordHash(input.beforeIndexCapture, "hash"),
    beforeIndexRevisionHash: nestedRecordHash(input.beforeIndexCapture, "revision", "hash"),
    beforeIndexMerkleRoot: nestedRecordHash(input.beforeIndexCapture, "revision", "merkleRoot"),
    afterIndexCaptureHash: recordHash(input.afterIndexCapture, "hash"),
    afterIndexRevisionHash: nestedRecordHash(input.afterIndexCapture, "revision", "hash"),
    afterIndexMerkleRoot: nestedRecordHash(input.afterIndexCapture, "revision", "merkleRoot"),
    failureFacts,
  };
  return Object.freeze({ ...base, hash: contentHash(stableJson(base)) });
}

/** Reproduce a stored verdict using only immutable artifacts. */
export async function replayCreatorMutation(
  attempt: CreatorMutationAttempt,
  store: ImmutableJsonArtifactStore,
): Promise<CreatorMutationReplay> {
  const base = {
    kind: "CreatorMutationReplay" as const,
    attemptId: isRecord(attempt) && isNonEmpty(attempt.id) ? attempt.id : "unknown",
    recordedStatus: "incomplete" as CreatorMutationReconciliationStatus,
    recordedFailureFactHashes: Object.freeze([] as string[]),
  };
  if (!isCreatorMutationAttempt(attempt))
    return replayMismatch(base, "Mutation attempt binding is invalid.");

  if (attempt.completion === "incomplete") {
    try {
      const manifest = await readManifest(store, attempt.manifest);
      const before = await readIndexCapture(store, attempt.beforeIndexCapture, manifest);
      if (attempt.phase === "apply") {
        const final = await readIndexCapture(store, attempt.finalIndexCapture, manifest);
        if (before.revision.merkleRoot !== final.revision.merkleRoot)
          throw new Error("Incomplete apply attempt did not retain an exact rollback capture");
      }
    } catch (error) {
      return replayMissing(
        base,
        `Incomplete mutation index evidence could not be verified: ${errorMessage(error)}`,
      );
    }
    return {
      ...base,
      recordedFailureFactHashes: attempt.failureFacts.map((fact) => fact.hash),
      result: "missing_or_incomplete",
      detail:
        attempt.phase === "apply"
          ? "The provisionally applied mutation was cancelled and has no matched verdict."
          : attempt.phase === "durable_intent"
            ? "Detached preflight passed, but Studio could not durably persist the recording intent before opening a recording."
            : "The detached capability preflight did not produce a matched mutation verdict.",
    };
  }

  let manifest: StudioCapabilityManifest;
  let changeSet: CreatorMutationChangeSetLike;
  let projection: StudioEvidenceProjection;
  let preflightProjection: StudioEvidenceProjection;
  let preflightEnvelope: StudioEvidenceEnvelope;
  let directReadback: StudioEvidenceEnvelope;
  let before: StudioProjectIndexCapture;
  let after: StudioProjectIndexCapture;
  let final: StudioProjectIndexCapture;
  let recorded: CreatorMutationReconciliation;
  let finalization: CreatorMutationFinalization;
  try {
    manifest = await readManifest(store, attempt.manifest);
    // Attestation stays append-only evidence for the transaction. Its policy
    // grade is owned by its dedicated verifier, not this reconciler.
    await readProjection(store, attempt.attestation.projection, manifest);
    await readEnvelope(store, attempt.attestation.envelope, manifest);
    changeSet = await readChangeSet(store, attempt.changeSet);
    projection = await readProjection(store, attempt.projection, manifest);
    preflightProjection = await readProjection(store, attempt.preflight.projection, manifest);
    preflightEnvelope = await readEnvelope(store, attempt.preflight.envelope, manifest);
    directReadback = await readEnvelope(store, attempt.directReadback, manifest);
    before = await readIndexCapture(store, attempt.beforeIndexCapture, manifest);
    after = await readIndexCapture(store, attempt.afterIndexCapture, manifest);
    final = await readIndexCapture(store, attempt.finalIndexCapture, manifest);
    recorded = await readReconciliation(store, attempt.reconciliation);
    finalization = await readFinalization(store, attempt.finalization);
  } catch (error) {
    return replayMissing(
      base,
      `Required mutation evidence could not be read: ${errorMessage(error)}`,
    );
  }

  const replayBase = {
    ...base,
    recordedStatus: recorded.status,
    recordedFailureFactHashes: Object.freeze(recorded.failureFacts.map((fact) => fact.hash)),
  };
  const replayed = reconcileCreatorMutation({
    sessionId: attempt.sessionId,
    attemptId: attempt.id,
    manifest,
    manifestHash: attempt.manifest.hash,
    changeSet,
    projection,
    preflight: { projection: preflightProjection, envelope: preflightEnvelope },
    directReadback,
    beforeIndexCapture: before,
    afterIndexCapture: after,
  });
  if (replayed.status === "incomplete") {
    return {
      ...replayBase,
      result: "missing_or_incomplete",
      replayedStatus: replayed.status,
      replayedFailureFactHashes: Object.freeze(replayed.failureFacts.map((fact) => fact.hash)),
      detail: "Stored direct-readback or project-index evidence is incomplete.",
    };
  }
  if (
    !matchesFinalization(
      finalization,
      attempt,
      changeSet,
      projection,
      recorded,
      before,
      after,
      final,
    )
  )
    return replayMismatch(
      replayBase,
      "Finalization does not bind the recorded index-capture transaction.",
    );
  const exact =
    sameReconciliation(recorded, replayed) && recorded.hash === attempt.reconciliation.hash;
  return {
    ...replayBase,
    result: exact ? "exact_match" : "mismatch",
    replayedStatus: replayed.status,
    replayedFailureFactHashes: Object.freeze(replayed.failureFacts.map((fact) => fact.hash)),
    detail: exact
      ? "Provider-free replay reproduced the recorded mutation reconciliation."
      : "Provider-free replay did not reproduce the recorded mutation reconciliation.",
  };
}

function adaptStudioChangeOperation(
  operation: CreatorMutationStudioOperation,
  structuralParent: StudioInstanceEvidenceTarget | undefined,
  postStateTargets: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): MutationEvidenceOperation {
  switch (operation.kind) {
    case "create": {
      const target = rewritePostStateTarget(operation.target, postStateTargets);
      return {
        id: operation.id,
        kind: "create",
        target,
        properties: rewritePostStateProperties(operation.properties, postStateTargets),
        attributes: operation.attributes,
        ...(operation.sourceBlob === undefined
          ? {}
          : { sourceHash: operation.sourceBlob.sourceHash }),
        structure: structureFor(target, operation.parent, structuralParent, postStateTargets),
      };
    }
    case "update": {
      const target = rewritePostStateTarget(operation.target, postStateTargets);
      return {
        id: operation.id,
        kind: "update",
        target,
        ...(operation.enrollment === undefined ? {} : { beforeTarget: operation.target }),
        properties: rewritePostStateProperties(operation.properties, postStateTargets),
        attributes: operation.attributes,
        removedAttributes: operation.removedAttributes,
      };
    }
    case "move": {
      const target = rewritePostStateTarget(operation.target, postStateTargets);
      return {
        id: operation.id,
        kind: "move",
        target,
        beforeTarget: operation.target,
        properties: rewritePostStateProperties(operation.properties, postStateTargets),
        attributes: operation.attributes,
        removedAttributes: operation.removedAttributes,
        structure: structureFor(target, operation.parent, structuralParent, postStateTargets),
      };
    }
    case "delete":
      return {
        id: operation.id,
        kind: "delete",
        target: rewritePostStateTarget(operation.target, postStateTargets),
        ...(operation.enrollment === undefined ? {} : { beforeTarget: operation.target }),
        structureStatus: "absent",
      };
    case "edit_source":
      return {
        id: operation.id,
        kind: "edit_source",
        target: rewritePostStateTarget(operation.target, postStateTargets),
        ...(operation.enrollment === undefined ? {} : { beforeTarget: operation.target }),
        sourceHash: operation.finalSourceHash,
      };
  }
}

function assertCreatorChangeSetProjectionContext(
  changeSet: CreatorMutationSealedChangeSet,
  context: CreatorChangeSetProjectionContext,
): void {
  if (!isHash(changeSet.hash) || !isNonEmpty(changeSet.sessionId))
    throw new Error("Mutation projection requires a sealed creator change set");
  assertCreatorMutationBinding(context.binding, "Mutation projection context");
  if (
    context.binding.changeSetHash !== changeSet.hash ||
    context.binding.sessionId !== changeSet.sessionId ||
    context.binding.revisionHash !== changeSet.expectedRevisionHash ||
    context.binding.buildHash !== changeSet.buildContractHash
  )
    throw new Error("Mutation projection context is not bound to the sealed change set");
  if (!isProject(context.project))
    throw new Error("Mutation projection context has invalid project identity");
  if (
    context.purpose !== undefined &&
    !["mutation_preflight", "mutation_direct_readback", "mutation_post_state"].includes(
      context.purpose,
    )
  )
    throw new Error("Mutation projection context has an invalid purpose");
  const engineParentOperationIds = changeSet.operations
    .filter(
      (operation) =>
        (operation.kind === "create" || operation.kind === "move") &&
        operation.parent.kind === "engine_container",
    )
    .map((operation) => operation.id);
  if (engineParentOperationIds.length === 0) return;
  const structuralParents = context.structuralParents;
  if (!structuralParents)
    throw new Error("Mutation projection requires exact captured engine-parent identities");
  const parentByOperation = new Map(
    structuralParents.map((parent) => [parent.operationId, parent.target] as const),
  );
  if (
    parentByOperation.size !== structuralParents.length ||
    engineParentOperationIds.some((operationId) => parentByOperation.get(operationId) === undefined)
  )
    throw new Error("Mutation projection is missing an exact captured engine-parent identity");
}

function validateStoredMutationProjection(
  changeSet: CreatorMutationChangeSetLike,
  projection: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  incomplete: (code: string, detail: string) => void,
): void {
  try {
    assertStudioEvidenceProjection(projection, manifest);
    if (!isChangeSet(changeSet)) throw new Error("sealed change set is invalid");
    assertCreatorMutationBinding(projection.binding, "Mutation direct-readback projection");
    if (
      projection.manifestHash !== manifestHash ||
      projection.purpose !== "mutation_direct_readback" ||
      !matchesStudioCreatorMutationBinding(projection.binding, changeSet.binding) ||
      projection.id !== changeSet.projectionId
    )
      throw new Error("projection binding differs from sealed change set");
    const recompiled = compileMutationEvidenceProjectionForManifest(
      {
        id: changeSet.projectionId,
        project: changeSet.project,
        binding: changeSet.binding,
        operations: changeSet.operations,
        purpose: "mutation_direct_readback",
      },
      manifest,
      manifestHash,
    );
    if (recompiled.contentHash !== projection.contentHash)
      throw new Error("projection does not equal deterministic recompilation");
  } catch (error) {
    incomplete(
      "mutation_projection_invalid",
      `Mutation direct-readback projection is invalid: ${errorMessage(error)}`,
    );
  }
}

function validatePreflight(
  preflight: CreatorMutationEvidence,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
  incomplete: (code: string, detail: string) => void,
): void {
  try {
    assertStudioEvidenceProjection(preflight.projection, manifest);
    assertEvidenceAgainstProjection(preflight.envelope, preflight.projection, manifest);
    if (preflight.envelope.completion !== "complete")
      throw new Error("preflight envelope is incomplete");
    if (!isChangeSet(changeSet)) throw new Error("sealed change set is invalid");
    assertCreatorMutationBinding(preflight.projection.binding, "Mutation preflight projection");
    if (
      preflight.projection.manifestHash !== manifestHash ||
      preflight.projection.purpose !== "mutation_preflight" ||
      !matchesStudioCreatorMutationBinding(preflight.projection.binding, changeSet.binding)
    )
      throw new Error("preflight is not bound to sealed mutation");
    const recompiled = compileMutationEvidenceProjectionForManifest(
      {
        id: preflight.projection.id,
        project: changeSet.project,
        binding: changeSet.binding,
        operations: changeSet.operations,
        purpose: "mutation_preflight",
      },
      manifest,
      manifestHash,
    );
    if (recompiled.contentHash !== preflight.projection.contentHash)
      throw new Error("preflight projection does not equal deterministic recompilation");
  } catch (error) {
    incomplete(
      "capability_preflight_incomplete",
      `Preflight evidence is incomplete or invalid: ${errorMessage(error)}`,
    );
  }
}

function validateExactEvidence(
  envelope: StudioEvidenceEnvelope,
  projection: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest,
  label: string,
  incomplete: (code: string, detail: string) => void,
  mismatched: (code: string, detail: string) => void,
): void {
  try {
    assertStudioEvidenceEnvelope(envelope, undefined, manifest);
  } catch (error) {
    incomplete(`${label}_invalid`, `${label} envelope is invalid: ${errorMessage(error)}`);
    return;
  }
  if (!matchesProjectionBinding(envelope, projection)) {
    incomplete(
      `${label}_binding_invalid`,
      `${label} envelope does not bind the direct-readback projection.`,
    );
    return;
  }
  if (envelope.completion !== "complete") {
    incomplete(`${label}_incomplete`, `${label} envelope is incomplete.`);
    return;
  }
  const facts = new Map(envelope.facts.map((fact) => [fact.key, fact]));
  if (facts.size !== envelope.facts.length || facts.size !== projection.requirements.length) {
    incomplete(`${label}_coverage_invalid`, `${label} has missing, duplicate, or extra facts.`);
    return;
  }
  for (const requirement of projection.requirements) {
    const fact = facts.get(requirement.key);
    if (!fact || !factMatchesRequirement(fact, requirement)) {
      incomplete(`${label}_coverage_invalid`, `${label} misses required fact: ${requirement.key}.`);
      continue;
    }
    if (fact.result.status === "unavailable" || fact.result.status === "read_error") {
      incomplete(
        `${label}_fact_unavailable`,
        `${label} could not read required fact: ${requirement.key}.`,
      );
      continue;
    }
    const expectedStatus = requirement.expectedStatus ?? "observed";
    if (expectedStatus === "absent") {
      if (fact.result.status !== "absent")
        mismatched(`${label}_fact_mismatch`, `${label} expected absent fact: ${requirement.key}.`);
    } else if (
      fact.result.status !== "observed" ||
      (requirement.expected !== undefined &&
        !sameRequirementValue(fact.result.value, requirement.expected))
    ) {
      mismatched(
        `${label}_fact_mismatch`,
        `${label} fact differs from approved postcondition: ${requirement.key}.`,
      );
    }
  }
}

function validateIndexCapture(
  capture: unknown,
  label: string,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  project: StudioProjectIdentity,
  incomplete: (code: string, detail: string) => void,
): StudioProjectIndexCapture | undefined {
  try {
    assertStudioProjectIndexCapture(capture, manifest);
    if (
      capture.revision.manifestHash !== manifestHash ||
      !sameProject(capture.revision.project, project)
    )
      throw new Error("capture project or manifest binding differs from mutation");
    return capture;
  } catch (error) {
    incomplete(
      `${label}_incomplete`,
      `${label} capture evidence is missing, malformed, or unbound: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

type IndexDifference = {
  readonly changes: readonly {
    readonly key: string;
    readonly detail: string;
  }[];
};

type CapturedIndexEntry = {
  readonly node: StudioProjectIndexNode;
  readonly sourceHash?: string | undefined;
};

type MutationObjectTransition = {
  readonly operationKind: MutationEvidenceOperation["kind"];
  readonly beforeTarget: StudioInstanceEvidenceTarget;
  readonly target: StudioInstanceEvidenceTarget;
  readonly beforeObjectId: string;
  readonly objectId: string;
};

function mutationObjectTransitions(
  operations: readonly MutationEvidenceOperation[],
): readonly MutationObjectTransition[] {
  const transitions = new Map<string, MutationObjectTransition>();
  for (const operation of operations) {
    if (operation.beforeTarget?.kind !== "instance" || operation.target.kind !== "instance")
      continue;
    const transition: MutationObjectTransition = {
      operationKind: operation.kind,
      beforeTarget: operation.beforeTarget,
      target: operation.target,
      beforeObjectId: mutationTargetObjectId(operation.beforeTarget),
      objectId: mutationTargetObjectId(operation.target),
    };
    const key = stableJson({
      beforeTarget: transition.beforeTarget,
      target: transition.target,
    });
    if (!transitions.has(key)) transitions.set(key, transition);
  }
  return [...transitions.values()].sort(
    (left, right) =>
      left.beforeObjectId.localeCompare(right.beforeObjectId) ||
      left.objectId.localeCompare(right.objectId),
  );
}

function validateObjectTransitionsInCaptures(
  transitions: readonly MutationObjectTransition[],
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
  mismatch: (code: string, detail: string) => void,
): boolean {
  const beforeNodes = captureNodes(before);
  const afterNodes = captureNodes(after);
  let valid = true;
  for (const transition of transitions) {
    const prior = beforeNodes.get(transition.beforeObjectId);
    if (!prior || !capturedNodeMatchesTarget(prior.node, transition.beforeTarget)) {
      mismatch(
        "approved_before_target_missing",
        `Approved mutation before-target is absent or changed: ${transition.beforeObjectId}.`,
      );
      valid = false;
    }
    if (transition.beforeObjectId !== transition.objectId && beforeNodes.has(transition.objectId)) {
      mismatch(
        "identity_enrollment_collision",
        `Approved durable identity already exists before enrollment: ${transition.objectId}.`,
      );
      valid = false;
    }
    if (
      transition.beforeObjectId !== transition.objectId &&
      afterNodes.has(transition.beforeObjectId)
    ) {
      mismatch(
        "identity_enrollment_source_retained",
        `Ephemeral identity remains after enrollment: ${transition.beforeObjectId}.`,
      );
      valid = false;
    }
    const next = afterNodes.get(transition.objectId);
    if (transition.operationKind === "delete") {
      if (next) {
        mismatch(
          "approved_delete_still_present",
          `Approved enrolled delete target remains in after capture: ${transition.objectId}.`,
        );
        valid = false;
      }
    } else if (!next || !capturedNodeMatchesTarget(next.node, transition.target)) {
      mismatch(
        "approved_after_target_missing",
        `Approved mutation post-target is absent or changed: ${transition.objectId}.`,
      );
      valid = false;
    }
  }
  return valid;
}

function indexDifference(
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
  transitions: readonly MutationObjectTransition[],
): IndexDifference {
  const left = comparisonCaptureNodes(before, transitions);
  const right = captureNodes(after);
  const changes: Array<{ key: string; detail: string }> = [];
  const recordedIdentityChanges = new Set<string>();
  for (const transition of transitions) {
    const key = `node:${transition.objectId}:identity`;
    if (
      transition.operationKind !== "delete" &&
      transition.beforeObjectId !== transition.objectId &&
      !recordedIdentityChanges.has(key)
    ) {
      recordedIdentityChanges.add(key);
      changes.push({
        key,
        detail: "approved ephemeral identity enrolled",
      });
    }
  }
  for (const objectId of new Set([...left.keys(), ...right.keys()])) {
    const prior = left.get(objectId);
    const next = right.get(objectId);
    if (!prior || !next) {
      changes.push({
        key: `node:${objectId}:existence`,
        detail: !prior ? "created" : "removed",
      });
      continue;
    }
    if (prior.node.displayPath !== next.node.displayPath)
      changes.push({
        key: `node:${objectId}:display_path`,
        detail: "display path changed",
      });
    if (prior.node.className !== next.node.className)
      changes.push({
        key: `node:${objectId}:class_name`,
        detail: "class changed",
      });
    if (!sameOptionalJson(prior.node.parentIdentity, next.node.parentIdentity))
      changes.push({
        key: `node:${objectId}:parent`,
        detail: "parent changed",
      });
    recordRecordDifference(
      changes,
      objectId,
      "attribute",
      prior.node.attributes,
      next.node.attributes,
    );
    recordRecordDifference(
      changes,
      objectId,
      "property",
      prior.node.coveredProperties,
      next.node.coveredProperties,
    );
    if (stableJson(prior.node.tags) !== stableJson(next.node.tags))
      changes.push({ key: `node:${objectId}:tags`, detail: "tags changed" });
    if (prior.sourceHash !== next.sourceHash)
      changes.push({
        key: `source:${objectId}`,
        detail: "source body changed",
      });
  }
  return {
    changes: changes.sort((leftChange, rightChange) =>
      leftChange.key.localeCompare(rightChange.key),
    ),
  };
}

function captureNodes(capture: StudioProjectIndexCapture): Map<string, CapturedIndexEntry> {
  const sourceHashByManifest = new Map(
    capture.sourceManifests.map((manifest) => [manifest.hash, manifest.sourceHash]),
  );
  return new Map(
    capture.shards
      .flatMap((shard) => shard.nodes)
      .map((node) => [
        studioObjectIdentityKey(node.identity),
        {
          node,
          ...(node.sourceManifestHash
            ? { sourceHash: sourceHashByManifest.get(node.sourceManifestHash) }
            : {}),
        },
      ]),
  );
}

function comparisonCaptureNodes(
  capture: StudioProjectIndexCapture,
  transitions: readonly MutationObjectTransition[],
): Map<string, CapturedIndexEntry> {
  const raw = captureNodes(capture);
  const identityTransitions = new Map(
    transitions
      .filter((transition) => transition.beforeObjectId !== transition.objectId)
      .map((transition) => [transition.beforeObjectId, transition.target] as const),
  );
  const targetTransitions = new Map(
    transitions.map((transition) => [transition.beforeObjectId, transition.target] as const),
  );
  const normalized = new Map<string, CapturedIndexEntry>();
  for (const [objectId, entry] of raw) {
    const target = identityTransitions.get(objectId);
    const logicalObjectId = target ? mutationTargetObjectId(target) : objectId;
    if (normalized.has(logicalObjectId))
      throw new Error("Mutation identity transition collides with a captured object");
    const parentIdentity = entry.node.parentIdentity
      ? normalizedIdentity(entry.node.parentIdentity, identityTransitions)
      : undefined;
    normalized.set(logicalObjectId, {
      ...entry,
      node: {
        ...entry.node,
        identity: target?.identity ?? entry.node.identity,
        ...(parentIdentity === undefined ? {} : { parentIdentity }),
        coveredProperties: normalizeIndexValue(
          entry.node.coveredProperties,
          identityTransitions,
          targetTransitions,
        ) as Readonly<Record<string, unknown>>,
      },
    });
  }
  return normalized;
}

function normalizedIdentity(
  identity: StudioProjectIndexNode["identity"],
  transitions: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): StudioProjectIndexNode["identity"] {
  return transitions.get(studioObjectIdentityKey(identity))?.identity ?? identity;
}

function normalizeIndexValue(
  value: unknown,
  identityTransitions: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
  targetTransitions: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => normalizeIndexValue(item, identityTransitions, targetTransitions));
  if (!isRecord(value)) return value;
  if (
    value.kind === "studio_ephemeral" &&
    typeof value.connectorEpoch === "string" &&
    typeof value.opaqueHash === "string"
  ) {
    const objectId = `studio_ephemeral:${value.connectorEpoch}:${value.opaqueHash}`;
    return identityTransitions.get(objectId)?.identity ?? value;
  }
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeIndexValue(item, identityTransitions, targetTransitions),
    ]),
  );
  if (value.kind === "instance_ref" && value.state === "reference" && isRecord(value.identity)) {
    const beforeIdentity = value.identity;
    if (
      beforeIdentity.kind === "studio_ephemeral" &&
      typeof beforeIdentity.connectorEpoch === "string" &&
      typeof beforeIdentity.opaqueHash === "string"
    ) {
      const objectId = `studio_ephemeral:${beforeIdentity.connectorEpoch}:${beforeIdentity.opaqueHash}`;
      const target = targetTransitions.get(objectId);
      if (target) {
        normalized.identity = target.identity;
        normalized.path = target.path;
        normalized.className = target.className;
      }
    } else {
      try {
        const target = targetTransitions.get(
          studioObjectIdentityKey(beforeIdentity as StudioProjectIndexNode["identity"]),
        );
        if (target) {
          normalized.identity = target.identity;
          normalized.path = target.path;
          normalized.className = target.className;
        }
      } catch {
        // Invalid property values are rejected by the project-index validator;
        // this comparison helper never upgrades them into an identity claim.
      }
    }
  }
  return normalized;
}

function capturedNodeMatchesTarget(
  node: StudioProjectIndexNode,
  target: StudioInstanceEvidenceTarget,
): boolean {
  return (
    studioObjectIdentityKey(node.identity) === mutationTargetObjectId(target) &&
    node.displayPath === target.path &&
    node.className === target.className
  );
}

function recordRecordDifference(
  changes: Array<{ key: string; detail: string }>,
  objectId: string,
  kind: "attribute" | "property",
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameOptionalJson(before[name], after[name]))
      changes.push({
        key: `node:${objectId}:${kind}:${name}`,
        detail: `${kind} changed`,
      });
  }
}

function approvedIndexDelta(
  operations: readonly MutationEvidenceOperation[],
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
  transitions: readonly MutationObjectTransition[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  const beforeNodes = comparisonCaptureNodes(before, transitions);
  const afterNodes = captureNodes(after);
  for (const operation of operations) {
    if (operation.target.kind !== "instance") continue;
    const objectId = mutationTargetObjectId(operation.target);
    if (operation.kind === "create" || operation.kind === "delete")
      allowed.add(`node:${objectId}:existence`);
    if (
      operation.kind !== "delete" &&
      operation.beforeTarget?.kind === "instance" &&
      mutationTargetObjectId(operation.beforeTarget) !== objectId
    )
      allowed.add(`node:${objectId}:identity`);
    if (operation.kind === "move") {
      for (const descendant of moveSubtreeIds(objectId, beforeNodes, afterNodes)) {
        allowed.add(`node:${descendant}:display_path`);
        allowed.add(`node:${descendant}:parent`);
      }
    }
    for (const name of Object.keys(operation.attributes ?? {}))
      allowed.add(`node:${objectId}:attribute:${name}`);
    for (const name of operation.removedAttributes ?? [])
      allowed.add(`node:${objectId}:attribute:${name}`);
    for (const name of Object.keys(operation.properties ?? {}))
      allowed.add(`node:${objectId}:property:${name}`);
    if (operation.sourceHash !== undefined) allowed.add(`source:${objectId}`);
  }
  return allowed;
}

function moveSubtreeIds(
  rootId: string,
  before: ReadonlyMap<string, { node: StudioProjectIndexNode }>,
  after: ReadonlyMap<string, { node: StudioProjectIndexNode }>,
): readonly string[] {
  const values = new Set<string>([rootId]);
  for (const nodes of [before, after]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [objectId, entry] of nodes) {
        const parent = entry.node.parentIdentity
          ? studioObjectIdentityKey(entry.node.parentIdentity)
          : undefined;
        if (parent && values.has(parent) && !values.has(objectId)) {
          values.add(objectId);
          changed = true;
        }
      }
    }
  }
  return [...values];
}

function validateOperationsInAfterCapture(
  operations: readonly MutationEvidenceOperation[],
  after: StudioProjectIndexCapture,
  mismatch: (code: string, detail: string) => void,
): void {
  const nodes = captureNodes(after);
  for (const operation of operations) {
    if (operation.target.kind !== "instance") continue;
    const objectId = mutationTargetObjectId(operation.target);
    const captured = nodes.get(objectId);
    if (operation.kind === "delete") {
      if (captured)
        mismatch(
          "approved_delete_still_present",
          `Approved delete target remains in after capture: ${objectId}.`,
        );
      continue;
    }
    if (!captured) {
      mismatch(
        "approved_target_missing",
        `Approved mutation target is missing from after capture: ${objectId}.`,
      );
      continue;
    }
    const expectedStructure = operation.structure ?? {
      identity: operation.target.identity,
      path: operation.target.path,
      className: operation.target.className,
    };
    if (
      (operation.kind === "create" ||
        operation.kind === "move" ||
        operation.structure !== undefined) &&
      (captured.node.displayPath !== expectedStructure.path ||
        captured.node.className !== expectedStructure.className)
    )
      mismatch(
        "approved_structure_not_reflected",
        `Approved structure is not reflected by after capture: ${objectId}.`,
      );
    for (const [name, value] of Object.entries(operation.attributes ?? {})) {
      if (stableJson(captured.node.attributes[name]) !== stableJson(value))
        mismatch(
          "approved_attribute_not_reflected",
          `Approved attribute is not reflected by after capture: ${objectId}.${name}.`,
        );
    }
    for (const name of operation.removedAttributes ?? []) {
      if (captured.node.attributes[name] !== undefined)
        mismatch(
          "approved_attribute_not_removed",
          `Approved attribute remains in after capture: ${objectId}.${name}.`,
        );
    }
    for (const [name, value] of Object.entries(operation.properties ?? {})) {
      if (stableJson(captured.node.coveredProperties[name]) !== stableJson(value))
        mismatch(
          "approved_property_not_reflected",
          `Approved property is not reflected by after capture: ${objectId}.${name}.`,
        );
    }
    if (operation.sourceHash !== undefined && captured.sourceHash !== operation.sourceHash)
      mismatch(
        "approved_source_not_reflected",
        `Approved source hash is not reflected by after capture: ${objectId}.`,
      );
  }
}

function factMatchesRequirement(
  fact: StudioEvidenceFact,
  requirement: StudioEvidenceProjection["requirements"][number],
): boolean {
  return (
    fact.key === requirement.key &&
    fact.kind === requirement.kind &&
    sameTarget(fact.target, requirement.target) &&
    (requirement.propertyName === undefined ||
      (fact.kind === "property" && fact.propertyName === requirement.propertyName)) &&
    (requirement.attributeName === undefined ||
      (fact.kind === "attribute" && fact.attributeName === requirement.attributeName))
  );
}

function sameRequirementValue(observed: unknown, expected: StudioRequirementValue): boolean {
  return isStudioValue(observed) && isStudioValue(expected)
    ? studioValuesEqual(observed, expected)
    : stableJson(observed) === stableJson(expected);
}

function matchesProjectionBinding(
  envelope: StudioEvidenceEnvelope,
  projection: StudioEvidenceProjection,
): boolean {
  return (
    envelope.manifestHash === projection.manifestHash &&
    envelope.projectionId === projection.id &&
    envelope.projectionHash === projection.contentHash &&
    envelope.bindingHash === projection.bindingHash &&
    sameProject(envelope.project, projection.project)
  );
}

async function readManifest(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<StudioCapabilityManifest> {
  const value = await store.read(binding.artifact);
  assertStudioCapabilityManifest(value);
  if (contentHash(stableJson(value)) !== binding.hash)
    throw new Error("Manifest artifact binding changed");
  return value;
}

async function readChangeSet(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<CreatorMutationChangeSetLike> {
  const value = await store.read<CreatorMutationChangeSetLike>(binding.artifact);
  if (!isChangeSet(value) || value.hash !== binding.hash)
    throw new Error("Change-set artifact binding changed");
  return value;
}

async function readProjection(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
  manifest: StudioCapabilityManifest,
): Promise<StudioEvidenceProjection> {
  const value = await store.read<StudioEvidenceProjection>(binding.artifact);
  assertStudioEvidenceProjection(value, manifest);
  if (value.contentHash !== binding.hash) throw new Error("Projection artifact binding changed");
  return value;
}

async function readEnvelope(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
  manifest: StudioCapabilityManifest,
): Promise<StudioEvidenceEnvelope> {
  const value = await store.read<StudioEvidenceEnvelope>(binding.artifact);
  assertStudioEvidenceEnvelope(value, undefined, manifest);
  if (value.contentHash !== binding.hash)
    throw new Error("Evidence envelope artifact binding changed");
  return value;
}

async function readIndexCapture(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactIndexCapture,
  manifest: StudioCapabilityManifest,
): Promise<StudioProjectIndexCapture> {
  return readCreatorProjectIndexArtifacts(store, binding, manifest);
}

async function readReconciliation(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<CreatorMutationReconciliation> {
  const value = await store.read<CreatorMutationReconciliation>(binding.artifact);
  if (!isReconciliation(value) || value.hash !== binding.hash)
    throw new Error("Reconciliation artifact binding changed");
  return value;
}

async function readFinalization(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<CreatorMutationFinalization> {
  const value = await store.read<CreatorMutationFinalization>(binding.artifact);
  assertCreatorMutationFinalization(value);
  if (value.hash !== binding.hash) throw new Error("Finalization artifact binding changed");
  return value;
}

function matchesFinalization(
  finalization: CreatorMutationFinalization,
  attempt: CreatorSettledMutationAttempt,
  changeSet: CreatorMutationChangeSetLike,
  projection: StudioEvidenceProjection,
  reconciliation: CreatorMutationReconciliation,
  before: StudioProjectIndexCapture,
  after: StudioProjectIndexCapture,
  final: StudioProjectIndexCapture,
): boolean {
  if (
    finalization.attemptId !== attempt.id ||
    finalization.sessionId !== attempt.sessionId ||
    finalization.changeSetId !== changeSet.id ||
    finalization.changeSetHash !== changeSet.hash ||
    finalization.projectionId !== projection.id ||
    finalization.projectionHash !== projection.contentHash ||
    finalization.manifestHash !== attempt.manifest.hash ||
    finalization.reconciliationHash !== reconciliation.hash ||
    finalization.beforeIndexCaptureHash !== before.hash ||
    finalization.beforeIndexRevisionHash !== before.revision.hash ||
    finalization.afterIndexCaptureHash !== after.hash ||
    finalization.afterIndexRevisionHash !== after.revision.hash ||
    finalization.finalIndexCaptureHash !== final.hash ||
    finalization.finalIndexRevisionHash !== final.revision.hash
  )
    return false;
  if (finalization.action === "commit")
    return (
      finalization.status === "committed" &&
      reconciliation.status === "matched" &&
      final.revision.hash === after.revision.hash
    );
  if (finalization.action === "cancel")
    return (
      finalization.status === "cancelled" &&
      final.revision.merkleRoot === before.revision.merkleRoot
    );
  return (
    finalization.status === "recovery_cancelled" &&
    final.revision.merkleRoot === before.revision.merkleRoot
  );
}

function replayMissing(
  base: Omit<CreatorMutationReplay, "result" | "detail">,
  detail: string,
): CreatorMutationReplay {
  return { ...base, result: "missing_or_incomplete", detail };
}
function replayMismatch(
  base: Omit<CreatorMutationReplay, "result" | "detail">,
  detail: string,
): CreatorMutationReplay {
  return { ...base, result: "mismatch", detail };
}
function sameReconciliation(
  left: CreatorMutationReconciliation,
  right: CreatorMutationReconciliation,
): boolean {
  const { hash: leftHash, ...leftContent } = left;
  const { hash: rightHash, ...rightContent } = right;
  return (
    contentHash(stableJson(leftContent)) === leftHash &&
    contentHash(stableJson(rightContent)) === rightHash &&
    stableJson(leftContent) === stableJson(rightContent)
  );
}

export function isCreatorMutationAttempt(value: unknown): value is CreatorMutationAttempt {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorMutationAttempt" ||
    !isNonEmpty(value.id) ||
    !isHash(value.hash) ||
    !isNonEmpty(value.sessionId) ||
    !hasCanonicalHash(value)
  )
    return false;
  const common = [
    value.manifest,
    isRecord(value.attestation) ? value.attestation.projection : undefined,
    isRecord(value.attestation) ? value.attestation.envelope : undefined,
    value.changeSet,
    value.projection,
  ].every(isArtifactBinding);
  if (!common || !isProjectIndexBinding(value.beforeIndexCapture)) return false;
  if (value.completion === "settled")
    return (
      [
        isRecord(value.preflight) ? value.preflight.projection : undefined,
        isRecord(value.preflight) ? value.preflight.envelope : undefined,
        value.directReadback,
        value.reconciliation,
        value.finalization,
      ].every(isArtifactBinding) &&
      isProjectIndexBinding(value.afterIndexCapture) &&
      isProjectIndexBinding(value.finalIndexCapture)
    );
  if (
    value.completion !== "incomplete" ||
    !isArtifactBinding(value.preflightProjection) ||
    !hasCanonicalFailureFacts(value.failureFacts)
  )
    return false;
  if (value.phase === "preflight")
    return (
      value.preflight === undefined ||
      (isRecord(value.preflight) &&
        isArtifactBinding(value.preflight.projection) &&
        isArtifactBinding(value.preflight.envelope))
    );
  if (value.phase === "durable_intent")
    return (
      isRecord(value.preflight) &&
      isArtifactBinding(value.preflight.projection) &&
      isArtifactBinding(value.preflight.envelope)
    );
  return (
    value.phase === "apply" &&
    isRecord(value.preflight) &&
    isArtifactBinding(value.preflight.projection) &&
    isArtifactBinding(value.preflight.envelope) &&
    isProjectIndexBinding(value.finalIndexCapture) &&
    isArtifactBinding(value.finalization)
  );
}

export function assertCreatorMutationAttempt(
  value: unknown,
): asserts value is CreatorMutationAttempt {
  if (!isCreatorMutationAttempt(value)) throw new Error("Invalid CreatorMutationAttempt");
}

function isChangeSet(value: unknown): value is CreatorMutationChangeSetLike {
  return (
    isRecord(value) &&
    value.kind === "CreatorChangeSet" &&
    isNonEmpty(value.id) &&
    isHash(value.hash) &&
    isNonEmpty(value.projectionId) &&
    isProject(value.project) &&
    isStudioCreatorMutationBinding(value.binding) &&
    Array.isArray(value.operations) &&
    value.operations.length > 0
  );
}
function isArtifactBinding(value: unknown): value is CreatorMutationArtifactBinding {
  return (
    isRecord(value) &&
    isHash(value.hash) &&
    isRecord(value.artifact) &&
    typeof value.artifact.locator === "string" &&
    isHash(value.artifact.artifactHash) &&
    typeof value.artifact.bytes === "number"
  );
}
function isProjectIndexBinding(value: unknown): value is CreatorMutationArtifactIndexCapture {
  try {
    creatorProjectIndexArtifactReferences(value as CreatorMutationArtifactIndexCapture);
    return true;
  } catch {
    return false;
  }
}
function isReconciliation(value: unknown): value is CreatorMutationReconciliation {
  return (
    isRecord(value) &&
    value.kind === "CreatorMutationReconciliation" &&
    isHash(value.hash) &&
    isNonEmpty(value.attemptId) &&
    isNonEmpty(value.sessionId) &&
    (value.status === "matched" ||
      value.status === "mismatched" ||
      value.status === "incomplete") &&
    Array.isArray(value.failureFacts) &&
    value.failureFacts.every(isMutationFailureFact) &&
    hasCanonicalHash(value)
  );
}
function isFinalization(value: unknown): value is CreatorMutationFinalization {
  return (
    isRecord(value) &&
    value.kind === "CreatorMutationFinalization" &&
    isNonEmpty(value.id) &&
    isHash(value.hash) &&
    isNonEmpty(value.attemptId) &&
    isNonEmpty(value.sessionId) &&
    isNonEmpty(value.changeSetId) &&
    isHash(value.changeSetHash) &&
    isNonEmpty(value.projectionId) &&
    isHash(value.projectionHash) &&
    isHash(value.manifestHash) &&
    isHash(value.beforeIndexCaptureHash) &&
    isHash(value.beforeIndexRevisionHash) &&
    isHash(value.afterIndexCaptureHash) &&
    isHash(value.afterIndexRevisionHash) &&
    isHash(value.finalIndexCaptureHash) &&
    isHash(value.finalIndexRevisionHash) &&
    isNonEmpty(value.recordingId) &&
    (value.reconciliationHash === undefined || isHash(value.reconciliationHash)) &&
    (value.action === "commit" ||
      value.action === "cancel" ||
      value.action === "recovery_cancel") &&
    (value.status === "committed" ||
      value.status === "cancelled" ||
      value.status === "recovery_cancelled" ||
      value.status === "recovery_required")
  );
}
function isMutationFailureFact(value: unknown): value is CreatorMutationFailureFact {
  return (
    isRecord(value) && isNonEmpty(value.code) && isNonEmpty(value.detail) && isHash(value.hash)
  );
}
function hasCanonicalFailureFacts(value: unknown): value is readonly CreatorMutationFailureFact[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isMutationFailureFact))
    return false;
  const rebuilt = createMutationFailureFacts(
    value.map((fact) => ({ code: fact.code, detail: fact.detail })),
  );
  return stableJson(rebuilt) === stableJson(value);
}
function hasCanonicalHash(value: unknown): boolean {
  if (!isRecord(value) || !isHash(value.hash)) return false;
  const { hash, ...content } = value;
  return contentHash(stableJson(content)) === hash;
}
function factMatchesTarget(left: StudioEvidenceTarget, right: StudioEvidenceTarget): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "project" ||
      right.kind === "project" ||
      (studioObjectIdentityKey(left.identity) === studioObjectIdentityKey(right.identity) &&
        left.path === right.path &&
        left.className === right.className))
  );
}
/** Mutations preserve the exact authority namespace selected by the project index. */
function mutationTargetObjectId(target: StudioInstanceEvidenceTarget): string {
  return studioObjectIdentityKey(target.identity);
}
function sameTarget(left: StudioEvidenceTarget, right: StudioEvidenceTarget): boolean {
  return factMatchesTarget(left, right);
}
function sameProject(left: StudioProjectIdentity, right: StudioProjectIdentity): boolean {
  return (
    left.name === right.name &&
    left.placeId === right.placeId &&
    left.universeId === right.universeId
  );
}
function assertCreatorMutationBinding(
  binding: StudioEvidenceBinding,
  label: string,
): asserts binding is StudioCreatorMutationBinding {
  if (!isStudioCreatorMutationBinding(binding))
    throw new Error(`${label} must use the closed creator mutation binding schema`);
}
/**
 * Derive the one post-state identity namespace for the whole recording.
 *
 * A Studio ephemeral identity may appear in a target, another operation's
 * structural parent, and arbitrary `instance_ref` values. Treating enrollment
 * as an operation-local rewrite lets those facts disagree about which object
 * exists after Apply. This map is therefore constructed before any operation
 * is materialized and rejects two source identities that claim the same
 * durable Forge identity.
 */
function collectPostStateTargets(
  operations: readonly CreatorMutationStudioOperation[],
  initialTopology: readonly CreatorTransactionTopologyNode[],
): ReadonlyMap<string, StudioInstanceEvidenceTarget> {
  const topology = compileCreatorTransactionTopology({
    initial: initialTopology,
    operations,
  });
  const targetsByPreIdentity = new Map<string, StudioInstanceEvidenceTarget>();
  for (const node of topology.finalNodes) {
    const target: StudioInstanceEvidenceTarget = {
      kind: "instance",
      identity: node.identity,
      path: node.path,
      className: node.className,
    };
    if (targetsByPreIdentity.has(node.originalIdentityKey))
      throw new Error(
        `Creator mutation topology has duplicate final target for ${node.originalIdentityKey}`,
      );
    targetsByPreIdentity.set(node.originalIdentityKey, target);
  }

  for (const operation of operations) {
    const preIdentity = studioObjectIdentityKey(operation.target.identity);
    const enrolledTarget = postMutationTargetForOperation(operation);
    const topologyTarget = targetsByPreIdentity.get(preIdentity);
    if (topologyTarget === undefined && operation.kind !== "delete")
      throw new Error(`Creator mutation topology lost post-state target ${preIdentity}`);
    const postTarget =
      topologyTarget === undefined
        ? enrolledTarget
        : {
            ...topologyTarget,
            identity: enrolledTarget.identity,
          };
    if (
      topologyTarget !== undefined &&
      (topologyTarget.className !== operation.target.className ||
        (operation.kind !== "create" &&
          studioObjectIdentityKey(topologyTarget.identity) !== preIdentity))
    )
      throw new Error(`Creator mutation topology contradicts approved target ${preIdentity}`);
    targetsByPreIdentity.set(preIdentity, postTarget);
  }

  const preIdentityByPostIdentity = new Map<string, string>();
  for (const [preIdentity, postTarget] of targetsByPreIdentity) {
    const postIdentity = studioObjectIdentityKey(postTarget.identity);
    const existingPreIdentity = preIdentityByPostIdentity.get(postIdentity);
    if (existingPreIdentity !== undefined && existingPreIdentity !== preIdentity)
      throw new Error(
        `Creator mutation transaction has colliding post-state identity enrollment for ${postIdentity}`,
      );
    preIdentityByPostIdentity.set(postIdentity, preIdentity);
  }
  return targetsByPreIdentity;
}

function postMutationTargetForOperation(
  operation: CreatorMutationStudioOperation,
): StudioInstanceEvidenceTarget {
  switch (operation.kind) {
    case "create":
      return postMutationTarget(operation.target, undefined);
    case "move":
      return postMutationTarget(
        {
          ...operation.target,
          path: joinStudioPath(operation.parent.path, operation.name),
        },
        operation.enrollment,
      );
    case "update":
    case "delete":
    case "edit_source":
      return postMutationTarget(operation.target, operation.enrollment);
  }
}

function postMutationTarget(
  target: StudioInstanceEvidenceTarget,
  enrollment: StudioIdentityEnrollment | undefined,
): StudioInstanceEvidenceTarget {
  if (!isStudioPath(target.path) || !isNonEmpty(target.className))
    throw new Error("Creator mutation operation has an invalid instance target");
  if (!enrollment) return target;
  if (
    target.identity.kind !== "studio_ephemeral" ||
    studioObjectIdentityKey(target.identity) !== studioObjectIdentityKey(enrollment.identity)
  )
    throw new Error("Creator mutation enrollment does not bind its exact ephemeral target");
  return {
    ...target,
    identity: { kind: "forge_attribute", stableId: enrollment.stableId },
  };
}

/** Rewrite a post-state target, never a pre-state/before target. */
function rewritePostStateTarget(
  target: StudioInstanceEvidenceTarget,
  postStateTargets: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): StudioInstanceEvidenceTarget {
  return postStateTargets.get(studioObjectIdentityKey(target.identity)) ?? target;
}

/**
 * Properties can point at an object enrolled elsewhere in the same approved
 * transaction, including the target itself. Their path and class follow that
 * target's exact post-state target as well as its durable identity.
 */
function rewritePostStateProperties(
  properties: Readonly<Record<string, StudioValue>>,
  postStateTargets: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): Readonly<Record<string, StudioValue>> {
  let changed = false;
  const rewritten: Record<string, StudioValue> = {};
  for (const [name, value] of Object.entries(properties)) {
    const next = rewritePostStateStudioValue(value, postStateTargets);
    changed ||= next !== value;
    rewritten[name] = next;
  }
  return changed ? rewritten : properties;
}

function rewritePostStateStudioValue(
  value: StudioValue,
  postStateTargets: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): StudioValue {
  if (value.kind !== "instance_ref" || value.state !== "reference") return value;
  const target = postStateTargets.get(studioObjectIdentityKey(value.identity));
  if (target === undefined) return value;
  if (
    studioObjectIdentityKey(value.identity) === studioObjectIdentityKey(target.identity) &&
    value.path === target.path &&
    value.className === target.className
  )
    return value;
  return {
    ...value,
    identity: target.identity,
    path: target.path,
    className: target.className,
  };
}

function structureFor(
  target: StudioInstanceEvidenceTarget,
  parent: CreatorMutationParent,
  structuralParent: StudioInstanceEvidenceTarget | undefined,
  postStateTargets: ReadonlyMap<string, StudioInstanceEvidenceTarget>,
): import("../../studio-evidence/src/index.js").StudioStructureValue {
  if (
    parent.kind === "engine_container" &&
    structuralParent !== undefined &&
    (structuralParent.path !== parent.path || structuralParent.className !== parent.className)
  )
    throw new Error("Captured engine-container parent does not match the approved parent");
  const rawParent = parent.kind === "instance" ? parent : structuralParent;
  const postStateParent =
    rawParent === undefined ? undefined : rewritePostStateTarget(rawParent, postStateTargets);
  return {
    identity: target.identity,
    path: target.path,
    className: target.className,
    ...(postStateParent === undefined ? {} : { parentIdentity: postStateParent.identity }),
    parentPath: postStateParent?.path ?? parent.path,
  };
}
function joinStudioPath(parentPath: string, name: string): string {
  if (!isStudioPath(parentPath) || !isNonEmpty(name) || name.includes("/"))
    throw new Error("Creator mutation operation has an invalid parent path or name");
  return `${parentPath}/${name}`;
}
function isStudioPath(value: string): boolean {
  return (
    isNonEmpty(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
function isDescendantPath(path: string, ancestor: string): boolean {
  return isStudioPath(path) && isStudioPath(ancestor) && path.startsWith(`${ancestor}/`);
}
function isStudioValue(value: unknown): value is StudioValue {
  try {
    assertStudioValue(value);
    return true;
  } catch {
    return false;
  }
}
function isProject(value: unknown): value is StudioProjectIdentity {
  return (
    isRecord(value) &&
    isNonEmpty(value.name) &&
    typeof value.placeId === "number" &&
    Number.isSafeInteger(value.placeId) &&
    value.placeId >= 0 &&
    typeof value.universeId === "number" &&
    Number.isSafeInteger(value.universeId) &&
    value.universeId >= 0
  );
}
function sameOptionalJson(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined
    ? left === right
    : stableJson(left) === stableJson(right);
}
function compareFailureFacts(
  left: CreatorMutationFailureFact,
  right: CreatorMutationFailureFact,
): number {
  return (
    left.hash.localeCompare(right.hash) ||
    left.code.localeCompare(right.code) ||
    left.detail.localeCompare(right.detail)
  );
}
function safeHash(value: unknown): string {
  return isHash(value) ? value : contentHash(stableJson({ invalid: String(value) }));
}
function recordHash(value: unknown, field: string): string {
  return isRecord(value) ? safeHash(value[field]) : safeHash(undefined);
}
function nestedRecordHash(value: unknown, parent: string, field: string): string {
  return isRecord(value) && isRecord(value[parent])
    ? safeHash(value[parent][field])
    : safeHash(undefined);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
