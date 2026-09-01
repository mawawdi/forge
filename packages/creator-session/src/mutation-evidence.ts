import {
  assertEvidenceAgainstProjection,
  assertStudioCapabilityAttestation,
  assertStudioCapabilityManifest,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceProjection,
  assertStudioStateRevision,
  assertStudioValue,
  compileMutationEvidenceProjection,
  compileMutationEvidenceProjectionForManifest,
  createStudioStateRevision,
  studioEvidenceFactMaterial,
  studioValuesEqual,
  type MutationEvidenceOperation,
  type MutationEvidenceProjectionInput,
  type StudioCapabilityManifest,
  type StudioEvidenceBinding,
  type StudioEvidenceEnvelope,
  type StudioEvidenceFact,
  type StudioEvidenceProjection,
  type StudioEvidenceTarget,
  type StudioProjectIdentity,
  type StudioRequirementValue,
  type StudioStateRevision,
  type StudioValue,
} from "../../studio-evidence/src/index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { CreatorChangeSet, StudioChangeOperation } from "./index.js";

/** The only statuses a mutation reconciler can produce. */
export type CreatorMutationReconciliationStatus =
  | "matched"
  | "mismatched"
  | "incomplete";

export interface CreatorMutationFailureFact {
  readonly code: string;
  readonly detail: string;
  readonly hash: string;
}

export type CreatorMutationFailureInput =
  | string
  | { readonly code: string; readonly detail: string };

export interface CreatorMutationChangeSetLike {
  readonly kind: "CreatorChangeSet";
  readonly id: string;
  readonly hash: string;
  readonly project: StudioEvidenceProjection["project"];
  readonly binding: StudioEvidenceBinding;
  readonly projectionId: string;
  readonly operations: readonly MutationEvidenceOperation[];
  /** Every state-fact key that the approved mutation is permitted to change. */
  readonly allowedStateDelta: readonly string[];
}

export type StudioInstanceEvidenceTarget = Extract<
  StudioEvidenceTarget,
  { readonly kind: "instance" }
>;

/**
 * Extra delete identities are supplied from complete pre-apply inventory
 * evidence. The root delete is always included by the adapter itself.
 */
export interface CreatorChangeSetDeleteSubtree {
  readonly operationId: string;
  readonly descendants: readonly StudioInstanceEvidenceTarget[];
}

export interface CreatorChangeSetProjectionContext {
  readonly project: StudioProjectIdentity;
  readonly binding: StudioEvidenceBinding;
  /** Complete, canonical fact-key allowlist for the project-state delta. */
  readonly allowedStateDelta: readonly string[];
  readonly purpose?: MutationEvidenceProjectionInput["purpose"];
  readonly projectionId?: string;
  readonly deletedSubtrees?: readonly CreatorChangeSetDeleteSubtree[];
}

/**
 * The connector persists this deterministic identity before it reads a newly
 * created object back. It is never a random Studio-generated identity.
 */
export function creatorMutationCreateStableId(
  changeSet: Pick<CreatorChangeSet, "id">,
  tempId: string,
): string {
  if (!isNonEmpty(changeSet.id) || !isNonEmpty(tempId))
    throw new Error("Creator mutation create identity requires a change set and temp ID");
  return `${changeSet.id}:${tempId}`;
}

/** The projection identity is data-derived and independent of wall-clock time. */
export function creatorChangeSetMutationProjectionId(
  changeSet: Pick<CreatorChangeSet, "hash">,
  purpose: NonNullable<MutationEvidenceProjectionInput["purpose"]> = "mutation_direct_readback",
): string {
  if (!isHash(changeSet.hash))
    throw new Error("Creator mutation projection requires a sealed change-set hash");
  return `creator_mutation_${purpose}_${changeSet.hash.slice(0, 24)}`;
}

/**
 * Convert the real sealed CreatorChangeSet operation union into generated
 * evidence operations. It is pure and cannot inspect Studio or any provider.
 */
export function adaptCreatorChangeSetMutationOperations(
  changeSet: CreatorChangeSet,
  deletedSubtrees: readonly CreatorChangeSetDeleteSubtree[] = [],
): readonly MutationEvidenceOperation[] {
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
    const descendants = [...subtree.descendants];
    if (descendants.length > 64)
      throw new Error("Deleted subtree exceeds the bounded evidence limit");
    const seen = new Set<string>();
    for (const descendant of descendants) {
      if (
        descendant.kind !== "instance" ||
        !isNonEmpty(descendant.stableId) ||
        !isNonEmpty(descendant.path) ||
        !isNonEmpty(descendant.className) ||
        seen.has(descendant.stableId)
      )
        throw new Error("Deleted subtree contains an invalid or duplicate identity");
      seen.add(descendant.stableId);
    }
    subtreeByOperation.set(subtree.operationId, descendants);
  }

  const operations: MutationEvidenceOperation[] = [];
  for (const operation of changeSet.operations) {
    operations.push(adaptStudioChangeOperation(changeSet, operation));
    if (operation.kind !== "delete") continue;
    const descendants = subtreeByOperation.get(operation.id) ?? [];
    for (const descendant of descendants) {
      if (
        descendant.stableId === operation.stableId ||
        !isDescendantPath(descendant.path, operation.expectedPath)
      )
        throw new Error("Deleted subtree identity is not a proper descendant of its delete target");
      operations.push({
        id: `${operation.id}:delete:${descendant.stableId}`,
        kind: "delete",
        target: descendant,
        structureStatus: "absent",
      });
    }
  }
  const operationIds = new Set<string>();
  for (const operation of operations) {
    if (operationIds.has(operation.id))
      throw new Error("Mutation evidence operation IDs must be unique");
    operationIds.add(operation.id);
  }
  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

/**
 * Compile a real sealed CreatorChangeSet to its deterministic, manifest-bound
 * projection. Coordinator code can call this without unsafe type casts.
 */
export function compileCreatorChangeSetMutationProjection(
  changeSet: CreatorChangeSet,
  context: CreatorChangeSetProjectionContext,
): StudioEvidenceProjection {
  assertCreatorChangeSetProjectionContext(changeSet, context);
  const purpose = context.purpose ?? "mutation_direct_readback";
  return compileMutationEvidenceProjection({
    id:
      context.projectionId ??
      creatorChangeSetMutationProjectionId(changeSet, purpose),
    project: context.project,
    binding: context.binding,
    operations: adaptCreatorChangeSetMutationOperations(
      changeSet,
      context.deletedSubtrees,
    ),
    purpose,
    allowedStateDelta: context.allowedStateDelta,
  });
}

