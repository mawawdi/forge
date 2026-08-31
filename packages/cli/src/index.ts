import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ForgeNativeAgentRuntime, loadWorkspaceCandidateArtifact, runBoundedAgent } from "../../agent-runtime/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { defaultTraceDirectory, JsonFileTraceSink } from "../../flight-recorder/src/index.js";
import { OpenRouterModelClient } from "../../model-client/src/index.js";
import { assertAcceptanceSpec, assertAcceptanceSpecReferences, assertRequirementSet, resolveRequirementView, type AcceptanceSpec, type RequirementSet } from "../../semantic-authority/src/index.js";
import { StudioBridgeClient, StudioBridgeServer, readStudioBridgeDiscovery, removeStudioBridgeDiscovery, writeStudioBridgeDiscovery } from "../../studio-bridge/src/index.js";
import { STUDIO_CAPABILITY_SET, assertRuntimeEvalDefinition, assertRuntimeEvaluatorConfiguration, createRuntimeEvalPlan, createStudioExecutionPlan, type RuntimeEvalDefinition, type RuntimeEvaluatorConfiguration, type StudioCapabilityCall, type StudioExecutionBudget, type StudioRuntimeTarget } from "../../studio-capabilities/src/index.js";
import { executeRuntimeEvaluation, executeStudioCapabilityCanary, requestFreshStudioSnapshot, type RuntimeEvaluationRun, type StudioCapabilityCanaryRun } from "../../studio-runtime/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "agent" && subcommand === "build") return agentBuild(rest[0], rest.slice(1));
  if (command === "candidate" && subcommand === "evaluate") return candidateEvaluate(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "canary") return studioCapabilityCanary(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "bridge") return studioBridge(rest);
  if (command === "verify") return verify(subcommand, rest);
  if (command === "trace" && subcommand === "show") return showTrace(rest[0], rest.slice(1));
  usage();
  process.exitCode = command === "--help" || command === "help" || command === undefined ? 0 : 2;
}

async function agentBuild(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseAgentBuildOptions(optionArgs);
  if (!projectPath || !options.valid || !options.prompt || !options.requirementsPath || !options.model) {
    process.stderr.write("Usage: forge agent build <project> --prompt <creator request> --requirements <requirement-set.json> --model <exact-model-id> [--environment production|benchmark] [--run-dir <path>] [--trace-dir <path>] [--format json]\n");
    process.exitCode = 2; return;
  }
  try {
    const requirementSet = await readJson(options.requirementsPath);
    assertRequirementSet(requirementSet);
    const apiKey = loadOpenRouterApiKey();
    const runtime = new ForgeNativeAgentRuntime(new OpenRouterModelClient({ apiKey, model: options.model }));
    const result = await runBoundedAgent({ seedRoot: resolve(projectPath), creatorPrompt: options.prompt, requirementSet, runtime, model: options.model, runDirectory: resolve(options.runDirectory ?? ".forge/agent-runs"), traceDirectory: resolve(options.traceDirectory ?? ".forge/flight-recorder"), ...(options.environment ? { environment: options.environment } : {}) });
    process.stdout.write(`${JSON.stringify({ kind: "ForgeAgentBuildSummary", schemaVersion: 2, status: result.status, classification: result.classification, trialStarted: result.run.trialStarted, studio: "not_run", agentRunId: result.run.id, agentRunArtifact: result.persistence.path, ...(result.candidateArtifact ? { workspaceCandidateArtifactId: result.candidateArtifact.artifact.id, workspaceCandidateArtifact: result.candidateArtifact.persistence.path } : {}), buildTraceId: result.trace.id, finalVerifierTraceId: result.finalVerification.trace.id, finalGate: result.finalVerification.report.gate.status === "eligible" ? "locally_eligible" : result.finalVerification.report.gate.status, candidateRoot: result.candidateRoot, harnessConfigurationId: result.run.harnessConfigurationId, harnessConfigurationHash: result.run.harnessConfigurationHash, budgets: result.run.budgets }, null, 2)}\n`);
    process.exitCode = result.status === "locally_eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Forge agent build did not complete: ${message(error)}\n`); process.exitCode = 2;
  }
}

