import { contentHash, stableJson } from "../../contracts/src/index.js";

export type RequirementSource =
  | "creator"
  | "project_observation"
  | "platform_policy"
  | "agent_plan"
  | "evaluator"
  | "benchmark_oracle";

export type RequirementAuthority = "fact" | "policy" | "hypothesis" | "evaluation_only";
export type RequirementVisibility = "builder_visible" | "evaluator_only" | "internal";
export type RequirementEnforcement = "informational" | "advisory" | "blocking";
export type RequirementVerificationMode =
  "schema" | "static" | "preflight" | "studio" | "evaluator" | "human";

export type RequirementEvidence =
  | { kind: "creator_request"; id: string; intentId: string; requestHash: string }
  | {
      kind: "project_observation";
      id: string;
      projectId: string;
      projectSnapshotHash: string;
      locator: string;
      observationHash: string;
    }
  | {
      kind: "policy_reference";
      id: string;
      policyId: string;
      locator: string;
      documentHash: string;
    }
  | { kind: "agent_decision"; id: string; planId: string; decisionId: string; decisionHash: string }
  | {
      kind: "evaluation_spec";
      id: string;
      evaluationId: string;
      criterionId: string;
      specificationHash: string;
    }
  | {
      kind: "benchmark_fixture";
      id: string;
      benchmarkId: string;
      oracleId: string;
      fixtureHash: string;
    };

export interface Requirement {
  kind: "Requirement";
  id: string;
  statement: string;
  source: RequirementSource;
  authority: RequirementAuthority;
  visibility: RequirementVisibility;
  enforcement: RequirementEnforcement;
  verificationModes: RequirementVerificationMode[];
  evidence: RequirementEvidence[];
}

export interface RequirementSet {
  kind: "RequirementSet";
  id: string;
  requirements: Requirement[];
}

export interface AcceptanceSpec {
  kind: "AcceptanceSpec";
  id: string;
  requirementSetId: string;
  requirementIds: string[];
  assertionIds: string[];
  artifactIds: string[];
}

export interface IntegrationConstraint {
  kind: "IntegrationConstraint";
  id: string;
  requirementId: string;
  projectId: string;
  projectSnapshotHash: string;
}

export interface RequirementScope {
  phase: "build" | "evaluate";
  environment: "production" | "benchmark";
  audience: "builder" | "evaluator" | "internal";
}

type RequirementViewDecisionBase = {
  decisionId: string;
  requirementId: string;
  visible: boolean;
  enforceable: boolean;
  withheld: boolean;
  effectiveEnforcement: RequirementEnforcement | "none";
  reasons: string[];
};

export type RequirementViewDecision =
  | (RequirementViewDecisionBase & {
      visible: true;
      withheld: false;
      requirementId: string;
      requirement: Requirement;
    })
  | (Omit<RequirementViewDecisionBase, "requirementId" | "visible" | "withheld"> & {
      visible: false;
      withheld: true;
    });

export interface RequirementView {
  kind: "RequirementView";
  id: string;
  requirementSetId: string;
  scope: RequirementScope;
  decisions: RequirementViewDecision[];
}

const SOURCES: readonly RequirementSource[] = [
  "creator",
  "project_observation",
  "platform_policy",
  "agent_plan",
  "evaluator",
  "benchmark_oracle",
];
const AUTHORITIES: readonly RequirementAuthority[] = [
  "fact",
  "policy",
  "hypothesis",
  "evaluation_only",
];
const VISIBILITIES: readonly RequirementVisibility[] = [
  "builder_visible",
  "evaluator_only",
  "internal",
];
const ENFORCEMENTS: readonly RequirementEnforcement[] = ["informational", "advisory", "blocking"];
const VERIFICATION_MODES: readonly RequirementVerificationMode[] = [
  "schema",
  "static",
  "preflight",
  "studio",
  "evaluator",
  "human",
];

const EVIDENCE_KIND_BY_SOURCE: Readonly<Record<RequirementSource, RequirementEvidence["kind"]>> = {
  creator: "creator_request",
  project_observation: "project_observation",
  platform_policy: "policy_reference",
  agent_plan: "agent_decision",
  evaluator: "evaluation_spec",
  benchmark_oracle: "benchmark_fixture",
};

