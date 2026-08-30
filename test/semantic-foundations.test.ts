import { deepStrictEqual, strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertBuildTrace, assertFixtureManifest, assertMechanicContract, assertTrajectoryEvent, contentHash, type BuildOutcome, type ForgeFixtureManifest, type MechanicContract, type TrajectoryEvent } from "../packages/contracts/src/index.js";
import { candidateCapsule, assertVerifiedMechanicCapsule } from "../packages/capsules/src/index.js";
import { DeterministicContextCompiler, contextSummary } from "../packages/context-compiler/src/index.js";
import { FlightRecorder } from "../packages/flight-recorder/src/index.js";
import { affectedVerificationCone, assertProjectSemanticMap, assertProjectSnapshot, buildSemanticMap, canonicalProjectSemanticMap, compileMechanicImplementationSpec, createProjectSnapshot, mergeStudioObservation } from "../packages/semantic-map/src/index.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const projectRoot = resolve(root, "examples/collect-fruit/vulnerable");

test("ProjectSemanticMap and ProjectSnapshot are canonical, deterministic, and connected to M2", async () => {
  const manifest = await loadManifest();
  const first = await buildSemanticMap(projectRoot, manifest);
  const second = await buildSemanticMap(projectRoot, manifest);
  assertProjectSemanticMap(first);
  deepStrictEqual(canonicalProjectSemanticMap(first), canonicalProjectSemanticMap(second));
  deepStrictEqual(createProjectSnapshot(first), createProjectSnapshot(second));
  const relocated = createProjectSnapshot({ ...first, projectId: "project_relocated", root: "/different/checkout" });
  assert.equal(relocated.projectSemanticHash, createProjectSnapshot(first).projectSemanticHash);
  assert.equal(first.scripts.find((script) => script.path.endsWith("CollectFruit.server.luau"))?.executionContext, "server");
  assert.equal(first.scripts.find((script) => script.path.endsWith("CollectFruit.client.luau"))?.executionContext, "client");
  assert.ok(first.instances.find((instance) => instance.path === "Workspace/Fruit")?.id);
  assert.ok(first.instances.find((instance) => instance.path === "ReplicatedStorage/Remotes")?.tags.includes("network"));
  assert.equal(first.remotes.length, 1);
  assert.equal(first.remoteFlows[0]?.serverEvidence?.mutations[0]?.expression, "(Inventory[player] or 0) + amount");
  assert.ok(first.dependencies.some((dependency) => dependency.kind === "remote"));

  const live = mergeStudioObservation(first, {
    kind: "StudioSnapshotObservation",
    schemaVersion: 3,
    project: { name: "Fruit Islands", placeId: 123, universeId: 456 },
    capturedAt: "2026-08-29T00:00:00.000Z",
    instances: [{ stableId: "studio_fruit", path: "Workspace/Fruit", className: "Part", position: { x: 4, y: 3, z: 2 }, properties: [{ name: "CanTouch", value: false }], attributes: [{ name: "Consumed", value: true }, { name: "FruitType", value: "Apple" }], tags: ["collectible"] }],
    scripts: [{ stableId: "studio_collect", path: "src/server/CollectFruit.server.luau", executionContext: "server", sourceHash: "studio-source-token", source: first.files.find((file) => file.path.endsWith("CollectFruit.server.luau"))?.source ?? "" }],
    remotes: [{ path: "ReplicatedStorage/Remotes/CollectFruit", name: "CollectFruit", className: "RemoteEvent", direction: "client_to_server" }]
  });
  assert.equal(live.instances.find((instance) => instance.path === "Workspace/Fruit")?.properties.CanTouch, false);
  assert.equal(live.instances.find((instance) => instance.path === "Workspace/Fruit")?.attributes.Consumed, true);
  assert.deepEqual(live.instances.find((instance) => instance.path === "Workspace/Fruit")?.position, { x: 4, y: 3, z: 2 });
  assert.equal(live.scripts.find((script) => script.path.endsWith("CollectFruit.server.luau"))?.sourceHash, contentHash(first.files.find((file) => file.path.endsWith("CollectFruit.server.luau"))?.source ?? ""));
  assert.notEqual(createProjectSnapshot(live).projectSemanticHash, createProjectSnapshot(first).projectSemanticHash);
  const reidentifiedLive = mergeStudioObservation(first, {
    kind: "StudioSnapshotObservation", schemaVersion: 3, project: { name: "Fruit Islands", placeId: 123, universeId: 456 }, capturedAt: "2026-08-29T00:00:01.000Z",
    instances: [{ stableId: "different_live_target_id", path: "Workspace/Fruit", className: "Part", position: { x: 4, y: 3, z: 2 }, properties: [{ name: "CanTouch", value: false }], attributes: [{ name: "Consumed", value: true }, { name: "FruitType", value: "Apple" }, { name: "_forgeStableId", value: "different_live_target_id" }], tags: ["collectible"] }],
    scripts: [{ stableId: "different_script_target_id", path: "src/server/CollectFruit.server.luau", executionContext: "server", sourceHash: "different-live-token", source: first.files.find((file) => file.path.endsWith("CollectFruit.server.luau"))?.source ?? "" }],
    remotes: [{ path: "ReplicatedStorage/Remotes/CollectFruit", name: "CollectFruit", className: "RemoteEvent", direction: "client_to_server" }]
  });
  assert.equal(createProjectSnapshot(reidentifiedLive).projectSemanticHash, createProjectSnapshot(live).projectSemanticHash);

  const studioManifestValue: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/studio/forge.fixture.json"), "utf8"));
  assertFixtureManifest(studioManifestValue);
  const studioMap = await buildSemanticMap(resolve(root, "examples/collect-fruit/studio"), studioManifestValue);
  assert.match(studioMap.remoteFlows[0]?.serverEvidence?.mutations.find((mutation) => mutation.field === "Inventory")?.expression ?? "", /Fruit42:GetAttribute\("Reward"\)/);
  const observedStudio = mergeStudioObservation(studioMap, {
    kind: "StudioSnapshotObservation", schemaVersion: 3, project: { name: "ForgeCollectFruit", placeId: 0, universeId: 0 }, capturedAt: "2026-08-29T00:00:00.000Z",
    instances: [],
    scripts: studioMap.files.map((file, index) => ({ stableId: `studio_script_${index}`, path: "ServerScriptService/" + file.path.split("/").pop(), executionContext: file.executionContext, sourceHash: "local-token", source: file.source })),
    remotes: []
  });
  assert.equal(createProjectSnapshot(observedStudio).sourceHash, createProjectSnapshot(studioMap).sourceHash);

  const reordered: ForgeFixtureManifest = { ...manifest, instances: [...(manifest.instances ?? [])].reverse(), persistentState: [...(manifest.persistentState ?? [])].reverse(), uiBindings: [...(manifest.uiBindings ?? [])].reverse(), remoteFlows: [...manifest.remoteFlows].reverse() };
  const reorderedSnapshot = createProjectSnapshot(await buildSemanticMap(projectRoot, reordered));
  deepStrictEqual(reorderedSnapshot, createProjectSnapshot(first));

  const meaningfullyChanged: ForgeFixtureManifest = { ...manifest, instances: (manifest.instances ?? []).map((instance) => instance.path === "Workspace/Fruit" ? { ...instance, className: "Model" } : instance) };
  const changedSnapshot = createProjectSnapshot(await buildSemanticMap(projectRoot, meaningfullyChanged));
  assert.notEqual(changedSnapshot.structureHash, createProjectSnapshot(first).structureHash);
  assert.notEqual(changedSnapshot.projectSemanticHash, createProjectSnapshot(first).projectSemanticHash);
  assertProjectSnapshot(JSON.parse(JSON.stringify(changedSnapshot)));

  const cone = affectedVerificationCone(first, ["src/server/CollectFruit.server.luau"]);
  assert.deepStrictEqual(cone.affectedScriptPaths, ["src/server/CollectFruit.server.luau"]);
  assert.equal(cone.affectedRemoteIds.length, 1);
  assert.deepStrictEqual(cone.affectedMechanicContractIds, ["contract_collect_fruit"]);
  assert.ok(cone.checks.includes("replication_and_authority_contracts"));
  await assert.rejects(() => buildSemanticMap(projectRoot, { ...manifest, luauRoots: ["../outside"] }), /inside the project root/);
});

