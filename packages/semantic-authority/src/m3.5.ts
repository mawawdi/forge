import {
  assertCoreLoop,
  assertFixtureManifest,
  assertGameIntent,
  assertMechanicContract,
  assertMechanicImplementationSpec,
  contentHash,
  stableJson,
  type CoreLoop,
  type ForgeFixtureManifest,
  type GameIntent,
  type MechanicContract,
  type MechanicImplementationSpec
} from "../../contracts/src/index.js";
import { assertProjectSnapshot, type ProjectSnapshot } from "../../semantic-map/src/index.js";
import { assertStudioTestPlan, type StudioTestPlan } from "../../studio-proof/src/index.js";
import {
  createAcceptanceSpec,
  createIntegrationConstraint,
  createRequirementSet,
  type AcceptanceSpec,
  type IntegrationConstraint,
  type Requirement,
  type RequirementEvidence,
  type RequirementSet
} from "./index.js";

export interface HistoricalGenerationPolicyReference {
  mechanicName: "CollectFruit" | "SellInventory";
  allowedPaths: readonly string[];
  requiredPaths: readonly string[];
  maxFiles: number;
  maxAddedLines: number;
  maxRemovedLines: number;
  maxSourceBytes: number;
}

export interface M35CollectSellProjectionInput {
  manifest: ForgeFixtureManifest;
  gameIntent: GameIntent;
  coreLoop: CoreLoop;
  collectContract: MechanicContract;
  sellContract: MechanicContract;
  collectImplementationSpec: MechanicImplementationSpec;
  sellImplementationSpec: MechanicImplementationSpec;
  collectGenerationPolicy: HistoricalGenerationPolicyReference;
  sellGenerationPolicy: HistoricalGenerationPolicyReference;
  projectSnapshot: ProjectSnapshot;
  studioPlan: StudioTestPlan;
  policyReference: Extract<RequirementEvidence, { kind: "policy_reference" }>;
}

export interface M35CollectSellProjection {
  kind: "M35CollectSellProjection";
  schemaVersion: 1;
  requirementSet: RequirementSet;
  integrationConstraints: IntegrationConstraint[];
  acceptanceSpec: AcceptanceSpec;
  artifactReferences: {
    manifestHash: string;
    gameIntentHash: string;
    coreLoopHash: string;
    collectContractHash: string;
    sellContractHash: string;
    collectImplementationSpecHash: string;
    sellImplementationSpecHash: string;
    collectGenerationPolicyHash: string;
    sellGenerationPolicyHash: string;
    projectSnapshotHash: string;
    priorProofBundleIds: string[];
    studioPlanId: string;
    studioPlanVersion: string;
    studioAssertionIds: string[];
  };
}

const BENCHMARK_ID = "core-loop-bench-m3.5-collect-sell";

/**
 * Projects the preserved M3.5 Collect+Sell slice into provenance records.
 * This is intentionally not imported by generation, verification, or Studio
 * execution. Assertion bodies remain in StudioTestPlan and are reduced here to
 * identifier-only references.
 */
