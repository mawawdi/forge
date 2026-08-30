import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { applyPatchSet } from "../../patch-model/src/index.js";
import { assertFixtureManifest, assertMechanicContract, assertMechanicImplementationSpec, assertPatchSet, contentHash, stableJson, type GenerationAttempt, type GenerationRun, type MechanicContract, type MechanicImplementationSpec, type ModelPatchProposal, type PatchSet, type VerificationReport } from "../../contracts/src/index.js";
import { DeterministicContextCompiler, contextSummary } from "../../context-compiler/src/index.js";
import { compileIntent, parseIntentDraft, type CompiledIntent } from "../../intent/src/index.js";
import { compileMechanicImplementationSpec, FilesystemProjectSourceAdapter } from "../../semantic-map/src/index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";

export const OPENROUTER_MODELS = ["openai/gpt-5.6-luna", "google/gemini-3.7-flash"] as const;
export type OpenRouterModel = typeof OPENROUTER_MODELS[number];

export interface ModelRequest {
  purpose: "intent" | "patch" | "repair";
  model: OpenRouterModel;
  schema: Record<string, unknown>;
  prompt: string;
  timeoutMs: number;
}

export interface ModelResult {
  content: unknown;
  requestHash: string;
  responseHash: string;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

export interface ModelProvider { generate(request: ModelRequest): Promise<ModelResult>; }

export class OpenRouterProvider implements ModelProvider {
  constructor(private readonly apiKey = process.env.OPENROUTER_API_KEY, private readonly endpoint = "https://openrouter.ai/api/v1/chat/completions") {}

  async generate(request: ModelRequest): Promise<ModelResult> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is required for model generation or repair");
    const body = {
      model: request.model, stream: false, provider: { require_parameters: true },
      messages: [{ role: "user", content: request.prompt }],
      response_format: { type: "json_schema", json_schema: { name: `forge_${request.purpose}`, strict: true, schema: request.schema } }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(this.endpoint, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, "X-OpenRouter-Metadata": "enabled" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const bodyText = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
        const detail = bodyText ? `: ${bodyText}` : "";
        const guidance = response.status === 429 ? ` Free-model capacity is currently rate-limited${retryAfter ? `; retry after ${retryAfter}s` : ""}, or explicitly select a different configured model.` : "";
        throw new Error(`OpenRouter request failed (${response.status})${detail}.${guidance}`);
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== "string") throw new Error("OpenRouter response does not contain JSON content");
      let content: unknown;
      try { content = JSON.parse(payload.choices[0].message.content); } catch { throw new Error("OpenRouter response was not valid JSON"); }
      const usage = isRecord(payload.usage) ? payload.usage : {};
      return { content, requestHash: contentHash(stableJson({ model: request.model, purpose: request.purpose, prompt: request.prompt, schema: request.schema })), responseHash: contentHash(stableJson(content)), usage: { inputTokens: numberOrNull(usage.prompt_tokens), outputTokens: numberOrNull(usage.completion_tokens), costUsd: numberOrNull(usage.cost) } };
    } finally { clearTimeout(timer); }
  }
}

export interface GenerationPolicy {
  allowedPaths: readonly ["src/server/CollectFruit.server.luau", "src/client/CollectFruitClient.client.luau"];
  maxFiles: 2;
  maxAddedLines: 240;
  maxRemovedLines: 20;
  maxSourceBytes: 24_576;
}

export const COLLECT_FRUIT_GENERATION_POLICY: GenerationPolicy = {
  allowedPaths: ["src/server/CollectFruit.server.luau", "src/client/CollectFruitClient.client.luau"], maxFiles: 2, maxAddedLines: 240, maxRemovedLines: 20, maxSourceBytes: 24_576
};

export interface GenerationBuildOptions {
  seedRoot: string;
  prompt: string;
  provider: ModelProvider;
  model?: OpenRouterModel;
  modelTimeoutMs?: number;
  runDirectory?: string;
  traceDirectory?: string;
}

export interface GenerationBuildResult {
  run: GenerationRun;
  intent?: CompiledIntent;
  patchSet?: PatchSet;
  verification?: VerificationRun;
  outputRoot?: string;
  contextSummary?: ReturnType<typeof contextSummary>;
}

export interface CandidateRegression {
  kind: "CandidateRegression";
  schemaVersion: 1;
  id: string;
  sourceGenerationRunId: string;
  sourceGenerationAttemptId: string;
  sourceBuildTraceId: string;
  sourcePatchSetId: string;
  seedProject: string;
  mechanicContract: string;
  model: { provider: string; name: string; requestHash: string; responseHash: string; promptHash: string };
  sourceHashes: Record<string, string>;
  historicalVerdict: "rejected";
  historicalReason: string;
  expectedCorrectedLocalVerdict: "verified" | "rejected";
  studioVerdict: "not_run" | "verified" | "rejected";
}

export interface CandidateReverificationResult {
  kind: "CandidateReverification";
  schemaVersion: 1;
  regressionId: string;
  sourceUnchanged: true;
  historical: { generationRunId: string; buildTraceId: string; verdict: "rejected" };
  seedRoot: string;
  patchSet: PatchSet;
  implementationSpec: MechanicImplementationSpec;
  contract: MechanicContract;
  verification: VerificationRun;
}

export interface CandidateRepairOptions {
  regressionRoot: string;
  provider: ModelProvider;
  model?: OpenRouterModel;
  modelTimeoutMs?: number;
  runDirectory?: string;
  traceDirectory?: string;
}

export interface CandidateRepairResult {
  kind: "CandidateRepairRun";
  schemaVersion: 1;
  id: string;
  regressionId: string;
  source: {
    unchanged: true;
    generationRunId: string;
    generationAttemptId: string;
    buildTraceId: string;
    modelResponseHash: string;
    patchSetId: string;
    verificationTraceId: string;
  };
  model: { provider: "openrouter"; name: OpenRouterModel; requestHash: string; responseHash: string };
  attempt: GenerationAttempt;
  seedRoot: string;
  outputRoot: string;
  contract: MechanicContract;
  implementationSpec: MechanicImplementationSpec;
  patchSet: PatchSet;
  verification: VerificationRun;
  contextSummary: ReturnType<typeof contextSummary>;
  artifact: CandidateRepairArtifact;
  artifactPath: string;
}

