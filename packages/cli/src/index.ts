import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { FORGE_NATIVE_RUNTIME_IDENTITY, ForgeNativeAgentRuntime, loadWorkspaceCandidateArtifact } from "../../agent-runtime/src/index.js";
import { stableJson } from "../../contracts/src/index.js";
import { CreatorSessionCoordinator, type CreatorControlAction } from "../../creator-session/src/coordinator.js";
import { assertCreatorControlView, type CreatorControlActionId, type CreatorControlView } from "../../creator-session/src/index.js";
import { LocalCreatorAgentWorker } from "../../creator-session/src/worker.js";
import { assertExperimentRegistrationCurrent, assertRegisteredCandidate, loadExperimentRegistration, persistExperimentRegistration, registerExperiment, runRegisteredExperiment } from "../../experiments/src/index.js";
import { defaultTraceDirectory, JsonFileTraceSink } from "../../flight-recorder/src/index.js";
import { OPENROUTER_MODEL_CLIENT_DESCRIPTOR, OpenRouterModelClient } from "../../model-client/src/index.js";
import { assertAcceptanceSpec, assertAcceptanceSpecReferences, assertRequirementSet, type AcceptanceSpec, type RequirementSet } from "../../semantic-authority/src/index.js";
import { StudioBridgeClient, StudioBridgeServer, readStudioBridgeDiscovery, removeStudioBridgeDiscovery, writeStudioBridgeDiscovery } from "../../studio-bridge/src/index.js";
import { STUDIO_CAPABILITY_SET, assertRuntimeEvalDefinition, assertRuntimeEvaluatorConfiguration, createRuntimeEvalPlan, createStudioExecutionPlan, type RuntimeEvalDefinition, type RuntimeEvaluatorConfiguration, type StudioCapabilityCall, type StudioExecutionBudget, type StudioRuntimeTarget } from "../../studio-capabilities/src/index.js";
import { executeRuntimeEvaluation, executeStudioCapabilityCanary, requestFreshStudioSnapshot, type RuntimeEvaluationRun, type StudioCapabilityCanaryRun } from "../../studio-runtime/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "creator" && subcommand === "serve") return creatorServe(rest);
  if (command === "creator" && subcommand === "start") return creatorStart(rest);
  if (command === "creator" && subcommand === "status") return creatorStatus(rest[0], rest.slice(1));
  if (command === "creator" && ["approve-plan", "reject-plan", "approve-changes", "reject-changes", "start-checks", "cancel-changes", "accept", "reject-result"].includes(subcommand ?? "")) return creatorAction(subcommand!, rest[0], rest.slice(1));
  if (command === "experiment" && subcommand === "register") return experimentRegister(rest[0], rest.slice(1));
  if (command === "experiment" && subcommand === "build") return experimentBuild(rest[0], rest.slice(1));
  if (command === "experiment" && subcommand === "evaluate") return experimentEvaluate(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "canary") return studioCapabilityCanary(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "bridge") return studioBridge(rest);
  if (command === "verify") return verify(subcommand, rest);
  if (command === "trace" && subcommand === "show") return showTrace(rest[0], rest.slice(1));
  usage();
  process.exitCode = command === "--help" || command === "help" || command === undefined ? 0 : 2;
}