export interface CreatorMutationEvidence {
  readonly projection: StudioEvidenceProjection;
  readonly envelope: StudioEvidenceEnvelope;
}

export interface CreatorMutationStateEvidence extends CreatorMutationEvidence {
  readonly revision: StudioStateRevision;
}

export interface CreatorMutationReconciliationInput {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly manifest: StudioCapabilityManifest;
  readonly manifestHash: string;
  readonly changeSet: CreatorMutationChangeSetLike;
  /** The sealed projection that describes exact mutation postconditions. */
  readonly projection: StudioEvidenceProjection;
  /** Detached canary proof. It has its own explicitly bound projection. */
  readonly preflight: CreatorMutationEvidence;
  /** Direct engine readback from the provisionally changed objects. */
  readonly directReadback: StudioEvidenceEnvelope;
  readonly beforeState: CreatorMutationStateEvidence;
  readonly afterState: CreatorMutationStateEvidence;
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
  readonly beforeStateProjectionHash: string;
  readonly beforeStateBindingHash: string;
  readonly beforeStateHash: string;
  readonly afterStateProjectionHash: string;
  readonly afterStateBindingHash: string;
  readonly afterStateHash: string;
  readonly failureFacts: readonly CreatorMutationFailureFact[];
}

/** A hash-bound immutable artifact. `hash` is the semantic object hash. */
export interface CreatorMutationArtifactBinding {
  readonly artifact: ArtifactReference;
  readonly hash: string;
}

export interface CreatorMutationArtifactEvidence {
  readonly projection: CreatorMutationArtifactBinding;
  readonly envelope: CreatorMutationArtifactBinding;
}

export interface CreatorMutationArtifactStateEvidence
  extends CreatorMutationArtifactEvidence {
  readonly revision: CreatorMutationArtifactBinding;
}

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
  readonly beforeRevisionHash: string;
  readonly recordingId: string;
  /** Present only when a complete mutation reconciliation was produced. */
  readonly reconciliationHash?: string;
  readonly action: "commit" | "cancel" | "recovery_cancel";
  readonly afterRevisionHash: string;
  readonly postFinalizeProjectionHash: string;
  readonly postFinalizeEvidenceHash: string;
  readonly status:
    | "committed"
    | "cancelled"
    | "recovery_cancelled"
    | "recovery_required";
}

/**
 * Append-only mutation evidence.  The store owns the bytes; this object owns
 * just content-addressed references and the semantically meaningful hashes.
 */
export interface CreatorSettledMutationAttempt {
  readonly kind: "CreatorMutationAttempt";
  readonly id: string;
  readonly hash: string;
  readonly sessionId: string;
  readonly completion: "settled";
  readonly manifest: CreatorMutationArtifactBinding;
  /** Exact ReflectionService evidence from the paired connector used for this attempt. */
  readonly attestation: CreatorMutationArtifactEvidence;
  readonly changeSet: CreatorMutationArtifactBinding;
  readonly projection: CreatorMutationArtifactBinding;
  readonly preflight: CreatorMutationArtifactEvidence;
  readonly directReadback: CreatorMutationArtifactBinding;
  readonly beforeState: CreatorMutationArtifactStateEvidence;
  readonly afterState: CreatorMutationArtifactStateEvidence;
  readonly finalState: CreatorMutationArtifactStateEvidence;
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
  readonly beforeState: CreatorMutationArtifactStateEvidence;
  readonly failureFacts: readonly CreatorMutationFailureFact[];
}

/** A failed detached canary is evidence, but never a reconciliation verdict. */
export interface CreatorIncompletePreflightMutationAttempt
  extends CreatorIncompleteMutationAttemptBase {
  readonly phase: "preflight";
  readonly preflight?: CreatorMutationArtifactEvidence;
}

/** A same-call execution failure is closed only by cancellation and final state evidence. */
export interface CreatorIncompleteApplyMutationAttempt
  extends CreatorIncompleteMutationAttemptBase {
  readonly phase: "apply";
  readonly preflight: CreatorMutationArtifactEvidence;
  readonly finalState: CreatorMutationArtifactStateEvidence;
  readonly finalization: CreatorMutationArtifactBinding;
}

export type CreatorIncompleteMutationAttempt =
  | CreatorIncompletePreflightMutationAttempt
  | CreatorIncompleteApplyMutationAttempt;

export type CreatorMutationAttempt =
  | CreatorSettledMutationAttempt
  | CreatorIncompleteMutationAttempt;

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
  const payload = { ...base, id };
  const finalization = Object.freeze({
    ...payload,
    hash: contentHash(stableJson(payload)),
  });
  if (!isFinalization(finalization))
    throw new Error("Invalid CreatorMutationFinalization");
  return finalization;
}

export function createCreatorMutationAttempt(
  id: string,
  input: Omit<CreatorSettledMutationAttempt, "kind" | "id" | "hash" | "completion">,
): CreatorSettledMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = { kind: "CreatorMutationAttempt" as const, id, completion: "settled" as const, ...input };
  const attempt = Object.freeze({ ...payload, hash: contentHash(stableJson(payload)) });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createIncompleteCreatorMutationAttempt(
  id: string,
  input: Omit<CreatorIncompletePreflightMutationAttempt, "kind" | "id" | "hash" | "completion" | "phase">,
): CreatorIncompletePreflightMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "incomplete" as const,
    phase: "preflight" as const,
    ...input,
  };
  const attempt = Object.freeze({ ...payload, hash: contentHash(stableJson(payload)) });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

export function createIncompleteApplyMutationAttempt(
  id: string,
  input: Omit<CreatorIncompleteApplyMutationAttempt, "kind" | "id" | "hash" | "completion" | "phase">,
): CreatorIncompleteApplyMutationAttempt {
  if (!isNonEmpty(id)) throw new Error("Creator mutation attempt requires an ID");
  const payload = {
    kind: "CreatorMutationAttempt" as const,
    id,
    completion: "incomplete" as const,
    phase: "apply" as const,
    ...input,
  };
  const attempt = Object.freeze({ ...payload, hash: contentHash(stableJson(payload)) });
  assertCreatorMutationAttempt(attempt);
  return attempt;
}

