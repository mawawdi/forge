import { deepStrictEqual, strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertCoreLoop, assertGameIntent, assertMechanicContract, assertPatchSet, assertStudioAssertion, type MechanicContract, type PatchSet } from "../packages/contracts/src/index.js";
import { applyPatchSet } from "../packages/patch-model/src/index.js";
import { JsonFileTraceSink } from "../packages/flight-recorder/src/index.js";
import { createCollectFruitRepair } from "../packages/repair/src/index.js";
import { repairProject } from "../packages/repair/src/orchestrator.js";
import { verifyProject } from "../packages/verifier/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const vulnerable = resolve(root, "examples/collect-fruit/vulnerable");
const repaired = resolve(root, "examples/collect-fruit/repaired");
const contractPath = resolve(root, "examples/collect-fruit/contracts/MechanicContract.json");

test("M2 fixture contracts and immutable patch fixtures validate", async () => {
  const intent: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/GameIntent.json"), "utf8"));
  const loop: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/CoreLoop.json"), "utf8"));
  const contract: unknown = JSON.parse(await readFile(contractPath, "utf8"));
  const vulnerablePatch: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/patches/vulnerable.json"), "utf8"));
  const repairedPatch: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/patches/repaired.json"), "utf8"));
  const studioAssertion: unknown = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/contracts/StudioAssertion.json"), "utf8"));
  assertGameIntent(intent);
  assertCoreLoop(loop);
  assertMechanicContract(contract);
  assertPatchSet(vulnerablePatch);
  assertPatchSet(repairedPatch);
  assertStudioAssertion(studioAssertion);
  assert.equal(contract.id, "contract_collect_fruit");
  assert.equal(repairedPatch.mechanicContractId, contract.id);
});

test("deterministic CollectFruit repair rejects the vulnerable source and passes after atomic apply", async () => {
  const contract = await loadContract();
  const generated = await createCollectFruitRepair(vulnerable, contract, { now: () => new Date("2026-08-29T00:00:00.000Z") });
  const fixture = JSON.parse(await readFile(resolve(root, "examples/collect-fruit/patches/repaired.json"), "utf8")) as PatchSet;
  deepStrictEqual(generated, fixture);

  const outputParent = await mkdtemp(resolve(tmpdir(), "forge-m2-"));
  const output = resolve(outputParent, "repaired");
  const traceDirectory = resolve(outputParent, "traces");
  try {
    const before = await verifyProject(vulnerable, { traceDirectory, traceReferences: { mechanicContractId: contract.id } });
    assert.equal(before.report.gate.status, "rejected");
    assert.ok(before.report.issues.some((issue) => issue.ruleId === "REMOTE_CLIENT_CONTROLLED_REWARD"));

    const run = await repairProject(vulnerable, contract, { destinationRoot: output, traceDirectory, now: () => new Date("2026-08-29T00:00:00.000Z") });
    assert.equal(run.after.report.gate.status, "verified");
    assert.equal(run.application.changedPaths.length, 1);
    assert.equal(run.application.changedPaths[0], "src/server/CollectFruit.server.luau");
    assert.equal(run.after.trace.references.mechanicContractId, contract.id);
    assert.equal(run.after.trace.references.patchSetId, run.patchSet.id);
    assert.equal(run.after.trace.outcome.attempts, 2);
    assert.equal(run.after.trace.outcome.deterministicRepairs, 1);
    assert.ok((run.after.trace.context?.itemCount ?? 0) > 0);
    assert.ok(run.after.trace.context?.compositionHash);
    assert.ok(run.after.trace.spans.some((span) => span.name === "forge.repair.deterministic"));
    assert.ok(run.after.trace.spans.some((span) => span.name === "forge.patch.apply"));
    assert.equal(run.proofBundle.gate.status, "incomplete");
    assert.equal(run.proofBundle.checks.find((check) => check.name === "pure_luau_preflight")?.status, "not_run");
    assert.equal(run.proofBundle.checks.find((check) => check.name === "roblox_studio")?.status, "not_run");
    assert.equal((await new JsonFileTraceSink(traceDirectory).read(run.after.trace.id)).context?.compositionHash, run.after.trace.context?.compositionHash);

    const repairedReport = await verifyProject(repaired, { traceDirectory });
    assert.equal(repairedReport.report.gate.status, "verified");
    assert.equal(repairedReport.report.issues.length, 0);
  } finally {
    await rm(outputParent, { recursive: true, force: true });
  }
});

test("patch application refuses a stale source without publishing a destination", async () => {
  const contract = await loadContract();
  const patch = await createCollectFruitRepair(vulnerable, contract, { now: () => new Date("2026-08-29T00:00:00.000Z") });
  const stale: PatchSet = { ...patch, projectHash: "stale-project-hash" };
  const outputParent = await mkdtemp(resolve(tmpdir(), "forge-m2-atomic-"));
  const output = resolve(outputParent, "repaired");
  try {
    await assert.rejects(() => applyPatchSet(vulnerable, stale, output), /project hash mismatch/);
    await assert.rejects(() => readFile(resolve(output, "src/server/CollectFruit.server.luau"), "utf8"));
  } finally {
    await rm(outputParent, { recursive: true, force: true });
  }
});

async function loadContract(): Promise<MechanicContract> {
  const value: unknown = JSON.parse(await readFile(contractPath, "utf8"));
  assertMechanicContract(value);
  return value;
}