async function creatorServe(optionArgs: string[]): Promise<void> {
  const options = parseCreatorServeOptions(optionArgs);
  if (!options.valid || !options.model) { process.stderr.write("Usage: forge creator serve --model <exact-model-id> [--session-dir <path>] [--timeout-ms <ms>] [--external-rojo-root <StudioPath>]...\n"); process.exitCode = 2; return; }
  const bridge = new StudioBridgeServer();
  let coordinator: CreatorSessionCoordinator | undefined;
  try {
    const apiKey = loadOpenRouterApiKey();
    const runtime = new ForgeNativeAgentRuntime(new OpenRouterModelClient({ apiKey, model: options.model }));
    const directory = resolve(options.sessionDirectory ?? ".forge/creator-sessions");
    coordinator = new CreatorSessionCoordinator({ connection: bridge, worker: new LocalCreatorAgentWorker(runtime, directory), directory, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.externalRojoPaths.length > 0 ? { externalRojoPaths: options.externalRojoPaths } : {}) });
    bridge.setControlHandler(coordinator);
    bridge.subscribe((messageValue) => { if (messageValue.type !== "Heartbeat") process.stdout.write(`\n[studio -> creator] ${messageValue.type}${messageValue.sessionId ? ` (${messageValue.sessionId})` : ""}\n`); });
    const address = await bridge.listen();
    const discovery = { kind: "ForgeStudioBridgeDiscovery" as const, bridgeId: `bridge_${randomUUID()}`, host: address.host, port: address.port, controlToken: address.controlToken, pid: process.pid, startedAt: new Date().toISOString() };
    await writeStudioBridgeDiscovery(discovery);
    process.stdout.write(`Forge creator service listening at http://${address.host}:${address.port}\nThe Forge Studio connector will pair automatically. Studio is the only creator-session write authority.\n`);
    await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
    await removeStudioBridgeDiscovery(discovery.bridgeId);
  } catch (error) { process.stderr.write(`Forge creator service did not start: ${message(error)}\n`); process.exitCode = 2; }
  finally { coordinator?.close(); await bridge.close(); }
}