async function candidateEvaluate(artifactPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseCandidateEvaluateOptions(optionArgs);
  if (!artifactPath || !options.valid || !options.definitionPath || !options.requirementsPath || !options.acceptancePath) {
    process.stderr.write("Usage: forge candidate evaluate <workspace-candidate-artifact.json> --runtime-plan <runtime-eval-definition.json> --requirements <requirement-set.json> --acceptance <acceptance-spec.json> [--timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--proof-dir <path>] [--format json]\n");
    process.exitCode = 2; return;
  }
  let bridge: StudioBridgeClient | undefined;
  try {
    const [requirementsValue, acceptanceValue, definitionValue] = await Promise.all([readJson(options.requirementsPath), readJson(options.acceptancePath), readJson(options.definitionPath)]);
    assertRequirementSet(requirementsValue); assertAcceptanceSpec(acceptanceValue); assertAcceptanceSpecReferences(acceptanceValue, requirementsValue); assertRuntimeEvalDefinition(definitionValue);
    const requirements = requirementsValue as RequirementSet; const acceptance = acceptanceValue as AcceptanceSpec; const definition = definitionValue as RuntimeEvalDefinition;
    if (definition.requirementSetId !== requirements.id || definition.acceptanceSpecId !== acceptance.id) throw new Error("Runtime evaluator definition does not bind the supplied requirement or acceptance artifacts");
    if (definition.capabilitySetId !== STUDIO_CAPABILITY_SET.id || definition.capabilitySetHash !== STUDIO_CAPABILITY_SET.hash) throw new Error("Runtime evaluator definition does not bind the canonical Studio capability set");
    const evaluatorView = resolveRequirementView(requirements, { phase: "evaluate", environment: "benchmark", audience: "evaluator" });
    if (definition.evaluatorViewId !== evaluatorView.id || definition.evaluatorViewHash !== contentHash(stableJson(evaluatorView))) throw new Error("Runtime evaluator definition does not bind the resolved evaluator-only view");
    const configurationValue = await readJson(join(dirname(resolve(options.definitionPath)), "runtime-evaluator-configuration.json"));
    assertRuntimeEvaluatorConfiguration(configurationValue);
    const configuration = configurationValue as RuntimeEvaluatorConfiguration;
    if (configuration.runtimeEvalDefinitionId !== definition.id || configuration.runtimeEvalDefinitionHash !== definition.hash) throw new Error("Runtime evaluator configuration does not bind the supplied definition");
    const loaded = await loadWorkspaceCandidateArtifact(resolve(artifactPath), options.traceDirectory);
    if (loaded.artifact.requirementSetId !== requirements.id) throw new Error("Candidate artifact does not bind the supplied RequirementSet");
    const runDirectory = resolve(options.runDirectory ?? ".forge/runtime-evaluations");
    const placePath = await prepareRojoPlace(loaded.candidateRoot, runDirectory, `${loaded.artifact.id}.rbxlx`);
    printStudioSteps("candidate runtime evaluation", placePath);
    const discovery = await readStudioBridgeDiscovery();
    bridge = new StudioBridgeClient({ host: discovery.host, port: discovery.port, controlToken: discovery.controlToken });
    const timeoutMs = options.timeoutMs ?? 120_000;
    const session = await bridge.waitForSession(timeoutMs);
    const fresh = await requestFreshStudioSnapshot(bridge, session, timeoutMs);
    assertCandidateLiveBinding(loaded.artifact.sourceFiles, fresh.observation, definition.targets);
    const executionPlan = createStudioExecutionPlan({ purpose: "runtime_evaluation", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: { runId: `runtime_run_${randomUUID()}`, correlationId: `runtime_correlation_${randomUUID()}`, sessionId: session.sessionId, projectId: session.projectId, project: session.project, projectSnapshotHash: fresh.revisionHash, candidateHash: loaded.artifact.candidateHash }, targets: definition.targets, calls: definition.calls, budget: definition.budget });
    const agentRunId = loaded.artifact.origin.agentRunId;
    const runtimePlan = createRuntimeEvalPlan({ definitionId: definition.id, definitionHash: definition.hash, candidateArtifactId: loaded.artifact.id, candidateArtifactHash: loaded.artifact.artifactHash, agentRunId, workspaceDeltaId: loaded.artifact.workspaceDelta.id, candidateHash: loaded.artifact.candidateHash, executionPlan });
    const agentRun = await readJson(join(dirname(resolve(artifactPath)), `${agentRunId}.json`));
    if (!isRecord(agentRun) || typeof agentRun.creatorPromptHash !== "string") throw new Error("Runtime proof requires the sealed originating AgentRun beside its candidate artifact");
    const outcome = await executeRuntimeEvaluation({ connection: bridge, session, runtimeEvalPlan: runtimePlan, definition, configuration, timeoutMs, ...(options.traceDirectory ? { traceDirectory: resolve(options.traceDirectory) } : {}), ...(options.proofDirectory ? { proofDirectory: resolve(options.proofDirectory) } : {}), proofInput: { creatorPromptHash: agentRun.creatorPromptHash, requirementSetId: requirements.id, requirementViewId: loaded.artifact.requirementViewId, evaluatorViewId: evaluatorView.id, harnessConfigurationId: loaded.artifact.harnessConfigurationId, harnessConfigurationHash: loaded.artifact.harnessConfigurationHash, agentRunId, workspaceCandidateArtifactId: loaded.artifact.id, workspaceCandidateArtifactHash: loaded.artifact.artifactHash, seedHash: loaded.artifact.seedHash, candidateHash: loaded.artifact.candidateHash, workspaceDeltaId: loaded.artifact.workspaceDelta.id, localVerificationReportHash: loaded.artifact.localGate.reportHash, localVerificationTraceId: loaded.artifact.localGate.traceId, runtimeEvalDefinitionId: definition.id, runtimeEvalDefinitionHash: definition.hash, runtimeEvalPlanId: runtimePlan.id, runtimeEvalPlanHash: runtimePlan.hash, studioCapabilitySetId: STUDIO_CAPABILITY_SET.id, studioCapabilitySetHash: STUDIO_CAPABILITY_SET.hash, runtimeEvaluatorConfigurationId: configuration.id, runtimeEvaluatorConfigurationHash: configuration.hash, scope: "exact_runtime_definition_capability_set_configuration_authoritative_run" } });
    await persistPrivateRun(outcome.run, runDirectory);
    process.stdout.write(`${JSON.stringify({ kind: "ForgeCandidateRuntimeEvaluation", schemaVersion: 1, status: outcome.run.status, meaning: "runtime_verified means only that this exact candidate satisfied this exact RuntimeEvalDefinition under this exact StudioCapabilitySet and RuntimeEvaluatorConfiguration in this authoritative Studio run.", runtimeEvaluationRunId: outcome.run.id, runtimeEvalPlanId: runtimePlan.id, runtimeProofBundleId: outcome.proof?.id, traceId: outcome.trace.id }, null, 2)}\n`);
    process.exitCode = outcome.run.status === "runtime_verified" ? 0 : outcome.run.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Runtime candidate evaluation did not complete: ${message(error)}\n`); process.exitCode = 2;
  } finally { await bridge?.close(); }
}

async function studioCapabilityCanary(seedPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseStudioCanaryOptions(optionArgs);
  if (!seedPath || !options.valid || !options.planPath) {
    process.stderr.write("Usage: forge studio canary <seed> --plan <capability-canary-template.json> [--timeout-ms <ms>] [--run-dir <path>] [--format json]\n");
    process.exitCode = 2; return;
  }
  let bridge: StudioBridgeClient | undefined;
  try {
    const template = await readJson(options.planPath);
    if (!isRecord(template)) throw new Error("Invalid task-owned Studio capability canary template");
    const targets = template.targets as StudioRuntimeTarget[]; const calls = template.calls as StudioCapabilityCall[]; const budget = template.budget as StudioExecutionBudget; const staticTargetIds = template.staticTargetIds;
    if (template.kind !== "StudioCapabilityCanaryTemplate" || template.schemaVersion !== 1 || template.capabilitySetId !== STUDIO_CAPABILITY_SET.id || template.capabilitySetHash !== STUDIO_CAPABILITY_SET.hash || !Array.isArray(targets) || !Array.isArray(calls) || !budget || !Array.isArray(staticTargetIds) || staticTargetIds.length === 0 || staticTargetIds.some((id) => typeof id !== "string") || new Set(staticTargetIds).size !== staticTargetIds.length) throw new Error("Invalid task-owned Studio capability canary template");
    const runDirectory = resolve(options.runDirectory ?? ".forge/studio-canaries");
    const placePath = await prepareRojoPlace(resolve(seedPath), runDirectory, "studio-capability-canary.rbxlx");
    printStudioSteps("non-evaluative capability canary", placePath);
    const discovery = await readStudioBridgeDiscovery();
    bridge = new StudioBridgeClient({ host: discovery.host, port: discovery.port, controlToken: discovery.controlToken });
    const timeoutMs = options.timeoutMs ?? 120_000;
    const session = await bridge.waitForSession(timeoutMs);
    const fresh = await requestFreshStudioSnapshot(bridge, session, timeoutMs);
    const plan = createStudioExecutionPlan({ purpose: "capability_canary", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: { runId: `capability_canary_${randomUUID()}`, correlationId: `canary_correlation_${randomUUID()}`, sessionId: session.sessionId, projectId: session.projectId, project: session.project, projectSnapshotHash: fresh.revisionHash }, targets, calls, budget });
    const result = await executeStudioCapabilityCanary({ connection: bridge, session, executionPlan: plan, prePlayObservation: fresh.observation, staticTargetIds: staticTargetIds as string[], timeoutMs });
    await persistPrivateRun(result, runDirectory);
    process.stdout.write(`${JSON.stringify({ kind: result.kind, schemaVersion: result.schemaVersion, status: result.status, id: result.id, executionPlanId: plan.id, note: "Non-evaluative transport and static-position-integrity characterization only; no candidate verdict, RuntimeEvalDefinition, RuntimeProofBundle, or benchmark result exists." }, null, 2)}\n`);
    process.exitCode = result.status === "completed" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`Studio capability canary did not complete: ${message(error)}\n`); process.exitCode = 2;
  } finally { await bridge?.close(); }
}

async function verify(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseSimpleTraceOptions(optionArgs);
  if (!projectPath || !options.valid) { process.stderr.write("Usage: forge verify <project-path> [--format json] [--trace-dir <path>]\n"); process.exitCode = 2; return; }
  const run = await verifyProject(resolve(projectPath), { ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
  process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  if (run.tracePersistence.status === "written") process.stderr.write(`Forge trace: ${run.tracePersistence.traceId} (${run.tracePersistence.locator ?? "local JSON"})\n`);
  process.exitCode = run.report.gate.status === "eligible" ? 0 : run.report.gate.status === "rejected" ? 1 : 2;
}

async function showTrace(traceId: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseSimpleTraceOptions(optionArgs);
  if (!traceId || !options.valid) { process.stderr.write("Usage: forge trace show <trace-id> [--trace-dir <path>]\n"); process.exitCode = 2; return; }
  try { process.stdout.write(`${JSON.stringify(await new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory()).read(traceId), null, 2)}\n`); }
  catch (error) { process.stderr.write(`Unable to read trace ${traceId}: ${message(error)}\n`); process.exitCode = 2; }
}

async function studioBridge(optionArgs: string[]): Promise<void> {
  if (optionArgs.length > 0) { process.stderr.write("Usage: forge studio bridge\n"); process.exitCode = 2; return; }
  const bridge = new StudioBridgeServer();
  bridge.subscribe((messageValue) => { if (messageValue.type !== "Heartbeat") process.stdout.write(`\n[studio -> forge] ${messageValue.type}${messageValue.sessionId ? ` (${messageValue.sessionId})` : ""}\n${JSON.stringify(messageValue, null, 2)}\n`); });
  const address = await bridge.listen();
  const discovery = { kind: "ForgeStudioBridgeDiscovery" as const, schemaVersion: 1 as const, bridgeId: `bridge_${randomUUID()}`, host: address.host, port: address.port, controlToken: address.controlToken, pid: process.pid, startedAt: new Date().toISOString() };
  await writeStudioBridgeDiscovery(discovery);
  process.stdout.write(`Forge Studio bridge listening at http://${address.host}:${address.port}\nProtocol v12 / plugin 8.0.0 will pair automatically.\n`);
  try { await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); }); }
  finally { await bridge.close(); await removeStudioBridgeDiscovery(discovery.bridgeId); }
}

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(resolve(path), "utf8")) as unknown; }
async function prepareRojoPlace(projectRoot: string, directory: string, name: string): Promise<string> { const destinationDirectory = resolve(directory, "places"); await mkdir(destinationDirectory, { recursive: true }); const destination = join(destinationDirectory, name); await execFile("rojo", ["build", resolve(projectRoot, "default.project.json"), "-o", destination], { timeout: 60_000 }); return destination; }
function printStudioSteps(label: string, placePath: string): void { process.stdout.write(`Prepared ${label}.\nPlace: ${placePath}\nStudio steps:\n1. Keep \`forge studio bridge\` running in a separate terminal.\n2. Open the exact place above in Roblox Studio.\n3. Install/reload Forge Studio plugin 8.0.0 and allow local HTTP/script injection when prompted.\n4. Wait for the plugin to pair on protocol v12.\n5. Click \"Evaluate in Studio\" after Forge arms the plan.\n`); }
function assertCandidateLiveBinding(sourceFiles: Array<{ path: string; sourceHash: string }>, observation: { instances: Array<{ path: string; className: string }>; scripts: Array<{ sourceHash: string }> }, targets: StudioRuntimeTarget[]): void { for (const target of targets) if (!observation.instances.some((instance) => instance.path === target.path && ["Part", "MeshPart", "UnionOperation", "TrussPart", "Seat", "VehicleSeat", "WedgePart", "CornerWedgePart"].includes(instance.className))) throw new Error(`Live Studio candidate is missing required BasePart target ${target.path}`); for (const source of sourceFiles) if (!observation.scripts.some((script) => script.sourceHash === source.sourceHash)) throw new Error(`Live Studio candidate source binding is missing sealed source hash for ${source.path}`); }
async function persistPrivateRun(run: RuntimeEvaluationRun | StudioCapabilityCanaryRun, directory: string): Promise<void> { await mkdir(directory, { recursive: true }); const destination = join(directory, `${run.id}.json`); const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`); await writeFile(temporary, `${stableJson(run)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, destination); }

function loadOpenRouterApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { const source = readFileSync(resolve(process.cwd(), ".env"), "utf8"); const match = source.match(/^OPENROUTER_API_KEY=(.+)$/m); const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, ""); if (value) return value; }
  catch { /* Root .env is optional when the process environment is configured. */ }
  throw new Error("OPENROUTER_API_KEY is required in the process environment or root .env");
}

function parseSimpleTraceOptions(values: string[]): { valid: boolean; traceDirectory?: string } { let traceDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--format" && next === "json") { index += 1; continue; } if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; } return { valid: false }; } return { valid: true, ...(traceDirectory ? { traceDirectory } : {}) }; }
function parseAgentBuildOptions(values: string[]): { valid: boolean; prompt?: string; requirementsPath?: string; environment?: "production" | "benchmark"; model?: string; runDirectory?: string; traceDirectory?: string } { let prompt: string | undefined; let requirementsPath: string | undefined; let environment: "production" | "benchmark" | undefined; let model: string | undefined; let runDirectory: string | undefined; let traceDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--prompt" && next) { prompt = next; index += 1; continue; } if (option === "--requirements" && next) { requirementsPath = next; index += 1; continue; } if (option === "--environment" && (next === "production" || next === "benchmark")) { environment = next; index += 1; continue; } if (option === "--model" && next) { model = next; index += 1; continue; } if (option === "--run-dir" && next) { runDirectory = next; index += 1; continue; } if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; } if (option === "--format" && next === "json") { index += 1; continue; } return { valid: false }; } return { valid: true, ...(prompt ? { prompt } : {}), ...(requirementsPath ? { requirementsPath } : {}), ...(environment ? { environment } : {}), ...(model ? { model } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}) }; }
function parseCandidateEvaluateOptions(values: string[]): { valid: boolean; definitionPath?: string; requirementsPath?: string; acceptancePath?: string; timeoutMs?: number; runDirectory?: string; traceDirectory?: string; proofDirectory?: string } { let definitionPath: string | undefined; let requirementsPath: string | undefined; let acceptancePath: string | undefined; let timeoutMs: number | undefined; let runDirectory: string | undefined; let traceDirectory: string | undefined; let proofDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--runtime-plan" && next) definitionPath = next; else if (option === "--requirements" && next) requirementsPath = next; else if (option === "--acceptance" && next) acceptancePath = next; else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next); else if (option === "--run-dir" && next) runDirectory = next; else if (option === "--trace-dir" && next) traceDirectory = next; else if (option === "--proof-dir" && next) proofDirectory = next; else if (option === "--format" && next === "json") { index += 1; continue; } else return { valid: false }; index += 1; } return { valid: true, ...(definitionPath ? { definitionPath } : {}), ...(requirementsPath ? { requirementsPath } : {}), ...(acceptancePath ? { acceptancePath } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}), ...(proofDirectory ? { proofDirectory } : {}) }; }
function parseStudioCanaryOptions(values: string[]): { valid: boolean; planPath?: string; timeoutMs?: number; runDirectory?: string } { let planPath: string | undefined; let timeoutMs: number | undefined; let runDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--plan" && next) planPath = next; else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next); else if (option === "--run-dir" && next) runDirectory = next; else if (option === "--format" && next === "json") { index += 1; continue; } else return { valid: false }; index += 1; } return { valid: true, ...(planPath ? { planPath } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}) }; }
function usage(): void { process.stdout.write("Forge commands:\n  forge agent build <project> --prompt <request> --requirements <file> --model <exact-model-id>\n  forge candidate evaluate <artifact> --runtime-plan <file> --requirements <file> --acceptance <file>\n  forge studio canary <seed> --plan <file>\n  forge studio bridge\n  forge verify <project>\n  forge trace show <trace-id>\n"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

void main();
