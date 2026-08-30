import { deepStrictEqual, strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
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
  type RequirementViewDecision
} from "../packages/semantic-authority/src/index.js";
import { projectM35CollectSellAuthority } from "../packages/semantic-authority/src/m3.5.js";
import { assertCoreLoop, assertFixtureManifest, assertGameIntent, assertMechanicContract, contentHash, stableJson, type CoreLoop, type ForgeFixtureManifest, type GameIntent, type MechanicContract } from "../packages/contracts/src/index.js";
import { COLLECT_FRUIT_GENERATION_POLICY, SELL_INVENTORY_GENERATION_POLICY } from "../packages/generation/src/index.js";
import { compileCoreLoopExtension, parseCoreLoopExtensionDraft } from "../packages/intent/src/index.js";
import { buildSemanticMap, compileMechanicImplementationSpec, createProjectSnapshot } from "../packages/semantic-map/src/index.js";
import { COLLECT_SELL_HARNESS_HASH, COLLECT_SELL_HARNESS_ID, COLLECT_SELL_HARNESS_VERSION, STUDIO_HARNESS_REGISTRY } from "../packages/studio-protocol/src/index.js";
import { collectSellTestPlan } from "../packages/studio-proof/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const seed = resolve(root, "examples/core-loop/sell-inventory-seed");
const hash = (value: string): string => contentHash(value);

const policyEvidence: Extract<RequirementEvidence, { kind: "policy_reference" }> = {
  kind: "policy_reference",
  id: "evidence.policy.roblox_authority",
  policyId: "policy.roblox.server_authority",
  policyVersion: "m4.0",
  locator: "AGENTS.md#security-and-roblox-policy",
  documentHash: hash("reviewed policy")
};

test("semantic-authority contracts validate evidence, canonicalize deterministically, and reject malformed references", () => {
  const creator = creatorRequirement("req.creator.outcome", "The player can activate the door.");
  const observation = projectObservationRequirement("req.observation.door", "project_alpha", hash("snapshot"), "Workspace/Door");
  const set = createRequirementSet([observation, creator]);
  assertRequirementSet(set);
  assert.deepEqual(set.requirements.map((requirement) => requirement.id), ["req.creator.outcome", "req.observation.door"]);
  assert.deepEqual(set.requirements[0]?.verificationModes, ["evaluator", "studio"]);
  assert.equal(serializeRequirementSet(set), stableJson(set));
  assert.equal(requirementSetHash(set), requirementSetHash(createRequirementSet([creator, observation])));

  const acceptance = createAcceptanceSpec({ requirementSet: set, requirementIds: [observation.id, creator.id, creator.id], assertionIds: ["assert.door", "assert.door"], artifactIds: ["artifact.door"] });
  assertAcceptanceSpec(acceptance);
  assertAcceptanceSpecReferences(acceptance, set);
  assert.deepEqual(acceptance.requirementIds, [creator.id, observation.id]);
  assert.throws(() => assertAcceptanceSpecReferences({ ...acceptance, requirementIds: ["req.missing"], id: acceptanceId(set.id, ["req.missing"], acceptance.assertionIds, acceptance.artifactIds) }, set), /unknown requirements/);

  assert.throws(() => createRequirementSet([creator, creator]), /requirement IDs must be unique/);
  assert.throws(() => assertRequirement({ ...creator, expected: 123 }), /exact fields/);
  assert.throws(() => createRequirementSet([{ ...creator, evidence: [policyEvidence] }]), /evidence does not match source/);
  assert.throws(() => createRequirementSet([{ ...projectObservationRequirement("req.observation.missing", "project_alpha", hash("snapshot"), "Workspace/Missing"), evidence: [] }]), /evidence is required/);
  assert.throws(() => createRequirementSet([{ ...platformPolicyRequirement(), evidence: [{ ...policyEvidence, policyId: "req.policy.server_authority" }] }]), /independent policy provenance/);
  assert.throws(() => createRequirementSet([{ ...agentPlanRequirement("req.agent.bad", "Use a hidden preferred door API."), enforcement: "blocking" }]), /hypotheses cannot be blocking/);
});