export interface CandidateRepairArtifact {
  kind: "CandidateRepairArtifact";
  schemaVersion: 1;
  id: string;
  regressionId: string;
  createdAt: string;
  source: {
    generationRunId: string;
    generationAttemptId: string;
    buildTraceId: string;
    modelResponseHash: string;
    patchSetId: string;
    sourceHashes: Record<string, string>;
  };
  model: {
    provider: "openrouter";
    name: OpenRouterModel;
    requestHash: string;
    responseHash: string;
    usage: ModelResult["usage"];
  };
  attempt: GenerationAttempt;
  seedRoot: string;
  outputRoot: string;
  contract: MechanicContract;
  contractHash: string;
  implementationSpec: MechanicImplementationSpec;
  implementationSpecHash: string;
  patchSet: PatchSet;
  patchSetHash: string;
  outputSourceHashes: Record<string, string>;
  verification: { report: VerificationReport; traceId: string };
  context: ReturnType<typeof contextSummary>;
  artifactHash: string;
}

export interface LoadedCandidateRepairArtifact {
  artifact: CandidateRepairArtifact;
  verification: VerificationRun;
}

export async function reverifyCandidateRegression(regressionRoot: string, traceDirectory?: string): Promise<CandidateReverificationResult> {
  const root = resolve(regressionRoot);
  const metadata = parseCandidateRegression(JSON.parse(await readFile(join(root, "regression.json"), "utf8")) as unknown);
  const contractValue: unknown = JSON.parse(await readFile(join(root, metadata.mechanicContract), "utf8"));
  assertMechanicContract(contractValue);
  for (const [path, expectedHash] of Object.entries(metadata.sourceHashes)) {
    const observedHash = contentHash(await readFile(join(root, path), "utf8"));
    if (observedHash !== expectedHash) throw new Error(`Candidate regression source changed: ${path} expected ${expectedHash}, observed ${observedHash}`);
  }
  const manifestValue: unknown = JSON.parse(await readFile(join(root, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(manifestValue);
  const adapter = new FilesystemProjectSourceAdapter();
  const map = await adapter.load({ root, manifest: manifestValue });
  const implementationSpec = compileMechanicImplementationSpec(map, contractValue, { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  const operations = await Promise.all(COLLECT_FRUIT_GENERATION_POLICY.allowedPaths.map(async (path) => ({ type: "replace_text" as const, path, after: await readFile(join(root, path), "utf8") })));
  const proposal: ModelPatchProposal = { kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: contractValue.id, rationale: "Reconstruct the preserved model-authored candidate without changing source.", operations };
  const seedRoot = resolve(root, metadata.seedProject);
  const patchSet = await compilePatchProposal(seedRoot, proposal, contractValue, implementationSpec, { model: metadata.model.name, promptHash: metadata.model.promptHash });
  if (patchSet.id !== metadata.sourcePatchSetId) throw new Error(`Historical PatchSet identity mismatch: expected ${metadata.sourcePatchSetId}, reconstructed ${patchSet.id}`);
  const verification = await verifyProject(root, {
    ...(traceDirectory ? { traceDirectory } : {}),
    traceReferences: { mechanicContractId: contractValue.id, patchSetId: patchSet.id, benchmarkCaseId: metadata.id, generationRunId: metadata.sourceGenerationRunId, generationAttemptId: metadata.sourceGenerationAttemptId, modelResponseHash: metadata.model.responseHash },
    traceComponents: { model: { provider: metadata.model.provider, name: metadata.model.name, configurationHash: contentHash(stableJson({ requestHash: metadata.model.requestHash, responseHash: metadata.model.responseHash })) } },
    outcomeOverrides: { modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  });
  return { kind: "CandidateReverification", schemaVersion: 1, regressionId: metadata.id, sourceUnchanged: true, historical: { generationRunId: metadata.sourceGenerationRunId, buildTraceId: metadata.sourceBuildTraceId, verdict: metadata.historicalVerdict }, seedRoot, patchSet, implementationSpec, contract: contractValue, verification };
}

/**
 * Performs exactly one model repair against a byte-preserved regression. It
 * never calls intent/patch generation and never writes into the regression or
 * clean seed. The returned PatchSet is rebuilt against the seed so it can enter
 * the existing Studio transaction only after corrected local verification.
 */
export async function repairCandidateRegression(options: CandidateRepairOptions): Promise<CandidateRepairResult> {
  const root = resolve(options.regressionRoot);
  const metadata = parseCandidateRegression(JSON.parse(await readFile(join(root, "regression.json"), "utf8")) as unknown);
  const source = await reverifyCandidateRegression(root, options.traceDirectory);
  if (source.verification.report.gate.status !== "rejected") throw new Error(`Candidate repair requires a locally rejected source; observed ${source.verification.report.gate.status}`);

  const model = options.model ?? "openai/gpt-5.6-luna";
  const timeoutMs = options.modelTimeoutMs ?? 45_000;
  const id = `candidate_repair_${randomUUID()}`;
  const runDirectory = resolve(options.runDirectory ?? join(dirname(source.seedRoot), ".forge-generation-runs", "candidate-repairs"));
  assertExternalRunDirectory(runDirectory, [root, source.seedRoot]);

  const manifestValue: unknown = JSON.parse(await readFile(join(root, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(manifestValue);
  const candidateMap = await new FilesystemProjectSourceAdapter().load({ root, manifest: manifestValue });
  const context = await new DeterministicContextCompiler().compile({
    semanticMap: candidateMap,
    mechanicContract: source.contract,
    mechanicImplementationSpec: source.implementationSpec,
    verificationIssues: source.verification.report.issues,
    requestedChange: "Repair only the diagnosed candidate defects. Preserve the Forge-owned project ABI, state representation, constants, and authority invariants exactly.",
    patchSet: source.patchSet,
    generationPolicy: generationPolicyContext(),
    allowedSourcePaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths]
  });
  const prompt = repairPrompt(context.modelReadyContent);
  const startedAt = Date.now();
  const modelResult = await options.provider.generate({ purpose: "repair", model, timeoutMs, schema: patchProposalSchema(), prompt });
  const modelDurationMs = Date.now() - startedAt;
  const proposal = parseModelPatchProposal(modelResult.content, source.contract.id);
  const patchSet = await compilePatchProposal(source.seedRoot, proposal, source.contract, source.implementationSpec, { model, promptHash: contentHash(prompt) });
  const outputRoot = join(runDirectory, id, "candidate");
  await applyPatchSet(source.seedRoot, patchSet, outputRoot);
  await assertRegressionSourcesUnchanged(root, metadata.sourceHashes);

  const summary = contextSummary(context);
  const verification = await verifyProject(outputRoot, {
    ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}),
    traceReferences: {
      mechanicContractId: source.contract.id,
      patchSetId: patchSet.id,
      benchmarkCaseId: metadata.id,
      generationRunId: metadata.sourceGenerationRunId,
      generationAttemptId: metadata.sourceGenerationAttemptId,
      modelResponseHash: metadata.model.responseHash
    },
    tracePreludeSpans: [{ name: "forge.repair.model", status: "ok", durationMs: modelDurationMs, attributes: { "forge.model.provider": "openrouter", "forge.model.name": model, "forge.attempt": 1 } }],
    traceComponents: {
      model: { provider: "openrouter", name: model, configurationHash: contentHash(stableJson({ sourceResponseHash: metadata.model.responseHash, repairRequestHash: modelResult.requestHash, repairResponseHash: modelResult.responseHash, structured: true })) },
      repairPolicy: { name: "forge-candidate-model-repair", version: "m3.25-2026-08-30", configHash: contentHash(stableJson(generationPolicyContext())) }
    },
    traceContextSummary: summary,
    outcomeOverrides: { attempts: 1, modelRepairs: 1, modelUsage: { calls: 1, inputTokens: modelResult.usage.inputTokens, outputTokens: modelResult.usage.outputTokens, costUsd: modelResult.usage.costUsd } }
  });
  const repairAttempt = attempt("model_repair", patchSet, verification.report, { provider: "openrouter", name: model, requestHash: modelResult.requestHash, responseHash: modelResult.responseHash });
  const artifactPath = join(runDirectory, `${id}.json`);
  const outputSourceHashes = Object.fromEntries(await Promise.all(COLLECT_FRUIT_GENERATION_POLICY.allowedPaths.map(async (path) => [path, contentHash(await readFile(join(outputRoot, path), "utf8"))])));
  const artifactPayload: Omit<CandidateRepairArtifact, "artifactHash"> = {
    kind: "CandidateRepairArtifact", schemaVersion: 1, id, regressionId: metadata.id,
    createdAt: new Date().toISOString(),
    source: { generationRunId: metadata.sourceGenerationRunId, generationAttemptId: metadata.sourceGenerationAttemptId, buildTraceId: metadata.sourceBuildTraceId, modelResponseHash: metadata.model.responseHash, patchSetId: metadata.sourcePatchSetId, sourceHashes: metadata.sourceHashes },
    model: { provider: "openrouter", name: model, requestHash: modelResult.requestHash, responseHash: modelResult.responseHash, usage: modelResult.usage },
    attempt: repairAttempt,
    seedRoot: source.seedRoot,
    outputRoot,
    contract: source.contract,
    contractHash: contentHash(stableJson(source.contract)),
    implementationSpec: source.implementationSpec,
    implementationSpecHash: contentHash(stableJson(source.implementationSpec)),
    patchSet,
    patchSetHash: contentHash(stableJson(patchSet)),
    outputSourceHashes,
    verification: { report: verification.report, traceId: verification.trace.id },
    context: summary
  };
  const artifact: CandidateRepairArtifact = { ...artifactPayload, artifactHash: contentHash(stableJson(artifactPayload)) };
  await persistPrivateArtifact(artifactPath, artifact);
  return {
    kind: "CandidateRepairRun", schemaVersion: 1, id, regressionId: metadata.id,
    source: { unchanged: true, generationRunId: metadata.sourceGenerationRunId, generationAttemptId: metadata.sourceGenerationAttemptId, buildTraceId: metadata.sourceBuildTraceId, modelResponseHash: metadata.model.responseHash, patchSetId: metadata.sourcePatchSetId, verificationTraceId: source.verification.trace.id },
    model: { provider: "openrouter", name: model, requestHash: modelResult.requestHash, responseHash: modelResult.responseHash },
    attempt: repairAttempt, seedRoot: source.seedRoot, outputRoot, contract: source.contract, implementationSpec: source.implementationSpec, patchSet, verification, contextSummary: summary, artifact, artifactPath
  };
}

/**
 * Loads one retained repair candidate without invoking a model. The artifact is
 * only a claim until its envelope, referenced source bytes, seed preconditions,
 * and current local verification all agree.
 */
export async function loadCandidateRepairArtifact(artifactPath: string, traceDirectory?: string): Promise<LoadedCandidateRepairArtifact> {
  const artifact = parseCandidateRepairArtifact(JSON.parse(await readFile(resolve(artifactPath), "utf8")) as unknown);
  const { artifactHash, ...payload } = artifact;
  const observedArtifactHash = contentHash(stableJson(payload));
  if (artifactHash !== observedArtifactHash) throw new Error(`Candidate repair artifact hash mismatch: expected ${artifactHash}, observed ${observedArtifactHash}`);

  assertMechanicContract(artifact.contract);
  assertMechanicImplementationSpec(artifact.implementationSpec);
  assertPatchSet(artifact.patchSet);
  if (artifact.contractHash !== contentHash(stableJson(artifact.contract))) throw new Error("Candidate repair contract hash mismatch");
  if (artifact.implementationSpecHash !== contentHash(stableJson(artifact.implementationSpec))) throw new Error("Candidate repair implementation spec hash mismatch");
  if (artifact.patchSetHash !== contentHash(stableJson(artifact.patchSet))) throw new Error("Candidate repair PatchSet hash mismatch");
  if (artifact.implementationSpec.mechanicContractId !== artifact.contract.id || artifact.patchSet.mechanicContractId !== artifact.contract.id) throw new Error("Candidate repair contract linkage mismatch");
  if (artifact.attempt.type !== "model_repair" || artifact.attempt.patchSetId !== artifact.patchSet.id || artifact.attempt.verificationStatus !== artifact.verification.report.gate.status || artifact.attempt.model?.provider !== artifact.model.provider || artifact.attempt.model.name !== artifact.model.name || artifact.attempt.model.requestHash !== artifact.model.requestHash || artifact.attempt.model.responseHash !== artifact.model.responseHash) throw new Error("Candidate repair attempt linkage mismatch");
  if (artifact.patchSet.provenance.model !== artifact.model.name) throw new Error("Candidate repair model provenance mismatch");
  if (artifact.verification.report.gate.status !== "verified") throw new Error(`Candidate repair artifact is not eligible for Studio: local gate is ${artifact.verification.report.gate.status}`);

  const expectedPaths = [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths].sort();
  const operationPaths = artifact.patchSet.operations.map((operation) => operation.path).sort();
  if (artifact.patchSet.operations.length !== expectedPaths.length || operationPaths.some((path, index) => path !== expectedPaths[index])) throw new Error("Candidate repair artifact does not contain the complete bounded source target set");
  if (artifact.patchSet.operations.some((operation) => operation.type !== "replace_text")) throw new Error("Candidate repair artifact contains an unsupported PatchSet operation");
  if (Object.keys(artifact.outputSourceHashes).sort().some((path, index) => path !== expectedPaths[index]) || Object.keys(artifact.outputSourceHashes).length !== expectedPaths.length) throw new Error("Candidate repair artifact has an invalid output source hash set");

  const seedRoot = resolve(artifact.seedRoot);
  const outputRoot = resolve(artifact.outputRoot);
  const seedManifestValue: unknown = JSON.parse(await readFile(join(seedRoot, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(seedManifestValue);
  const seedMap = await new FilesystemProjectSourceAdapter().load({ root: seedRoot, manifest: seedManifestValue });
  const seedSnapshot = new FilesystemProjectSourceAdapter().snapshot(seedMap);
  if (artifact.patchSet.projectHash !== seedSnapshot.sourceHash) throw new Error("Candidate repair seed snapshot no longer matches the PatchSet precondition");

  for (const operation of artifact.patchSet.operations) {
    if (operation.type !== "replace_text") throw new Error("Candidate repair artifact contains an unsupported PatchSet operation");
    if (contentHash(operation.before) !== operation.beforeHash) throw new Error(`Candidate repair PatchSet beforeHash is invalid: ${operation.path}`);
    const seedSource = await readFile(join(seedRoot, operation.path), "utf8");
    if (seedSource !== operation.before) throw new Error(`Candidate repair seed source changed: ${operation.path}`);
    const outputSource = await readFile(join(outputRoot, operation.path), "utf8");
    if (outputSource !== operation.after || contentHash(outputSource) !== artifact.outputSourceHashes[operation.path]) throw new Error(`Candidate repair output source changed: ${operation.path}`);
  }

  const verification = await verifyProject(outputRoot, {
    ...(traceDirectory ? { traceDirectory } : {}),
    traceReferences: {
      mechanicContractId: artifact.contract.id,
      patchSetId: artifact.patchSet.id,
      benchmarkCaseId: artifact.regressionId,
      generationRunId: artifact.source.generationRunId,
      generationAttemptId: artifact.attempt.id,
      modelResponseHash: artifact.model.responseHash
    },
    traceComponents: { model: { provider: artifact.model.provider, name: artifact.model.name, configurationHash: contentHash(stableJson({ requestHash: artifact.model.requestHash, responseHash: artifact.model.responseHash })) } },
    outcomeOverrides: { attempts: 0, modelRepairs: 0, modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  });
  if (verification.report.projectHash !== artifact.verification.report.projectHash) throw new Error("Candidate repair output project hash changed after artifact creation");
  if (verification.report.gate.status !== "verified") throw new Error(`Candidate repair no longer passes the current local gate: ${verification.report.gate.reasons.join(", ")}`);
  return { artifact: { ...artifact, seedRoot, outputRoot }, verification };
}

/**
 * Local generation part of M3.25. It never modifies the seed: the candidate is
 * atomically written to a run-local directory and must pass official Luau/M2
 * before any Studio connection is considered.
 */
export async function buildGeneratedCandidate(options: GenerationBuildOptions): Promise<GenerationBuildResult> {
  const model = options.model ?? "openai/gpt-5.6-luna";
  const timeoutMs = options.modelTimeoutMs ?? 45_000;
  const runId = `generation_${randomUUID()}`;
  const root = resolve(options.seedRoot);
  // Candidates are full project copies; keeping them below the seed is both
  // unsafe and rejected by the atomic PatchSet applicator.
  const runDirectory = resolve(options.runDirectory ?? join(dirname(root), ".forge-generation-runs"));
  if (runDirectory === root || runDirectory.startsWith(`${root}${sep}`)) throw new Error("Generation run directory must be outside the source project");
  const attempts: GenerationAttempt[] = [];
  let modelCalls = 0;
  try {
    const intentResult = await options.provider.generate({ purpose: "intent", model, timeoutMs, schema: intentDraftSchema(), prompt: intentPrompt(options.prompt) });
    modelCalls += 1;
    const usages: ModelResult["usage"][] = [intentResult.usage];
    const intent = compileIntent(options.prompt, parseIntentDraft(intentResult.content));
    const adapter = new FilesystemProjectSourceAdapter();
    const manifest = JSON.parse(await readFile(join(root, "forge.fixture.json"), "utf8")) as unknown;
    assertFixtureManifest(manifest);
    const map = await adapter.load({ root, manifest });
    const implementationSpec = compileMechanicImplementationSpec(map, intent.mechanicContract, { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
    const context = await new DeterministicContextCompiler().compile({ semanticMap: map, mechanicContract: intent.mechanicContract, mechanicImplementationSpec: implementationSpec, verificationIssues: [], requestedChange: "Implement the Forge-owned mechanic contract while preserving the exact project ABI and state interface.", generationPolicy: { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], maxFiles: COLLECT_FRUIT_GENERATION_POLICY.maxFiles, maxAddedLines: COLLECT_FRUIT_GENERATION_POLICY.maxAddedLines, maxRemovedLines: COLLECT_FRUIT_GENERATION_POLICY.maxRemovedLines, maxSourceBytes: COLLECT_FRUIT_GENERATION_POLICY.maxSourceBytes }, allowedSourcePaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths] });
    const patchResult = await options.provider.generate({ purpose: "patch", model, timeoutMs, schema: patchProposalSchema(), prompt: patchPrompt(context.modelReadyContent, intent.mechanicContract) });
    modelCalls += 1;
    usages.push(patchResult.usage);
    const proposal = parseModelPatchProposal(patchResult.content, intent.mechanicContract.id);
    let patchSet = await compilePatchProposal(root, proposal, intent.mechanicContract, implementationSpec, { model, promptHash: contentHash(options.prompt) });
    let outputRoot = join(runDirectory, runId, "candidate");
    await applyPatchSet(root, patchSet, outputRoot);
    let verification = await generatedVerification(outputRoot, intent, patchSet, model, contextSummary(context), modelCalls, usages, options.traceDirectory);
    attempts.push(attempt("initial", patchSet, verification.report, { provider: "openrouter", name: model, requestHash: patchResult.requestHash, responseHash: patchResult.responseHash }));

    if (verification.report.gate.status !== "verified") {
      const candidateManifestValue: unknown = JSON.parse(await readFile(join(outputRoot, "forge.fixture.json"), "utf8"));
      assertFixtureManifest(candidateManifestValue);
      const candidateMap = await adapter.load({ root: outputRoot, manifest: candidateManifestValue });
      const repairContext = await new DeterministicContextCompiler().compile({ semanticMap: candidateMap, mechanicContract: intent.mechanicContract, mechanicImplementationSpec: implementationSpec, verificationIssues: verification.report.issues, requestedChange: "Repair the candidate without changing the Forge-owned project ABI or state representation.", patchSet, generationPolicy: { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], maxFiles: COLLECT_FRUIT_GENERATION_POLICY.maxFiles, maxAddedLines: COLLECT_FRUIT_GENERATION_POLICY.maxAddedLines, maxRemovedLines: COLLECT_FRUIT_GENERATION_POLICY.maxRemovedLines, maxSourceBytes: COLLECT_FRUIT_GENERATION_POLICY.maxSourceBytes }, allowedSourcePaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths] });
      const repairResult = await options.provider.generate({ purpose: "repair", model, timeoutMs, schema: patchProposalSchema(), prompt: repairPrompt(repairContext.modelReadyContent) });
      modelCalls += 1;
      usages.push(repairResult.usage);
      const repairProposal = parseModelPatchProposal(repairResult.content, intent.mechanicContract.id);
      const repairedPatch = await compilePatchProposal(root, repairProposal, intent.mechanicContract, implementationSpec, { model, promptHash: contentHash(options.prompt) });
      const repairedRoot = join(runDirectory, runId, "model-repaired");
      await applyPatchSet(root, repairedPatch, repairedRoot);
      const repairedVerification = await generatedVerification(repairedRoot, intent, repairedPatch, model, contextSummary(context), modelCalls, usages, options.traceDirectory);
      attempts.push(attempt("model_repair", repairedPatch, repairedVerification.report, { provider: "openrouter", name: model, requestHash: repairResult.requestHash, responseHash: repairResult.responseHash }));
      patchSet = repairedPatch; outputRoot = repairedRoot; verification = repairedVerification;
    }
    const status = verification.report.gate.status;
    const classification = status !== "verified" ? null : attempts.some((entry) => entry.type === "model_repair") ? "MODEL_REPAIRED_VERIFIED" : attempts.some((entry) => entry.type === "deterministic_repair") ? "DETERMINISTICALLY_REPAIRED_VERIFIED" : "FIRST_PASS_VERIFIED";
    const run: GenerationRun = { kind: "GenerationRun", schemaVersion: 1, id: runId, status, classification, gameIntentId: intent.gameIntent.id, coreLoopId: intent.coreLoop.id, mechanicContractId: intent.mechanicContract.id, patchSetId: patchSet.id, attempts, traceId: verification.trace.id, generatedAt: new Date().toISOString() };
    await persistPrivateRun(runDirectory, run, { intent, patchSet, verificationReport: verification.report, modelUsage: { calls: modelCalls } });
    return { run, intent, patchSet, verification, outputRoot, contextSummary: contextSummary(context) };
  } catch (error) {
    const run: GenerationRun = { kind: "GenerationRun", schemaVersion: 1, id: runId, status: "incomplete", classification: null, attempts, generatedAt: new Date().toISOString() };
    await persistPrivateRun(runDirectory, run, { error: error instanceof Error ? error.message : String(error), modelCalls });
    throw error;
  }
}

export async function compilePatchProposal(root: string, proposal: ModelPatchProposal, contract: MechanicContract, implementationSpec: MechanicImplementationSpec, provenance: { model: string; promptHash: string }): Promise<PatchSet> {
  const parsed = validateModelPatchProposal(proposal, contract.id);
  if (implementationSpec.mechanicContractId !== contract.id) throw new Error("MechanicImplementationSpec contract linkage mismatch");
  if (parsed.operations.length !== 2 || new Set(parsed.operations.map((operation) => operation.path)).size !== 2) throw new Error("Generation policy requires exactly one server and one client replacement");
  const operations = await Promise.all(parsed.operations.map(async (operation) => {
    if (!implementationSpec.sourceTargets.some((target) => target.path === operation.path) || !implementationSpec.allowedPatchOperations.includes("replace_text")) throw new Error(`MechanicImplementationSpec rejects path or operation: ${operation.path}`);
    if (operation.after.length > COLLECT_FRUIT_GENERATION_POLICY.maxSourceBytes || forbiddenSource(operation.after)) throw new Error(`Generation policy rejects source for ${operation.path}`);
    if (implementationSpec.remote.preserveExisting && /Instance\.new\s*\(\s*["']Remote(?:Event|Function)["']\s*\)/.test(operation.after)) throw new Error(`MechanicImplementationSpec requires preserving ${implementationSpec.remote.path}`);
    const before = await readFile(join(resolve(root), operation.path), "utf8");
    return { type: "replace_text" as const, path: operation.path, beforeHash: contentHash(before), before, after: operation.after };
  }));
  const absoluteRoot = resolve(root);
  const manifest = JSON.parse(await readFile(join(absoluteRoot, "forge.fixture.json"), "utf8")) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
  const map = await new FilesystemProjectSourceAdapter().load({ root: absoluteRoot, manifest });
  const projectHash = new FilesystemProjectSourceAdapter().snapshot(map).sourceHash;
  const patchSet: PatchSet = { kind: "PatchSet", schemaVersion: 1, id: `patch_generated_${contentHash(stableJson({ projectHash, after: operations.map((operation) => operation.after) })).slice(0, 24)}`, projectHash, mechanicContractId: contract.id, operations, expectedEffects: [{ statement: "Implements the Forge-owned CollectFruit server authority boundary.", evidence: "contract" }, { statement: "Creates the real client request boundary for StudioProof.", evidence: "preflight" }], provenance: { model: provenance.model, promptHash: provenance.promptHash, generatedAt: new Date().toISOString() }, bounds: { maxFiles: 2, maxAddedLines: 240, maxRemovedLines: 20 } };
  return patchSet;
}

export function parseModelPatchProposal(value: unknown, contractId: string): ModelPatchProposal {
  if (!isRecord(value)) throw new Error("Model patch payload must be an object");
  exact(value, ["rationale", "operations"]);
  if (typeof value.rationale !== "string" || !Array.isArray(value.operations)) throw new Error("Invalid model patch payload");
  const operations = value.operations.map((operation) => {
    if (!isRecord(operation)) throw new Error("Invalid model patch operation");
    exact(operation, ["path", "after"]);
    if (typeof operation.path !== "string" || typeof operation.after !== "string") throw new Error("Invalid model patch operation");
    return { type: "replace_text" as const, path: operation.path, after: operation.after };
  });
  return { kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: contractId, rationale: value.rationale, operations };
}

/** The model never supplies Forge's canonical envelope or contract linkage. */
function validateModelPatchProposal(value: ModelPatchProposal, contractId: string): ModelPatchProposal {
  if (!isRecord(value)) throw new Error("Internal ModelPatchProposal must be an object");
  exact(value, ["kind", "schemaVersion", "mechanicContractId", "rationale", "operations"]);
  if (value.kind !== "ModelPatchProposal" || value.schemaVersion !== 1 || value.mechanicContractId !== contractId || typeof value.rationale !== "string" || !Array.isArray(value.operations)) throw new Error("Invalid internal ModelPatchProposal");
  value.operations.forEach((operation) => {
    if (!isRecord(operation)) throw new Error("Invalid internal ModelPatchProposal operation");
    exact(operation, ["type", "path", "after"]);
    if (operation.type !== "replace_text" || typeof operation.path !== "string" || typeof operation.after !== "string") throw new Error("Invalid internal ModelPatchProposal operation");
  });
  return value;
}

function attempt(type: GenerationAttempt["type"], patchSet: PatchSet, report: VerificationReportLike, model?: NonNullable<GenerationAttempt["model"]>): GenerationAttempt {
  return { kind: "GenerationAttempt", schemaVersion: 1, id: `attempt_${contentHash(`${type}|${patchSet.id}`).slice(0, 16)}`, type, ...(model ? { model } : {}), patchSetId: patchSet.id, verificationStatus: report.gate.status, issueCodes: report.issues.map((issue) => issue.ruleId) };
}

type VerificationReportLike = { gate: { status: "verified" | "rejected" | "incomplete" }; issues: Array<{ ruleId: string }> };

async function generatedVerification(outputRoot: string, intent: CompiledIntent, patchSet: PatchSet, model: OpenRouterModel, summary: ReturnType<typeof contextSummary>, modelCalls: number, usages: ModelResult["usage"][], traceDirectory: string | undefined): Promise<VerificationRun> {
  return verifyProject(outputRoot, {
    ...(traceDirectory ? { traceDirectory } : {}),
    traceReferences: { gameIntentId: intent.gameIntent.id, coreLoopId: intent.coreLoop.id, mechanicContractId: intent.mechanicContract.id, patchSetId: patchSet.id },
    traceComponents: { model: { provider: "openrouter", name: model, configurationHash: contentHash(stableJson({ model, structured: true })) } },
    traceContextSummary: summary,
    outcomeOverrides: { modelUsage: { calls: modelCalls, inputTokens: sumUsage(usages, "inputTokens"), outputTokens: sumUsage(usages, "outputTokens"), costUsd: sumUsage(usages, "costUsd") } }
  });
}

function generationPolicyContext(): { allowedPaths: string[]; maxFiles: number; maxAddedLines: number; maxRemovedLines: number; maxSourceBytes: number } {
  return { allowedPaths: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths], maxFiles: COLLECT_FRUIT_GENERATION_POLICY.maxFiles, maxAddedLines: COLLECT_FRUIT_GENERATION_POLICY.maxAddedLines, maxRemovedLines: COLLECT_FRUIT_GENERATION_POLICY.maxRemovedLines, maxSourceBytes: COLLECT_FRUIT_GENERATION_POLICY.maxSourceBytes };
}

function assertExternalRunDirectory(runDirectory: string, protectedRoots: string[]): void {
  for (const protectedRoot of protectedRoots.map((root) => resolve(root))) {
    if (runDirectory === protectedRoot || runDirectory.startsWith(`${protectedRoot}${sep}`)) throw new Error(`Candidate repair run directory must be outside ${protectedRoot}`);
  }
}

async function assertRegressionSourcesUnchanged(root: string, sourceHashes: Record<string, string>): Promise<void> {
  for (const [path, expectedHash] of Object.entries(sourceHashes)) {
    const observedHash = contentHash(await readFile(join(root, path), "utf8"));
    if (observedHash !== expectedHash) throw new Error(`Candidate regression source changed during repair: ${path}`);
  }
}

function sumUsage(usages: ModelResult["usage"][], field: keyof ModelResult["usage"]): number | null { return usages.some((usage) => usage[field] === null) ? null : usages.reduce((total, usage) => total + (usage[field] as number), 0); }

function forbiddenSource(source: string): boolean { return /(?:StudioTestService|ScriptEditorService|ChangeHistoryService|_forgeStableId|__Forge|loadstring)/.test(source); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseCandidateRepairArtifact(value: unknown): CandidateRepairArtifact {
  if (!isRecord(value)) throw new Error("Invalid CandidateRepairArtifact");
  exactKeys(value, ["kind", "schemaVersion", "id", "regressionId", "createdAt", "source", "model", "attempt", "seedRoot", "outputRoot", "contract", "contractHash", "implementationSpec", "implementationSpecHash", "patchSet", "patchSetHash", "outputSourceHashes", "verification", "context", "artifactHash"], "CandidateRepairArtifact");
  if (value.kind !== "CandidateRepairArtifact" || value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.regressionId !== "string" || typeof value.createdAt !== "string" || typeof value.seedRoot !== "string" || !isAbsolute(value.seedRoot) || typeof value.outputRoot !== "string" || !isAbsolute(value.outputRoot) || !isSha256(value.contractHash) || !isSha256(value.implementationSpecHash) || !isSha256(value.patchSetHash) || !isSha256(value.artifactHash)) throw new Error("Invalid CandidateRepairArtifact envelope");
  if (!isRecord(value.source)) throw new Error("Invalid CandidateRepairArtifact source");
  exactKeys(value.source, ["generationRunId", "generationAttemptId", "buildTraceId", "modelResponseHash", "patchSetId", "sourceHashes"], "CandidateRepairArtifact source");
  if (typeof value.source.generationRunId !== "string" || typeof value.source.generationAttemptId !== "string" || typeof value.source.buildTraceId !== "string" || !isSha256(value.source.modelResponseHash) || typeof value.source.patchSetId !== "string" || !isHashRecord(value.source.sourceHashes)) throw new Error("Invalid CandidateRepairArtifact source");
  if (!isRecord(value.model)) throw new Error("Invalid CandidateRepairArtifact model");
  exactKeys(value.model, ["provider", "name", "requestHash", "responseHash", "usage"], "CandidateRepairArtifact model");
  if (value.model.provider !== "openrouter" || !(OPENROUTER_MODELS as readonly unknown[]).includes(value.model.name) || !isSha256(value.model.requestHash) || !isSha256(value.model.responseHash) || !isModelUsage(value.model.usage)) throw new Error("Invalid CandidateRepairArtifact model");
  if (!isGenerationAttempt(value.attempt)) throw new Error("Invalid CandidateRepairArtifact attempt");
  if (!isHashRecord(value.outputSourceHashes)) throw new Error("Invalid CandidateRepairArtifact output source hashes");
  if (!isRecord(value.verification)) throw new Error("Invalid CandidateRepairArtifact verification");
  exactKeys(value.verification, ["report", "traceId"], "CandidateRepairArtifact verification");
  if (!isVerificationReportEnvelope(value.verification.report) || typeof value.verification.traceId !== "string") throw new Error("Invalid CandidateRepairArtifact verification");
  if (!isContextSummary(value.context)) throw new Error("Invalid CandidateRepairArtifact context");
  return value as unknown as CandidateRepairArtifact;
}
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void { const received = Object.keys(value).sort(); const expected = [...keys].sort(); if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${label} fields: ${received.join(", ")}`); }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isHashRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every(isSha256); }
function isModelUsage(value: unknown): value is ModelResult["usage"] { return isRecord(value) && Object.keys(value).length === 3 && nullableFiniteNumber(value.inputTokens) && nullableFiniteNumber(value.outputTokens) && nullableFiniteNumber(value.costUsd); }
function nullableFiniteNumber(value: unknown): value is number | null { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function isGenerationAttempt(value: unknown): value is GenerationAttempt { return isRecord(value) && value.kind === "GenerationAttempt" && value.schemaVersion === 1 && typeof value.id === "string" && ["initial", "model_repair", "deterministic_repair"].includes(String(value.type)) && (value.model === undefined || (isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.name === "string" && typeof value.model.requestHash === "string" && typeof value.model.responseHash === "string")) && (value.patchSetId === undefined || typeof value.patchSetId === "string") && ["verified", "rejected", "incomplete"].includes(String(value.verificationStatus)) && Array.isArray(value.issueCodes) && value.issueCodes.every((code) => typeof code === "string"); }
function isVerificationReportEnvelope(value: unknown): value is VerificationReport { return isRecord(value) && value.kind === "VerificationReport" && value.schemaVersion === 1 && typeof value.projectPath === "string" && isSha256(value.projectHash) && Array.isArray(value.toolchain) && Array.isArray(value.issues) && Array.isArray(value.checks) && isRecord(value.gate) && ["verified", "rejected", "incomplete"].includes(String(value.gate.status)) && Array.isArray(value.gate.reasons) && value.gate.reasons.every((reason) => typeof reason === "string") && isRecord(value.reproducibility); }
function isContextSummary(value: unknown): value is ReturnType<typeof contextSummary> { return isRecord(value) && ["itemCount", "requiredItemCount", "totalTokenEstimate", "candidateTokenEstimate", "evictedTokenEstimate"].every((key) => typeof value[key] === "number" && Number.isInteger(value[key]) && (value[key] as number) >= 0) && isSha256(value.compositionHash); }
function parseCandidateRegression(value: unknown): CandidateRegression {
  if (!isRecord(value) || value.kind !== "CandidateRegression" || value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.sourceGenerationRunId !== "string" || typeof value.sourceGenerationAttemptId !== "string" || typeof value.sourceBuildTraceId !== "string" || typeof value.sourcePatchSetId !== "string" || typeof value.seedProject !== "string" || typeof value.mechanicContract !== "string" || !isRecord(value.model) || typeof value.model.provider !== "string" || typeof value.model.name !== "string" || typeof value.model.requestHash !== "string" || typeof value.model.responseHash !== "string" || typeof value.model.promptHash !== "string" || !isRecord(value.sourceHashes) || !Object.values(value.sourceHashes).every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) || value.historicalVerdict !== "rejected" || typeof value.historicalReason !== "string" || (value.expectedCorrectedLocalVerdict !== "verified" && value.expectedCorrectedLocalVerdict !== "rejected") || !["not_run", "verified", "rejected"].includes(String(value.studioVerdict))) throw new Error("Invalid CandidateRegression");
  return value as unknown as CandidateRegression;
}
function exact(value: Record<string, unknown>, keys: string[]): void { const received = Object.keys(value).sort(); const expected = [...keys].sort(); if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) throw new Error(`Unexpected model output fields: ${received.join(", ")}`); }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
async function persistPrivateRun(directory: string, run: GenerationRun, details: unknown): Promise<void> { const destination = join(directory, `${run.id}.json`); await mkdir(directory, { recursive: true }); await writeFile(destination, `${stableJson({ run, details })}\n`, { encoding: "utf8", mode: 0o600 }); }
async function persistPrivateArtifact(destination: string, value: unknown): Promise<void> { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${stableJson(value)}\n`, { encoding: "utf8", mode: 0o600 }); }

function intentPrompt(prompt: string): string { return `Turn this creator request into one bounded CollectFruit core-loop payload. Select only CollectFruit. Return ONLY the requested payload fields: normalizedGoal, audience, genreSignals, desiredOutcomes, unresolvedQuestions, selectedMechanic, coreLoop. The coreLoop must have unique non-empty node IDs, and entryNodeId must exactly equal one node ID; every edge endpoint must be a node ID. Do not return kind, schemaVersion, security rules, source code, markdown, or any extra fields.\n\nCreator request:\n${prompt}`; }
function patchPrompt(context: string, _contract: MechanicContract): string { return `Implement the supplied mechanic in exactly the complete Luau replacements permitted by the MechanicImplementationSpec. Return ONLY this payload shape: {"rationale":"short explanation","operations":[{"path":"allowed source path","after":"complete source"}]}. Preserve remote identity, positional ABI, state bindings, constants, and authority invariants exactly. The model authors the implementation logic; the interface is immutable. Never create a preserved remote or use Forge/Test/Studio services, markdown, PatchSet fields, IDs, versions, or extra fields.\n\n${context}`; }
function repairPrompt(context: string): string { return `Repair this bounded candidate while preserving the supplied MechanicImplementationSpec. Return ONLY a payload with rationale and complete replacement operations for every allowed source target. The context includes the original contract, exact ABI/state interface, candidate source, PatchSet, normalized ranged diagnostics, and semantic evidence. Do not invent a different remote, state schema, tag, attribute, target path, or mechanic. Do not add tests, Forge code, Studio services, PatchSet fields, IDs, versions, or extra fields.\n\n${context}`; }
/**
 * Deliberately uses the portable structural subset accepted by OpenAI-backed
 * OpenRouter providers. Semantic bounds stay in Forge's parser/compiler.
 */
function intentDraftSchema(): Record<string, unknown> { return { type: "object", additionalProperties: false, required: ["normalizedGoal", "audience", "genreSignals", "desiredOutcomes", "unresolvedQuestions", "selectedMechanic", "coreLoop"], properties: { normalizedGoal: { type: "string" }, audience: { type: "string", enum: ["novice_creator", "experienced_creator", "unknown"] }, genreSignals: { type: "array", items: { type: "string" } }, desiredOutcomes: { type: "array", items: { type: "string" } }, unresolvedQuestions: { type: "array", items: { type: "string" } }, selectedMechanic: { type: "string", const: "CollectFruit" }, coreLoop: { type: "object", additionalProperties: false, required: ["title", "nodes", "edges", "entryNodeId"], properties: { title: { type: "string" }, nodes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "label", "category"], properties: { id: { type: "string" }, label: { type: "string" }, category: { type: "string", enum: ["acquisition", "conversion", "progression", "social", "retention", "monetization"] } } } }, edges: { type: "array", items: { type: "object", additionalProperties: false, required: ["from", "to", "condition"], properties: { from: { type: "string" }, to: { type: "string" }, condition: { anyOf: [{ type: "string" }, { type: "null" }] } } } }, entryNodeId: { type: "string" } } } } }; }
function patchProposalSchema(): Record<string, unknown> { return { type: "object", additionalProperties: false, required: ["rationale", "operations"], properties: { rationale: { type: "string" }, operations: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "after"], properties: { path: { type: "string", enum: [...COLLECT_FRUIT_GENERATION_POLICY.allowedPaths] }, after: { type: "string" } } } } } }; }