/**
 * Canonical, de-duplicated failure facts.  They are intentionally descriptive
 * evidence rather than inferred Studio values, so a missing read cannot turn
 * into a fabricated mismatch.
 */
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
  const deduplicated = new Map<string, CreatorMutationFailureFact>();
  for (const fact of facts) deduplicated.set(fact.hash, fact);
  return Object.freeze(
    [...deduplicated.values()].sort(
      (left, right) =>
        left.hash.localeCompare(right.hash) ||
        left.code.localeCompare(right.code) ||
        left.detail.localeCompare(right.detail),
    ),
  );
}

/**
 * Pure reconciliation of stored evidence.  It has no connector, provider, or
 * Studio dependency: malformed or unavailable evidence is always incomplete.
 */
export function reconcileCreatorMutation(
  input: CreatorMutationReconciliationInput,
): CreatorMutationReconciliation {
  const incomplete: CreatorMutationFailureInput[] = [];
  const mismatched: CreatorMutationFailureInput[] = [];
  const addIncomplete = (code: string, detail: string): void => {
    incomplete.push({ code, detail });
  };
  const addMismatch = (code: string, detail: string): void => {
    mismatched.push({ code, detail });
  };

  if (!isNonEmpty(input.sessionId) || !isNonEmpty(input.attemptId))
    addIncomplete("mutation_binding_invalid", "Mutation session or attempt identity is missing.");
  try {
    assertStudioCapabilityManifest(input.manifest);
  } catch (error) {
    addIncomplete("manifest_invalid", `Stored capability manifest is invalid: ${errorMessage(error)}`);
  }
  if (contentHash(stableJson(input.manifest)) !== input.manifestHash)
    addIncomplete("manifest_binding_invalid", "Stored capability manifest does not match its immutable hash binding.");

  const changeSet = input.changeSet;
  if (!isChangeSet(changeSet)) {
    addIncomplete("change_set_invalid", "The sealed creator change set is invalid.");
  } else {
    if (!isHash(changeSet.hash))
      addIncomplete("change_set_binding_invalid", "The sealed creator change set has no valid hash.");
    if (changeSet.binding.changeSetHash !== changeSet.hash)
      addIncomplete("change_set_binding_invalid", "The change-set binding does not name the sealed change-set hash.");
    if (!sortedUnique(changeSet.allowedStateDelta))
      addIncomplete("state_delta_invalid", "The approved state delta is missing, duplicated, or not in canonical order.");
  }

  const projection = input.projection;
  try {
    assertStudioEvidenceProjection(projection, input.manifest);
  } catch (error) {
    addIncomplete("mutation_projection_invalid", `Mutation projection is invalid: ${errorMessage(error)}`);
  }
  if (projection.manifestHash !== input.manifestHash)
    addIncomplete("mutation_projection_binding_invalid", "Mutation projection manifest binding differs from the attempt manifest.");
  if (projection.purpose !== "mutation_direct_readback")
    addIncomplete("mutation_projection_invalid", "Mutation projection must be a direct-readback projection.");
  if (isChangeSet(changeSet)) {
    if (!sameBinding(projection.binding, changeSet.binding))
      addIncomplete("mutation_projection_binding_invalid", "Mutation projection binding differs from the sealed change set.");
    if (projection.id !== changeSet.projectionId)
      addIncomplete("mutation_projection_binding_invalid", "Mutation projection identity differs from the sealed change set.");
    if (!sameStringArray(projection.allowedStateDelta ?? [], changeSet.allowedStateDelta))
      addIncomplete("state_delta_binding_invalid", "Mutation projection does not declare the complete approved state delta.");
    try {
      const recompiled = compileMutationEvidenceProjectionForManifest(
        {
          id: changeSet.projectionId,
          project: changeSet.project,
          binding: changeSet.binding,
          operations: changeSet.operations,
          purpose: "mutation_direct_readback",
          allowedStateDelta: changeSet.allowedStateDelta,
        },
        input.manifest,
        input.manifestHash,
      );
      if (recompiled.contentHash !== projection.contentHash)
        addIncomplete("mutation_projection_recompile_failed", "Stored mutation projection does not equal deterministic recompilation.");
    } catch (error) {
      addIncomplete("mutation_projection_recompile_failed", `Mutation projection could not be recompiled: ${errorMessage(error)}`);
    }
  }

  validateExactEvidence(
    input.directReadback,
    projection,
    input.manifest,
    "direct_readback",
    addIncomplete,
    addMismatch,
  );
  validatePreflight(
    input.preflight,
    input.manifest,
    input.manifestHash,
    changeSet,
    addIncomplete,
  );
  validateProjectState(
    input.beforeState,
    input.manifest,
    input.manifestHash,
    changeSet,
    "before_state",
    addIncomplete,
  );
  validateProjectState(
    input.afterState,
    input.manifest,
    input.manifestHash,
    changeSet,
    "after_state",
    addIncomplete,
  );

  if (incomplete.length === 0) {
    const allowed = new Set(changeSet.allowedStateDelta);
    const before = indexFacts(input.beforeState.envelope.facts);
    const after = indexFacts(input.afterState.envelope.facts);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(key);
      const right = after.get(key);
      if (sameFact(left, right)) continue;
      if (!allowed.has(key))
        addMismatch("unapproved_observable_delta", `Observable project-state fact changed outside the approved delta: ${key}.`);
    }
    const afterFacts = indexFacts(input.afterState.envelope.facts);
    for (const requirement of projection.requirements) {
      const direct = indexFacts(input.directReadback.facts).get(requirement.key);
      const postState = afterFacts.get(requirement.key);
      if (requirement.expectedStatus === "absent" && direct?.result.status === "absent" && postState === undefined) {
        continue;
      }
      if (direct === undefined || postState === undefined) {
        addIncomplete("post_state_coverage_incomplete", `Post-apply state lacks projected mutation fact: ${requirement.key}.`);
        continue;
      }
      if (!sameFact(direct, postState))
        addMismatch("direct_readback_state_difference", `Direct readback and post-apply project state differ for: ${requirement.key}.`);
    }
  }

  const status: CreatorMutationReconciliationStatus =
    incomplete.length > 0
      ? "incomplete"
      : mismatched.length > 0
        ? "mismatched"
        : "matched";
  const failureFacts = createMutationFailureFacts(
    status === "incomplete" ? incomplete : mismatched,
  );
  const base = {
    kind: "CreatorMutationReconciliation" as const,
    id: `creator_mutation_reconciliation_${input.attemptId}`,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    status,
    manifestHash: input.manifestHash,
    changeSetHash: changeSet.hash,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    preflightProjectionHash: input.preflight.projection.contentHash,
    preflightBindingHash: input.preflight.projection.bindingHash,
    preflightEnvelopeHash: input.preflight.envelope.contentHash,
    directReadbackHash: input.directReadback.contentHash,
    beforeStateProjectionHash: input.beforeState.projection.contentHash,
    beforeStateBindingHash: input.beforeState.projection.bindingHash,
    beforeStateHash: input.beforeState.revision.stateHash,
    afterStateProjectionHash: input.afterState.projection.contentHash,
    afterStateBindingHash: input.afterState.projection.bindingHash,
    afterStateHash: input.afterState.revision.stateHash,
    failureFacts,
  };
  return freeze({ ...base, hash: contentHash(stableJson(base)) });
}

