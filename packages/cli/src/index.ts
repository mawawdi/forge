import { JsonFileTraceSink, defaultTraceDirectory } from "../../flight-recorder/src/index.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMechanicContract, repairProject } from "../../repair/src/orchestrator.js";
import { StudioBridgeServer, readStudioBridgeDiscovery, removeStudioBridgeDiscovery, writeStudioBridgeDiscovery } from "../../studio-bridge/src/index.js";
import { runStudioPatchVerification, runStudioVerification, type StudioFaultMode } from "../../studio-proof/src/runner.js";
import type { PluginToBackendMessage } from "../../studio-protocol/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";
import { OPENROUTER_MODELS, OpenRouterProvider, buildGeneratedCandidate, loadCandidateArtifact, repairCandidateRegression, reverifyCandidateRegression, type OpenRouterModel } from "../../generation/src/index.js";

const args = process.argv.slice(2);

loadLocalEnvironment();

/** Deliberately narrow local configuration: do not add a general dotenv surface. */
function loadLocalEnvironment(): void {
  if (process.env.OPENROUTER_API_KEY) return;
  try {
    const source = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    const match = source.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match?.[1]) process.env.OPENROUTER_API_KEY = match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    // A local .env is optional. The provider reports a precise missing-key error.
  }
}

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "verify") {
    await verify(subcommand, rest);
    return;
  }
  if (command === "repair") {
    await repair(subcommand, rest);
    return;
  }
  if (command === "build") {
    await build(subcommand, rest);
    return;
  }
  if (command === "candidate" && subcommand === "reverify") {
    await candidateReverify(rest[0], rest.slice(1));
    return;
  }
  if (command === "candidate" && subcommand === "repair") {
    await candidateRepair(rest[0], rest.slice(1));
    return;
  }
  if (command === "candidate" && subcommand === "studio") {
    await candidateStudio(rest[0], rest.slice(1));
    return;
  }
  if (command === "trace" && subcommand === "show") {
    await showTrace(rest[0], rest.slice(1));
    return;
  }
  if (command === "studio" && subcommand === "bridge") {
    await studioBridge(rest);
    return;
  }
  if (command === "studio" && subcommand === "verify") {
    await studioVerify(rest[0], rest.slice(1));
    return;
  }
  usage();
  process.exitCode = 2;
}