export function projectM35CollectSellAuthority(input: M35CollectSellProjectionInput): M35CollectSellProjection {
  validateInput(input);
  const snapshotHash = input.projectSnapshot.projectSemanticHash;
  const projectId = input.projectSnapshot.projectId;
  const priorBindings = input.manifest.generationTarget?.verifiedMechanics ?? [];
  const priorProofBundleIds = priorBindings.map((binding) => binding.proofBundleId).sort(compareStrings);
  const sellPrompt = input.manifest.instances?.find((instance) => instance.path === "Workspace/SellZone/SellPrompt");
  const promptDistance = sellPrompt?.properties?.MaxActivationDistance;
  const remoteFacts = input.manifest.remoteFlows.map((flow) => ({ name: flow.name, path: flow.remote.path, className: flow.remote.className, preserveExisting: flow.remote.preserveExisting }));
  const stateFacts = input.manifest.persistentState ?? [];

  const requirements: Requirement[] = [
    requirement({
      id: "req.m35.creator.collect_sell_outcome",
      statement: input.gameIntent.normalizedGoal,
      source: "creator",
      authority: "policy",
      visibility: "builder_visible",
      enforcement: "blocking",
      verificationModes: ["studio", "evaluator"],
      evidence: [{ kind: "creator_request", id: "evidence.m35.creator_request", intentId: input.gameIntent.id, requestHash: contentHash(input.gameIntent.rawPrompt) }]
    }),
    observationRequirement({
      id: "req.m35.observation.remote_identities",
      statement: `Observed before-state remote identities: ${remoteFacts.map((remote) => `${remote.name}=${remote.path}`).join(", ")}.`,
      locator: "forge.fixture.json#remoteFlows",
      observation: remoteFacts,
      projectId,
      snapshotHash
    }),
    observationRequirement({
      id: "req.m35.observation.sell_prompt",
      statement: `Observed before-state contains Workspace/SellZone/SellPrompt with MaxActivationDistance ${String(promptDistance)}.`,
      locator: "forge.fixture.json#instances[Workspace/SellZone/SellPrompt]",
      observation: sellPrompt,
      projectId,
      snapshotHash
    }),
    observationRequirement({
      id: "req.m35.observation.state_representation",
      statement: `Observed before-state represents authoritative session state as ${stateFacts.map((state) => `${state.field}:${state.type}`).join(", ")}.`,
      locator: "forge.fixture.json#persistentState",
      observation: stateFacts,
      projectId,
      snapshotHash
    }),
    observationRequirement({
      id: "req.m35.observation.collect_regression_binding",
      statement: "The CollectFruit seed is linked to a prior verified proof and sealed source hashes.",
      locator: "forge.fixture.json#generationTarget.verifiedMechanics[CollectFruit]",
      observation: priorBindings,
      projectId,
      snapshotHash,
      visibility: "internal"
    }),
    requirement({
      id: "req.m35.policy.server_owned_authority",
      statement: "Untrusted clients must not control authoritative rewards, inventory, prices, payouts, or resulting currency state.",
      source: "platform_policy",
      authority: "policy",
      visibility: "internal",
      enforcement: "blocking",
      verificationModes: ["static", "studio"],
      evidence: [input.policyReference]
    }),
    requirement({
      id: "req.m35.hypothesis.bounded_capabilities",
      statement: "Agent mutations should remain within explicit workspace capabilities authorized for the current task.",
      source: "platform_policy",
      authority: "hypothesis",
      visibility: "internal",
      enforcement: "advisory",
      verificationModes: ["schema", "static"],
      evidence: [input.policyReference]
    }),
    requirement({
      id: "req.m35.hypothesis.atomic_economy",
      statement: "A sale should not duplicate value or leave a partially committed economic transition.",
      source: "platform_policy",
      authority: "hypothesis",
      visibility: "internal",
      enforcement: "advisory",
      verificationModes: ["static", "studio"],
      evidence: [input.policyReference]
    }),
    requirement({
      id: "req.m35.evaluator.registered_studio_outcomes",
      statement: "The preserved Collect+Sell behavior is evaluated by the registered M3.5 Studio plan.",
      source: "evaluator",
      authority: "evaluation_only",
      visibility: "builder_visible",
      enforcement: "blocking",
      verificationModes: ["studio"],
      evidence: [{ kind: "evaluation_spec", id: "evidence.m35.studio_plan", evaluationId: input.studioPlan.id, criterionId: "registered_collect_sell_outcomes", specificationHash: contentHash(stableJson({ planId: input.studioPlan.id, version: input.studioPlan.version, assertionIds: input.studioPlan.assertions.map((assertion) => assertion.id) })) }]
    }),
    benchmarkRequirement("req.m35.oracle.sell_zero_argument_abi", "The historical SellInventory client ABI has exactly zero client-supplied arguments.", "sell_zero_argument_abi", input.sellImplementationSpec.clientInputs),
    benchmarkRequirement("req.m35.oracle.authorization_distance", "The historical server authorization threshold is exactly 20 studs.", "authorization_distance_20", input.sellImplementationSpec.interactionBinding?.serverAuthorization),
    benchmarkRequirement("req.m35.oracle.exact_source_allowlist", `The historical generation scope is exactly these source paths: ${[...input.sellGenerationPolicy.allowedPaths].sort(compareStrings).join(", ")}.`, "exact_six_file_allowlist", input.sellGenerationPolicy),
    benchmarkRequirement("req.m35.oracle.clear_then_credit_order", "The historical implementation clears Inventory before crediting Coins and yields between neither mutation.", "clear_then_credit_order", input.sellImplementationSpec.authorityInvariants)
  ];

  for (const assertion of input.studioPlan.assertions) {
    requirements.push(benchmarkRequirement(
      `req.m35.assertion.${assertion.id}`,
      `The registered M3.5 evaluator assertion ${assertion.id} must execute and report an authoritative result.`,
      assertion.id,
      { planId: input.studioPlan.id, version: input.studioPlan.version, assertionId: assertion.id }
    ));
  }

  const requirementSet = createRequirementSet(requirements);
  const integrationRequirementIds = [
    "req.m35.observation.remote_identities",
    "req.m35.observation.sell_prompt",
    "req.m35.observation.state_representation",
    "req.m35.observation.collect_regression_binding"
  ];
  const integrationConstraints = integrationRequirementIds.map((requirementId) => createIntegrationConstraint({ requirementSet, requirementId, projectId, projectSnapshotHash: snapshotHash })).sort((left, right) => compareStrings(left.id, right.id));
  const acceptanceSpec = createAcceptanceSpec({
    requirementSet,
    requirementIds: requirementSet.requirements.map((item) => item.id),
    assertionIds: input.studioPlan.assertions.map((assertion) => assertion.id),
    artifactIds: [input.studioPlan.id, input.collectImplementationSpec.id, input.sellImplementationSpec.id, ...priorProofBundleIds]
  });

  return {
    kind: "M35CollectSellProjection",
    schemaVersion: 1,
    requirementSet,
    integrationConstraints,
    acceptanceSpec,
    artifactReferences: {
      manifestHash: contentHash(stableJson(input.manifest)),
      gameIntentHash: contentHash(stableJson(input.gameIntent)),
      coreLoopHash: contentHash(stableJson(input.coreLoop)),
      collectContractHash: contentHash(stableJson(input.collectContract)),
      sellContractHash: contentHash(stableJson(input.sellContract)),
      collectImplementationSpecHash: contentHash(stableJson(input.collectImplementationSpec)),
      sellImplementationSpecHash: contentHash(stableJson(input.sellImplementationSpec)),
      collectGenerationPolicyHash: contentHash(stableJson(input.collectGenerationPolicy)),
      sellGenerationPolicyHash: contentHash(stableJson(input.sellGenerationPolicy)),
      projectSnapshotHash: snapshotHash,
      priorProofBundleIds,
      studioPlanId: input.studioPlan.id,
      studioPlanVersion: input.studioPlan.version,
      studioAssertionIds: input.studioPlan.assertions.map((assertion) => assertion.id).sort(compareStrings)
    }
  };
}