/**
 * Reconstruct an attempt solely from immutable artifacts and reproduce its
 * reconciliation.  A recorded mismatch is successful replay when reproduced.
 */
export async function replayCreatorMutation(
  attempt: CreatorMutationAttempt,
  store: ImmutableJsonArtifactStore,
): Promise<CreatorMutationReplay> {
  const base = {
    kind: "CreatorMutationReplay" as const,
    attemptId: attempt.id,
    recordedStatus: "incomplete" as CreatorMutationReconciliationStatus,
    recordedFailureFactHashes: Object.freeze([] as string[]),
  };
  if (!isCreatorMutationAttempt(attempt))
    return replayMismatch(base, "Mutation attempt binding is invalid.");
  if (attempt.completion === "incomplete") {
    try {
      const manifest = await readManifest(store, attempt.manifest);
      const attestationProjection = await readProjection(store, attempt.attestation.projection, manifest);
      const attestationEnvelope = await readEnvelope(store, attempt.attestation.envelope, manifest);
      validateCapabilityAttestation(
        manifest,
        attempt.manifest.hash,
        attestationProjection,
        attestationEnvelope,
      );
      const changeSet = await readChangeSet(store, attempt.changeSet);
      const projection = await readProjection(store, attempt.projection, manifest);
      const preflightProjection = await readProjection(store, attempt.preflightProjection, manifest);
      const beforeProjection = await readProjection(store, attempt.beforeState.projection, manifest);
      const beforeEnvelope = await readEnvelope(store, attempt.beforeState.envelope, manifest);
      const beforeRevision = await readStateRevision(store, attempt.beforeState.revision);
      assertStoredMutationProjection(
        changeSet,
        projection,
        manifest,
        attempt.manifest.hash,
      );
      assertPreflightProjection(
        preflightProjection,
        manifest,
        attempt.manifest.hash,
        changeSet,
      );
      assertProjectStateEvidence(
        { projection: beforeProjection, envelope: beforeEnvelope, revision: beforeRevision },
        manifest,
        attempt.manifest.hash,
        changeSet,
      );
      if (attempt.preflight) {
        const preflightAttemptProjection = await readProjection(store, attempt.preflight.projection, manifest);
        const preflightEnvelope = await readEnvelope(store, attempt.preflight.envelope, manifest);
        if (preflightAttemptProjection.contentHash !== preflightProjection.contentHash)
          throw new Error("Incomplete preflight attempt has conflicting projection bindings");
        assertPreflightEvidence(
          { projection: preflightAttemptProjection, envelope: preflightEnvelope },
          manifest,
          attempt.manifest.hash,
          changeSet,
        );
      }
      if (attempt.phase === "apply") {
        const applyPreflightProjection = await readProjection(store, attempt.preflight.projection, manifest);
        const applyPreflightEnvelope = await readEnvelope(store, attempt.preflight.envelope, manifest);
        const finalProjection = await readProjection(store, attempt.finalState.projection, manifest);
        const finalEnvelope = await readEnvelope(store, attempt.finalState.envelope, manifest);
        const finalRevision = await readStateRevision(store, attempt.finalState.revision);
        const finalization = await readFinalization(store, attempt.finalization);
        assertCompletePreflightEvidence(
          { projection: applyPreflightProjection, envelope: applyPreflightEnvelope },
          manifest,
          attempt.manifest.hash,
          changeSet,
        );
        assertProjectStateEvidence(
          { projection: finalProjection, envelope: finalEnvelope, revision: finalRevision },
          manifest,
          attempt.manifest.hash,
          changeSet,
        );
        if (
          finalization.attemptId !== attempt.id ||
          !finalizationMatchesTransaction(
            finalization,
            attempt.sessionId,
            changeSet,
            projection,
            attempt.manifest.hash,
          ) ||
          finalization.reconciliationHash !== undefined ||
          finalization.afterRevisionHash !== finalRevision.stateHash ||
          finalization.postFinalizeProjectionHash !== finalProjection.contentHash ||
          finalization.postFinalizeEvidenceHash !== finalEnvelope.contentHash ||
          finalization.action !== "cancel" ||
          finalization.status !== "cancelled"
        ) throw new Error("Incomplete apply finalization is not an exact proven cancellation");
      }
    } catch (error) {
      return replayMissing(base, `Incomplete mutation evidence could not be verified: ${errorMessage(error)}`);
    }
    return {
      ...base,
      recordedFailureFactHashes: attempt.failureFacts.map((fact) => fact.hash),
      result: "missing_or_incomplete",
      detail: attempt.phase === "apply"
        ? "The provisionally applied mutation failed and was cancelled, so no matched mutation verdict exists."
        : "The detached capability preflight did not produce passed evidence, so no mutation verdict exists.",
    };
  }

  let manifest: StudioCapabilityManifest;
  let attestationProjection: StudioEvidenceProjection;
  let attestationEnvelope: StudioEvidenceEnvelope;
  let changeSet: CreatorMutationChangeSetLike;
  let projection: StudioEvidenceProjection;
  let preflightProjection: StudioEvidenceProjection;
  let preflightEnvelope: StudioEvidenceEnvelope;
  let directReadback: StudioEvidenceEnvelope;
  let beforeProjection: StudioEvidenceProjection;
  let beforeEnvelope: StudioEvidenceEnvelope;
  let beforeRevision: StudioStateRevision;
  let afterProjection: StudioEvidenceProjection;
  let afterEnvelope: StudioEvidenceEnvelope;
  let afterRevision: StudioStateRevision;
  let finalProjection: StudioEvidenceProjection;
  let finalEnvelope: StudioEvidenceEnvelope;
  let finalRevision: StudioStateRevision;
  let recorded: CreatorMutationReconciliation;
  let finalization: CreatorMutationFinalization;
  try {
    manifest = await readManifest(store, attempt.manifest);
    attestationProjection = await readProjection(store, attempt.attestation.projection, manifest);
    attestationEnvelope = await readEnvelope(store, attempt.attestation.envelope, manifest);
    changeSet = await readChangeSet(store, attempt.changeSet);
    projection = await readProjection(store, attempt.projection, manifest);
    preflightProjection = await readProjection(store, attempt.preflight.projection, manifest);
    preflightEnvelope = await readEnvelope(store, attempt.preflight.envelope, manifest);
    directReadback = await readEnvelope(store, attempt.directReadback, manifest);
    beforeProjection = await readProjection(store, attempt.beforeState.projection, manifest);
    beforeEnvelope = await readEnvelope(store, attempt.beforeState.envelope, manifest);
    beforeRevision = await readStateRevision(store, attempt.beforeState.revision);
    afterProjection = await readProjection(store, attempt.afterState.projection, manifest);
    afterEnvelope = await readEnvelope(store, attempt.afterState.envelope, manifest);
    afterRevision = await readStateRevision(store, attempt.afterState.revision);
    finalProjection = await readProjection(store, attempt.finalState.projection, manifest);
    finalEnvelope = await readEnvelope(store, attempt.finalState.envelope, manifest);
    finalRevision = await readStateRevision(store, attempt.finalState.revision);
    recorded = await readReconciliation(store, attempt.reconciliation);
    finalization = await readFinalization(store, attempt.finalization);
  } catch (error) {
    return replayMissing(base, `Required mutation evidence could not be read: ${errorMessage(error)}`);
  }

  const replayBase = {
    ...base,
    recordedStatus: recorded.status,
    recordedFailureFactHashes: Object.freeze(recorded.failureFacts.map((fact) => fact.hash)),
  };
  try {
    validateCapabilityAttestation(
      manifest,
      attempt.manifest.hash,
      attestationProjection,
      attestationEnvelope,
    );
  } catch (error) {
    return replayMissing(
      replayBase,
      `Capability attestation is missing, incompatible, or incomplete: ${errorMessage(error)}`,
    );
  }
  try {
    assertStoredMutationProjection(
      changeSet,
      projection,
      manifest,
      attempt.manifest.hash,
    );
    assertCompletePreflightEvidence(
      { projection: preflightProjection, envelope: preflightEnvelope },
      manifest,
      attempt.manifest.hash,
      changeSet,
    );
    assertProjectStateEvidence(
      { projection: finalProjection, envelope: finalEnvelope, revision: finalRevision },
      manifest,
      attempt.manifest.hash,
      changeSet,
    );
  } catch (error) {
    return replayMissing(
      replayBase,
      `Final mutation evidence is missing, malformed, or improperly bound: ${errorMessage(error)}`,
    );
  }
  if (
    recorded.attemptId !== attempt.id ||
    recorded.sessionId !== attempt.sessionId ||
    finalization.attemptId !== attempt.id ||
    !finalizationMatchesTransaction(
      finalization,
      attempt.sessionId,
      changeSet,
      projection,
      attempt.manifest.hash,
    ) ||
    finalization.reconciliationHash !== recorded.hash
  )
    return replayMismatch(replayBase, "Attempt, reconciliation, or finalization bindings changed.");
  if (
    finalization.afterRevisionHash !== finalRevision.stateHash ||
    finalization.postFinalizeProjectionHash !== finalProjection.contentHash ||
    finalization.postFinalizeEvidenceHash !== finalEnvelope.contentHash
  ) return replayMismatch(replayBase, "Finalization state-evidence bindings changed.");
  if (!finalizationMatchesReconciliation(finalization, recorded))
    return replayMismatch(replayBase, "Finalization action is not legal for the recorded reconciliation.");

  const replayed = reconcileCreatorMutation({
    sessionId: attempt.sessionId,
    attemptId: attempt.id,
    manifest,
    manifestHash: attempt.manifest.hash,
    changeSet,
    projection,
    preflight: { projection: preflightProjection, envelope: preflightEnvelope },
    directReadback,
    beforeState: { projection: beforeProjection, envelope: beforeEnvelope, revision: beforeRevision },
    afterState: { projection: afterProjection, envelope: afterEnvelope, revision: afterRevision },
  });
  if (replayed.status === "incomplete")
    return {
      ...replayBase,
      result: "missing_or_incomplete",
      replayedStatus: replayed.status,
      replayedFailureFactHashes: Object.freeze(replayed.failureFacts.map((fact) => fact.hash)),
      detail: "Stored mutation evidence is missing, unavailable, malformed, or incomplete.",
    };
  const exact =
    sameReconciliation(recorded, replayed) &&
    recorded.hash === attempt.reconciliation.hash;
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
  changeSet: CreatorChangeSet,
  operation: StudioChangeOperation,
): MutationEvidenceOperation {
  switch (operation.kind) {
    case "create": {
      const target = instanceTarget(
        creatorMutationCreateStableId(changeSet, operation.tempId),
        joinStudioPath(operation.parentPath, operation.name),
        operation.className,
      );
      return {
        id: operation.id,
        kind: "create",
        target,
        properties: operation.properties,
        attributes: operation.attributes,
        ...(operation.source === undefined
          ? {}
          : { sourceHash: contentHash(operation.source) }),
        structure: {
          stableId: target.stableId,
          path: target.path,
          className: target.className,
          parentPath: operation.parentPath,
        },
      };
    }
    case "update":
      return {
        id: operation.id,
        kind: "update",
        target: instanceTarget(
          operation.stableId,
          operation.expectedPath,
          operation.expectedClass,
        ),
        properties: operation.properties,
        attributes: operation.attributes,
        removedAttributes: operation.removedAttributes,
      };
    case "move": {
      const target = instanceTarget(
        operation.stableId,
        joinStudioPath(operation.parentPath, operation.name),
        operation.expectedClass,
      );
      return {
        id: operation.id,
        kind: "move",
        target,
        properties: operation.properties,
        attributes: operation.attributes,
        removedAttributes: operation.removedAttributes,
        structure: {
          stableId: target.stableId,
          path: target.path,
          className: target.className,
          parentPath: operation.parentPath,
        },
      };
    }
    case "delete":
      return {
        id: operation.id,
        kind: "delete",
        target: instanceTarget(
          operation.stableId,
          operation.expectedPath,
          operation.expectedClass,
        ),
        structureStatus: "absent",
      };
    case "write_source":
      return {
        id: operation.id,
        kind: "write_source",
        target: instanceTarget(
          operation.stableId,
          operation.expectedPath,
          operation.expectedClass,
        ),
        attributes: operation.attributes,
        removedAttributes: operation.removedAttributes,
        sourceHash: contentHash(operation.source),
      };
  }
}

