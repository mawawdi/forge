import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertFixtureManifest, assertMechanicContract, type ForgeFixtureManifest, type MechanicContract, type PatchSet } from "../packages/contracts/src/index.js";
import { buildSemanticMap, createProjectSnapshot, type StudioSnapshotObservation } from "../packages/semantic-map/src/index.js";
import { assembleStaticSemanticProof } from "../packages/proofs/src/index.js";
import { assertStudioProofRun, assertStudioTestPlan, attachStudioProof, collectFruitTestPlan, StudioProofCapture } from "../packages/studio-proof/src/index.js";
import { resolveStudioPatchSet, resolveStudioPatchTargets } from "../packages/studio-proof/src/runner.js";
import { COLLECT_FRUIT_HARNESS_HASH, COLLECT_FRUIT_HARNESS_VERSION, STUDIO_PLUGIN_VERSION } from "../packages/studio-protocol/src/index.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const repaired = resolve(root, "examples/collect-fruit/repaired");
const time = "2026-08-29T00:00:00.000Z";
const nonce = "nonce_capture_1234567890";
const nonceCommitment = createHash("sha256").update(nonce).digest("hex");

async function fixture(): Promise<{ contract: MechanicContract; manifest: ForgeFixtureManifest; snapshot: Awaited<ReturnType<typeof createProjectSnapshot>> }> {
  const contractValue: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/MechanicContract.json"), "utf8"));
  const manifestValue: unknown = JSON.parse(await readFile(resolve(repaired, "forge.fixture.json"), "utf8"));
  assertMechanicContract(contractValue); assertFixtureManifest(manifestValue);
  return { contract: contractValue, manifest: manifestValue, snapshot: createProjectSnapshot(await buildSemanticMap(repaired, manifestValue)) };
}