async function candidateReverify(regressionPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseCandidateReverifyOptions(optionArgs);
  if (!regressionPath || !options.valid) {
    process.stderr.write("Usage: forge candidate reverify <candidate-regression> [--trace-dir <path>] [--studio] [--timeout-ms <ms>] [--proof-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const root = resolve(regressionPath);
    const result = await reverifyCandidateRegression(root, options.traceDirectory);
    process.stdout.write(`${JSON.stringify({ kind: result.kind, schemaVersion: result.schemaVersion, regressionId: result.regressionId, sourceUnchanged: result.sourceUnchanged, historical: result.historical, patchSetId: result.patchSet.id, verification: result.verification.report, traceId: result.verification.trace.id }, null, 2)}\n`);
    if (result.verification.report.gate.status !== "verified" || !options.studio) {
      process.exitCode = result.verification.report.gate.status === "verified" ? 0 : result.verification.report.gate.status === "incomplete" ? 2 : 1;
      return;
    }
    const discovery = await readStudioBridgeDiscovery();
    process.stdout.write("The unchanged historical candidate passed corrected local gates. Attaching it to the existing authoritative StudioProof path.\n");
    const studio = await runStudioPatchVerification({ projectRoot: result.seedRoot, candidateProjectRoot: root, candidatePatchSet: result.patchSet, candidateVerification: result.verification, contract: result.contract, controlToken: discovery.controlToken, host: discovery.host, port: discovery.port, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}), ...(options.proofDirectory ? { proofDirectory: options.proofDirectory } : {}), onReady: (address) => process.stdout.write(`Attaching to discovered Forge Studio bridge at http://${address.host}:${address.port}\nWaiting for Studio to connect and send a live snapshot...\n`), onMessage: printStudioVerificationMessage });
    process.stdout.write(`${JSON.stringify({ kind: "CandidateStudioReverification", schemaVersion: 1, regressionId: result.regressionId, sourceUnchanged: true, studioStatus: studio.status, proofBundleId: studio.proofBundle.id, traceId: studio.trace?.id }, null, 2)}\n`);
    process.exitCode = studio.status === "verified" ? 0 : studio.status === "incomplete" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`Candidate re-verification did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function candidateRepair(regressionPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseCandidateRepairOptions(optionArgs);
  if (!regressionPath || !options.valid) {
    process.stderr.write("Usage: forge candidate repair <candidate-regression> [--model openai/gpt-5.6-luna|google/gemini-3.7-flash] [--model-timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--format json]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const model = options.model ?? "openai/gpt-5.6-luna";
    if (!options.formatJson) process.stdout.write(`Forge candidate repair: ${model}; one bounded repair call against the preserved regression.\n`);
    const result = await repairCandidateRegression({ regressionRoot: resolve(regressionPath), provider: new OpenRouterProvider(), model, ...(options.modelTimeoutMs !== undefined ? { modelTimeoutMs: options.modelTimeoutMs } : {}), ...(options.runDirectory ? { runDirectory: options.runDirectory } : {}), ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
    process.stdout.write(`${JSON.stringify({ kind: result.kind, schemaVersion: result.schemaVersion, id: result.id, regressionId: result.regressionId, source: result.source, model: result.model, attempt: result.attempt, outputRoot: result.outputRoot, artifactPath: result.artifactPath, patchSetId: result.patchSet.id, verification: result.verification.report, traceId: result.verification.trace.id, context: result.contextSummary }, null, 2)}\n`);
    if (!options.formatJson && result.verification.report.gate.status === "verified") process.stdout.write(`Repaired candidate passed local gates. Immutable Studio input: ${result.artifactPath}\n`);
    else if (!options.formatJson) process.stdout.write(`Repaired candidate was retained for diagnosis but is not eligible for Studio: ${result.artifactPath}\n`);
    process.exitCode = result.verification.report.gate.status === "verified" ? 0 : result.verification.report.gate.status === "incomplete" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`Candidate repair did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function candidateStudio(artifactPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseCandidateStudioOptions(optionArgs);
  if (!artifactPath || !options.valid) {
    process.stderr.write("Usage: forge candidate studio <candidate-artifact> [--fault client-controlled-reward|client-controlled-payout] [--timeout-ms <ms>] [--trace-dir <path>] [--proof-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write("Validating the retained candidate artifact and rerunning current local gates; no model will be called.\n");
    const loaded = await loadCandidateArtifact(resolve(artifactPath), options.traceDirectory);
    const discovery = await readStudioBridgeDiscovery();
    if (options.fault) {
      process.stdout.write(`INTENTIONAL FAULT MODE: ${options.fault}\nExpected outcome: semantic rejection, one failed authoritative assertion, rejected ProofBundle, and transaction rollback.\n`);
      process.stdout.write(`Candidate ${loaded.artifact.id} is the preserved safe baseline. Open its output project in Studio before clicking Verify in Studio.\n`);
      const studio = await runStudioVerification({
        projectRoot: loaded.artifact.outputRoot,
        contract: loaded.artifact.contract,
        fault: options.fault,
        controlToken: discovery.controlToken,
        host: discovery.host,
        port: discovery.port,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}),
        ...(options.proofDirectory ? { proofDirectory: options.proofDirectory } : {}),
        onReady: (address) => process.stdout.write(`Attaching to discovered Forge Studio bridge at http://${address.host}:${address.port}\nWaiting for Studio to connect and send a live snapshot...\n`),
        onMessage: printStudioVerificationMessage
      });
      process.stdout.write(`${JSON.stringify({ kind: "CandidateStudioFaultResult", schemaVersion: 1, fault: options.fault, baselineCandidateArtifactId: loaded.artifact.id, baselineArtifactHash: loaded.artifact.artifactHash, faultPatchSetId: studio.patchSet.id, localVerificationTraceId: studio.staticAfter.trace.id, localIssueCodes: [...new Set(studio.staticAfter.report.issues.map((issue) => issue.ruleId))], studioStatus: studio.status, proofBundleId: studio.proofBundle.id, traceId: studio.trace?.id }, null, 2)}\n`);
      process.exitCode = studio.status === "verified" ? 0 : studio.status === "incomplete" ? 2 : 1;
      return;
    }
    process.stdout.write(`Candidate ${loaded.artifact.id} passed artifact integrity and local verification. Open the original seed project in Studio (not the generated candidate output): Forge will apply this exact PatchSet to that seed during StudioProof.\n`);
    const studio = await runStudioPatchVerification({
      projectRoot: loaded.artifact.seedRoot,
      candidateProjectRoot: loaded.artifact.outputRoot,
      candidatePatchSet: loaded.artifact.patchSet,
      candidateVerification: loaded.verification,
      contract: loaded.artifact.contract,
      candidateArtifact: loaded.artifact,
      controlToken: discovery.controlToken,
      host: discovery.host,
      port: discovery.port,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}),
      ...(options.proofDirectory ? { proofDirectory: options.proofDirectory } : {}),
      onReady: (address) => process.stdout.write(`Attaching to discovered Forge Studio bridge at http://${address.host}:${address.port}\nWaiting for Studio to connect and send a live snapshot...\n`),
      onMessage: printStudioVerificationMessage
    });
    process.stdout.write(`${JSON.stringify({ kind: "CandidateStudioResult", schemaVersion: 1, candidateArtifactId: loaded.artifact.id, artifactHash: loaded.artifact.artifactHash, ...(loaded.artifact.origin.regressionId ? { regressionId: loaded.artifact.origin.regressionId } : {}), patchSetId: loaded.artifact.patchSet.id, localVerificationTraceId: loaded.verification.trace.id, studioStatus: studio.status, proofBundleId: studio.proofBundle.id, traceId: studio.trace?.id }, null, 2)}\n`);
    process.exitCode = studio.status === "verified" ? 0 : studio.status === "incomplete" ? 2 : 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Candidate StudioProof did not complete: ${detail}\n`);
    if (!options.fault && /source precondition mismatch/i.test(detail)) {
      process.stderr.write("Studio is not at the artifact's seed revision. Reopen the original seed project, not the generated candidate output; candidate studio applies the artifact PatchSet itself.\n");
    }
    process.exitCode = 2;
  }
}

async function build(seedPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseBuildOptions(optionArgs);
  if (!seedPath || !options.valid || !options.prompt) {
    process.stderr.write("Usage: forge build <generated-seed-project> --prompt <creator request> [--model openai/gpt-5.6-luna|google/gemini-3.7-flash] [--model-timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--format json]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const progress = `Forge build: ${options.model ?? "openai/gpt-5.6-luna"}; compiling bounded intent and candidate.\n`;
    if (options.formatJson) process.stderr.write(progress);
    else process.stdout.write(progress);
    const result = await buildGeneratedCandidate({ seedRoot: resolve(seedPath), prompt: options.prompt, provider: new OpenRouterProvider(), ...(options.model ? { model: options.model } : {}), ...(options.modelTimeoutMs !== undefined ? { modelTimeoutMs: options.modelTimeoutMs } : {}), ...(options.runDirectory ? { runDirectory: options.runDirectory } : {}), ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
    const summary = { kind: "ForgeBuildSummary", schemaVersion: 1, run: result.run, outputRoot: result.outputRoot, artifactPath: result.artifactPath, verification: result.verification?.report.gate, context: result.contextSummary };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (result.run.status === "verified") {
      const hint = `Candidate passed local gates. Attach this sealed artifact to StudioProof with: forge candidate studio ${result.artifactPath}\n`;
      if (options.formatJson) process.stderr.write(hint);
      else process.stdout.write(hint);
    }
    process.exitCode = result.run.status === "verified" ? 0 : result.run.status === "incomplete" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`Forge build did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function repair(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseRepairOptions(optionArgs);
  if (!projectPath || !options.valid || !options.contractPath || !options.destinationRoot) {
    process.stderr.write("Usage: forge repair <project-path> --contract <path> --out <directory> [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const contract = await loadMechanicContract(options.contractPath);
    const result = await repairProject(projectPath, contract, { destinationRoot: options.destinationRoot, ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
    process.stdout.write(`${JSON.stringify({ kind: "RepairRun", schemaVersion: 1, before: result.before.report, patchSet: result.patchSet, application: result.application, after: result.after.report, proofBundle: result.proofBundle, tracePersistence: result.tracePersistence }, null, 2)}\n`);
    process.stderr.write(`Forge repair traces: ${result.before.trace.id}, ${result.after.trace.id}\n`);
    process.exitCode = result.after.report.gate.status === "incomplete" ? 2 : result.after.report.gate.status === "verified" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Unable to repair project: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function verify(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseOptions(optionArgs);
  if (!projectPath || !options.valid) {
    process.stderr.write("Usage: forge verify <project-path> [--format json] [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  const run = await verifyProject(projectPath, { ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
  process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  const persistence = run.tracePersistence;
  if (persistence.status === "written") {
    process.stderr.write(`Forge trace: ${persistence.traceId} (${persistence.locator ?? "local JSON"})\n`);
  } else {
    process.stderr.write(`Forge trace persistence ${persistence.status}: ${persistence.error ?? "no artifact written"}\n`);
  }
  process.exitCode = run.report.gate.status === "incomplete" ? 2 : run.report.gate.status === "verified" ? 0 : 1;
}

async function showTrace(traceId: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseOptions(optionArgs);
  if (!traceId || !options.valid) {
    process.stderr.write("Usage: forge trace show <trace-id> [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const trace = await new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory()).read(traceId);
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Unable to read trace ${traceId}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function studioBridge(optionArgs: string[]): Promise<void> {
  const options = parseBridgeOptions(optionArgs);
  if (!options.valid) {
    process.stderr.write("Usage: forge studio bridge\n");
    process.exitCode = 2;
    return;
  }
  const bridge = new StudioBridgeServer();
  bridge.subscribe((message) => {
    // Heartbeats maintain session liveness but are not operator events. Keeping
    // them off the bridge console makes real pairing, patch, and proof events
    // inspectable without changing transport behavior or retention.
    if (message.type === "Heartbeat") return;
    process.stdout.write(`\n[studio -> forge] ${message.type}${message.sessionId ? ` (${message.sessionId})` : ""}\n${JSON.stringify(message, null, 2)}\n`);
  });
  const address = await bridge.listen();
  const discovery = { kind: "ForgeStudioBridgeDiscovery" as const, schemaVersion: 1 as const, bridgeId: `bridge_${randomUUID()}`, host: address.host, port: address.port, controlToken: address.controlToken, pid: process.pid, startedAt: new Date().toISOString() };
  await writeStudioBridgeDiscovery(discovery);
  process.stdout.write(`Forge Studio bridge listening at http://${address.host}:${address.port}\nStudio plugin and verifier will connect automatically. No tokens are required.\n`);
  try {
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  } finally {
    await bridge.close();
    await removeStudioBridgeDiscovery(discovery.bridgeId);
  }
}

async function studioVerify(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseStudioVerifyOptions(optionArgs);
  if (!projectPath || !options.valid) {
    process.stderr.write("Usage: forge studio verify <project-path> [--contract <path>] [--timeout-ms <ms>] [--trace-dir <path>] [--proof-dir <path>] [--fault client-controlled-reward|client-controlled-payout]\n");
    process.exitCode = 2;
    return;
  }
  const projectRoot = resolve(projectPath);
  const contractPath = options.contractPath ?? resolve(projectRoot, "../contracts/MechanicContract.json");
  try {
    process.stdout.write(options.fault
      ? `INTENTIONAL FAULT MODE: ${options.fault}\nExpected outcome: a contract-applicable assertion fails, the ProofBundle is rejected, and the Studio transaction rolls back.\n`
      : "Studio verification mode: SAFE CANDIDATE\n");
    const contract = await loadMechanicContract(contractPath);
    const discovery = await readStudioBridgeDiscovery();
    const result = await runStudioVerification({ projectRoot, contract, controlToken: discovery.controlToken, host: discovery.host, port: discovery.port, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}), ...(options.proofDirectory ? { proofDirectory: options.proofDirectory } : {}), ...(options.fault ? { fault: options.fault } : {}), onReady: (address) => process.stdout.write(`Attaching to discovered Forge Studio bridge at http://${address.host}:${address.port}\nWaiting for Studio to connect and send a live snapshot...\n`), onMessage: printStudioVerificationMessage });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.proofPath) process.stderr.write(`Forge Studio ProofBundle: ${result.proofPath}\n`);
    if (result.proofRunPath) process.stderr.write(`Forge Studio proof run: ${result.proofRunPath}\n`);
    if (result.tracePath) process.stderr.write(`Forge Studio trace: ${result.tracePath}\n`);
    process.exitCode = result.status === "verified" ? 0 : result.status === "incomplete" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`Studio verification did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Error && "status" in error && (error as { status?: string }).status === "incomplete" ? 2 : 1;
  }
}

function printStudioVerificationMessage(message: PluginToBackendMessage): void {
  if (message.type === "ProjectObservation") {
    process.stdout.write(`[studio -> forge] ProjectObservation (${message.payload.observation.scripts.length} scripts, ${message.payload.observation.instances.length} instances, ${message.payload.revision.observationHash})\n`);
    return;
  }
  if (message.type === "AssertionPlanAccepted") {
    process.stdout.write(`[studio -> forge] ${message.type}: ${message.payload.instruction}\n`);
    return;
  }
  if (message.type === "StudioTestResult") {
    process.stdout.write(`[studio result] ${message.payload.status}: ${message.payload.assertions.length} correlated assertions\n`);
    for (const assertion of message.payload.assertions) process.stdout.write(`[studio assertion] ${assertion.assertionId}: ${assertion.status} (observed ${String(assertion.observed)})\n`);
    for (const diagnostic of message.payload.diagnostics) process.stdout.write(`[studio diagnostic] ${diagnostic.context}/${diagnostic.level}: ${diagnostic.message}\n`);
    return;
  }
  if (message.type === "PluginError") {
    process.stdout.write(`[studio plugin error] ${message.payload.code}: ${message.payload.message}${message.payload.retryable ? " (retryable)" : ""}\n`);
    return;
  }
  if (message.type === "Heartbeat") return;
  process.stdout.write(`[studio -> forge] ${message.type}\n`);
}

function parseOptions(values: string[]): { valid: boolean; traceDirectory?: string } {
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--format" && values[index + 1] === "json") {
      index += 1;
      continue;
    }
    if (option === "--trace-dir" && values[index + 1]) {
      traceDirectory = values[index + 1];
      index += 1;
      continue;
    }
    return { valid: false };
  }
  return traceDirectory ? { valid: true, traceDirectory } : { valid: true };
}

function parseRepairOptions(values: string[]): { valid: boolean; contractPath?: string; destinationRoot?: string; traceDirectory?: string } {
  let contractPath: string | undefined;
  let destinationRoot: string | undefined;
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--contract" && values[index + 1]) {
      contractPath = values[index + 1];
      index += 1;
      continue;
    }
    if (option === "--out" && values[index + 1]) {
      destinationRoot = values[index + 1];
      index += 1;
      continue;
    }
    if (option === "--trace-dir" && values[index + 1]) {
      traceDirectory = values[index + 1];
      index += 1;
      continue;
    }
    return { valid: false };
  }
  return { valid: true, ...(contractPath ? { contractPath } : {}), ...(destinationRoot ? { destinationRoot } : {}), ...(traceDirectory ? { traceDirectory } : {}) };
}

function parseBridgeOptions(values: string[]): { valid: boolean } {
  return { valid: values.length === 0 };
}

function parseCandidateReverifyOptions(values: string[]): { valid: boolean; traceDirectory?: string; proofDirectory?: string; studio?: boolean; timeoutMs?: number } {
  let traceDirectory: string | undefined;
  let proofDirectory: string | undefined;
  let studio = false;
  let timeoutMs: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; }
    if (option === "--proof-dir" && next) { proofDirectory = next; index += 1; continue; }
    if (option === "--studio") { studio = true; continue; }
    if (option === "--timeout-ms" && next && /^\d+$/.test(next)) { timeoutMs = Number(next); index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, ...(traceDirectory ? { traceDirectory } : {}), ...(proofDirectory ? { proofDirectory } : {}), ...(studio ? { studio: true } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

function parseCandidateRepairOptions(values: string[]): { valid: boolean; model?: OpenRouterModel; modelTimeoutMs?: number; runDirectory?: string; traceDirectory?: string; formatJson?: true } {
  let model: OpenRouterModel | undefined;
  let modelTimeoutMs: number | undefined;
  let runDirectory: string | undefined;
  let traceDirectory: string | undefined;
  let formatJson = false;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--model" && next && (OPENROUTER_MODELS as readonly string[]).includes(next)) { model = next as OpenRouterModel; index += 1; continue; }
    if (option === "--model-timeout-ms" && next && /^\d+$/.test(next)) { modelTimeoutMs = Number(next); index += 1; continue; }
    if (option === "--run-dir" && next) { runDirectory = next; index += 1; continue; }
    if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; }
    if (option === "--format" && next === "json") { formatJson = true; index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, ...(model ? { model } : {}), ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}), ...(formatJson ? { formatJson: true as const } : {}) };
}

function parseCandidateStudioOptions(values: string[]): { valid: boolean; timeoutMs?: number; traceDirectory?: string; proofDirectory?: string; fault?: StudioFaultMode } {
  let timeoutMs: number | undefined;
  let traceDirectory: string | undefined;
  let proofDirectory: string | undefined;
  let fault: StudioFaultMode | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--timeout-ms" && next && /^\d+$/.test(next)) { timeoutMs = Number(next); index += 1; continue; }
    if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; }
    if (option === "--proof-dir" && next) { proofDirectory = next; index += 1; continue; }
    if (option === "--fault" && (next === "client-controlled-reward" || next === "client-controlled-payout")) { fault = next; index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(traceDirectory ? { traceDirectory } : {}), ...(proofDirectory ? { proofDirectory } : {}), ...(fault ? { fault } : {}) };
}

function parseBuildOptions(values: string[]): { valid: boolean; prompt?: string; model?: OpenRouterModel; modelTimeoutMs?: number; runDirectory?: string; traceDirectory?: string; formatJson?: boolean } {
  let prompt: string | undefined;
  let model: OpenRouterModel | undefined;
  let modelTimeoutMs: number | undefined;
  let runDirectory: string | undefined;
  let traceDirectory: string | undefined;
  let formatJson = false;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--prompt" && next) { prompt = next; index += 1; continue; }
    if (option === "--model" && next && (OPENROUTER_MODELS as readonly string[]).includes(next)) { model = next as OpenRouterModel; index += 1; continue; }
    if (option === "--model-timeout-ms" && next && /^\d+$/.test(next)) { modelTimeoutMs = Number(next); index += 1; continue; }
    if (option === "--run-dir" && next) { runDirectory = next; index += 1; continue; }
    if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; }
    if (option === "--format" && next === "json") { formatJson = true; index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, formatJson, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}) };
}

function parseStudioVerifyOptions(values: string[]): { valid: boolean; contractPath?: string; timeoutMs?: number; traceDirectory?: string; proofDirectory?: string; fault?: StudioFaultMode } {
  let contractPath: string | undefined;
  let timeoutMs: number | undefined;
  let traceDirectory: string | undefined;
  let proofDirectory: string | undefined;
  let fault: StudioFaultMode | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--contract" && next) { contractPath = next; index += 1; continue; }
    if (option === "--timeout-ms" && next && /^\d+$/.test(next)) { timeoutMs = Number(next); index += 1; continue; }
    if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; }
    if (option === "--proof-dir" && next) { proofDirectory = next; index += 1; continue; }
    if (option === "--fault" && (next === "client-controlled-reward" || next === "client-controlled-payout")) { fault = next; index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, ...(contractPath ? { contractPath } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(traceDirectory ? { traceDirectory } : {}), ...(proofDirectory ? { proofDirectory } : {}), ...(fault ? { fault } : {}) };
}

function usage(): void {
  process.stderr.write("Usage:\n  forge verify <project-path> [--format json] [--trace-dir <path>]\n  forge repair <project-path> --contract <path> --out <directory> [--trace-dir <path>]\n  forge build <generated-seed-project> --prompt <creator request> [--model <model>] [--model-timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--format json]\n  forge candidate reverify <candidate-regression> [--trace-dir <path>] [--studio] [--timeout-ms <ms>] [--proof-dir <path>]\n  forge candidate repair <candidate-regression> [--model <model>] [--model-timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--format json]\n  forge candidate studio <candidate-artifact> [--fault client-controlled-reward|client-controlled-payout] [--timeout-ms <ms>] [--trace-dir <path>] [--proof-dir <path>]\n  forge trace show <trace-id> [--trace-dir <path>]\n  forge studio bridge\n  forge studio verify <project-path> [--contract <path>] [--timeout-ms <ms>] [--trace-dir <path>] [--proof-dir <path>] [--fault client-controlled-reward|client-controlled-payout]\n");
}

void main();