export function createRequirementSet(requirements: readonly Requirement[]): RequirementSet {
  const canonical = requirements
    .map(canonicalRequirement)
    .sort((left, right) => compareStrings(left.id, right.id));
  const set: RequirementSet = {
    kind: "RequirementSet",
    id: requirementSetId(canonical),
    requirements: canonical,
  };
  assertRequirementSet(set);
  return set;
}

export function createAcceptanceSpec(input: {
  requirementSet: RequirementSet;
  requirementIds: readonly string[];
  assertionIds?: readonly string[];
  artifactIds?: readonly string[];
}): AcceptanceSpec {
  assertRequirementSet(input.requirementSet);
  const payload = {
    requirementSetId: input.requirementSet.id,
    requirementIds: canonicalIds(input.requirementIds),
    assertionIds: canonicalIds(input.assertionIds ?? []),
    artifactIds: canonicalIds(input.artifactIds ?? []),
  };
  const spec: AcceptanceSpec = {
    kind: "AcceptanceSpec",
    id: `acceptance_spec_${contentHash(stableJson(payload)).slice(0, 24)}`,
    ...payload,
  };
  assertAcceptanceSpec(spec);
  assertAcceptanceSpecReferences(spec, input.requirementSet);
  return spec;
}

export function createIntegrationConstraint(input: {
  requirementSet: RequirementSet;
  requirementId: string;
  projectId: string;
  projectSnapshotHash: string;
}): IntegrationConstraint {
  const payload = {
    requirementId: input.requirementId,
    projectId: input.projectId,
    projectSnapshotHash: input.projectSnapshotHash,
  };
  const constraint: IntegrationConstraint = {
    kind: "IntegrationConstraint",
    id: `integration_constraint_${contentHash(stableJson(payload)).slice(0, 24)}`,
    ...payload,
  };
  assertIntegrationConstraint(constraint);
  assertIntegrationConstraintReferences(constraint, input.requirementSet);
  return constraint;
}

export function resolveRequirementView(
  requirementSet: RequirementSet,
  scope: RequirementScope,
): RequirementView {
  assertRequirementSet(requirementSet);
  assertRequirementScope(scope);
  const decisions = requirementSet.requirements.map((requirement) =>
    resolveRequirement(requirement, scope),
  );
  const payload = { requirementSetId: requirementSet.id, scope, decisions };
  return {
    kind: "RequirementView",
    id: `requirement_view_${contentHash(stableJson(payload)).slice(0, 24)}`,
    ...payload,
  };
}

export function requirementSetHash(requirementSet: RequirementSet): string {
  assertRequirementSet(requirementSet);
  return contentHash(stableJson(requirementSet));
}

export function serializeRequirementSet(requirementSet: RequirementSet): string {
  assertRequirementSet(requirementSet);
  return stableJson(requirementSet);
}

export function assertRequirement(value: unknown): asserts value is Requirement {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "id",
      "statement",
      "source",
      "authority",
      "visibility",
      "enforcement",
      "verificationModes",
      "evidence",
    ]) ||
    value.kind !== "Requirement"
  ) {
    throw new Error("Invalid Requirement: expected exact fields");
  }
  if (
    !isId(value.id) ||
    !isNonEmptyString(value.statement) ||
    value.statement !== value.statement.trim() ||
    !includes(SOURCES, value.source) ||
    !includes(AUTHORITIES, value.authority) ||
    !includes(VISIBILITIES, value.visibility) ||
    !includes(ENFORCEMENTS, value.enforcement)
  ) {
    throw new Error("Invalid Requirement: invalid identity or authority axes");
  }
  if (
    !Array.isArray(value.verificationModes) ||
    value.verificationModes.length === 0 ||
    !value.verificationModes.every((mode) => includes(VERIFICATION_MODES, mode)) ||
    !isCanonicalUniqueStrings(value.verificationModes)
  ) {
    throw new Error(
      "Invalid Requirement: verificationModes must be non-empty, unique, and canonical",
    );
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0)
    throw new Error("Invalid Requirement: evidence is required");
  for (const evidence of value.evidence) assertRequirementEvidence(evidence);
  const evidence = value.evidence as RequirementEvidence[];
  if (!isCanonicalUniqueBy(evidence, (item) => item.id))
    throw new Error("Invalid Requirement: evidence IDs must be unique and canonical");
  if (
    evidence.some(
      (item) => item.kind !== EVIDENCE_KIND_BY_SOURCE[value.source as RequirementSource],
    )
  )
    throw new Error("Invalid Requirement: evidence does not match source");

  const source = value.source as RequirementSource;
  const authority = value.authority as RequirementAuthority;
  const visibility = value.visibility as RequirementVisibility;
  const enforcement = value.enforcement as RequirementEnforcement;
  if (
    source === "benchmark_oracle" &&
    (authority !== "evaluation_only" || visibility !== "evaluator_only")
  )
    throw new Error(
      "Invalid Requirement: benchmark oracles must be evaluation-only and evaluator-only",
    );
  if (source === "project_observation" && authority !== "fact")
    throw new Error("Invalid Requirement: project observations must be factual");
  if (source === "agent_plan" && authority !== "hypothesis")
    throw new Error("Invalid Requirement: agent plans cannot declare policy authority");
  if (authority === "hypothesis" && enforcement === "blocking")
    throw new Error("Invalid Requirement: hypotheses cannot be blocking");
  if (source === "platform_policy") {
    if (authority !== "policy" && authority !== "hypothesis")
      throw new Error(
        "Invalid Requirement: platform policy must be policy or hypothesis authority",
      );
    if (enforcement === "blocking") {
      if (
        authority !== "policy" ||
        !evidence.every((item) => item.kind === "policy_reference" && item.policyId !== value.id)
      )
        throw new Error(
          "Invalid Requirement: blocking platform policy requires independent policy provenance",
        );
    }
  }
}

