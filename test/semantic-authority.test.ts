import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertAcceptanceSpec,
  assertAcceptanceSpecReferences,
  assertIntegrationConstraintReferences,
  assertRequirement,
  assertRequirementIdentityStable,
  assertRequirementSet,
  assertRequirementSetIdentityStable,
  createAcceptanceSpec,
  createIntegrationConstraint,
  createRequirementSet,
  requirementSetHash,
  resolveRequirementView,
  serializeRequirementSet,
  type Requirement,
  type RequirementEvidence,
  type RequirementViewDecision,
} from "../packages/semantic-authority/src/index.js";

const hash = contentHash;
const policyEvidence: Extract<RequirementEvidence, { kind: "policy_reference" }> = {
  kind: "policy_reference",
  id: "evidence.policy.roblox_authority",
  policyId: "policy.roblox.server_authority",
  locator: "code:semantic-authority/policies",
  documentHash: hash("reviewed policy"),
};

test("requirements validate provenance and canonicalize deterministically", () => {
  const creator = creatorRequirement("req.creator.outcome", "The player can activate the door.");
  const observation = observationRequirement(
    "req.observation.door",
    "project_alpha",
    hash("snapshot"),
    "Workspace/Door",
  );
  const set = createRequirementSet([observation, creator]);
  assertRequirementSet(set);
  assert.deepEqual(
    set.requirements.map((item) => item.id),
    [creator.id, observation.id],
  );
  assert.equal(serializeRequirementSet(set), stableJson(set));
  assert.equal(
    requirementSetHash(set),
    requirementSetHash(createRequirementSet([creator, observation])),
  );
  const acceptance = createAcceptanceSpec({
    requirementSet: set,
    requirementIds: [observation.id, creator.id, creator.id],
    assertionIds: ["assert.door", "assert.door"],
  });
  assertAcceptanceSpec(acceptance);
  assertAcceptanceSpecReferences(acceptance, set);
  assert.deepEqual(acceptance.requirementIds, [creator.id, observation.id]);
  assert.throws(() => createRequirementSet([creator, creator]), /unique/);
  assert.throws(() => assertRequirement({ ...creator, expected: 123 }), /exact fields/);
  assert.throws(
    () => createRequirementSet([{ ...creator, evidence: [policyEvidence] }]),
    /evidence does not match source/,
  );
  assert.throws(
    () =>
      createRequirementSet([
        { ...agentRequirement("req.agent.bad", "Use one API."), enforcement: "blocking" },
      ]),
    /hypotheses cannot be blocking/,
  );
});

test("source and authority cannot change in place", () => {
  const original = creatorRequirement("req.creator.immutable", "Players can open the door.");
  assertRequirementIdentityStable(
    canonical(original),
    canonical({ ...original, visibility: "internal" }),
  );
  const changedAuthority = canonical({
    ...original,
    authority: "hypothesis",
    enforcement: "advisory",
  });
  assert.throws(
    () => assertRequirementIdentityStable(canonical(original), changedAuthority),
    /immutable/,
  );
  const changedSource = canonical(
    observationRequirement(original.id, "project_alpha", hash("snapshot"), "Workspace/Door"),
  );
  assert.throws(
    () =>
      assertRequirementSetIdentityStable(
        createRequirementSet([original]),
        createRequirementSet([changedSource]),
      ),
    /immutable/,
  );
});

test("one view resolver separates visibility from enforceability and never leaks hidden bodies", () => {
  const creator = creatorRequirement("req.creator.round", "The player knows the current round.");
  const internalPolicy = platformPolicyRequirement();
  const visibleEvaluation = evaluatorRequirement(
    "req.evaluator.visible",
    "The player can tell which round is active.",
    "builder_visible",
  );
  const hiddenEvaluation = evaluatorRequirement(
    "req.evaluator.hidden",
    "HIDDEN_EVALUATOR_BODY",
    "evaluator_only",
  );
  const oracle = benchmarkRequirement("req.oracle.enemy_count", "HIDDEN_ORACLE_EXPECTED_VALUE_3");
  const set = createRequirementSet([
    oracle,
    hiddenEvaluation,
    internalPolicy,
    visibleEvaluation,
    creator,
  ]);
  const build = resolveRequirementView(set, {
    phase: "build",
    environment: "benchmark",
    audience: "builder",
  });
  visible(build.decisions, creator.id, true, "blocking");
  withheld(build.decisions, "internal_policy_enforced_without_disclosure", true, "blocking");
  visible(build.decisions, visibleEvaluation.id, false, "none");
  withheld(build.decisions, "evaluator_only_requirement_withheld", false, "none");
  withheld(build.decisions, "benchmark_oracle_hidden_from_builder", false, "none");
  assert.doesNotMatch(
    stableJson(build),
    /HIDDEN_EVALUATOR_BODY|HIDDEN_ORACLE_EXPECTED_VALUE_3|req\.evaluator\.hidden|req\.oracle\.enemy_count/,
  );
  const evaluation = resolveRequirementView(set, {
    phase: "evaluate",
    environment: "benchmark",
    audience: "evaluator",
  });
  visible(evaluation.decisions, oracle.id, true, "blocking");
  assert.match(stableJson(evaluation), /HIDDEN_ORACLE_EXPECTED_VALUE_3/);
});