function assertCreatorChangeSetProjectionContext(
  changeSet: CreatorChangeSet,
  context: CreatorChangeSetProjectionContext,
): void {
  if (!isHash(changeSet.hash) || !isNonEmpty(changeSet.sessionId))
    throw new Error("Mutation projection requires a sealed creator change set");
  if (
    context.binding.changeSetHash !== changeSet.hash ||
    context.binding.sessionId !== changeSet.sessionId ||
    context.binding.revisionHash !== changeSet.expectedRevisionHash ||
    context.binding.buildHash !== changeSet.buildContractHash
  )
    throw new Error("Mutation projection context is not bound to the sealed change set");
  if (
    !isNonEmpty(context.project.name) ||
    !Number.isSafeInteger(context.project.placeId) ||
    context.project.placeId < 0 ||
    !Number.isSafeInteger(context.project.universeId) ||
    context.project.universeId < 0 ||
    !sortedUnique(context.allowedStateDelta)
  )
    throw new Error("Mutation projection context has invalid project identity or state delta");
  if (
    context.purpose !== undefined &&
    ![
      "mutation_preflight",
      "mutation_direct_readback",
      "mutation_post_state",
    ].includes(context.purpose)
  )
    throw new Error("Mutation projection context has an invalid purpose");
}

function instanceTarget(
  stableId: string,
  path: string,
  className: string,
): StudioInstanceEvidenceTarget {
  if (!isNonEmpty(stableId) || !isStudioPath(path) || !isNonEmpty(className))
    throw new Error("Creator mutation operation has an invalid instance identity");
  return { kind: "instance", stableId, path, className };
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
    incomplete(`${label}_binding_invalid`, `${label} envelope does not bind the exact mutation projection.`);
    return;
  }
  if (envelope.completion !== "complete") {
    incomplete(`${label}_incomplete`, `${label} envelope is incomplete.`);
    return;
  }
  const facts = indexFacts(envelope.facts);
  if (facts.size !== envelope.facts.length || facts.size !== projection.requirements.length) {
    incomplete(`${label}_coverage_invalid`, `${label} has missing, duplicate, or extra facts.`);
    return;
  }
  for (const requirement of projection.requirements) {
    const fact = facts.get(requirement.key);
    if (fact === undefined || !factMatchesRequirement(fact, requirement)) {
      incomplete(`${label}_coverage_invalid`, `${label} does not contain required fact: ${requirement.key}.`);
      continue;
    }
    if (fact.result.status === "unavailable" || fact.result.status === "read_error") {
      incomplete(`${label}_fact_unavailable`, `${label} could not read required fact: ${requirement.key}.`);
      continue;
    }
    const expectedStatus = requirement.expectedStatus ?? "observed";
    if (expectedStatus === "absent") {
      if (fact.result.status !== "absent")
        mismatched(`${label}_fact_mismatch`, `${label} fact expected absent but was observed: ${requirement.key}.`);
    } else if (fact.result.status !== "observed") {
      mismatched(`${label}_fact_mismatch`, `${label} fact differs from the approved projection: ${requirement.key}.`);
    } else if (
      requirement.expected !== undefined &&
      !sameRequirementValue(fact.result.value, requirement.expected)
    ) {
      mismatched(`${label}_fact_mismatch`, `${label} fact differs from the approved projection: ${requirement.key}.`);
    }
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
  } catch (error) {
    incomplete("capability_preflight_failed", `Preflight evidence is incomplete or invalid: ${errorMessage(error)}`);
    return;
  }
  try {
    assertPreflightProjection(preflight.projection, manifest, manifestHash, changeSet);
  } catch (error) {
    incomplete("capability_preflight_binding_invalid", `Preflight evidence is not bound to the sealed mutation: ${errorMessage(error)}`);
  }
}