test("source and authority are immutable for an existing requirement ID", () => {
  const original = creatorRequirement("req.creator.immutable", "Players can open the door.");
  const sameIdentity = { ...original, visibility: "internal" as const };
  assertRequirementIdentityStable(canonicalRequirement(original), canonicalRequirement(sameIdentity));

  const changedAuthority = canonicalRequirement({ ...original, authority: "hypothesis", enforcement: "advisory" });
  assert.throws(() => assertRequirementIdentityStable(canonicalRequirement(original), changedAuthority), /source and authority are immutable/);

  const changedSource = canonicalRequirement(projectObservationRequirement(original.id, "project_alpha", hash("snapshot"), "Workspace/Door"));
  assert.throws(() => assertRequirementIdentityStable(canonicalRequirement(original), changedSource), /source and authority are immutable/);
  assert.throws(() => assertRequirementSetIdentityStable(createRequirementSet([original]), createRequirementSet([changedSource])), /source and authority are immutable/);
});

test("one resolver separates visibility from enforcement across production and benchmark scopes", () => {
  const creator = creatorRequirement("req.creator.round", "The player knows the current round.");
  const internalPolicy = platformPolicyRequirement();
  const visibleEvaluation = evaluatorRequirement("req.evaluator.visible", "The player can tell which round is active.", "builder_visible");
  const hiddenEvaluation = evaluatorRequirement("req.evaluator.hidden", "HIDDEN_EVALUATOR_BODY", "evaluator_only");
  const oracle = benchmarkRequirement("req.oracle.enemy_count", "HIDDEN_ORACLE_EXPECTED_VALUE_3");
  const set = createRequirementSet([oracle, hiddenEvaluation, internalPolicy, visibleEvaluation, creator]);

  const productionBuild = resolveRequirementView(set, { phase: "build", environment: "production", audience: "builder" });
  visibleDecision(productionBuild.decisions, creator.id, { enforceable: true, enforcement: "blocking" });
  withheldDecision(productionBuild.decisions, "internal_policy_enforced_without_disclosure", { enforceable: true, enforcement: "blocking" });
  visibleDecision(productionBuild.decisions, visibleEvaluation.id, { enforceable: false, enforcement: "none" });
  withheldDecision(productionBuild.decisions, "evaluator_only_requirement_withheld", { enforceable: false, enforcement: "none" });
  withheldDecision(productionBuild.decisions, "benchmark_oracle_hidden_from_builder", { enforceable: false, enforcement: "none" });
  const builderSerialization = stableJson(productionBuild);
  assert.doesNotMatch(builderSerialization, /HIDDEN_EVALUATOR_BODY|HIDDEN_ORACLE_EXPECTED_VALUE_3|req\.evaluator\.hidden|req\.oracle\.enemy_count/);

  const productionEvaluation = resolveRequirementView(set, { phase: "evaluate", environment: "production", audience: "evaluator" });
  visibleDecision(productionEvaluation.decisions, visibleEvaluation.id, { enforceable: true, enforcement: "blocking" });
  visibleDecision(productionEvaluation.decisions, hiddenEvaluation.id, { enforceable: true, enforcement: "blocking" });
  withheldDecision(productionEvaluation.decisions, "benchmark_oracle_out_of_scope", { enforceable: false, enforcement: "none" });

  const benchmarkBuild = resolveRequirementView(set, { phase: "build", environment: "benchmark", audience: "builder" });
  withheldDecision(benchmarkBuild.decisions, "benchmark_oracle_hidden_from_builder", { enforceable: false, enforcement: "none" });
  const hiddenBenchmarkEvaluation = resolveRequirementView(set, { phase: "evaluate", environment: "benchmark", audience: "evaluator" });
  visibleDecision(hiddenBenchmarkEvaluation.decisions, oracle.id, { enforceable: true, enforcement: "blocking" });
  assert.match(stableJson(hiddenBenchmarkEvaluation), /HIDDEN_ORACLE_EXPECTED_VALUE_3/);
});