export function assertRequirementSet(value: unknown): asserts value is RequirementSet {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "id", "requirements"]) ||
    value.kind !== "RequirementSet" ||
    !isId(value.id) ||
    !Array.isArray(value.requirements)
  ) {
    throw new Error("Invalid RequirementSet");
  }
  for (const requirement of value.requirements) assertRequirement(requirement);
  const requirements = value.requirements as Requirement[];
  if (!isCanonicalUniqueBy(requirements, (item) => item.id))
    throw new Error("Invalid RequirementSet: requirement IDs must be unique and canonical");
  if (value.id !== requirementSetId(requirements))
    throw new Error("Invalid RequirementSet: ID does not match canonical content");
}

export function assertAcceptanceSpec(value: unknown): asserts value is AcceptanceSpec {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "id",
      "requirementSetId",
      "requirementIds",
      "assertionIds",
      "artifactIds",
    ]) ||
    value.kind !== "AcceptanceSpec" ||
    !isId(value.id) ||
    !isId(value.requirementSetId)
  ) {
    throw new Error("Invalid AcceptanceSpec: expected references-only fields");
  }
  for (const key of ["requirementIds", "assertionIds", "artifactIds"] as const) {
    if (
      !Array.isArray(value[key]) ||
      !value[key].every(isId) ||
      !isCanonicalUniqueStrings(value[key])
    )
      throw new Error(`Invalid AcceptanceSpec: ${key} must be unique canonical IDs`);
  }
  const requirementIds = value.requirementIds as string[];
  const assertionIds = value.assertionIds as string[];
  const artifactIds = value.artifactIds as string[];
  if (requirementIds.length === 0)
    throw new Error("Invalid AcceptanceSpec: at least one requirement reference is required");
  const expectedId = `acceptance_spec_${contentHash(stableJson({ requirementSetId: value.requirementSetId, requirementIds, assertionIds, artifactIds })).slice(0, 24)}`;
  if (value.id !== expectedId)
    throw new Error("Invalid AcceptanceSpec: ID does not match canonical references");
}

export function assertAcceptanceSpecReferences(
  spec: AcceptanceSpec,
  requirementSet: RequirementSet,
): void {
  assertAcceptanceSpec(spec);
  assertRequirementSet(requirementSet);
  if (spec.requirementSetId !== requirementSet.id)
    throw new Error("Invalid AcceptanceSpec references: requirement set does not match");
  const requirementIds = new Set(requirementSet.requirements.map((requirement) => requirement.id));
  const missing = spec.requirementIds.filter((id) => !requirementIds.has(id));
  if (missing.length > 0)
    throw new Error(
      `Invalid AcceptanceSpec references: unknown requirements ${missing.join(", ")}`,
    );
}

