import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertMechanicContract, assertPatchSet, assertFixtureManifest, contentHash, stableJson, type MechanicContract, type PatchSet } from "../../contracts/src/index.js";
import { buildSemanticMap } from "../../semantic-map/src/index.js";
import { sourceSnapshotHash } from "../../patch-model/src/index.js";

export interface DeterministicRepairOptions {
  now?: () => Date;
}

export async function createCollectFruitRepair(projectRoot: string, contract: MechanicContract, options: DeterministicRepairOptions = {}): Promise<PatchSet> {
  assertMechanicContract(contract);
  if (contract.name !== "CollectFruit") throw new Error(`Deterministic M2 repair only supports CollectFruit, received ${contract.name}`);
  const root = resolve(projectRoot);
  const manifest = JSON.parse(await readFile(resolve(root, "forge.fixture.json"), "utf8")) as unknown;
  assertFixtureManifest(manifest);
  const flow = manifest.remoteFlows.find((candidate) => candidate.name === contract.name);
  if (!flow) throw new Error(`No ${contract.name} remote flow is declared in forge.fixture.json`);
  const semanticMap = await buildSemanticMap(root, manifest);
  const mapped = semanticMap.remoteFlows.find((candidate) => candidate.declaration.name === contract.name);
  if (!mapped?.serverEvidence) throw new Error(`No repairable server mutation was found for ${contract.name}`);
  const input = flow.clientInputs[0];
  if (!input) throw new Error(`No client input is declared for ${contract.name}`);
  const inputName = mapped.serverEvidence.parameters.find((parameter) => parameter.position === input.position)?.name;
  if (!inputName) throw new Error(`No server parameter is bound to ${input.role} at position ${input.position}`);
  if (!new RegExp(`\\b${escapeRegExp(inputName)}\\b`).test(mapped.serverEvidence.mutationExpression)) throw new Error(`No client-controlled reward expression was found for ${contract.name}`);

  const before = mapped.server.source;
  const mutation = mapped.serverEvidence.mutation;
  const safeMutation = mutation.replace(new RegExp(`\\+\\s*${escapeRegExp(inputName)}\\s*$`), "+ 1");
  if (safeMutation === mutation) throw new Error(`Unsupported ${contract.name} mutation shape`);
  const indentation = mutation.match(/^\s*/)?.[0] ?? "";
  const after = before.replace(mutation, `${indentation}if typeof(${inputName}) ~= "number" then return end\n${indentation}if ${inputName} <= 0 then return end\n${safeMutation}`);
  if (after === before) throw new Error(`Unable to construct deterministic repair for ${contract.name}`);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const projectHash = await sourceSnapshotHash(root);
  const patch: PatchSet = {
    kind: "PatchSet",
    schemaVersion: 1,
    id: `patch_${contentHash(stableJson({ projectHash, mechanicContractId: contract.id, path: mapped.server.path, after })).slice(0, 24)}`,
    projectHash,
    mechanicContractId: contract.id,
    operations: [{ type: "replace_text", path: mapped.server.path, beforeHash: contentHash(before), before, after }],
    expectedEffects: [
      { statement: "Reject invalid client amount values at the server boundary.", evidence: "contract" },
      { statement: "Compute the inventory reward from server-owned state rather than the client amount.", evidence: "contract" }
    ],
    provenance: { generatedAt },
    bounds: { maxFiles: 1, maxAddedLines: 2, maxRemovedLines: 0 }
  };
  assertPatchSet(patch);
  return patch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}