function assertPreflightEvidence(
  preflight: CreatorMutationEvidence,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
): void {
  assertStudioEvidenceProjection(preflight.projection, manifest);
  assertEvidenceAgainstProjection(preflight.envelope, preflight.projection, manifest);
  assertPreflightProjection(preflight.projection, manifest, manifestHash, changeSet);
}

function assertCompletePreflightEvidence(
  preflight: CreatorMutationEvidence,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
): void {
  assertPreflightEvidence(preflight, manifest, manifestHash, changeSet);
  if (preflight.envelope.completion !== "complete")
    throw new Error("Preflight envelope did not contain complete passed evidence");
}

function assertPreflightProjection(
  projection: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
): void {
  assertStudioEvidenceProjection(projection, manifest);
  if (
    projection.manifestHash !== manifestHash ||
    projection.purpose !== "mutation_preflight" ||
    !sameBinding(projection.binding, changeSet.binding)
  )
    throw new Error("Preflight projection is not bound to the sealed mutation");
  const recompiled = compileMutationEvidenceProjectionForManifest(
    {
      id: projection.id,
      project: changeSet.project,
      binding: changeSet.binding,
      operations: changeSet.operations,
      purpose: "mutation_preflight",
      allowedStateDelta: changeSet.allowedStateDelta,
    },
    manifest,
    manifestHash,
  );
  if (recompiled.contentHash !== projection.contentHash)
    throw new Error("Preflight projection does not equal deterministic recompilation");
}