test("observations become integration constraints only through an explicit matching reference", () => {
  const snapshotHash = hash("project snapshot");
  const observedDoor = projectObservationRequirement("req.observation.existing_door", "project_alpha", snapshotHash, "Workspace/Door");
  const unrelatedObservation = projectObservationRequirement("req.observation.unrelated", "project_alpha", snapshotHash, "Workspace/Sky");
  const set = createRequirementSet([unrelatedObservation, observedDoor]);
  const constraint = createIntegrationConstraint({ requirementSet: set, requirementId: observedDoor.id, projectId: "project_alpha", projectSnapshotHash: snapshotHash });
  assertIntegrationConstraintReferences(constraint, set);
  assert.equal(constraint.requirementId, observedDoor.id);
  assert.notEqual(constraint.requirementId, unrelatedObservation.id);
  assert.throws(() => createIntegrationConstraint({ requirementSet: set, requirementId: observedDoor.id, projectId: "project_beta", projectSnapshotHash: snapshotHash }), /observation evidence does not match/);
  assert.throws(() => createIntegrationConstraint({ requirementSet: createRequirementSet([creatorRequirement("req.creator.not_observation", "Replace the door.")]), requirementId: "req.creator.not_observation", projectId: "project_alpha", projectSnapshotHash: snapshotHash }), /project observation fact/);
});

test("platform policy remains enforceable and creator outcomes outrank advisory agent preferences without choosing a door architecture", () => {
  const unsafeCreator = creatorRequirement("req.creator.unsafe_currency", "Let the client decide the authoritative currency reward.");
  const policy = platformPolicyRequirement();
  const unsafeSet = createRequirementSet([unsafeCreator, policy]);
  const unsafeView = resolveRequirementView(unsafeSet, { phase: "build", environment: "production", audience: "builder" });
  withheldDecision(unsafeView.decisions, "internal_policy_enforced_without_disclosure", { enforceable: true, enforcement: "blocking" });

  const outcome = creatorRequirement("req.creator.activate_door", "Give the player an explicit way to activate a door.");
  const proximity = agentPlanRequirement("req.agent.proximity_prompt", "Use a ProximityPrompt to activate the door.");
  const click = agentPlanRequirement("req.agent.click_detector", "Use a ClickDetector to activate the door.");
  const proximityView = resolveRequirementView(createRequirementSet([outcome, proximity]), { phase: "build", environment: "production", audience: "builder" });
  const clickView = resolveRequirementView(createRequirementSet([outcome, click]), { phase: "build", environment: "production", audience: "builder" });
  visibleDecision(proximityView.decisions, outcome.id, { enforceable: true, enforcement: "blocking" });
  visibleDecision(proximityView.decisions, proximity.id, { enforceable: true, enforcement: "advisory" });
  visibleDecision(clickView.decisions, outcome.id, { enforceable: true, enforcement: "blocking" });
  visibleDecision(clickView.decisions, click.id, { enforceable: true, enforcement: "advisory" });
  assert.equal(proximityView.decisions.some((item) => item.reasons.some((reason) => reason.includes("preferred"))), false);
  assert.equal(clickView.decisions.some((item) => item.reasons.some((reason) => reason.includes("preferred"))), false);
});