test("DeterministicContextCompiler selects relevant evidence with provenance", async () => {
  const manifest = await loadManifest();
  const semanticMap = await buildSemanticMap(projectRoot, manifest);
  semanticMap.files.push({ path: "src/unrelated/Unrelated.luau", absolutePath: resolve(projectRoot, "src/unrelated/Unrelated.luau"), source: "return 42", executionContext: "shared" });
  const contract = await loadContract();
  const traceDirectory = await mkdtemp(resolve(tmpdir(), "forge-context-test-"));
  const report = await verifyProject(projectRoot, { traceDirectory });
  await rm(traceDirectory, { recursive: true, force: true });
  const compiler = new DeterministicContextCompiler();
  const mechanicImplementationSpec = compileMechanicImplementationSpec(semanticMap, contract, { allowedPaths: ["src/server/CollectFruit.server.luau", "src/client/CollectFruit.client.luau"], allowedPatchOperations: ["replace_text"] });
  const context = await compiler.compile({ semanticMap, mechanicContract: contract, mechanicImplementationSpec, verificationIssues: report.report.issues, requestedChange: "Make collection reward server-owned." });
  const repeated = await compiler.compile({ semanticMap, mechanicContract: contract, mechanicImplementationSpec, verificationIssues: report.report.issues, requestedChange: "Make collection reward server-owned." });
  deepStrictEqual(context, repeated);
  assert.ok(context.items.find((item) => item.type === "mechanic_contract")?.required);
  assert.ok(context.items.find((item) => item.type === "verification_issue")?.required);
  assert.ok(context.items.some((item) => item.source.endsWith("CollectFruit.server.luau")));
  assert.ok(context.items.some((item) => item.source.endsWith("CollectFruit.client.luau")));
  assert.equal(context.items.some((item) => item.source.includes("Unrelated.luau")), false);
  assert.ok(context.items.every((item) => item.contentHash.length === 64 && item.reason.length > 0));
  assert.equal(context.evictedTokenEstimate, 0);
  const recorder = new FlightRecorder({ projectId: semanticMap.projectId });
  recorder.setContextSummary(contextSummary(context));
  const trace = recorder.complete(acceptedOutcome(), { issues: [] }, { level: "semantic_reproduction", reasons: ["test"], randomSeeds: {} });
  assertBuildTrace(trace);
  assert.equal(trace.context?.compositionHash, context.compositionHash);
  assert.equal(trace.components.studio, undefined);

  const studioRecorder = new FlightRecorder({ projectId: semanticMap.projectId, components: { studio: { name: "Forge Studio Plugin", version: "forge-studio-plugin-0.1.0" } } });
  studioRecorder.recordSpan("forge.studio.connect", "ok", { session: "test" });
  studioRecorder.recordSpan("forge.studio.snapshot", "ok", { observation: "test" });
  const studioTrace = studioRecorder.complete(acceptedOutcome(), { issues: [] }, { level: "semantic_reproduction", reasons: ["unit test"], randomSeeds: {} });
  assertBuildTrace(studioTrace);
  assert.equal(studioTrace.components.studio?.version, "forge-studio-plugin-0.1.0");
  assert.deepEqual(studioTrace.spans.map((span) => span.name), ["forge.studio.connect", "forge.studio.snapshot"]);

  const trajectory: TrajectoryEvent = { kind: "TrajectoryEvent", schemaVersion: 1, id: "trajectory_1", sequence: 1, occurredAt: "2026-08-29T00:00:00.000Z", event: "verification_completed", actor: "forge", projectId: semanticMap.projectId, references: { mechanicContractId: "contract_collect_fruit" }, payloadHash: contentHash("normalized-result"), attributes: { status: "rejected" }, privacyClass: "project" };
  assertTrajectoryEvent(trajectory);
});