function validateCapabilityAttestation(
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  projection: StudioEvidenceProjection,
  envelope: StudioEvidenceEnvelope,
): void {
  assertStudioCapabilityAttestation(manifest, manifestHash, projection, envelope);
}

function validateProjectState(
  state: CreatorMutationStateEvidence,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
  label: string,
  incomplete: (code: string, detail: string) => void,
): void {
  try {
    assertProjectStateEvidence(state, manifest, manifestHash, changeSet);
  } catch (error) {
    incomplete(`${label}_incomplete`, `${label} project-state evidence is invalid or incomplete: ${errorMessage(error)}`);
  }
}

function assertProjectStateEvidence(
  state: CreatorMutationStateEvidence,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  changeSet: CreatorMutationChangeSetLike,
): void {
  assertStudioEvidenceProjection(state.projection, manifest);
  assertEvidenceAgainstProjection(state.envelope, state.projection, manifest);
  assertStudioStateRevision(state.revision);
  const expected = createStudioStateRevision(
    state.envelope,
    state.projection,
    state.revision.capturedAt,
    manifest,
  );
  if (
    expected.manifestHash !== state.revision.manifestHash ||
    expected.projectionHash !== state.revision.projectionHash ||
    expected.stateDomainHash !== state.revision.stateDomainHash ||
    expected.stateHash !== state.revision.stateHash
  )
    throw new Error("State revision hash differs from its projection and facts");
  if (
    state.projection.manifestHash !== manifestHash ||
    state.projection.scope.mode !== "project_state" ||
    !bindingContains(state.projection.binding, changeSet.binding)
  )
    throw new Error("State evidence is not bound to the sealed mutation");
}

function assertStoredMutationProjection(
  changeSet: CreatorMutationChangeSetLike,
  projection: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
): void {
  assertStudioEvidenceProjection(projection, manifest);
  if (
    projection.manifestHash !== manifestHash ||
    projection.purpose !== "mutation_direct_readback" ||
    !sameBinding(projection.binding, changeSet.binding) ||
    projection.id !== changeSet.projectionId ||
    !sameStringArray(projection.allowedStateDelta ?? [], changeSet.allowedStateDelta)
  ) throw new Error("Mutation projection binding differs from the sealed change set");
  const recompiled = compileMutationEvidenceProjectionForManifest(
    {
      id: changeSet.projectionId,
      project: changeSet.project,
      binding: changeSet.binding,
      operations: changeSet.operations,
      purpose: "mutation_direct_readback",
      allowedStateDelta: changeSet.allowedStateDelta,
    },
    manifest,
    manifestHash,
  );
  if (recompiled.contentHash !== projection.contentHash)
    throw new Error("Mutation projection does not equal deterministic recompilation");
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
    envelope.project.name === projection.project.name &&
    envelope.project.placeId === projection.project.placeId &&
    envelope.project.universeId === projection.project.universeId
  );
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
      (fact.kind === "attribute" && fact.attributeName === requirement.attributeName)) &&
    (requirement.callId === undefined ||
      ("callId" in fact && fact.callId === requirement.callId)) &&
    (requirement.runtimeTargetId === undefined ||
      ("runtimeTargetId" in fact && fact.runtimeTargetId === requirement.runtimeTargetId)) &&
    (requirement.capability === undefined ||
      ("capability" in fact && fact.capability === requirement.capability))
  );
}

function sameRequirementValue(
  observed: unknown,
  expected: StudioRequirementValue,
): boolean {
  if (isStudioValue(observed) && isStudioValue(expected))
    return studioValuesEqual(observed, expected);
  return stableJson(observed) === stableJson(expected);
}

function indexFacts(
  facts: readonly StudioEvidenceFact[],
): ReadonlyMap<string, StudioEvidenceFact> {
  return new Map(facts.map((fact) => [fact.key, fact]));
}

function sameFact(
  left: StudioEvidenceFact | undefined,
  right: StudioEvidenceFact | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return studioEvidenceFactMaterial(left) === studioEvidenceFactMaterial(right);
}

function sameBinding(
  left: StudioEvidenceBinding,
  right: StudioEvidenceBinding,
): boolean {
  return stableJson(definedBinding(left)) === stableJson(definedBinding(right));
}

/** State observations may add their own revision binding but cannot alter mutation bindings. */
function bindingContains(
  candidate: StudioEvidenceBinding,
  required: StudioEvidenceBinding,
): boolean {
  return Object.entries(definedBinding(required)).every(
    ([key, value]) => candidate[key] === value,
  );
}