export function assertIntegrationConstraint(
  value: unknown,
): asserts value is IntegrationConstraint {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "id", "requirementId", "projectId", "projectSnapshotHash"]) ||
    value.kind !== "IntegrationConstraint" ||
    !isId(value.id) ||
    !isId(value.requirementId) ||
    !isId(value.projectId) ||
    !isHash(value.projectSnapshotHash)
  ) {
    throw new Error("Invalid IntegrationConstraint: expected project/snapshot reference");
  }
  const expectedId = `integration_constraint_${contentHash(stableJson({ requirementId: value.requirementId, projectId: value.projectId, projectSnapshotHash: value.projectSnapshotHash })).slice(0, 24)}`;
  if (value.id !== expectedId)
    throw new Error("Invalid IntegrationConstraint: ID does not match canonical references");
}

export function assertIntegrationConstraintReferences(
  constraint: IntegrationConstraint,
  requirementSet: RequirementSet,
): void {
  assertIntegrationConstraint(constraint);
  assertRequirementSet(requirementSet);
  const requirement = requirementSet.requirements.find(
    (candidate) => candidate.id === constraint.requirementId,
  );
  if (
    !requirement ||
    requirement.source !== "project_observation" ||
    requirement.authority !== "fact"
  )
    throw new Error(
      "Invalid IntegrationConstraint references: requirement must be a project observation fact",
    );
  const matchingEvidence = requirement.evidence.some(
    (evidence) =>
      evidence.kind === "project_observation" &&
      evidence.projectId === constraint.projectId &&
      evidence.projectSnapshotHash === constraint.projectSnapshotHash,
  );
  if (!matchingEvidence)
    throw new Error(
      "Invalid IntegrationConstraint references: observation evidence does not match project snapshot",
    );
}

export function assertRequirementIdentityStable(previous: Requirement, next: Requirement): void {
  assertRequirement(previous);
  assertRequirement(next);
  if (previous.id !== next.id)
    throw new Error("Requirement identity comparison requires the same requirement ID");
  if (previous.source !== next.source || previous.authority !== next.authority)
    throw new Error("Requirement source and authority are immutable for an existing ID");
}

export function assertRequirementSetIdentityStable(
  previous: RequirementSet,
  next: RequirementSet,
): void {
  assertRequirementSet(previous);
  assertRequirementSet(next);
  const nextById = new Map(next.requirements.map((requirement) => [requirement.id, requirement]));
  for (const requirement of previous.requirements) {
    const revised = nextById.get(requirement.id);
    if (revised) assertRequirementIdentityStable(requirement, revised);
  }
}