test("the historical M3.5 projection references all fourteen assertions without copying hidden evaluator bodies", async () => {
  const artifacts = await loadM35Artifacts();
  const map = await buildSemanticMap(seed, artifacts.manifest);
  const snapshot = createProjectSnapshot(map);
  const extension = compileCoreLoopExtension(
    "Now let players sell fruit for coins.",
    parseCoreLoopExtensionDraft({ normalizedGoal: "Players collect fruit on floating islands, then sell their inventory for coins.", desiredOutcomes: ["a secure collection and conversion loop"], unresolvedQuestions: [], selectedMechanic: "SellInventory" }),
    artifacts.gameIntent,
    artifacts.coreLoop,
    "node_sell",
    new Date("2026-08-30T00:00:00.000Z")
  );
  const collectSpec = compileMechanicImplementationSpec(map, artifacts.collectContract, { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  const sellSpec = compileMechanicImplementationSpec(map, extension.mechanicContract, { allowedPaths: [...SELL_INVENTORY_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  const binding = artifacts.manifest.generationTarget?.verifiedMechanics[0];
  assert.ok(binding);
  const studioPlan = collectSellTestPlan(extension.mechanicContract, artifacts.collectContract, binding.proofBundleId, binding.sourceHashes, snapshot);
  const studioPlanBefore = stableJson(studioPlan);
  const projection = projectM35CollectSellAuthority({
    manifest: artifacts.manifest,
    gameIntent: artifacts.gameIntent,
    coreLoop: artifacts.coreLoop,
    collectContract: artifacts.collectContract,
    sellContract: extension.mechanicContract,
    collectImplementationSpec: collectSpec,
    sellImplementationSpec: sellSpec,
    collectGenerationPolicy: COLLECT_FRUIT_GENERATION_POLICY,
    sellGenerationPolicy: SELL_INVENTORY_GENERATION_POLICY,
    projectSnapshot: snapshot,
    studioPlan,
    policyReference: { ...policyEvidence, documentHash: contentHash(await readFile(resolve(root, "AGENTS.md"), "utf8")) }
  });

  assertRequirementSet(projection.requirementSet);
  assert.equal(projection.acceptanceSpec.assertionIds.length, 14);
  assert.deepEqual(projection.acceptanceSpec.assertionIds, studioPlan.assertions.map((assertion) => assertion.id).sort());
  assert.equal(projection.requirementSet.requirements.filter((requirement) => requirement.source === "benchmark_oracle" && requirement.id.startsWith("req.m35.assertion.")).length, 14);
  assert.equal(projection.integrationConstraints.length, 4);
  assert.equal(projection.artifactReferences.priorProofBundleIds[0], "proof_932e3d0abd04b04894b38e73");
  assert.equal(stableJson(studioPlan), studioPlanBefore);

  const projectionSerialization = stableJson(projection);
  assert.doesNotMatch(projectionSerialization, /claimed payout spoof rejected|sell with claimed payout|999999|"expected"/);
  const builderView = resolveRequirementView(projection.requirementSet, { phase: "build", environment: "benchmark", audience: "builder" });
  const builderSerialization = stableJson(builderView);
  assert.doesNotMatch(builderSerialization, /claimed payout spoof rejected|sell with claimed payout|999999|exactly 20 studs|clear Inventory before crediting|src\/server\/SellInventory\.server\.luau|req\.m35\.assertion\.|assert_sell_inventory_spoof/);
  assert.equal(builderView.decisions.filter((item) => item.reasons.includes("benchmark_oracle_hidden_from_builder")).length, 18);

  assert.equal(COLLECT_SELL_HARNESS_VERSION, "collect-sell-v4");
  assert.equal(COLLECT_SELL_HARNESS_HASH, "0bd9310b99afb44f2d4be258fcb1dfc8885434256c213eede9172b07741cc8aa");
  deepStrictEqual(STUDIO_HARNESS_REGISTRY[COLLECT_SELL_HARNESS_ID], { version: COLLECT_SELL_HARNESS_VERSION, hash: COLLECT_SELL_HARNESS_HASH, assertionCount: 14 });
});

function creatorRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id,
    statement,
    source: "creator",
    authority: "policy",
    visibility: "builder_visible",
    enforcement: "blocking",
    verificationModes: ["studio", "evaluator"],
    evidence: [{ kind: "creator_request", id: `evidence.${id}`, intentId: "intent.test", requestHash: hash(statement) }]
  };
}

function projectObservationRequirement(id: string, projectId: string, projectSnapshotHash: string, locator: string): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id,
    statement: `${locator} exists in the observed before-state.`,
    source: "project_observation",
    authority: "fact",
    visibility: "builder_visible",
    enforcement: "informational",
    verificationModes: ["static", "schema"],
    evidence: [{ kind: "project_observation", id: `evidence.${id}`, projectId, projectSnapshotHash, locator, observationHash: hash(locator) }]
  };
}

function platformPolicyRequirement(): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id: "req.policy.server_authority",
    statement: "Clients cannot control authoritative currency.",
    source: "platform_policy",
    authority: "policy",
    visibility: "internal",
    enforcement: "blocking",
    verificationModes: ["studio", "static"],
    evidence: [policyEvidence]
  };
}