function binding(plan: ReturnType<typeof collectFruitTestPlan>, snapshot: Awaited<ReturnType<typeof createProjectSnapshot>>) {
  return { projectId: "studio_project_1", sessionId: "session_capture", project: { name: "ForgeCollectFruit", placeId: 1, universeId: 2 }, runId: "run_capture", testPlanId: plan.id, correlationId: "correlation_capture", projectSnapshotHash: snapshot.projectSemanticHash, mechanicContractHash: plan.mechanicContractHash, nonceCommitment };
}
function captureOptions(plan: ReturnType<typeof collectFruitTestPlan>, snapshot: Awaited<ReturnType<typeof createProjectSnapshot>>) {
  return { ...binding(plan, snapshot), projectSnapshot: snapshot, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", authoritativeSession: true, harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, harnessHash: COLLECT_FRUIT_HARNESS_HASH, testPlan: plan };
}
function envelope(plan: ReturnType<typeof collectFruitTestPlan>, snapshot: Awaited<ReturnType<typeof createProjectSnapshot>>) {
  const current = binding(plan, snapshot);
  return { kind: "StudioHarnessRunEnvelope" as const, schemaVersion: 1 as const, ...current, nonce, harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, harnessHash: COLLECT_FRUIT_HARNESS_HASH, status: "completed" as const, authoritative: true, startedAt: time, endedAt: time, durationMs: 7, assertions: plan.assertions.map((assertion) => ({ kind: "StudioHarnessEvidence" as const, schemaVersion: 1 as const, ...current, nonce, id: `result_${assertion.id}`, assertionId: assertion.id, status: "pass" as const, expected: true, observed: true, evidence: [{ type: "state" as const, statement: assertion.name }], authoritative: true, durationMs: 1, emittedAt: time })), diagnostics: [] };
}
function accepted(plan: ReturnType<typeof collectFruitTestPlan>, snapshot: Awaited<ReturnType<typeof createProjectSnapshot>>) { return { kind: "StudioProtocolMessage" as const, schemaVersion: 7 as const, direction: "plugin_to_backend" as const, type: "AssertionPlanAccepted" as const, messageId: "accepted", sentAt: time, payload: { ...binding(plan, snapshot), assertionCount: 7, harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, instruction: "Ready" } }; }
function lifecycle(type: "PlaytestStarted" | "PlaytestStopped", plan: ReturnType<typeof collectFruitTestPlan>, snapshot: Awaited<ReturnType<typeof createProjectSnapshot>>) { return { kind: "StudioProtocolMessage" as const, schemaVersion: 7 as const, direction: "plugin_to_backend" as const, type, messageId: type, sentAt: time, payload: { ...binding(plan, snapshot), mode: "play_solo" as const, playerCount: type === "PlaytestStarted" ? 1 : 0, control: "plugin_action" as const } }; }

test("CollectFruit plan has seven assertions and four adversarial cases", async () => { const { contract, snapshot } = await fixture(); const plan = collectFruitTestPlan(contract, snapshot); assertStudioTestPlan(plan); assert.equal(plan.assertions.length, 7); assert.equal(plan.adversarialCases.length, 4); });

test("an external candidate bypasses fixture-only fallback construction", async () => {
  const candidate = { kind: "PatchSet", schemaVersion: 1, id: "candidate", projectHash: "seed", mechanicContractId: "contract", operations: [], expectedEffects: [], provenance: { generatedAt: time }, bounds: { maxFiles: 0, maxAddedLines: 0, maxRemovedLines: 0 } } satisfies PatchSet;
  let fallbackCalls = 0;
  const selected = await resolveStudioPatchSet(candidate, async () => { fallbackCalls += 1; throw new Error("fallback must remain lazy"); });
  assert.equal(selected, candidate);
  assert.equal(fallbackCalls, 0);
});

test("candidate patch targets retain observed Script and LocalScript classes", () => {
  const serverSource = "return true";
  const clientSource = "return false";
  const patchSet = { kind: "PatchSet", schemaVersion: 1, id: "candidate", projectHash: "seed", mechanicContractId: "contract", operations: [{ type: "replace_text", path: "src/server/CollectFruit.server.luau", beforeHash: createHash("sha256").update(serverSource).digest("hex"), before: serverSource, after: serverSource }, { type: "replace_text", path: "src/client/CollectFruitClient.client.luau", beforeHash: createHash("sha256").update(clientSource).digest("hex"), before: clientSource, after: clientSource }], expectedEffects: [], provenance: { generatedAt: time }, bounds: { maxFiles: 2, maxAddedLines: 0, maxRemovedLines: 0 } } satisfies PatchSet;
  const observation = { kind: "StudioSnapshotObservation", schemaVersion: 2, project: { name: "Fixture", placeId: 0, universeId: 0 }, capturedAt: time, instances: [{ stableId: "server", path: "ServerScriptService/CollectFruit.server.luau", className: "Script", properties: [], attributes: [], tags: [] }, { stableId: "client", path: "StarterPlayer/StarterPlayerScripts/CollectFruitClient.client.luau", className: "LocalScript", properties: [], attributes: [], tags: [] }], scripts: [{ stableId: "server", path: "ServerScriptService/CollectFruit.server.luau", executionContext: "server", sourceHash: createHash("sha256").update(serverSource).digest("hex"), source: serverSource }, { stableId: "client", path: "StarterPlayer/StarterPlayerScripts/CollectFruitClient.client.luau", executionContext: "client", sourceHash: createHash("sha256").update(clientSource).digest("hex"), source: clientSource }], remotes: [] } satisfies StudioSnapshotObservation;
  const targets = resolveStudioPatchTargets(patchSet, observation);
  assert.deepEqual(targets.map((entry) => entry.target?.className), ["Script", "LocalScript"]);
});

test("atomic server result creates an authoritative verified StudioProof", async () => {
  const { contract, snapshot } = await fixture(); const plan = collectFruitTestPlan(contract, snapshot); const capture = new StudioProofCapture(captureOptions(plan, snapshot));
  capture.accept(accepted(plan, snapshot)); capture.accept(lifecycle("PlaytestStarted", plan, snapshot)); capture.accept({ kind: "StudioProtocolMessage", schemaVersion: 7, direction: "plugin_to_backend", type: "StudioTestResult", messageId: "result", sentAt: time, payload: envelope(plan, snapshot) }); capture.accept(lifecycle("PlaytestStopped", plan, snapshot));
  const run = capture.complete(); assert.equal(run.status, "pass"); assert.equal(run.authoritative, true); assert.equal(run.assertionResults.length, 7); assertStudioProofRun(run);
  const traceDirectory = await mkdtemp(resolve(tmpdir(), "forge-studio-proof-test-"));
  try {
    const report = await verifyProject(repaired, { traceDirectory });
    const staticBundle = assembleStaticSemanticProof(report.report, contract, "patch_collect_fruit", "patch_hash", snapshot.projectSemanticHash, snapshot.projectSemanticHash, time);
    const bundle = attachStudioProof(staticBundle, run); assert.equal(bundle.gate.status, "verified");
    const failedRun = { ...run, runId: "run_failed", correlationId: "correlation_failed", status: "fail" as const, assertionResults: run.assertionResults.map((result, index) => ({ ...result, id: `failed_${index}`, runId: "run_failed", correlationId: "correlation_failed", ...(index === run.assertionResults.length - 1 ? { status: "fail" as const, observed: 2 } : {}) })) };
    assertStudioProofRun(failedRun);
    const rejectedBundle = attachStudioProof(staticBundle, failedRun);
    assert.equal(rejectedBundle.gate.status, "rejected");
    assert.notEqual(rejectedBundle.id, bundle.id, "runtime verdict and evidence must change ProofBundle identity");
    assert.equal(attachStudioProof(staticBundle, run).id, bundle.id, "identical decision evidence must retain its identity");
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
});

test("atomic result rejects duplicates and wrong nonces; Output is not a protocol message", async () => {
  const { contract, snapshot } = await fixture(); const plan = collectFruitTestPlan(contract, snapshot); const result = envelope(plan, snapshot); const message = { kind: "StudioProtocolMessage" as const, schemaVersion: 7 as const, direction: "plugin_to_backend" as const, type: "StudioTestResult" as const, messageId: "result", sentAt: time, payload: result };
  const capture = new StudioProofCapture(captureOptions(plan, snapshot)); capture.accept(accepted(plan, snapshot)); capture.accept(lifecycle("PlaytestStarted", plan, snapshot)); capture.accept(message); assert.throws(() => capture.accept({ ...message, messageId: "duplicate" }), /Duplicate Studio test result/);
  capture.accept(lifecycle("PlaytestStopped", plan, snapshot)); assert.throws(() => capture.accept({ ...lifecycle("PlaytestStopped", plan, snapshot), messageId: "duplicate_stop" }), /Duplicate Studio playtest stop/);
  const rejected = new StudioProofCapture(captureOptions(plan, snapshot)); rejected.accept(accepted(plan, snapshot)); rejected.accept(lifecycle("PlaytestStarted", plan, snapshot)); assert.throws(() => rejected.accept({ ...message, payload: { ...result, nonce: "wrong_nonce_1234567890" } }), /(Invalid StudioTestResult payload|active run binding)/);
});

test("the fixture has no permanent test context or nonce", async () => { for (const file of ["default.project.json", "forge.fixture.json", "src/server/CollectFruit.server.luau", "src/client/CollectFruitClient.client.luau"]) assert.doesNotMatch(await readFile(resolve(root, "examples/collect-fruit/studio", file), "utf8"), /ForgeStudioTestInput|ForgeTestEvidence|ForgeTestControl|ForgeTestReply|nonce/); });

test("the plugin arms first and uses the canary-proven Play Solo result contract", async () => {
  const proof = await readFile(resolve(root, "plugin/src/Forge/StudioProofExecutor.luau"), "utf8");
  const harness = await readFile(resolve(root, "plugin/src/Forge/CollectFruitHarness.luau"), "utf8");
  const revision = await readFile(resolve(root, "plugin/src/Forge/ObservationRevision.luau"), "utf8");
  const runtime = await readFile(resolve(root, "plugin/src/Forge/Runtime.luau"), "utf8");
  const transactions = await readFile(resolve(root, "plugin/src/Forge/TransactionManager.luau"), "utf8");
  const snapshots = await readFile(resolve(root, "plugin/src/Forge/SnapshotCollector.luau"), "utf8");
  const main = await readFile(resolve(root, "plugin/src/Main.server.luau"), "utf8");
  const constants = await readFile(resolve(root, "plugin/src/Forge/Constants.luau"), "utf8");
  const modules = await readdir(resolve(root, "plugin/src/Forge"));
  assert.match(main, /RunService:IsRunning\(\)[\s\S]*return/);
  assert.equal(modules.includes("TestModeRelay.luau"), false);
  assert.equal(createHash("sha256").update(harness).digest("hex"), COLLECT_FRUIT_HARNESS_HASH);
  assert.match(constants, new RegExp(STUDIO_PLUGIN_VERSION.replaceAll(".", "\\.")));
  assert.match(proof, /function StudioProofExecutor:arm/); assert.match(proof, /function StudioProofExecutor:start/); assert.ok(proof.indexOf("function StudioProofExecutor:arm") < proof.indexOf("function StudioProofExecutor:start"));
  const armOnly = proof.slice(proof.indexOf("function StudioProofExecutor:arm"), proof.indexOf("function StudioProofExecutor:start")); assert.doesNotMatch(armOnly, /StudioTestService:ExecutePlayModeAsync\(|server\.Parent|client\.Parent/, "arming must not launch Studio or mutate the DataModel");
  assert.match(proof, /StudioTestService:ExecutePlayModeAsync/); assert.doesNotMatch(proof + harness, /ExecuteMultiplayerTestAsync|GetTestArgs|FORGE_STUDIO_EVIDENCE|LogService|returnValue/); assert.doesNotMatch(proof, /timeoutSeconds\s*=/); assert.match(harness, /StudioTestService:EndTest\(HttpService:JSONEncode\(envelope\)\)/); assert.match(proof, /forgeStudioProofRunId = binding\.runId/); assert.match(proof, /server\.Parent = Workspace/); assert.match(proof, /client\.Parent = starterPlayerScripts/); assert.doesNotMatch(proof + harness, /loadstring/);
  assert.match(harness, /EXPECTED_ASSERTION_IDS/); assert.match(harness, /supportsAssertions/); assert.match(harness, /supportsResults/); assert.match(runtime, /proof:supportsPlan\(payload\)/); assert.match(proof, /CollectFruitHarness\.supportsResults\(envelope\.assertions\)/);
  assert.match(harness, /spoofedRewardDelta == 1/); assert.match(harness, /inventoryBefore = beforeSpoofedReward/); assert.doesNotMatch(harness, /spoofedRewardInventory == 1/, "CF-007 must assert the authoritative reward delta, not absolute inventory");
  const resetFruitBlock = harness.slice(harness.indexOf("local function resetFruit"), harness.indexOf("local function complete")); assert.doesNotMatch(resetFruitBlock, /SetAttribute\("Inventory"/, "test setup must not rewrite candidate inventory state");
  assert.match(harness, /beforeDistanceInventory/); assert.match(harness, /afterDistanceInventory ~= beforeDistanceInventory/);
  assert.equal(harness.match(/StudioTestService:EndTest\(/g)?.length, 1, "exactly one server path owns EndTest");
  assert.match(runtime, /runButton\.MouseButton1Click/); assert.match(runtime, /proof:arm\(/); assert.match(runtime, /proof:start\(\)/); assert.doesNotMatch(runtime, /proof:execute\(/);
  assert.match(runtime, /\/v1\/pairing/); assert.match(runtime, /pairAutomatically/); assert.doesNotMatch(runtime, /Paste bridge pairing token|pairTokenBox|pairingToken = string\.gsub/);
  assert.match(transactions, /FinishRecording\(active\.recording, Enum\.FinishRecordingOperation\.Cancel\)[\s\S]*for index = #active\.inverse, 1, -1/); assert.doesNotMatch(transactions, /if cancelled then return true/);
  assert.match(runtime, /revision ~= expectedRevision/); assert.match(runtime, /ROLLBACK FAILED/);
  assert.ok(runtime.indexOf('sendSnapshot("pre_play")') < runtime.indexOf("proof:start()"), "the live revision must be checked before Play Solo starts");
  assert.match(proof, /self\.blocked = true/); assert.match(proof, /PLUGIN RELOAD REQUIRED/);
  assert.match(proof, /PLAYTEST_INTERRUPTED/); assert.match(proof, /retryable = interrupted or timedOut/); assert.match(proof, /VERIFICATION INCOMPLETE/); assert.match(runtime, /proof:isIncomplete\(\)/); assert.match(runtime, /state\("INCOMPLETE"/);
  assert.doesNotMatch(runtime, /SetSetting\(/); assert.match(runtime, /ProjectObservation/);
  assert.doesNotMatch(snapshots, /snapshot\s*=\s*\{\s*kind\s*=\s*"ProjectSnapshot"/);
  const patchFailureBlock = runtime.slice(runtime.indexOf("if failure then"), runtime.indexOf("sendSnapshot(\"post_patch\")"));
  assert.doesNotMatch(patchFailureBlock, /transactions:rollback/, "the verifier is the sole rollback owner after PatchRejected");
  assert.doesNotMatch(revision, /capturedAt/);
});