async function creatorStart(optionArgs: string[]): Promise<void> {
  const options = parseCreatorStartOptions(optionArgs);
  if (!options.valid || (!options.prompt && !options.promptPath)) { process.stderr.write("Usage: forge creator start (--prompt <request> | --prompt-file <file-or->)\n"); process.exitCode = 2; return; }
  try {
    const prompt = options.prompt ?? (options.promptPath === "-" ? await readStdin() : await readFile(resolve(options.promptPath!), "utf8"));
    process.stdout.write(`${JSON.stringify(await creatorControl({ action: "start", prompt: prompt.trim() }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`Creator session did not start: ${message(error)}\n`); process.exitCode = 2; }
}

async function creatorStatus(sessionId: string | undefined, optionArgs: string[]): Promise<void> {
  if (optionArgs.length > 0) { process.stderr.write("Usage: forge creator status [session-id]\n"); process.exitCode = 2; return; }
  try { process.stdout.write(`${JSON.stringify(await creatorState(sessionId), null, 2)}\n`); }
  catch (error) { process.stderr.write(`Creator status unavailable: ${message(error)}\n`); process.exitCode = 2; }
}

async function creatorAction(command: string, sessionId: string | undefined, optionArgs: string[]): Promise<void> {
  if (!sessionId || optionArgs.length > 0) { process.stderr.write(`Usage: forge creator ${command} <session-id>\n`); process.exitCode = 2; return; }
  try {
    const viewValue = await creatorState(sessionId); assertCreatorControlView(viewValue); const view = viewValue as CreatorControlView;
    const mapping: Record<string, CreatorControlActionId> = { "approve-plan": "approve_plan", "reject-plan": "reject_plan", "approve-changes": "approve_and_apply_changes", "reject-changes": "reject_changes", "start-checks": "start_checks", "cancel-changes": "cancel_changes", accept: "accept_result", "reject-result": "reject_and_rollback" };
    const actionId = mapping[command]; if (!actionId || ![view.primaryAction?.id, view.secondaryAction?.id].includes(actionId)) throw new Error(`${command} is not available in the current creator control view`);
    const action: CreatorControlAction = { action: "act", sessionId, viewId: view.id, viewHash: view.hash, actionId };
    process.stdout.write(`${JSON.stringify(await creatorControl(action), null, 2)}\n`);
  } catch (error) { process.stderr.write(`Creator action failed: ${message(error)}\n`); process.exitCode = 2; }
}

async function experimentRegister(seedPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseExperimentRegisterOptions(optionArgs);
  if (!seedPath || !options.valid || !options.promptPath || !options.requirementsPath || !options.acceptancePath || !options.definitionPath || !options.configurationPath || !options.model || !options.outputPath) {
    process.stderr.write("Usage: forge experiment register <seed> --prompt-file <file> --requirements <requirement-set.json> --acceptance <acceptance-spec.json> --runtime-plan <runtime-eval-definition.json> --runtime-configuration <runtime-evaluator-configuration.json> --model <exact-model-id> --output <registration.json>\n");
    process.exitCode = 2; return;
  }
  try {
    const [creatorPrompt, requirementsValue, acceptanceValue, definitionValue, configurationValue] = await Promise.all([
      readFile(resolve(options.promptPath), "utf8"), readJson(options.requirementsPath), readJson(options.acceptancePath), readJson(options.definitionPath), readJson(options.configurationPath)
    ]);
    assertRequirementSet(requirementsValue); assertAcceptanceSpec(acceptanceValue); assertAcceptanceSpecReferences(acceptanceValue, requirementsValue); assertRuntimeEvalDefinition(definitionValue); assertRuntimeEvaluatorConfiguration(configurationValue);
    const registration = await registerExperiment({
      repositoryRoot: process.cwd(), seedRoot: resolve(seedPath), name: options.name ?? "registered-experiment", hypothesis: options.hypothesis ?? "A preregistered treatment can produce a locally eligible candidate and a separately graded Studio runtime outcome.", creatorPrompt: creatorPrompt.trim(),
      requirementSet: requirementsValue as RequirementSet, acceptanceSpec: acceptanceValue as AcceptanceSpec, runtimeEvalDefinition: definitionValue as RuntimeEvalDefinition, runtimeEvaluatorConfiguration: configurationValue as RuntimeEvaluatorConfiguration,
      runtime: { identity: FORGE_NATIVE_RUNTIME_IDENTITY, modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR }, model: options.model
    });
    const persisted = await persistExperimentRegistration(registration, options.outputPath);
    process.stdout.write(`${JSON.stringify({ kind: "ForgeExperimentRegistration", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, artifact: persisted.path, seedHash: registration.seed.hash, harnessConfigurationId: registration.expected.harnessConfigurationId, harnessConfigurationHash: registration.expected.harnessConfigurationHash }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Experiment registration did not complete: ${message(error)}\n`); process.exitCode = 2;
  }
}

async function experimentBuild(seedPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseExperimentBuildOptions(optionArgs);
  if (!seedPath || !options.valid || !options.registrationPath) {
    process.stderr.write("Usage: forge experiment build <seed> --registration <registration.json> [--run-dir <path>] [--trace-dir <path>] [--format json]\n");
    process.exitCode = 2; return;
  }
  try {
    const registration = await loadExperimentRegistration(options.registrationPath);
    const apiKey = loadOpenRouterApiKey();
    const runtime = new ForgeNativeAgentRuntime(new OpenRouterModelClient({ apiKey, model: registration.model.name }));
    const result = await runRegisteredExperiment({ registration, repositoryRoot: process.cwd(), seedRoot: resolve(seedPath), runtime, runDirectory: resolve(options.runDirectory ?? join(".forge/experiment-runs", registration.id)), traceDirectory: resolve(options.traceDirectory ?? ".forge/flight-recorder") });
    process.stdout.write(`${JSON.stringify({ kind: "ForgeExperimentBuildSummary", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, status: result.status, classification: result.classification, trialStarted: result.run.trialStarted, agentRunId: result.run.id, agentRunArtifact: result.persistence.path, ...(result.candidateArtifact ? { workspaceCandidateArtifactId: result.candidateArtifact.artifact.id, workspaceCandidateArtifact: result.candidateArtifact.persistence.path } : {}), buildTraceId: result.trace.id, finalVerifierTraceId: result.finalVerification.trace.id, finalGate: result.finalVerification.report.gate.status === "eligible" ? "locally_eligible" : result.finalVerification.report.gate.status, candidateRoot: result.candidateRoot, harnessConfigurationId: result.run.harnessConfigurationId, harnessConfigurationHash: result.run.harnessConfigurationHash, budgets: result.run.budgets }, null, 2)}\n`);
    process.exitCode = result.status === "locally_eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Registered experiment build did not complete: ${message(error)}\n`); process.exitCode = 2;
  }
}

async function experimentEvaluate(artifactPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseExperimentEvaluateOptions(optionArgs);
  if (!artifactPath || !options.valid || !options.registrationPath) {
    process.stderr.write("Usage: forge experiment evaluate <workspace-candidate-artifact.json> --registration <registration.json> [--timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--proof-dir <path>] [--format json]\n");
    process.exitCode = 2; return;
  }
  let bridge: StudioBridgeClient | undefined;
  try {
    const registration = await loadExperimentRegistration(options.registrationPath);
    const loaded = await loadWorkspaceCandidateArtifact(resolve(artifactPath), options.traceDirectory);
    assertRegisteredCandidate(registration, loaded.artifact);
    await assertExperimentRegistrationCurrent(registration, { repositoryRoot: process.cwd(), seedRoot: loaded.artifact.seedRoot, runtime: { identity: FORGE_NATIVE_RUNTIME_IDENTITY, modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR } });
    const definition = registration.artifacts.runtimeEvalDefinition;
    const configuration = registration.artifacts.runtimeEvaluatorConfiguration;
    const runDirectory = resolve(options.runDirectory ?? join(".forge/runtime-evaluations", registration.id));
    const placePath = await prepareRojoPlace(loaded.candidateRoot, runDirectory, `${loaded.artifact.id}.rbxlx`);
    printStudioSteps("registered experiment runtime evaluation", placePath);
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
    const outcome = await executeRuntimeEvaluation({ connection: bridge, session, runtimeEvalPlan: runtimePlan, definition, configuration, timeoutMs, ...(options.traceDirectory ? { traceDirectory: resolve(options.traceDirectory) } : {}), ...(options.proofDirectory ? { proofDirectory: resolve(options.proofDirectory) } : {}), proofInput: { creatorPromptHash: agentRun.creatorPromptHash, experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, requirementSetId: registration.artifacts.requirementSet.id, requirementViewId: loaded.artifact.requirementViewId, evaluatorViewId: registration.artifacts.evaluatorViewId, harnessConfigurationId: loaded.artifact.harnessConfigurationId, harnessConfigurationHash: loaded.artifact.harnessConfigurationHash, agentRunId, workspaceCandidateArtifactId: loaded.artifact.id, workspaceCandidateArtifactHash: loaded.artifact.artifactHash, seedHash: loaded.artifact.seedHash, candidateHash: loaded.artifact.candidateHash, workspaceDeltaId: loaded.artifact.workspaceDelta.id, localVerificationReportHash: loaded.artifact.localGate.reportHash, localVerificationTraceId: loaded.artifact.localGate.traceId, runtimeEvalDefinitionId: definition.id, runtimeEvalDefinitionHash: definition.hash, runtimeEvalPlanId: runtimePlan.id, runtimeEvalPlanHash: runtimePlan.hash, studioCapabilitySetId: STUDIO_CAPABILITY_SET.id, studioCapabilitySetHash: STUDIO_CAPABILITY_SET.hash, runtimeEvaluatorConfigurationId: configuration.id, runtimeEvaluatorConfigurationHash: configuration.hash, scope: "exact_runtime_definition_capability_set_configuration_authoritative_run" } });
    await persistPrivateRun(outcome.run, runDirectory);
    process.stdout.write(`${JSON.stringify({ kind: "ForgeExperimentRuntimeEvaluation", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, status: outcome.run.status, meaning: "runtime_verified means only that this exact registered candidate satisfied this exact RuntimeEvalDefinition under this exact StudioCapabilitySet and RuntimeEvaluatorConfiguration in this authoritative Studio run.", runtimeEvaluationRunId: outcome.run.id, runtimeEvalPlanId: runtimePlan.id, runtimeProofBundleId: outcome.proof?.id, traceId: outcome.trace.id }, null, 2)}\n`);
    process.exitCode = outcome.run.status === "runtime_verified" ? 0 : outcome.run.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Registered experiment evaluation did not complete: ${message(error)}\n`); process.exitCode = 2;
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
    if (template.kind !== "StudioCapabilityCanaryTemplate" || template.capabilitySetId !== STUDIO_CAPABILITY_SET.id || template.capabilitySetHash !== STUDIO_CAPABILITY_SET.hash || !Array.isArray(targets) || !Array.isArray(calls) || !budget || !Array.isArray(staticTargetIds) || staticTargetIds.length === 0 || staticTargetIds.some((id) => typeof id !== "string") || new Set(staticTargetIds).size !== staticTargetIds.length) throw new Error("Invalid task-owned Studio capability canary template");
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
    process.stdout.write(`${JSON.stringify({ kind: result.kind, status: result.status, id: result.id, executionPlanId: plan.id, note: "Non-evaluative transport and static-position-integrity characterization only; no candidate verdict, RuntimeEvalDefinition, RuntimeProofBundle, or benchmark result exists." }, null, 2)}\n`);
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
  const discovery = { kind: "ForgeStudioBridgeDiscovery" as const, bridgeId: `bridge_${randomUUID()}`, host: address.host, port: address.port, controlToken: address.controlToken, pid: process.pid, startedAt: new Date().toISOString() };
  await writeStudioBridgeDiscovery(discovery);
  process.stdout.write(`Forge Studio bridge listening at http://${address.host}:${address.port}\nThe Forge Studio connector will pair automatically.\n`);
  try { await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); }); }
  finally { await bridge.close(); await removeStudioBridgeDiscovery(discovery.bridgeId); }
}

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(resolve(path), "utf8")) as unknown; }
async function prepareRojoPlace(projectRoot: string, directory: string, name: string): Promise<string> { const destinationDirectory = resolve(directory, "places"); await mkdir(destinationDirectory, { recursive: true }); const destination = join(destinationDirectory, name); await execFile("rojo", ["build", resolve(projectRoot, "default.project.json"), "-o", destination], { timeout: 60_000 }); return destination; }
function printStudioSteps(label: string, placePath: string): void { process.stdout.write(`Prepared ${label}.\nPlace: ${placePath}\nStudio steps:\n1. Keep \`forge studio bridge\` running in a separate terminal.\n2. Open the exact place above in Roblox Studio.\n3. Install or reload the Forge Studio connector and allow local HTTP/script injection when prompted.\n4. Wait for the connector to pair.\n5. Click \"Evaluate in Studio\" after Forge arms the plan.\n`); }
function assertCandidateLiveBinding(sourceFiles: Array<{ path: string; sourceHash: string }>, observation: { instances: Array<{ path: string; className: string }>; scripts: Array<{ sourceHash: string }> }, targets: StudioRuntimeTarget[]): void { for (const target of targets) if (!observation.instances.some((instance) => instance.path === target.path && ["Part", "MeshPart", "UnionOperation", "TrussPart", "Seat", "VehicleSeat", "WedgePart", "CornerWedgePart"].includes(instance.className))) throw new Error(`Live Studio candidate is missing required BasePart target ${target.path}`); for (const source of sourceFiles) if (!observation.scripts.some((script) => script.sourceHash === source.sourceHash)) throw new Error(`Live Studio candidate source binding is missing sealed source hash for ${source.path}`); }
async function persistPrivateRun(run: RuntimeEvaluationRun | StudioCapabilityCanaryRun, directory: string): Promise<void> { await mkdir(directory, { recursive: true }); const destination = join(directory, `${run.id}.json`); const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`); await writeFile(temporary, `${stableJson(run)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, destination); }

function loadOpenRouterApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { const source = readFileSync(resolve(process.cwd(), ".env"), "utf8"); const match = source.match(/^OPENROUTER_API_KEY=(.+)$/m); const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, ""); if (value) return value; }
  catch { /* Root .env is optional when the process environment is configured. */ }
  throw new Error("OPENROUTER_API_KEY is required in the process environment or root .env");
}

function parseSimpleTraceOptions(values: string[]): { valid: boolean; traceDirectory?: string } { let traceDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--format" && next === "json") { index += 1; continue; } if (option === "--trace-dir" && next) { traceDirectory = next; index += 1; continue; } return { valid: false }; } return { valid: true, ...(traceDirectory ? { traceDirectory } : {}) }; }
function parseCreatorServeOptions(values: string[]): { valid: boolean; model?: string; sessionDirectory?: string; timeoutMs?: number; externalRojoPaths: string[] } { let model: string | undefined; let sessionDirectory: string | undefined; let timeoutMs: number | undefined; const externalRojoPaths: string[] = []; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--model" && next) model = next; else if (option === "--session-dir" && next) sessionDirectory = next; else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next); else if (option === "--external-rojo-root" && next) externalRojoPaths.push(next); else return { valid: false, externalRojoPaths: [] }; index += 1; } return { valid: new Set(externalRojoPaths).size === externalRojoPaths.length, externalRojoPaths: [...externalRojoPaths].sort(), ...(model ? { model } : {}), ...(sessionDirectory ? { sessionDirectory } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }; }
function parseCreatorStartOptions(values: string[]): { valid: boolean; prompt?: string; promptPath?: string } { let prompt: string | undefined; let promptPath: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--prompt" && next) prompt = next; else if (option === "--prompt-file" && next) promptPath = next; else return { valid: false }; index += 1; } return { valid: Boolean(prompt) !== Boolean(promptPath), ...(prompt ? { prompt } : {}), ...(promptPath ? { promptPath } : {}) }; }
async function creatorControl(action: CreatorControlAction): Promise<unknown> { const discovery = await readStudioBridgeDiscovery(); return creatorRequest(discovery, "/control/action", { method: "POST", body: stableJson(action) }); }
async function creatorState(sessionId?: string): Promise<unknown> { const discovery = await readStudioBridgeDiscovery(); return creatorRequest(discovery, `/control/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "GET" }); }
async function creatorRequest(discovery: Awaited<ReturnType<typeof readStudioBridgeDiscovery>>, path: string, input: { method: "GET" | "POST"; body?: string }): Promise<unknown> { const response = await fetch(`http://${discovery.host}:${discovery.port}${path}`, { method: input.method, headers: { "x-forge-control-token": discovery.controlToken, ...(input.body ? { "content-type": "application/json" } : {}) }, ...(input.body ? { body: input.body } : {}) }); const payload = await response.json() as unknown; if (!response.ok) throw new Error(isRecord(payload) && typeof payload.message === "string" ? payload.message : `Creator service returned HTTP ${response.status}`); return payload; }
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
function parseExperimentRegisterOptions(values: string[]): { valid: boolean; promptPath?: string; requirementsPath?: string; acceptancePath?: string; definitionPath?: string; configurationPath?: string; model?: string; outputPath?: string; name?: string; hypothesis?: string } { let promptPath: string | undefined; let requirementsPath: string | undefined; let acceptancePath: string | undefined; let definitionPath: string | undefined; let configurationPath: string | undefined; let model: string | undefined; let outputPath: string | undefined; let name: string | undefined; let hypothesis: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--prompt-file" && next) promptPath = next; else if (option === "--requirements" && next) requirementsPath = next; else if (option === "--acceptance" && next) acceptancePath = next; else if (option === "--runtime-plan" && next) definitionPath = next; else if (option === "--runtime-configuration" && next) configurationPath = next; else if (option === "--model" && next) model = next; else if (option === "--output" && next) outputPath = next; else if (option === "--name" && next) name = next; else if (option === "--hypothesis" && next) hypothesis = next; else return { valid: false }; index += 1; } return { valid: true, ...(promptPath ? { promptPath } : {}), ...(requirementsPath ? { requirementsPath } : {}), ...(acceptancePath ? { acceptancePath } : {}), ...(definitionPath ? { definitionPath } : {}), ...(configurationPath ? { configurationPath } : {}), ...(model ? { model } : {}), ...(outputPath ? { outputPath } : {}), ...(name ? { name } : {}), ...(hypothesis ? { hypothesis } : {}) }; }
function parseExperimentBuildOptions(values: string[]): { valid: boolean; registrationPath?: string; runDirectory?: string; traceDirectory?: string } { let registrationPath: string | undefined; let runDirectory: string | undefined; let traceDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--registration" && next) registrationPath = next; else if (option === "--run-dir" && next) runDirectory = next; else if (option === "--trace-dir" && next) traceDirectory = next; else if (option === "--format" && next === "json") { index += 1; continue; } else return { valid: false }; index += 1; } return { valid: true, ...(registrationPath ? { registrationPath } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}) }; }
function parseExperimentEvaluateOptions(values: string[]): { valid: boolean; registrationPath?: string; timeoutMs?: number; runDirectory?: string; traceDirectory?: string; proofDirectory?: string } { let registrationPath: string | undefined; let timeoutMs: number | undefined; let runDirectory: string | undefined; let traceDirectory: string | undefined; let proofDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--registration" && next) registrationPath = next; else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next); else if (option === "--run-dir" && next) runDirectory = next; else if (option === "--trace-dir" && next) traceDirectory = next; else if (option === "--proof-dir" && next) proofDirectory = next; else if (option === "--format" && next === "json") { index += 1; continue; } else return { valid: false }; index += 1; } return { valid: true, ...(registrationPath ? { registrationPath } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}), ...(traceDirectory ? { traceDirectory } : {}), ...(proofDirectory ? { proofDirectory } : {}) }; }
function parseStudioCanaryOptions(values: string[]): { valid: boolean; planPath?: string; timeoutMs?: number; runDirectory?: string } { let planPath: string | undefined; let timeoutMs: number | undefined; let runDirectory: string | undefined; for (let index = 0; index < values.length; index += 1) { const option = values[index]; const next = values[index + 1]; if (option === "--plan" && next) planPath = next; else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next); else if (option === "--run-dir" && next) runDirectory = next; else if (option === "--format" && next === "json") { index += 1; continue; } else return { valid: false }; index += 1; } return { valid: true, ...(planPath ? { planPath } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(runDirectory ? { runDirectory } : {}) }; }
function usage(): void { process.stdout.write(`Forge commands:\n  forge creator serve --model <exact-model-id>\n  forge creator start (--prompt <request> | --prompt-file <file-or->)\n  forge creator status [session-id]\n  forge creator approve-plan|reject-plan <session-id>\n  forge creator approve-changes|reject-changes <session-id>\n  forge creator start-checks|cancel-changes <session-id>\n  forge creator accept|reject-result <session-id>\n  forge experiment register <seed> --prompt-file <file> --requirements <file> --acceptance <file> --runtime-plan <file> --runtime-configuration <file> --model <exact-model-id> --output <registration.json>\n  forge experiment build <seed> --registration <registration.json>\n  forge experiment evaluate <artifact> --registration <registration.json>\n  forge studio canary <seed> --plan <file>\n  forge studio bridge\n  forge verify <project>\n  forge trace show <trace-id>\n`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

void main();
