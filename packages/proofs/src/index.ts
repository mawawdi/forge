import { assertProofBundle, contentHash, stableJson, type MechanicContract, type ProofBundle, type VerificationReport } from "../../contracts/src/index.js";

export function assembleStaticSemanticProof(report: VerificationReport, contract: MechanicContract, patchSetId: string, generatedAt: string): ProofBundle {
  const staticCheck = report.checks.find((check) => check.name === "official_luau_analysis");
  const semanticCheck = report.checks.find((check) => check.name === "replication_and_authority_contracts");
  const bundle: ProofBundle = {
    kind: "ProofBundle",
    schemaVersion: 1,
    id: `proof_${contentHash(stableJson({ projectHash: report.projectHash, patchSetId, contractId: contract.id, reportHash: contentHash(stableJson(report)) })).slice(0, 24)}`,
    projectHash: report.projectHash,
    patchSetId,
    generatedAt,
    toolchain: report.toolchain,
    checks: [
      { name: "official_luau_analysis", tier: "static", status: staticCheck?.status ?? "unknown", issueIds: staticCheck?.issueIds ?? [] },
      { name: "replication_and_authority_contracts", tier: "static", status: semanticCheck?.status ?? "unknown", issueIds: semanticCheck?.issueIds ?? [] },
      { name: "pure_luau_preflight", tier: "preflight", status: "not_run", issueIds: [] },
      { name: "roblox_studio", tier: "studio", status: "not_run", issueIds: [] }
    ],
    issues: report.issues,
    assertions: contract.studioAssertions.map((assertionId) => ({ assertionId, status: "not_run" })),
    gate: { status: report.gate.status === "rejected" ? "rejected" : "incomplete", reasons: report.gate.status === "rejected" ? report.gate.reasons : ["Static and semantic verification passed; preflight and Studio proof remain not_run."] },
    reproducibility: report.reproducibility
  };
  assertProofBundle(bundle);
  return bundle;
}
