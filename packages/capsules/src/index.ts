import { type ID, type MechanicContract } from "../../contracts/src/index.js";

export interface VerifiedMechanicCapsule {
  kind: "VerifiedMechanicCapsule";
  schemaVersion: 1;
  id: ID;
  version: string;
  taxonomy: string[];
  baseContract: Pick<MechanicContract, "kind" | "schemaVersion" | "id" | "name">;
  parameterSchema: Record<string, { type: "string" | "number" | "boolean"; required: boolean }>;
  implementationStrategy: { kind: "deterministic" | "adaptation_required" | "model_assisted"; description: string };
  requiredProjectCapabilities: string[];
  producedProjectCapabilities: string[];
  invariants: string[];
  adaptationRules: Array<{ parameter: string; allowedValues: string[]; verificationRequired: true }>;
  verificationSuite: { assertionIds: ID[]; requiredTiers: Array<"static" | "preflight" | "studio"> };
  provenance: { proofBundleIds: ID[]; buildTraceIds: ID[]; toolchainVersions: Array<{ name: string; version: string }>; studioRuntimeVersions: string[]; contractVersion: 1; testSuiteVersion: string; knownLimitations: string[] };
  verification: { status: "candidate" | "verified"; verifiedAt?: string };
}

export function assertVerifiedMechanicCapsule(value: unknown): asserts value is VerifiedMechanicCapsule {
  if (!isRecord(value) || value.kind !== "VerifiedMechanicCapsule" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.version) || !Array.isArray(value.taxonomy) || !isRecord(value.baseContract) || !isRecord(value.verification) || !isString(value.verification.status)) throw new Error("Invalid VerifiedMechanicCapsule: expected schemaVersion 1");
  if (value.verification.status === "verified") {
    const provenance = isRecord(value.provenance) ? value.provenance : undefined;
    const verificationSuite = isRecord(value.verificationSuite) ? value.verificationSuite : undefined;
    if (!provenance || !Array.isArray(provenance.proofBundleIds) || provenance.proofBundleIds.length === 0 || !verificationSuite || !Array.isArray(verificationSuite.assertionIds) || verificationSuite.assertionIds.length === 0 || !Array.isArray(provenance.studioRuntimeVersions) || provenance.studioRuntimeVersions.length === 0 || !isString(value.verification.verifiedAt)) throw new Error("Invalid VerifiedMechanicCapsule: verified status requires ProofBundle, assertions, Studio runtime, and timestamp provenance");
  }
}

export function candidateCapsule(input: Omit<VerifiedMechanicCapsule, "kind" | "schemaVersion" | "verification">): VerifiedMechanicCapsule {
  return { kind: "VerifiedMechanicCapsule", schemaVersion: 1, ...input, verification: { status: "candidate" } };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