function validateInput(input: M35CollectSellProjectionInput): void {
  assertFixtureManifest(input.manifest);
  assertGameIntent(input.gameIntent);
  assertCoreLoop(input.coreLoop);
  assertMechanicContract(input.collectContract);
  assertMechanicContract(input.sellContract);
  assertMechanicImplementationSpec(input.collectImplementationSpec);
  assertMechanicImplementationSpec(input.sellImplementationSpec);
  assertProjectSnapshot(input.projectSnapshot);
  assertStudioTestPlan(input.studioPlan);
  if (input.collectContract.name !== "CollectFruit" || input.sellContract.name !== "SellInventory") throw new Error("M3.5 projection requires the historical CollectFruit and SellInventory contracts");
  if (input.collectImplementationSpec.mechanicContractId !== input.collectContract.id || input.sellImplementationSpec.mechanicContractId !== input.sellContract.id) throw new Error("M3.5 projection implementation specs do not match their contracts");
  if (input.studioPlan.assertions.length !== 14 || input.studioPlan.version !== "collect-sell-v4") throw new Error("M3.5 projection requires the immutable collect-sell-v4 fourteen-assertion plan");
  if (input.studioPlan.projectSnapshotHash !== input.projectSnapshot.projectSemanticHash) throw new Error("M3.5 projection Studio plan does not match the project snapshot");
  if (input.policyReference.kind !== "policy_reference") throw new Error("M3.5 projection requires independent platform policy provenance");
  const prompt = input.manifest.instances?.find((instance) => instance.path === "Workspace/SellZone/SellPrompt");
  if (prompt?.className !== "ProximityPrompt" || prompt.properties?.MaxActivationDistance !== 12) throw new Error("M3.5 projection could not find the observed 12-stud SellPrompt");
  if (!input.manifest.generationTarget?.verifiedMechanics.some((binding) => binding.name === "CollectFruit")) throw new Error("M3.5 projection requires the prior CollectFruit proof binding");
  validateGenerationPolicy(input.collectGenerationPolicy, input.collectImplementationSpec, "CollectFruit");
  validateGenerationPolicy(input.sellGenerationPolicy, input.sellImplementationSpec, "SellInventory");
}