test("VerifiedMechanicCapsule requires authoritative provenance before verified status", () => {
  const capsule = candidateCapsule({
    id: "capsule_collectible",
    version: "1.0.0",
    taxonomy: ["acquisition", "collectible"],
    baseContract: { kind: "MechanicContract", schemaVersion: 2, id: "contract_collect_fruit", name: "CollectFruit" },
    parameterSchema: { inventoryField: { type: "string", required: true } },
    implementationStrategy: { kind: "adaptation_required", description: "Adapt the contract to project-specific world and inventory capabilities." },
    requiredProjectCapabilities: ["server_authority", "remote_event"],
    producedProjectCapabilities: ["authoritative_collection"],
    invariants: ["Reward is server-owned.", "Consumed fruit cannot be collected twice."],
    adaptationRules: [{ parameter: "inventoryField", allowedValues: ["Inventory", "Crystals"], verificationRequired: true }],
    verificationSuite: { assertionIds: ["assert_collect_fruit_server_reward"], requiredTiers: ["static", "studio"] },
    provenance: { proofBundleIds: [], buildTraceIds: [], toolchainVersions: [], studioRuntimeVersions: [], contractVersion: 1, testSuiteVersion: "m2", knownLimitations: ["Studio proof not yet available."] }
  });
  assertVerifiedMechanicCapsule(capsule);
  assert.throws(() => assertVerifiedMechanicCapsule({ ...capsule, verification: { status: "verified" } }), /requires ProofBundle/);
});

async function loadManifest(): Promise<ForgeFixtureManifest> {
  const value: unknown = JSON.parse(await readFile(resolve(projectRoot, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(value);
  return value;
}

async function loadContract(): Promise<MechanicContract> {
  const value: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/MechanicContract.json"), "utf8"));
  assertMechanicContract(value);
  return value;
}

function acceptedOutcome(): BuildOutcome {
  return { status: "accepted", verified: false, staticPass: true, semanticPass: true, studioPass: "not_run", attempts: 1, deterministicRepairs: 0, modelRepairs: 0, assertions: { total: 0, passed: 0 }, modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: { total: 0 }, issueCounts: { info: 0, warning: 0, error: 0, critical: 0 } };
}
