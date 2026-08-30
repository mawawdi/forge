import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFixtureManifest } from "../../contracts/src/index.js";
import { DeterministicContextCompiler, contextSummary } from "../../context-compiler/src/index.js";
import { buildSemanticMap, compileMechanicImplementationSpec } from "../../semantic-map/src/index.js";
import { assembleStaticSemanticProof } from "../../proofs/src/index.js";
import { applyPatchSet, type PatchApplicationResult } from "../../patch-model/src/index.js";
import { assertMechanicContract, contentHash, stableJson, type MechanicContract, type ProofBundle, type PatchSet, type TracePersistence } from "../../contracts/src/index.js";
import { createCollectFruitRepair } from "./index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";

export interface RepairProjectOptions {
  destinationRoot: string;
  traceDirectory?: string;
  now?: () => Date;
}

export interface RepairProjectResult {
  before: VerificationRun;
  patchSet: PatchSet;
  application: PatchApplicationResult;
  after: VerificationRun;
  proofBundle: ProofBundle;
  tracePersistence: { before: TracePersistence; after: TracePersistence };
}

export async function repairProject(projectRoot: string, contract: MechanicContract, options: RepairProjectOptions): Promise<RepairProjectResult> {
  const before = await verifyProject(projectRoot, { ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}), traceReferences: { mechanicContractId: contract.id } });
  const patchSet = await createCollectFruitRepair(projectRoot, contract, options.now ? { now: options.now } : {});
  const application = await applyPatchSet(projectRoot, patchSet, options.destinationRoot);
  const manifestValue: unknown = JSON.parse(await readFile(resolve(projectRoot, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(manifestValue);
  const semanticMap = await buildSemanticMap(projectRoot, manifestValue);
  const implementationSpec = compileMechanicImplementationSpec(semanticMap, contract, { allowedPaths: semanticMap.remoteFlows.filter((flow) => flow.declaration.name === contract.name).flatMap((flow) => [flow.client.path, flow.server.path]), allowedPatchOperations: ["replace_text"] });
  const compiledContext = await new DeterministicContextCompiler().compile({ semanticMap, mechanicContract: contract, mechanicImplementationSpec: implementationSpec, verificationIssues: before.report.issues, requestedChange: "Repair the client-controlled reward while preserving the project ABI.", patchSet });
  const after = await verifyProject(options.destinationRoot, {
    ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}),
    traceReferences: { mechanicContractId: contract.id, patchSetId: patchSet.id },
    tracePreludeSpans: [
      { name: "forge.patch.create", status: "ok", attributes: { "forge.patch_id": patchSet.id, "forge.patch.files_changed": application.changedPaths.length }, durationMs: 0 },
      { name: "forge.patch.apply", status: "ok", attributes: { "forge.patch_id": patchSet.id, "forge.patch.atomic": true }, durationMs: 0 },
      { name: "forge.repair.deterministic", status: "ok", attributes: { "forge.repair.policy": "collect-fruit-server-reward-v1", "forge.patch_id": patchSet.id }, durationMs: 0 }
    ],
    traceComponents: { repairPolicy: { name: "collect-fruit-server-reward", version: "1" } },
    traceContextSummary: contextSummary(compiledContext),
    outcomeOverrides: { attempts: 2, deterministicRepairs: 1 }
  });
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const proofBundle = assembleStaticSemanticProof(after.report, contract, patchSet.id, contentHash(stableJson(patchSet)), before.report.projectHash, after.report.projectHash, generatedAt);
  return { before, patchSet, application, after, proofBundle, tracePersistence: { before: before.tracePersistence, after: after.tracePersistence } };
}

export async function loadMechanicContract(path: string): Promise<MechanicContract> {
  const { readFile } = await import("node:fs/promises");
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  assertMechanicContract(value);
  return value;
}
