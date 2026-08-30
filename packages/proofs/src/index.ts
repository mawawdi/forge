import { assertProofBundle, contentHash, stableJson, type MechanicContract, type ProofBundle, type VerificationReport } from "../../contracts/src/index.js";

export function assembleStaticSemanticProof(report: VerificationReport, contract: MechanicContract, patchSetId: string, patchSetHash: string, snapshotBeforeHash: string, snapshotAfterHash: string, generatedAt: string): ProofBundle {
  const syntaxCheck = report.checks.find((check) => check.name === "official_luau_syntax");
  const robloxTypeCheck = report.checks.find((check) => check.name === "roblox_type_analysis");
  const semanticCheck = report.checks.find((check) => check.name === "replication_and_authority_contracts");
  const bundle: ProofBundle = {
    kind: "ProofBundle",
    schemaVersion: 4,
    id: `proof_${contentHash(stableJson({ projectHash: report.projectHash, patchSetId, patchSetHash, snapshotBeforeHash, snapshotAfterHash, contractId: contract.id, reportHash: contentHash(stableJson(report)) })).slice(0, 24)}`,
    projectHash: report.projectHash,
    projectSnapshotBeforeHash: snapshotBeforeHash,
    projectSnapshotAfterHash: snapshotAfterHash,
    mechanicContractId: contract.id,
    mechanicContractHash: contentHash(stableJson(contract)),
    patchSetId,
    patchSetHash,
    generatedAt,
    toolchain: report.toolchain,
    checks: [
      { name: "official_luau_syntax", tier: "static", status: syntaxCheck?.status ?? "unknown", issueIds: syntaxCheck?.issueIds ?? [] },
      { name: "roblox_type_analysis", tier: "static", status: robloxTypeCheck?.status ?? "unknown", issueIds: robloxTypeCheck?.issueIds ?? [] },
      { name: "replication_and_authority_contracts", tier: "static", status: semanticCheck?.status ?? "unknown", issueIds: semanticCheck?.issueIds ?? [] },
      { name: "pure_luau_preflight", tier: "preflight", status: "not_run", issueIds: [] },
      { name: "roblox_studio", tier: "studio", status: "not_run", issueIds: [] }
    ],
    issues: report.issues,
    assertions: contract.studioAssertions.map((assertionId) => ({ assertionId, mechanicContractId: contract.id, status: "not_run" })),
    gate: { status: report.gate.status === "rejected" ? "rejected" : "incomplete", reasons: report.gate.status === "rejected" ? report.gate.reasons : ["Static and semantic verification passed; preflight and Studio proof remain not_run."] },
    reproducibility: report.reproducibility
  };
  assertProofBundle(bundle);
  return bundle;
}
