import { contentHash, stableJson } from "../../contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../../artifact-store/src/index.js";
import {
  canonicalizeStudioRuntimeTargets,
  canonicalizeStudioRuntimeCalls,
  assertStudioExecutionPlan,
  type StudioExecutionPlan,
  type StudioCapabilityCall,
  type StudioRuntimeTarget,
} from "../../studio-capabilities/src/index.js";
import {
  assertStudioEvidenceEnvelope,
  isRobloxClassAssignableTo,
  runtimeResultsFromEvidence,
  studioProjectIndexMetadataView,
  type StudioEvidenceEnvelope,
  type StudioProjectIndexCapture,
  type StudioProjectIndexMetadataView,
} from "../../studio-evidence/src/index.js";
import {
  subtreeProjectIndexHash,
  type CreatorChangeSet,
  type CreatorSessionBundle,
  type CreatorVerificationRecord,
  type CreatorVerificationReplay,
  type VerificationCharterClause,
} from "./index.js";
import { replayCreatorMutation } from "./mutation-evidence.js";
import { readCreatorProjectIndexArtifacts } from "./project-refresh.js";

export interface CreatorVerificationFailureFact {
  statement: string;
  hash: string;
}

export function createVerificationFailureFacts(
  statements: readonly string[],
): CreatorVerificationFailureFact[] {
  return statements
    .map((statement) => statement.slice(0, 4096))
    .map((statement) => ({ statement, hash: contentHash(statement) }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

export function createCharterExecution(
  clauses: readonly VerificationCharterClause[],
  projectIndex: StudioProjectIndexMetadataView,
  changeSet?: CreatorChangeSet,
): { targets: StudioRuntimeTarget[]; calls: StudioCapabilityCall[] } {
  const paths = charterRuntimePaths(clauses);
  if (paths.length === 0)
    throw new Error("The approved charter has no executable Studio observation");

  const targets = paths.map((path, index) => {
    const clausesForPath = clauses.filter(
      (clause): clause is Extract<VerificationCharterClause, { kind: "studio_check" }> =>
        clause.kind === "studio_check" && "path" in clause && clause.path === path,
    );
    const position = clausesForPath.find((clause) => clause.check === "position_series");
    const existence = clausesForPath.find((clause) => clause.check === "instance_exists");
    const expectedClass = position?.expectedClass ?? existence?.expectedClass;
    if (
      !expectedClass ||
      clausesForPath.some(
        (clause) => "expectedClass" in clause && clause.expectedClass !== expectedClass,
      )
    )
      throw new Error(`Creator charter has conflicting expected classes for ${path}`);
    const changedTargets = (changeSet?.operations ?? []).flatMap((operation) => {
      if (operation.kind === "create" && operation.target.path === path) return [operation.target];
      if (operation.kind === "move" && `${operation.parent.path}/${operation.name}` === path)
        return [{ ...runtimeTargetAfterEnrollment(operation), path }];
      if (
        operation.kind !== "create" &&
        operation.kind !== "move" &&
        operation.target.path === path
      )
        return [runtimeTargetAfterEnrollment(operation)];
      return [];
    });
    const indexedTargets = projectIndex.instances
      .filter((instance) => instance.path === path)
      .map((instance) => ({
        kind: "instance" as const,
        identity: instance.identity,
        path: instance.path,
        className: instance.className,
      }));
    const candidates = (changedTargets.length > 0 ? changedTargets : indexedTargets)
      .filter(
        (target, candidateIndex, all) =>
          all.findIndex((entry) => stableJson(entry.identity) === stableJson(target.identity)) ===
          candidateIndex,
      )
      .filter((target) => isRobloxClassAssignableTo(target.className, expectedClass));
    if (candidates.length !== 1)
      throw new Error(`Creator charter target ${path} is not exactly identifiable`);
    return {
      id: `creator_target_${index + 1}`,
      identity: candidates[0]!.identity,
      path,
      expectedClass,
    };
  });

  const calls: StudioCapabilityCall[] = [];
  for (const target of targets) {
    calls.push({
      id: `resolve_${target.id}`,
      capability: "instance.resolve",
      targetId: target.id,
    });
    const series = clauses.find(
      (clause): clause is Extract<VerificationCharterClause, { check: "position_series" }> =>
        clause.kind === "studio_check" &&
        clause.check === "position_series" &&
        clause.path === target.path,
    );
    if (series)
      calls.push({
        id: `series_${target.id}`,
        capability: "base_part.position_series",
        targetId: target.id,
        sampleCount: series.sampleCount,
        intervalMs: series.intervalMs,
      });
  }
  return {
    targets: canonicalizeStudioRuntimeTargets(targets),
    calls: canonicalizeStudioRuntimeCalls(calls),
  };
}

function runtimeTargetAfterEnrollment(
  operation: Exclude<CreatorChangeSet["operations"][number], { readonly kind: "create" }>,
) {
  return operation.enrollment
    ? {
        ...operation.target,
        identity: {
          kind: "forge_attribute" as const,
          stableId: operation.enrollment.stableId,
        },
      }
    : operation.target;
}

/**
 * Preservation clauses are replayed against the immutable project-index view
 * that was actually bound to verification. Display paths scope the check;
 * opaque identities and canonical covered facts keep duplicate names safe.
 */
export function gradeProjectIndexCharter(
  clauses: readonly VerificationCharterClause[],
  index: StudioProjectIndexMetadataView,
): string[] {
  return clauses.flatMap((clause) => {
    if (clause.kind !== "snapshot_check") return [];
    try {
      return subtreeProjectIndexHash(index, clause.path) === clause.baselineHash
        ? []
        : [clause.statement];
    } catch {
      return [clause.statement];
    }
  });
}

export function gradeRuntimeCharter(
  clauses: readonly VerificationCharterClause[],
  envelope: StudioEvidenceEnvelope,
): string[] {
  const failures: string[] = [];
  const results = runtimeResultsFromEvidence(envelope);
  const paths = charterRuntimePaths(clauses);
  for (const clause of clauses) {
    if (clause.kind !== "studio_check") continue;
    if (clause.check === "playtest_diagnostics") {
      if (
        (envelope.diagnostics ?? []).filter((entry) => entry.code === "error").length >
          clause.maximumErrors ||
        (envelope.diagnostics ?? []).filter((entry) => entry.code === "warning").length >
          clause.maximumWarnings ||
        envelope.completion !== "complete"
      )
        failures.push(clause.statement);
      continue;
    }
    const targetId = `creator_target_${paths.indexOf(clause.path) + 1}`;
    if (clause.check === "instance_exists") {
      const result = results.find((entry) => entry.id === `resolve_${targetId}`);
      if (result?.capability !== "instance.resolve" || result.status !== "resolved")
        failures.push(clause.statement);
      continue;
    }

    const result = results.find((entry) => entry.id === `series_${targetId}`);
    if (
      result?.capability !== "base_part.position_series" ||
      result.status !== "ok" ||
      !result.samples
    ) {
      failures.push(clause.statement);
      continue;
    }
    const distinct = new Set(
      result.samples.map(
        (sample) =>
          `${Math.round(sample.value.x / clause.quantizationStuds)},${Math.round(sample.value.y / clause.quantizationStuds)},${Math.round(sample.value.z / clause.quantizationStuds)}`,
      ),
    );
    if (distinct.size < clause.minimumDistinctPositions) failures.push(clause.statement);
  }
  return failures;
}

export function verificationEvidenceHash(value: unknown): string {
  return contentHash(stableJson(value));
}

export async function replayCreatorVerification(
  bundle: CreatorSessionBundle,
  verification: CreatorVerificationRecord,
  store: ImmutableJsonArtifactStore,
): Promise<CreatorVerificationReplay> {
  const recordedFailureFactHashes = verification.failureFacts.map((fact) => fact.hash);
  const base = {
    kind: "CreatorVerificationReplay" as const,
    sessionId: bundle.session.id,
    verificationId: verification.id,
    recordedStatus: verification.status,
    recordedFailureFactHashes,
  };
  if (verification.status === "incomplete")
    return {
      ...base,
      result: "missing_or_incomplete",
      detail:
        verification.nonReplayableReason ?? "The connector run did not produce complete evidence.",
    };

  const mutationAttempt = bundle.mutationAttempts.find(
    (entry) =>
      entry.id === verification.mutationAttempt.id &&
      entry.hash === verification.mutationAttempt.hash,
  );
  if (!mutationAttempt || mutationAttempt.completion !== "settled")
    return {
      ...base,
      result: "missing_or_incomplete",
      detail: "The linked matched mutation attempt is missing.",
    };
  const mutationReplay = await replayCreatorMutation(mutationAttempt, store);
  if (mutationReplay.result !== "exact_match" || mutationReplay.recordedStatus !== "matched")
    return {
      ...base,
      result: mutationReplay.result === "mismatch" ? "mismatch" : "missing_or_incomplete",
      detail: "Verification requires an exactly replayable matched mutation attempt.",
    };
  if (mutationAttempt.reconciliation.hash !== verification.mutationAttempt.reconciliationHash)
    return {
      ...base,
      result: "mismatch",
      detail: "The linked mutation reconciliation binding changed.",
    };

  const projectIndex = bundle.projectIndices.find(
    (entry) => entry.revision.hash === verification.stateRevisionHash,
  );
  if (!projectIndex)
    return {
      ...base,
      result: "missing_or_incomplete",
      detail: "The exact graded Studio project-index revision is missing.",
    };
  let capture: StudioProjectIndexCapture;
  try {
    capture = await readCreatorProjectIndexArtifacts(store, projectIndex);
  } catch (error) {
    return evidenceReadFailure(base, "graded Studio project index", error);
  }
  if (
    capture.hash !== projectIndex.captureHash ||
    capture.revision.hash !== verification.stateRevisionHash ||
    capture.revision.id !== projectIndex.revision.id ||
    capture.indexManifest.id !== projectIndex.manifest.id
  )
    return {
      ...base,
      result: "mismatch",
      detail: "The graded Studio project-index artifact changed its bound identity.",
    };
  if (verificationEvidenceHash(capture) !== verification.stateEvidenceHash)
    return {
      ...base,
      result: "mismatch",
      detail: "The graded Studio project index no longer matches its recorded hash.",
    };

  let executionPlan: StudioExecutionPlan;
  try {
    executionPlan = await store.read(verification.executionPlan.artifact, (value) =>
      assertStudioExecutionPlan(value, mutationAttempt.manifest.hash),
    );
  } catch (error) {
    return evidenceReadFailure(base, "execution plan", error);
  }
  if (
    executionPlan.id !== verification.executionPlan.id ||
    executionPlan.hash !== verification.executionPlan.hash
  )
    return {
      ...base,
      result: "mismatch",
      detail: "The execution-plan artifact identity changed.",
    };
  const expectedExecution = createCharterExecution(
    bundle.plan?.charter.clauses ?? [],
    studioProjectIndexMetadataView(capture),
    bundle.changeSets.at(-1),
  );
  if (
    stableJson(executionPlan.targets) !== stableJson(expectedExecution.targets) ||
    stableJson(executionPlan.calls) !== stableJson(expectedExecution.calls)
  )
    return {
      ...base,
      result: "mismatch",
      detail: "The execution plan does not implement the persisted charter.",
    };

  const clauses = bundle.plan?.charter.clauses ?? [];
  const indexFailures = gradeProjectIndexCharter(clauses, studioProjectIndexMetadataView(capture));
  let failures = indexFailures;
  if (failures.length === 0) {
    if (!verification.runtimeEvidence)
      return {
        ...base,
        result: "missing_or_incomplete",
        detail: "Runtime observation evidence is required but missing.",
      };
    let envelope: StudioEvidenceEnvelope;
    try {
      envelope = await store.read(
        verification.runtimeEvidence.artifact,
        assertStudioEvidenceEnvelope,
      );
    } catch (error) {
      return evidenceReadFailure(base, "runtime observation", error);
    }
    if (
      verificationEvidenceHash(envelope) !== verification.runtimeEvidence.evidenceHash ||
      verificationEvidenceHash(envelope.diagnostics ?? []) !==
        verification.runtimeEvidence.diagnosticsHash ||
      envelope.projectionHash !== executionPlan.evidenceProjection.contentHash ||
      envelope.bindingHash !== executionPlan.evidenceProjection.bindingHash
    )
      return {
        ...base,
        result: "mismatch",
        detail: "Runtime observation bindings or diagnostics changed.",
      };
    failures = gradeRuntimeCharter(clauses, envelope);
  }
  const replayedFailureFactHashes = createVerificationFailureFacts(failures).map(
    (fact) => fact.hash,
  );
  const replayedStatus = failures.length === 0 ? "passed" : "failed";
  const exact =
    replayedStatus === verification.status &&
    stableJson(replayedFailureFactHashes) === stableJson(recordedFailureFactHashes);
  return {
    ...base,
    result: exact ? "exact_match" : "mismatch",
    replayedStatus,
    replayedFailureFactHashes,
    detail: exact
      ? "Provider-free replay reproduced the recorded verdict and failure facts."
      : "Provider-free replay did not reproduce the recorded verdict and failure facts.",
  };
}

function evidenceReadFailure(
  base: Omit<CreatorVerificationReplay, "result" | "detail">,
  label: string,
  error: unknown,
): CreatorVerificationReplay {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...base,
    result: /missing|does not exist/i.test(message) ? "missing_or_incomplete" : "mismatch",
    detail: `The ${label} artifact could not be verified: ${message}`,
  };
}

function charterRuntimePaths(clauses: readonly VerificationCharterClause[]): string[] {
  return [
    ...new Set(
      clauses.flatMap((clause) =>
        clause.kind === "studio_check" &&
        (clause.check === "instance_exists" || clause.check === "position_series")
          ? [clause.path]
          : [],
      ),
    ),
  ].sort();
}