function evaluatorRequirement(id: string, statement: string, visibility: "builder_visible" | "evaluator_only"): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id,
    statement,
    source: "evaluator",
    authority: "evaluation_only",
    visibility,
    enforcement: "blocking",
    verificationModes: ["evaluator"],
    evidence: [{ kind: "evaluation_spec", id: `evidence.${id}`, evaluationId: "evaluation.test", criterionId: id, specificationHash: hash(statement) }]
  };
}

function benchmarkRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id,
    statement,
    source: "benchmark_oracle",
    authority: "evaluation_only",
    visibility: "evaluator_only",
    enforcement: "blocking",
    verificationModes: ["studio"],
    evidence: [{ kind: "benchmark_fixture", id: `evidence.${id}`, benchmarkId: "benchmark.test", oracleId: id, fixtureHash: hash(statement) }]
  };
}

function agentPlanRequirement(id: string, statement: string): Requirement {
  return {
    kind: "Requirement",
    schemaVersion: 1,
    id,
    statement,
    source: "agent_plan",
    authority: "hypothesis",
    visibility: "builder_visible",
    enforcement: "advisory",
    verificationModes: ["studio"],
    evidence: [{ kind: "agent_decision", id: `evidence.${id}`, planId: "plan.door", decisionId: id, decisionHash: hash(statement) }]
  };
}

function canonicalRequirement(requirement: Requirement): Requirement {
  return createRequirementSet([requirement]).requirements[0]!;
}

function visibleDecision(decisions: RequirementViewDecision[], requirementId: string, expected: { enforceable: boolean; enforcement: RequirementViewDecision["effectiveEnforcement"] }): void {
  const result = decisions.find((item) => item.visible && item.requirementId === requirementId);
  assert.ok(result, `missing decision for ${requirementId}`);
  assert.equal(result.visible, true);
  assert.equal(result.enforceable, expected.enforceable);
  assert.equal(result.effectiveEnforcement, expected.enforcement);
  assert.equal(result.withheld, false);
  assert.equal(result.requirement.id, requirementId);
}

function withheldDecision(decisions: RequirementViewDecision[], reason: string, expected: { enforceable: boolean; enforcement: RequirementViewDecision["effectiveEnforcement"] }): void {
  const result = decisions.find((item) => !item.visible && item.reasons.includes(reason));
  assert.ok(result, `missing withheld decision for ${reason}`);
  assert.equal(result.visible, false);
  assert.equal(result.enforceable, expected.enforceable);
  assert.equal(result.effectiveEnforcement, expected.enforcement);
  assert.equal(result.withheld, true);
}

function acceptanceId(requirementSetId: string, requirementIds: string[], assertionIds: string[], artifactIds: string[]): string {
  return `acceptance_spec_${contentHash(stableJson({ requirementSetId, requirementIds, assertionIds, artifactIds })).slice(0, 24)}`;
}

async function loadM35Artifacts(): Promise<{ manifest: ForgeFixtureManifest; gameIntent: GameIntent; coreLoop: CoreLoop; collectContract: MechanicContract }> {
  const manifest: unknown = JSON.parse(await readFile(resolve(seed, "forge.fixture.json"), "utf8"));
  const gameIntent: unknown = JSON.parse(await readFile(resolve(seed, "contracts/GameIntent.json"), "utf8"));
  const coreLoop: unknown = JSON.parse(await readFile(resolve(seed, "contracts/CoreLoop.json"), "utf8"));
  const collectContract: unknown = JSON.parse(await readFile(resolve(seed, "contracts/CollectFruit.json"), "utf8"));
  assertFixtureManifest(manifest);
  assertGameIntent(gameIntent);
  assertCoreLoop(coreLoop);
  assertMechanicContract(collectContract);
  return { manifest, gameIntent, coreLoop, collectContract };
}