test("an observation becomes an integration constraint only by explicit evidenced reference", () => {
  const snapshotHash = hash("project snapshot");
  const door = observationRequirement(
    "req.observation.door",
    "project_alpha",
    snapshotHash,
    "Workspace/Door",
  );
  const sky = observationRequirement(
    "req.observation.sky",
    "project_alpha",
    snapshotHash,
    "Workspace/Sky",
  );
  const set = createRequirementSet([sky, door]);
  const constraint = createIntegrationConstraint({
    requirementSet: set,
    requirementId: door.id,
    projectId: "project_alpha",
    projectSnapshotHash: snapshotHash,
  });
  assertIntegrationConstraintReferences(constraint, set);
  assert.equal(constraint.requirementId, door.id);
  assert.throws(
    () =>
      createIntegrationConstraint({
        requirementSet: set,
        requirementId: door.id,
        projectId: "other",
        projectSnapshotHash: snapshotHash,
      }),
    /does not match/,
  );
});

test("creator outcomes outrank advisory plans without selecting a greenfield architecture", () => {
  const outcome = creatorRequirement(
    "req.creator.activate_door",
    "Give the player an explicit way to activate a door.",
  );
  for (const plan of [
    agentRequirement("req.agent.prompt", "Use a ProximityPrompt."),
    agentRequirement("req.agent.click", "Use a ClickDetector."),
  ]) {
    const view = resolveRequirementView(createRequirementSet([outcome, plan]), {
      phase: "build",
      environment: "production",
      audience: "builder",
    });
    visible(view.decisions, outcome.id, true, "blocking");
    visible(view.decisions, plan.id, true, "advisory");
    assert.equal(
      view.decisions.some((item) => item.reasons.some((reason) => reason.includes("preferred"))),
      false,
    );
  }
});

function creatorRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    id,
    statement,
    source: "creator",
    authority: "policy",
    visibility: "builder_visible",
    enforcement: "blocking",
    verificationModes: ["evaluator", "studio"],
    evidence: [
      {
        kind: "creator_request",
        id: `evidence.${id}`,
        intentId: "intent.test",
        requestHash: hash(statement),
      },
    ],
  };
}
function observationRequirement(
  id: string,
  projectId: string,
  projectSnapshotHash: string,
  locator: string,
): Requirement {
  return {
    kind: "Requirement",
    id,
    statement: `${locator} exists in the observed before-state.`,
    source: "project_observation",
    authority: "fact",
    visibility: "builder_visible",
    enforcement: "informational",
    verificationModes: ["schema", "static"],
    evidence: [
      {
        kind: "project_observation",
        id: `evidence.${id}`,
        projectId,
        projectSnapshotHash,
        locator,
        observationHash: hash(locator),
      },
    ],
  };
}
function platformPolicyRequirement(): Requirement {
  return {
    kind: "Requirement",
    id: "req.policy.server_authority",
    statement: "Clients cannot control authoritative currency.",
    source: "platform_policy",
    authority: "policy",
    visibility: "internal",
    enforcement: "blocking",
    verificationModes: ["static", "studio"],
    evidence: [policyEvidence],
  };
}
function evaluatorRequirement(
  id: string,
  statement: string,
  visibility: "builder_visible" | "evaluator_only",
): Requirement {
  return {
    kind: "Requirement",
    id,
    statement,
    source: "evaluator",
    authority: "evaluation_only",
    visibility,
    enforcement: "blocking",
    verificationModes: ["evaluator"],
    evidence: [
      {
        kind: "evaluation_spec",
        id: `evidence.${id}`,
        evaluationId: "evaluation.test",
        criterionId: id,
        specificationHash: hash(statement),
      },
    ],
  };
}
function benchmarkRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    id,
    statement,
    source: "benchmark_oracle",
    authority: "evaluation_only",
    visibility: "evaluator_only",
    enforcement: "blocking",
    verificationModes: ["studio"],
    evidence: [
      {
        kind: "benchmark_fixture",
        id: `evidence.${id}`,
        benchmarkId: "benchmark.test",
        oracleId: id,
        fixtureHash: hash(statement),
      },
    ],
  };
}
function agentRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    id,
    statement,
    source: "agent_plan",
    authority: "hypothesis",
    visibility: "builder_visible",
    enforcement: "advisory",
    verificationModes: ["studio"],
    evidence: [
      {
        kind: "agent_decision",
        id: `evidence.${id}`,
        planId: "plan.door",
        decisionId: id,
        decisionHash: hash(statement),
      },
    ],
  };
}
function canonical(requirement: Requirement): Requirement {
  return createRequirementSet([requirement]).requirements[0]!;
}
function visible(
  decisions: RequirementViewDecision[],
  id: string,
  enforceable: boolean,
  enforcement: RequirementViewDecision["effectiveEnforcement"],
): void {
  const result = decisions.find((item) => item.visible && item.requirementId === id);
  assert.ok(result);
  assert.equal(result.enforceable, enforceable);
  assert.equal(result.effectiveEnforcement, enforcement);
}
function withheld(
  decisions: RequirementViewDecision[],
  reason: string,
  enforceable: boolean,
  enforcement: RequirementViewDecision["effectiveEnforcement"],
): void {
  const result = decisions.find((item) => !item.visible && item.reasons.includes(reason));
  assert.ok(result);
  assert.equal(result.enforceable, enforceable);
  assert.equal(result.effectiveEnforcement, enforcement);
}
