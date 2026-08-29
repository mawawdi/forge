import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertFixtureManifest, assertMechanicContract, type ForgeFixtureManifest, type MechanicContract } from "../packages/contracts/src/index.js";
import { buildSemanticMap, createProjectSnapshot } from "../packages/semantic-map/src/index.js";
import { assembleStaticSemanticProof } from "../packages/proofs/src/index.js";
import { assertStudioProofRun, assertStudioTestPlan, attachStudioProof, collectFruitTestPlan, StudioProofCapture, type StudioProofRun } from "../packages/studio-proof/src/index.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const repaired = resolve(root, "examples/collect-fruit/repaired");

test("CollectFruit StudioProof plan has seven adversarial/runtime assertions", async () => {
  const contract = await loadContract();
  const manifest = await loadManifest();
  const map = await buildSemanticMap(repaired, manifest);
  const plan = collectFruitTestPlan(contract, createProjectSnapshot(map));
  assertStudioTestPlan(plan);
  assert.equal(plan.assertions.length, 7);
  assert.equal(plan.adversarialCases.length, 4);
  assert.ok(plan.assertions.every((assertion) => assertion.mechanicContractId === contract.id));
});

test("incomplete Studio runs remain explicit and complete runs require every authoritative assertion", async () => {
  const contract = await loadContract();
  const manifest = await loadManifest();
  const map = await buildSemanticMap(repaired, manifest);
  const beforeSnapshot = createProjectSnapshot(map);
  const plan = collectFruitTestPlan(contract, beforeSnapshot);
  const report = await verifyProject(repaired, { traceDirectory: resolve(root, ".forge", "test-traces") });
  const bundle = assembleStaticSemanticProof(report.report, contract, "patch_collect_fruit", "2026-08-29T00:00:00.000Z");

  const incomplete: StudioProofRun = { kind: "StudioProofRun", schemaVersion: 1, runId: "run_incomplete", testPlan: plan, beforeSnapshot, pluginVersion: "forge-studio-plugin-0.1.0", studioVersion: "unknown", assertionResults: [], runtimeEvidence: [], status: "incomplete", authoritative: false };
  assertStudioProofRun(incomplete);
  const incompleteBundle = attachStudioProof(bundle, incomplete);
  assert.equal(incompleteBundle.gate.status, "incomplete");
  assert.equal(incompleteBundle.studioProof, undefined);

  const complete: StudioProofRun = {
    ...incomplete,
    runId: "run_complete",
    status: "pass",
    authoritative: true,
    assertionResults: plan.assertions.map((assertion) => ({
      kind: "StudioAssertionResult",
      schemaVersion: 1,
      id: "result_" + assertion.id,
      runId: "run_complete",
      testPlanId: plan.id,
      assertionId: assertion.id,
      status: "pass",
      expected: true,
      observed: true,
      evidence: [{ type: "state", statement: "Studio observed " + assertion.name }],
      authoritative: true,
      durationMs: 10
    }))
  };
  const completeBundle = attachStudioProof(bundle, complete);
  assert.equal(completeBundle.gate.status, "verified");
  assert.equal(completeBundle.studioProof?.assertionResultIds.length, 7);
});

test("StudioProofCapture converts correlated bridge messages into an explicit run", async () => {
  const contract = await loadContract();
  const manifest = await loadManifest();
  const map = await buildSemanticMap(repaired, manifest);
  const beforeSnapshot = createProjectSnapshot(map);
  const plan = collectFruitTestPlan(contract, beforeSnapshot);
  const capture = new StudioProofCapture({ runId: "run_capture", testPlan: plan, beforeSnapshot, pluginVersion: "forge-studio-plugin-0.1.0", studioVersion: "0.736.0", authoritativeSession: true });
  for (const assertion of plan.assertions) capture.accept({ kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "AssertionResult", messageId: "message_" + assertion.id, sentAt: "2026-08-29T00:00:00.000Z", payload: { id: "result_" + assertion.id, runId: "run_capture", testPlanId: plan.id, assertionId: assertion.id, status: "pass", expected: true, observed: true, evidence: [{ type: "state", statement: assertion.name }], authoritative: true, durationMs: 10 } });
  capture.accept({ kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "PlaytestStopped", messageId: "message_stop", sentAt: "2026-08-29T00:00:00.000Z", payload: { runId: "run_capture", mode: "play", playerCount: 1 } });
  const run = capture.complete();
  assertStudioProofRun(run);
  assert.equal(run.status, "pass");
  assert.equal(run.authoritative, true);
  assert.equal(run.assertionResults.length, 7);
});

async function loadManifest(): Promise<ForgeFixtureManifest> {
  const value: unknown = JSON.parse(await readFile(resolve(repaired, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(value);
  return value;
}

async function loadContract(): Promise<MechanicContract> {
  const value: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/MechanicContract.json"), "utf8"));
  assertMechanicContract(value);
  return value;
}