function definedBinding(binding: StudioEvidenceBinding): Record<string, string> {
  return Object.fromEntries(
    Object.entries(binding).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function readManifest(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<StudioCapabilityManifest> {
  const value = await store.read(binding.artifact);
  assertStudioCapabilityManifest(value);
  if (binding.hash !== contentHash(stableJson(value)))
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
  if (value.contentHash !== binding.hash)
    throw new Error("Projection artifact binding changed");
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

async function readStateRevision(
  store: ImmutableJsonArtifactStore,
  binding: CreatorMutationArtifactBinding,
): Promise<StudioStateRevision> {
  const value = await store.read<StudioStateRevision>(binding.artifact);
  assertStudioStateRevision(value);
  if (value.stateHash !== binding.hash)
    throw new Error("State revision artifact binding changed");
  return value;
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
  if (!isFinalization(value) || value.hash !== binding.hash || !hasCanonicalHash(value))
    throw new Error("Finalization artifact binding changed");
  return value;
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
  const { hash: _leftHash, ...leftContent } = left;
  const { hash: _rightHash, ...rightContent } = right;
  return (
    contentHash(stableJson(leftContent)) === left.hash &&
    contentHash(stableJson(rightContent)) === right.hash &&
    stableJson(leftContent) === stableJson(rightContent)
  );
}

function finalizationMatchesReconciliation(
  finalization: CreatorMutationFinalization,
  reconciliation: CreatorMutationReconciliation,
): boolean {
  if (finalization.action === "commit")
    return finalization.status === "committed" && reconciliation.status === "matched";
  if (finalization.action === "cancel")
    return finalization.status === "cancelled";
  return finalization.status === "recovery_cancelled";
}

function finalizationMatchesTransaction(
  finalization: CreatorMutationFinalization,
  sessionId: string,
  changeSet: CreatorMutationChangeSetLike,
  projection: StudioEvidenceProjection,
  manifestHash: string,
): boolean {
  return (
    finalization.sessionId === sessionId &&
    finalization.changeSetId === changeSet.id &&
    finalization.changeSetHash === changeSet.hash &&
    finalization.projectionId === projection.id &&
    finalization.projectionHash === projection.contentHash &&
    finalization.manifestHash === manifestHash &&
    finalization.beforeRevisionHash === changeSet.binding.revisionHash &&
    isNonEmpty(finalization.recordingId)
  );
}

function isChangeSet(value: unknown): value is CreatorMutationChangeSetLike {
  if (!isRecord(value)) return false;
  return (
    value.kind === "CreatorChangeSet" &&
    isNonEmpty(value.id) &&
    isHash(value.hash) &&
    isNonEmpty(value.projectionId) &&
    isRecord(value.project) &&
    isRecord(value.binding) &&
    Array.isArray(value.operations) &&
    Array.isArray(value.allowedStateDelta) &&
    value.allowedStateDelta.every(isNonEmpty)
  );
}

export function isCreatorMutationAttempt(value: unknown): value is CreatorMutationAttempt {
  if (!isRecord(value)) return false;
  const commonBindings = [
    value.manifest,
    isRecord(value.attestation) ? value.attestation.projection : undefined,
    isRecord(value.attestation) ? value.attestation.envelope : undefined,
    value.changeSet,
    value.projection,
    isRecord(value.beforeState) ? value.beforeState.projection : undefined,
    isRecord(value.beforeState) ? value.beforeState.envelope : undefined,
    isRecord(value.beforeState) ? value.beforeState.revision : undefined,
  ];
  const common =
    value.kind === "CreatorMutationAttempt" &&
    isNonEmpty(value.id) &&
    isHash(value.hash) &&
    isNonEmpty(value.sessionId) &&
    hasCanonicalHash(value) &&
    commonBindings.every(isArtifactBinding);
  if (!common) return false;
  if (value.completion === "incomplete") {
    const facts = value.failureFacts;
    const base =
      isArtifactBinding(value.preflightProjection) &&
      Array.isArray(facts) &&
      facts.length > 0 &&
      hasCanonicalFailureFacts(facts);
    if (!base) return false;
    if (value.phase === "preflight")
      return (
        value.preflight === undefined ||
        isRecord(value.preflight) &&
        isArtifactBinding(value.preflight.projection) &&
        isArtifactBinding(value.preflight.envelope)
      );
    return (
      value.phase === "apply" &&
      isRecord(value.preflight) &&
      isArtifactBinding(value.preflight.projection) &&
      isArtifactBinding(value.preflight.envelope) &&
      isRecord(value.finalState) &&
      isArtifactBinding(value.finalState.projection) &&
      isArtifactBinding(value.finalState.envelope) &&
      isArtifactBinding(value.finalState.revision) &&
      isArtifactBinding(value.finalization)
    );
  }
  if (value.completion !== "settled") return false;
  const settledBindings = [
    isRecord(value.preflight) ? value.preflight.projection : undefined,
    isRecord(value.preflight) ? value.preflight.envelope : undefined,
    value.directReadback,
    isRecord(value.afterState) ? value.afterState.projection : undefined,
    isRecord(value.afterState) ? value.afterState.envelope : undefined,
    isRecord(value.afterState) ? value.afterState.revision : undefined,
    isRecord(value.finalState) ? value.finalState.projection : undefined,
    isRecord(value.finalState) ? value.finalState.envelope : undefined,
    isRecord(value.finalState) ? value.finalState.revision : undefined,
    value.reconciliation,
    value.finalization,
  ];
  return settledBindings.every(isArtifactBinding);
}

export function assertCreatorMutationAttempt(value: unknown): asserts value is CreatorMutationAttempt {
  if (!isCreatorMutationAttempt(value)) throw new Error("Invalid CreatorMutationAttempt");
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

function isMutationFailureFact(value: unknown): value is CreatorMutationFailureFact {
  return isRecord(value) && isNonEmpty(value.code) && isNonEmpty(value.detail) && isHash(value.hash);
}

function hasCanonicalFailureFacts(value: unknown): value is readonly CreatorMutationFailureFact[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isMutationFailureFact))
    return false;
  try {
    const expected = createMutationFailureFacts(
      value.map((fact) => ({ code: fact.code, detail: fact.detail })),
    );
    return (
      expected.length === value.length &&
      expected.every((fact, index) =>
        fact.code === value[index]!.code &&
        fact.detail === value[index]!.detail &&
        fact.hash === value[index]!.hash,
      )
    );
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
    (value.status === "matched" || value.status === "mismatched" || value.status === "incomplete") &&
    Array.isArray(value.failureFacts) &&
    value.failureFacts.every(
      (fact) =>
        isRecord(fact) &&
        isNonEmpty(fact.code) &&
        isNonEmpty(fact.detail) &&
        isHash(fact.hash),
    )
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
    isHash(value.beforeRevisionHash) &&
    isNonEmpty(value.recordingId) &&
    (value.reconciliationHash === undefined || isHash(value.reconciliationHash)) &&
    (value.action === "commit" || value.action === "cancel" || value.action === "recovery_cancel") &&
    isHash(value.afterRevisionHash) &&
    isHash(value.postFinalizeProjectionHash) &&
    isHash(value.postFinalizeEvidenceHash) &&
    (value.status === "committed" ||
      value.status === "cancelled" ||
      value.status === "recovery_cancelled" ||
      value.status === "recovery_required")
  );
}

function hasCanonicalHash(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isHash(value.hash)) return false;
  const { hash: _hash, ...content } = value;
  return contentHash(stableJson(content)) === value.hash;
}

function isStudioValue(value: unknown): value is StudioValue {
  try {
    assertStudioValue(value);
    return true;
  } catch {
    return false;
  }
}

function sameTarget(
  left: StudioEvidenceFact["target"],
  right: StudioEvidenceFact["target"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "project" ||
      right.kind === "project" ||
      (left.stableId === right.stableId &&
        left.path === right.path &&
        left.className === right.className))
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: readonly string[]): boolean {
  return (
    values.length > 0 &&
    values.every(
      (value, index) =>
        isNonEmpty(value) && (index === 0 || values[index - 1]! < value),
    )
  );
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