function canonicalRequirement(requirement: Requirement): Requirement {
  const canonical: Requirement = {
    ...requirement,
    verificationModes: [...requirement.verificationModes].sort(compareStrings),
    evidence: requirement.evidence
      .map((item) => ({ ...item }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  };
  assertRequirement(canonical);
  return canonical;
}

function resolveRequirement(
  requirement: Requirement,
  scope: RequirementScope,
): RequirementViewDecision {
  const reasons: string[] = [];
  const benchmarkInScope =
    requirement.source !== "benchmark_oracle" ||
    (scope.environment === "benchmark" &&
      scope.phase === "evaluate" &&
      scope.audience !== "builder");
  const visibilityAllowed =
    scope.audience === "internal"
      ? true
      : scope.audience === "evaluator"
        ? requirement.visibility !== "internal"
        : requirement.visibility === "builder_visible" && requirement.source !== "benchmark_oracle";
  const visible = benchmarkInScope && visibilityAllowed;

  if (!benchmarkInScope)
    reasons.push(
      requirement.source === "benchmark_oracle" && scope.audience === "builder"
        ? "benchmark_oracle_hidden_from_builder"
        : "benchmark_oracle_out_of_scope",
    );
  else if (visible) reasons.push("visible_to_audience");
  else
    reasons.push(
      requirement.visibility === "internal"
        ? "internal_requirement_withheld"
        : "evaluator_only_requirement_withheld",
    );

  const evaluationInScope =
    requirement.authority !== "evaluation_only" || scope.phase === "evaluate";
  const hiddenPolicyCanEnforce =
    requirement.visibility === "internal" &&
    requirement.source === "platform_policy" &&
    requirement.authority === "policy";
  const audienceCanEnforce = visible || hiddenPolicyCanEnforce;
  const enforceable =
    benchmarkInScope &&
    evaluationInScope &&
    audienceCanEnforce &&
    requirement.enforcement !== "informational";
  if (requirement.enforcement === "informational") reasons.push("informational_not_enforced");
  else if (!evaluationInScope) reasons.push("evaluation_only_build_phase");
  else if (!audienceCanEnforce) reasons.push("withheld_requirement_not_enforceable");
  else if (enforceable && !visible) reasons.push("internal_policy_enforced_without_disclosure");
  else if (enforceable) reasons.push("requirement_enforceable_in_scope");

  const decision: Omit<RequirementViewDecisionBase, "requirementId" | "visible" | "withheld"> = {
    decisionId: `requirement_decision_${contentHash(stableJson({ requirementId: requirement.id, scope })).slice(0, 24)}`,
    enforceable,
    effectiveEnforcement: enforceable ? requirement.enforcement : "none",
    reasons: [...reasons].sort(compareStrings),
  };
  return visible
    ? { ...decision, visible: true, withheld: false, requirementId: requirement.id, requirement }
    : { ...decision, visible: false, withheld: true };
}

function assertRequirementEvidence(value: unknown): asserts value is RequirementEvidence {
  if (!isRecord(value) || !isId(value.id) || !isNonEmptyString(value.kind))
    throw new Error("Invalid Requirement evidence");
  switch (value.kind) {
    case "creator_request":
      if (
        !hasExactKeys(value, ["kind", "id", "intentId", "requestHash"]) ||
        !isId(value.intentId) ||
        !isHash(value.requestHash)
      )
        throw new Error("Invalid creator request evidence");
      return;
    case "project_observation":
      if (
        !hasExactKeys(value, [
          "kind",
          "id",
          "projectId",
          "projectSnapshotHash",
          "locator",
          "observationHash",
        ]) ||
        !isId(value.projectId) ||
        !isHash(value.projectSnapshotHash) ||
        !isNonEmptyString(value.locator) ||
        !isHash(value.observationHash)
      )
        throw new Error("Invalid project observation evidence");
      return;
    case "policy_reference":
      if (
        !hasExactKeys(value, ["kind", "id", "policyId", "locator", "documentHash"]) ||
        !isId(value.policyId) ||
        !isNonEmptyString(value.locator) ||
        !isHash(value.documentHash)
      )
        throw new Error("Invalid policy reference evidence");
      return;
    case "agent_decision":
      if (
        !hasExactKeys(value, ["kind", "id", "planId", "decisionId", "decisionHash"]) ||
        !isId(value.planId) ||
        !isId(value.decisionId) ||
        !isHash(value.decisionHash)
      )
        throw new Error("Invalid agent decision evidence");
      return;
    case "evaluation_spec":
      if (
        !hasExactKeys(value, ["kind", "id", "evaluationId", "criterionId", "specificationHash"]) ||
        !isId(value.evaluationId) ||
        !isId(value.criterionId) ||
        !isHash(value.specificationHash)
      )
        throw new Error("Invalid evaluation specification evidence");
      return;
    case "benchmark_fixture":
      if (
        !hasExactKeys(value, ["kind", "id", "benchmarkId", "oracleId", "fixtureHash"]) ||
        !isId(value.benchmarkId) ||
        !isId(value.oracleId) ||
        !isHash(value.fixtureHash)
      )
        throw new Error("Invalid benchmark fixture evidence");
      return;
    default:
      throw new Error(`Invalid Requirement evidence kind: ${String(value.kind)}`);
  }
}

function assertRequirementScope(value: unknown): asserts value is RequirementScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["phase", "environment", "audience"]) ||
    !["build", "evaluate"].includes(String(value.phase)) ||
    !["production", "benchmark"].includes(String(value.environment)) ||
    !["builder", "evaluator", "internal"].includes(String(value.audience))
  )
    throw new Error("Invalid RequirementScope");
}

function requirementSetId(requirements: readonly Requirement[]): string {
  return `requirement_set_${contentHash(stableJson(requirements)).slice(0, 24)}`;
}

function canonicalIds(values: readonly string[]): string[] {
  const result = [...new Set(values)].sort(compareStrings);
  if (!result.every(isId)) throw new Error("Expected canonical ID references");
  return result;
}

function isCanonicalUniqueStrings(values: readonly unknown[]): values is string[] {
  return (
    values.every((value) => typeof value === "string") &&
    isCanonicalUniqueBy(values as string[], (value) => value)
  );
}

function isCanonicalUniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const current = key(values[index]!);
    if (index > 0 && compareStrings(key(values[index - 1]!), current) >= 0) return false;
  }
  return true;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isId(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim() && !/\s/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