function validateGenerationPolicy(policy: HistoricalGenerationPolicyReference, implementationSpec: MechanicImplementationSpec, mechanicName: HistoricalGenerationPolicyReference["mechanicName"]): void {
  if (policy.mechanicName !== mechanicName || !Number.isInteger(policy.maxFiles) || !Number.isInteger(policy.maxAddedLines) || !Number.isInteger(policy.maxRemovedLines) || !Number.isInteger(policy.maxSourceBytes)) throw new Error(`Invalid historical ${mechanicName} generation policy`);
  const allowed = [...policy.allowedPaths].sort(compareStrings);
  const targets = implementationSpec.sourceTargets.map((target) => target.path).sort(compareStrings);
  if (stableJson(allowed) !== stableJson(targets)) throw new Error(`Historical ${mechanicName} generation policy does not match the implementation spec source targets`);
}

function requirement(input: Omit<Requirement, "kind" | "schemaVersion">): Requirement {
  return { kind: "Requirement", schemaVersion: 1, ...input };
}

function observationRequirement(input: {
  id: string;
  statement: string;
  locator: string;
  observation: unknown;
  projectId: string;
  snapshotHash: string;
  visibility?: "builder_visible" | "internal";
}): Requirement {
  return requirement({
    id: input.id,
    statement: input.statement,
    source: "project_observation",
    authority: "fact",
    visibility: input.visibility ?? "builder_visible",
    enforcement: "informational",
    verificationModes: ["schema", "static"],
    evidence: [{ kind: "project_observation", id: `evidence.${input.id}`, projectId: input.projectId, projectSnapshotHash: input.snapshotHash, locator: input.locator, observationHash: contentHash(stableJson(input.observation)) }]
  });
}

function benchmarkRequirement(id: string, statement: string, oracleId: string, fixture: unknown): Requirement {
  return requirement({
    id,
    statement,
    source: "benchmark_oracle",
    authority: "evaluation_only",
    visibility: "evaluator_only",
    enforcement: "blocking",
    verificationModes: ["studio", "evaluator"],
    evidence: [{ kind: "benchmark_fixture", id: `evidence.${id}`, benchmarkId: BENCHMARK_ID, oracleId, fixtureHash: contentHash(stableJson(fixture)) }]
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
