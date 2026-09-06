import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FORGE_NATIVE_RUNTIME_IDENTITY,
  ForgeNativeAgentRuntime,
  loadWorkspaceCandidateArtifact,
} from "../../agent-runtime/src/index.js";
import {
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  BLENDER_COMPILER_INSTALLATION_SCHEMA,
  compileBlenderScene,
  currentBlenderWorkerIdentity,
  inspectBlenderInstallation,
  qualifyBlenderInstallation,
  type BlenderSourceInput,
  type BlenderCompilerInstallation,
} from "../../blender-compiler/src/index.js";
import {
  CreatorAssetJobs,
  readCreatorAssetInput,
  probeCreatorCubeInstallation,
} from "../../asset-registry/src/index.js";
import { stableJson } from "../../contracts/src/index.js";
import {
  CreatorConversationCoordinator,
  CreatorControlServer,
  acquireCreatorStoreLease,
  readCreatorControlDiscovery,
  removeCreatorControlDiscovery,
  studioCapabilityExplorerPage,
  studioCatalogSummary,
  writeCreatorControlDiscovery,
  type CreatorStoreLease,
} from "../../creator-control/src/index.js";
import { CreatorSessionCoordinator } from "../../creator-session/src/coordinator.js";
import { CREATOR_DEFAULT_STORE, loadCreatorBundle } from "../../creator-session/src/index.js";
import { replayCreatorOfflineRegression } from "../../creator-session/src/offline-regression.js";
import {
  assertCreatorDashboardState,
  type CreatorDashboardState,
  type CreatorWorkAdmission,
} from "../../creator-conversation/src/index.js";
import { replayCreatorVerification } from "../../creator-session/src/verification.js";
import { replayCreatorMutation } from "../../creator-session/src/mutation-evidence.js";
import {
  assertRojoMutationAttempt,
  assertRojoSourceRevert,
  assertRojoSourceRevertSyncProof,
  assertRojoSourceChangeSet,
  assertRojoSyncProof,
  replayRojoMutation,
} from "../../project-authority/src/index.js";
import { LocalCreatorAgentWorker } from "../../creator-session/src/worker.js";
import {
  assertExperimentRegistrationCurrent,
  assertRegisteredCandidate,
  loadExperimentRegistration,
  persistExperimentRegistration,
  registerExperiment,
  runRegisteredExperiment,
} from "../../experiments/src/index.js";
import {
  defaultTraceDirectory,
  JsonFileTraceSink,
  loadCreatorHostTimingReport,
} from "../../flight-recorder/src/index.js";
import {
  CREATOR_MODEL_REGISTRY,
  DEFAULT_CREATOR_MODEL_ID,
  OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
  OpenRouterModelCatalogProbe,
  OpenRouterModelClient,
  isCreatorModelId,
} from "../../model-client/src/index.js";
import {
  assertAcceptanceSpec,
  assertAcceptanceSpecReferences,
  assertRequirementSet,
  type AcceptanceSpec,
  type RequirementSet,
} from "../../semantic-authority/src/index.js";
import {
  ensureOfficialSourceAnalysisToolchain,
  PinnedSourceAnalysisHost,
} from "../../source-intelligence/src/index.js";
import {
  StudioBridgeClient,
  StudioBridgeServer,
  readStudioBridgeDiscovery,
  removeStudioBridgeDiscovery,
  writeStudioBridgeDiscovery,
  type StudioBridgeSession,
} from "../../studio-bridge/src/index.js";
import {
  assertRuntimeEvalDefinition,
  assertRuntimeEvaluatorConfiguration,
  createRuntimeEvalPlan,
  createStudioExecutionPlan,
  type RuntimeEvalDefinition,
  type RuntimeEvaluatorConfiguration,
  type StudioCapabilityCall,
  type StudioExecutionBudget,
  type StudioRuntimeTarget,
} from "../../studio-capabilities/src/index.js";
import {
  createStudioConnectorEpoch,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  studioProjectIndexView,
} from "../../studio-evidence/src/index.js";
import {
  executeRuntimeEvaluation,
  executeStudioCapabilityCanary,
  requestStudioProjectIndex,
  type RuntimeEvaluationRun,
  type StudioCapabilityCanaryRun,
} from "../../studio-runtime/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";
import { solveBlenderScene, validateBlenderSceneSpec } from "../../visual-world/src/index.js";
import { loadCreatorServeOptions, parseCreatorServeOptions } from "./creator-serve-options.js";
import {
  createCreatorActionCommandRequest,
  createCreatorTurnCommandRequest,
  creatorActionCommandInput,
  parseCreatorActionCommandOptions,
  parseCreatorTurnCommandOptions,
} from "./creator-conversation-options.js";
import { submitCreatorControlWork } from "./creator-control-client.js";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);

async function main(): Promise<void> {
  loadRootEnvironment();
  const [command, subcommand, ...rest] = args;
  if (command === "creator" && subcommand === "serve") return creatorServe(rest);
  if (command === "creator" && subcommand === "turn") return creatorTurn(rest);
  if (command === "creator" && subcommand === "state")
    return creatorStateCommand(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "visual-state")
    return creatorVisualState(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "visual-act")
    return creatorVisualAction(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "act")
    return creatorAction(rest[0], rest[1], rest.slice(2));
  if (command === "creator" && subcommand === "replay-verification")
    return creatorReplayVerification(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "replay-mutation")
    return creatorReplayMutation(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "replay-regression")
    return creatorReplayRegression(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "timings")
    return creatorTimings(rest[0], rest.slice(1));
  if (command === "creator" && subcommand === "asset") return creatorAsset(rest);
  if (command === "experiment" && subcommand === "register")
    return experimentRegister(rest[0], rest.slice(1));
  if (command === "experiment" && subcommand === "build")
    return experimentBuild(rest[0], rest.slice(1));
  if (command === "experiment" && subcommand === "evaluate")
    return experimentEvaluate(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "api-status") return studioApiStatus(rest);
  if (command === "studio" && subcommand === "capabilities") return studioCapabilities(rest);
  if (command === "studio" && subcommand === "canary")
    return studioCapabilityCanary(rest[0], rest.slice(1));
  if (command === "studio" && subcommand === "bridge") return studioBridge(rest);
  if (command === "visual" && subcommand === "solve") return visualSolve(rest[0], rest.slice(1));
  if (command === "visual" && subcommand === "blender-qualify") return visualBlenderQualify(rest);
  if (command === "visual" && subcommand === "blender-status") return visualBlenderStatus(rest);
  if (command === "visual" && subcommand === "compile")
    return visualCompile(rest[0], rest.slice(1));
  if (command === "verify") return verify(subcommand, rest);
  if (command === "trace" && subcommand === "show") return showTrace(rest[0], rest.slice(1));
  usage();
  process.exitCode = command === "--help" || command === "help" || command === undefined ? 0 : 2;
}

async function visualSolve(intentPath: string | undefined, values: string[]): Promise<void> {
  const outputPath = oneOption(values, "--output");
  if (!intentPath || !outputPath) {
    process.stderr.write(
      "Usage: forge visual solve <scene-intent.json> --output <scene-spec.json>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const result = solveBlenderScene(await readJson(intentPath));
    if (result.status === "eligible") await writeCanonicalJson(outputPath, result.spec);
    process.stdout.write(
      `${JSON.stringify({ ...result, ...(result.status === "eligible" ? { output: resolve(outputPath) } : {}) }, null, 2)}\n`,
    );
    process.exitCode = result.status === "eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Visual scene solving did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function visualBlenderStatus(values: string[]): Promise<void> {
  const installationPath = oneOption(values, "--installation");
  if (!installationPath) {
    process.stderr.write("Usage: forge visual blender-status --installation <installation.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await inspectBlenderInstallation(await readJson(installationPath));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Blender qualification check did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function visualBlenderQualify(values: string[]): Promise<void> {
  const options = exactOptions(values, ["--distribution", "--application", "--output"]);
  const distributionPath = options?.get("--distribution");
  const applicationPath = options?.get("--application");
  const outputPath = options?.get("--output");
  if (!distributionPath || !applicationPath || !outputPath) {
    process.stderr.write(
      "Usage: forge visual blender-qualify --distribution <blender.dmg> --application <Blender.app> --output <installation.json>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const result = await qualifyBlenderInstallation({
      distributionPath: resolve(distributionPath),
      applicationPath: resolve(applicationPath),
      compilerIdentity: await currentBlenderWorkerIdentity(),
    });
    if (result.status === "eligible") await writeCanonicalJson(outputPath, result.qualification);
    process.stdout.write(
      `${JSON.stringify(
        result.status === "eligible" ? { ...result, output: resolve(outputPath) } : result,
        null,
        2,
      )}\n`,
    );
    process.exitCode = result.status === "eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Blender qualification did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function visualCompile(specPath: string | undefined, values: string[]): Promise<void> {
  const options = exactOptions(values, ["--installation", "--store", "--source-root", "--sources"]);
  const installationPath = options?.get("--installation");
  const storePath = options?.get("--store");
  const sourceRoot = options?.get("--source-root");
  const sourcesPath = options?.get("--sources");
  if (!specPath || !installationPath || !storePath || !sourceRoot || !sourcesPath) {
    process.stderr.write(
      "Usage: forge visual compile <scene-spec.json> --installation <installation.json> --store <directory> --source-root <directory> --sources <source-list.json>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const sourceValue = await readJson(sourcesPath);
    if (!Array.isArray(sourceValue)) throw new Error("Source list must be a JSON array");
    const sources: BlenderSourceInput[] = sourceValue.map((entry) => {
      if (
        !isRecord(entry) ||
        Object.keys(entry).some((key) => key !== "sourceId" && key !== "path") ||
        typeof entry.sourceId !== "string" ||
        typeof entry.path !== "string"
      )
        throw new Error("Each source entry must contain only sourceId and path strings");
      return { sourceId: entry.sourceId, path: entry.path };
    });
    const root = resolve(storePath);
    const result = await compileBlenderScene({
      spec: validateBlenderSceneSpec(await readJson(specPath)),
      installation: BLENDER_COMPILER_INSTALLATION_SCHEMA.parse(await readJson(installationPath)),
      binaryStore: new ImmutableBinaryArtifactStore(root),
      allowedSourceRoots: [resolve(sourceRoot)],
      sources,
    });
    const presented =
      result.status !== "eligible"
        ? result
        : {
            ...result,
            bundle: {
              ...result.bundle,
              manifestPath: resolve(root, result.bundle.manifestArtifact.locator),
              artifactPaths: result.bundle.artifacts.map(({ output, artifact }) => ({
                outputId: output.id,
                path: resolve(root, artifact.locator),
                hash: artifact.artifactHash,
              })),
            },
          };
    process.stdout.write(`${JSON.stringify(presented, null, 2)}\n`);
    process.exitCode = result.status === "eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Visual compilation did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

function oneOption(values: string[], name: string): string | undefined {
  if (values.length !== 2 || values[0] !== name || !values[1] || values[1].startsWith("--"))
    return undefined;
  return values[1];
}

function exactOptions(values: string[], names: readonly string[]): Map<string, string> | undefined {
  if (values.length !== names.length * 2) return undefined;
  const allowed = new Set(names);
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name || !value || !allowed.has(name) || value.startsWith("--") || result.has(name))
      return undefined;
    result.set(name, value);
  }
  return result.size === names.length ? result : undefined;
}

async function writeCanonicalJson(pathValue: string, value: unknown): Promise<void> {
  const destination = resolve(pathValue);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
}

async function creatorAsset(values: string[]): Promise<void> {
  const instructions =
    "Usage: forge creator asset doctor --installation <host-json> | prepare --request-file <json> --installation <host-json> --store <path> | run|status|fetch <job-id> --store <path> | reconcile <job-id> --output-sha256 <hash> --store <path> | preview <job-id> --output <absolute.html> --store <path> | review <job-id> --lock-hash <hash> --store <path>\n";
  const [operation, ...rest] = values;
  if (
    !operation ||
    !["doctor", "prepare", "run", "status", "fetch", "reconcile", "review", "preview"].includes(
      operation,
    )
  ) {
    process.stderr.write(instructions);
    process.exitCode = 2;
    return;
  }
  const jobId = operation === "prepare" || operation === "doctor" ? undefined : rest.shift();
  const expected =
    operation === "doctor"
      ? ["--installation"]
      : operation === "prepare"
        ? ["--request-file", "--installation", "--store"]
        : operation === "reconcile"
          ? ["--output-sha256", "--store"]
          : operation === "review"
            ? ["--lock-hash", "--store"]
            : operation === "preview"
              ? ["--output", "--store"]
              : ["--store"];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key || !value || value.startsWith("--") || !expected.includes(key) || options.has(key)) {
      process.stderr.write(instructions);
      process.exitCode = 2;
      return;
    }
    options.set(key, value);
  }
  if (options.size !== expected.length || (!["prepare", "doctor"].includes(operation) && !jobId)) {
    process.stderr.write(instructions);
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (operation === "doctor") {
      process.stdout.write(
        JSON.stringify(
          await probeCreatorCubeInstallation(
            await readCreatorAssetInput(options.get("--installation")!),
          ),
          null,
          2,
        ) + "\n",
      );
      return;
    }
    const jobs = new CreatorAssetJobs(resolve(options.get("--store")!));
    const result =
      operation === "prepare"
        ? await jobs.prepare(
            await readCreatorAssetInput(options.get("--request-file")!),
            await readCreatorAssetInput(options.get("--installation")!),
          )
        : operation === "run"
          ? await jobs.run(jobId!, controller.signal)
          : operation === "fetch"
            ? await jobs.fetch(jobId!, controller.signal)
            : operation === "reconcile"
              ? await jobs.reconcile(jobId!, options.get("--output-sha256")!)
              : operation === "review"
                ? await jobs.review(jobId!, options.get("--lock-hash")!)
                : operation === "preview"
                  ? await jobs.preview(jobId!, options.get("--output")!)
                  : await jobs.status(jobId!);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (["recovery_required", "dispatched", "failed", "queued", "running"].includes(result.status))
      process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Creator asset preparation failed: ${message(error)}\n`);
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function creatorServe(optionArgs: string[]): Promise<void> {
  const parsedOptions = parseCreatorServeOptions(optionArgs);
  if (!parsedOptions.valid) {
    process.stderr.write(
      "Usage: forge creator serve [--default-model <registered-model-id>] [--session-dir <path>] [--timeout-ms <ms>] [--control-port <port>] [--project-authority <manifest.json>]\n",
    );
    process.exitCode = 2;
    return;
  }
  const defaultModel = parsedOptions.defaultModel ?? DEFAULT_CREATOR_MODEL_ID;
  if (!isCreatorModelId(defaultModel)) {
    process.stderr.write(
      `Creator default model must be in registry ${CREATOR_MODEL_REGISTRY.hash}: ${CREATOR_MODEL_REGISTRY.models.map((entry) => entry.id).join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    await ensureOfficialSourceAnalysisToolchain(resolve(process.cwd()));
  } catch (error) {
    process.stderr.write(`Forge creator service did not start: ${message(error)}\n`);
    process.exitCode = 2;
    return;
  }
  let options;
  try {
    options = await loadCreatorServeOptions(parsedOptions);
  } catch (error) {
    process.stderr.write(`Creator serve configuration is invalid: ${message(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const bridge = new StudioBridgeServer();
  let coordinator: CreatorSessionCoordinator | undefined;
  let conversation: CreatorConversationCoordinator | undefined;
  let control: CreatorControlServer | undefined;
  let storeLease: CreatorStoreLease | undefined;
  let bridgeId: string | undefined;
  let controlId: string | undefined;
  try {
    const apiKey = loadOpenRouterApiKey();
    const modelCatalog = await new OpenRouterModelCatalogProbe({ apiKey }).probe();
    const runtime = new ForgeNativeAgentRuntime(
      new OpenRouterModelClient({ apiKey, modelCatalog }),
    );
    const directory = resolve(options.sessionDirectory ?? CREATOR_DEFAULT_STORE);
    const visualCompilerInstallation = await loadOptionalVisualCompilerInstallation();
    storeLease = await acquireCreatorStoreLease(directory);
    const sourceAnalysisHost = await PinnedSourceAnalysisHost.create({
      root: resolve(process.cwd()),
    });
    coordinator = new CreatorSessionCoordinator({
      connection: bridge,
      worker: new LocalCreatorAgentWorker(runtime, directory),
      directory,
      sourceAnalysisHost,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.projectAuthority ? { projectAuthority: options.projectAuthority.context } : {}),
    });
    await coordinator.initialize();
    conversation = new CreatorConversationCoordinator({
      transaction: coordinator,
      connection: bridge,
      directory,
      defaultModelId: defaultModel,
      modelCatalog,
      compactConversation: (input) => runtime.compact(input),
      ...(visualCompilerInstallation ? { visualCompilerInstallation } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    await conversation.initialize();
    control = new CreatorControlServer({
      coordinator: conversation,
      dashboardDirectory: resolve("dashboard/dist"),
      artifactRoot: directory,
      ...(options.controlPort ? { port: options.controlPort } : {}),
    });
    bridge.subscribe((messageValue) => {
      if (messageValue.type !== "Heartbeat")
        process.stdout.write(
          `\n[studio -> creator] ${messageValue.type}${messageValue.sessionId ? ` (${messageValue.sessionId})` : ""}\n`,
        );
    });
    const address = await bridge.listen();
    bridgeId = `bridge_${randomUUID()}`;
    await writeStudioBridgeDiscovery({
      kind: "ForgeStudioBridgeDiscovery",
      bridgeId,
      host: address.host,
      port: address.port,
      controlToken: address.controlToken,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const controlAddress = await control.listen();
    controlId = `creator_control_${randomUUID()}`;
    await writeCreatorControlDiscovery({
      kind: "ForgeCreatorControlDiscovery",
      controlId,
      host: controlAddress.host,
      port: controlAddress.port,
      bearerToken: controlAddress.bearerToken,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const launchUrl = control.createLaunchUrl(controlAddress.port);
    process.stdout.write(
      `Forge Studio bridge listening at http://${address.host}:${address.port}\nForge creator dashboard: ${launchUrl}\nThe launch URL is one-time and expires after five minutes. Studio pairs automatically; prompts, evidence, consent, and reports stay in the dashboard.\n`,
    );
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  } catch (error) {
    process.stderr.write(`Forge creator service did not start: ${message(error)}\n`);
    process.exitCode = 2;
  } finally {
    if (controlId) await removeCreatorControlDiscovery(controlId);
    if (bridgeId) await removeStudioBridgeDiscovery(bridgeId);
    await control?.close();
    await conversation?.close();
    coordinator?.close();
    await bridge.close();
    await storeLease?.release();
  }
}

async function loadOptionalVisualCompilerInstallation(): Promise<
  BlenderCompilerInstallation | undefined
> {
  const path = resolve(".forge/blender/installation-qualification-v2.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Visual compiler qualification must be a regular file");
    return BLENDER_COMPILER_INSTALLATION_SCHEMA.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function creatorStateCommand(
  conversationId: string | undefined,
  optionArgs: string[],
): Promise<void> {
  if (optionArgs.length > 0) {
    process.stderr.write("Usage: forge creator state [conversation-id]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await creatorState(conversationId), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Creator conversation state unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorVisualState(
  workflowId: string | undefined,
  optionArgs: string[],
): Promise<void> {
  if (!workflowId || optionArgs.length > 0) {
    process.stderr.write("Usage: forge creator visual-state <workflow-id>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const discovery = await readCreatorControlDiscovery();
    process.stdout.write(
      `${JSON.stringify(
        await creatorRequest(discovery, `/api/visual-workflows/${encodeURIComponent(workflowId)}`, {
          method: "GET",
        }),
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`Visual workflow state unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorVisualAction(
  inputPath: string | undefined,
  optionArgs: string[],
): Promise<void> {
  if (!inputPath || optionArgs.length > 0) {
    process.stderr.write("Usage: forge creator visual-act <action.json|->\n");
    process.exitCode = 2;
    return;
  }
  try {
    const text = inputPath === "-" ? await readStdin() : await readFile(resolve(inputPath), "utf8");
    const action = JSON.parse(text) as unknown;
    const discovery = await readCreatorControlDiscovery();
    process.stdout.write(
      `${JSON.stringify(
        await creatorRequest(discovery, "/api/control/visual-world", {
          method: "POST",
          body: JSON.stringify(action),
        }),
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`Visual workflow action failed: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorTurn(optionArgs: string[]): Promise<void> {
  const options = parseCreatorTurnCommandOptions(optionArgs);
  if (!options.valid || (options.prompt === undefined && options.promptPath === undefined)) {
    process.stderr.write(
      "Usage: forge creator turn [conversation-id] (--prompt <message> | --prompt-file <file-or->) [--model <registered-model-id>] [--kind new_work|clarification|plan_refinement|follow_up]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const stateValue = await creatorState(options.conversationId);
    assertCreatorDashboardState(stateValue);
    const state = stateValue as CreatorDashboardState;
    const text =
      options.prompt ??
      (options.promptPath === "-"
        ? await readStdin()
        : await readFile(resolve(options.promptPath!), "utf8"));
    const request = createCreatorTurnCommandRequest({
      state,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.turnKind ? { turnKind: options.turnKind } : {}),
      text,
      ...(options.model ? { selectedModelId: options.model } : {}),
      idempotencyKey: `creator_cli_turn_${randomUUID()}`,
    });
    process.stdout.write(
      `${JSON.stringify(await creatorRequestFromDiscovery("/api/control/turn", request), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Creator turn was not admitted: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorAction(
  conversationId: string | undefined,
  actionInstanceId: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const inputOptions = parseCreatorActionCommandOptions(optionArgs);
  if (!conversationId || !actionInstanceId || !inputOptions.valid) {
    process.stderr.write(
      "Usage: forge creator act <conversation-id> <action-instance-id> [--text <value> | --text-file <file-or-> | --report <value> | --report-file <file-or->] [--model <registered-model-id>] [--memory-item-id <id> --memory-revision-id <id> --memory-revision-hash <hash>] [--memory-category preference|convention|vocabulary|goal|unresolved]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const stateValue = await creatorState(conversationId);
    assertCreatorDashboardState(stateValue);
    const view = stateValue.controlView;
    if (!view || view.conversationId !== conversationId)
      throw new Error("Conversation has no current control view");
    const inputPath = inputOptions.textPath ?? inputOptions.reportPath;
    const fileText = inputPath
      ? inputPath === "-"
        ? await readStdin()
        : await readFile(resolve(inputPath), "utf8")
      : undefined;
    const commandInput = creatorActionCommandInput(inputOptions, fileText);
    const action = createCreatorActionCommandRequest({
      state: stateValue,
      conversationId,
      actionInstanceId,
      idempotencyKey: `creator_cli_action_${randomUUID()}`,
      ...(inputOptions.memoryItemId
        ? {
            memoryTarget: {
              itemId: inputOptions.memoryItemId,
              revisionId: inputOptions.memoryRevisionId!,
              revisionHash: inputOptions.memoryRevisionHash!,
            },
          }
        : {}),
      ...(inputOptions.memoryCategory ? { memoryCategory: inputOptions.memoryCategory } : {}),
      ...(inputOptions.model ? { selectedModelId: inputOptions.model } : {}),
      ...(commandInput ? { commandInput } : {}),
    });
    process.stdout.write(
      `${JSON.stringify(await creatorRequestFromDiscovery("/api/control/action", action), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Creator action was not admitted: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorReplayVerification(
  sessionId: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const options = parseCreatorReplayOptions(optionArgs);
  if (!sessionId || !options.valid) {
    process.stderr.write(
      "Usage: forge creator replay-verification <session-id> [--verification <id>] [--session-dir <path>]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const directory = resolve(options.sessionDirectory ?? CREATOR_DEFAULT_STORE);
    const bundle = await loadCreatorBundle(join(directory, `${sessionId}.json`));
    const verification = options.verificationId
      ? bundle.verifications.find((item) => item.id === options.verificationId)
      : bundle.verifications.at(-1);
    if (!verification) throw new Error("Creator verification evidence is missing");
    const replay = await replayCreatorVerification(
      bundle,
      verification,
      new ImmutableJsonArtifactStore(directory),
    );
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    process.exitCode = replay.result === "exact_match" ? 0 : replay.result === "mismatch" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Creator verification replay unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorReplayRegression(hash: string | undefined, args: string[]): Promise<void> {
  if (
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !(
      args.length === 0 ||
      (args.length === 2 && args[0] === "--session-dir" && args[1] && !args[1].startsWith("--"))
    )
  ) {
    process.stderr.write(
      "Usage: forge creator replay-regression <manifest-artifact-hash> [--session-dir <path>]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const store = new ImmutableJsonArtifactStore(resolve(args[1] ?? CREATOR_DEFAULT_STORE));
    const locator = `artifacts/${hash}.json`;
    const info = await lstat(join(store.root, locator));
    if (!info.isFile() || info.isSymbolicLink() || info.size > store.maxBytes)
      throw new Error("Regression manifest must be a bounded regular artifact");
    const replay = await replayCreatorOfflineRegression({
      store,
      artifact: { locator, artifactHash: hash, bytes: info.size },
    });
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    process.exitCode = replay.result === "exact_match" ? 0 : replay.result === "mismatch" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Creator regression replay unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorTimings(sessionId: string | undefined, args: string[]): Promise<void> {
  if (
    !sessionId ||
    !(
      args.length === 0 ||
      (args.length === 2 && args[0] === "--session-dir" && args[1] && !args[1].startsWith("--"))
    )
  ) {
    process.stderr.write("Usage: forge creator timings <session-id> [--session-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const report = await loadCreatorHostTimingReport(
      resolve(args[1] ?? CREATOR_DEFAULT_STORE),
      sessionId,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "available" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`Creator timings unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function creatorReplayMutation(
  sessionId: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const options = parseCreatorMutationReplayOptions(optionArgs);
  if (!sessionId || !options.valid) {
    process.stderr.write(
      "Usage: forge creator replay-mutation <session-id> [--attempt <id>] [--session-dir <path>]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const directory = resolve(options.sessionDirectory ?? CREATOR_DEFAULT_STORE);
    const bundle = await loadCreatorBundle(join(directory, `${sessionId}.json`));
    const rojoMutation = options.attemptId
      ? bundle.rojoSourceMutations.find((item) => item.attempt.id === options.attemptId)
      : bundle.rojoSourceMutations.at(-1);
    if (rojoMutation) {
      const store = new ImmutableJsonArtifactStore(directory);
      const [changeSet, sourceAttempt, proof, revert, revertProof] = await Promise.all([
        store.read(rojoMutation.changeSet.artifact, assertRojoSourceChangeSet),
        store.read(rojoMutation.attempt.artifact, assertRojoMutationAttempt),
        rojoMutation.syncProofs.at(-1)
          ? store.read(rojoMutation.syncProofs.at(-1)!.artifact, assertRojoSyncProof)
          : undefined,
        rojoMutation.revert
          ? store.read(rojoMutation.revert.artifact, assertRojoSourceRevert)
          : undefined,
        rojoMutation.revertSyncProofs.at(-1)
          ? store.read(
              rojoMutation.revertSyncProofs.at(-1)!.artifact,
              assertRojoSourceRevertSyncProof,
            )
          : undefined,
      ]);
      const replay = replayRojoMutation({
        changeSet,
        attempt: sourceAttempt,
        ...(proof ? { syncProof: proof } : {}),
        ...(revert ? { revert } : {}),
        ...(revertProof ? { revertSyncProof: revertProof } : {}),
      });
      process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
      process.exitCode = replay.status === "exact_match" ? 0 : replay.status === "mismatch" ? 1 : 2;
      return;
    }
    const attempt = options.attemptId
      ? bundle.mutationAttempts.find((item) => item.id === options.attemptId)
      : bundle.mutationAttempts.at(-1);
    if (!attempt) throw new Error("Creator mutation evidence is missing");
    const replay = await replayCreatorMutation(attempt, new ImmutableJsonArtifactStore(directory));
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    process.exitCode = replay.result === "exact_match" ? 0 : replay.result === "mismatch" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Creator mutation replay unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function experimentRegister(
  seedPath: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const options = parseExperimentRegisterOptions(optionArgs);
  if (
    !seedPath ||
    !options.valid ||
    !options.promptPath ||
    !options.requirementsPath ||
    !options.acceptancePath ||
    !options.definitionPath ||
    !options.configurationPath ||
    !options.model ||
    !options.outputPath
  ) {
    process.stderr.write(
      "Usage: forge experiment register <seed> --prompt-file <file> --requirements <requirement-set.json> --acceptance <acceptance-spec.json> --runtime-plan <runtime-eval-definition.json> --runtime-configuration <runtime-evaluator-configuration.json> --model <exact-model-id> --output <registration.json>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const [creatorPrompt, requirementsValue, acceptanceValue, definitionValue, configurationValue] =
      await Promise.all([
        readFile(resolve(options.promptPath), "utf8"),
        readJson(options.requirementsPath),
        readJson(options.acceptancePath),
        readJson(options.definitionPath),
        readJson(options.configurationPath),
      ]);
    assertRequirementSet(requirementsValue);
    assertAcceptanceSpec(acceptanceValue);
    assertAcceptanceSpecReferences(acceptanceValue, requirementsValue);
    assertRuntimeEvalDefinition(definitionValue);
    assertRuntimeEvaluatorConfiguration(configurationValue);
    const registration = await registerExperiment({
      repositoryRoot: process.cwd(),
      seedRoot: resolve(seedPath),
      name: options.name ?? "registered-experiment",
      hypothesis:
        options.hypothesis ??
        "A preregistered treatment can produce a locally eligible candidate and a separately graded Studio runtime outcome.",
      creatorPrompt: creatorPrompt.trim(),
      requirementSet: requirementsValue as RequirementSet,
      acceptanceSpec: acceptanceValue as AcceptanceSpec,
      runtimeEvalDefinition: definitionValue as RuntimeEvalDefinition,
      runtimeEvaluatorConfiguration: configurationValue as RuntimeEvaluatorConfiguration,
      runtime: {
        identity: FORGE_NATIVE_RUNTIME_IDENTITY,
        modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
      },
      model: options.model,
    });
    const persisted = await persistExperimentRegistration(registration, options.outputPath);
    process.stdout.write(
      `${JSON.stringify({ kind: "ForgeExperimentRegistration", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, artifact: persisted.path, seedHash: registration.seed.hash, harnessConfigurationId: registration.expected.harnessConfigurationId, harnessConfigurationHash: registration.expected.harnessConfigurationHash }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Experiment registration did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function experimentBuild(seedPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseExperimentBuildOptions(optionArgs);
  if (!seedPath || !options.valid || !options.registrationPath) {
    process.stderr.write(
      "Usage: forge experiment build <seed> --registration <registration.json> [--run-dir <path>] [--trace-dir <path>] [--format json]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const registration = await loadExperimentRegistration(options.registrationPath);
    const apiKey = loadOpenRouterApiKey();
    const runtime = new ForgeNativeAgentRuntime(new OpenRouterModelClient({ apiKey }));
    const result = await runRegisteredExperiment({
      registration,
      repositoryRoot: process.cwd(),
      seedRoot: resolve(seedPath),
      runtime,
      runDirectory: resolve(
        options.runDirectory ?? join(".forge/experiment-runs", registration.id),
      ),
      traceDirectory: resolve(options.traceDirectory ?? ".forge/flight-recorder"),
    });
    process.stdout.write(
      `${JSON.stringify({ kind: "ForgeExperimentBuildSummary", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, status: result.status, classification: result.classification, trialStarted: result.run.trialStarted, agentRunId: result.run.id, agentRunArtifact: result.persistence.path, ...(result.candidateArtifact ? { workspaceCandidateArtifactId: result.candidateArtifact.artifact.id, workspaceCandidateArtifact: result.candidateArtifact.persistence.path } : {}), buildTraceId: result.trace.id, finalVerifierTraceId: result.finalVerification.trace.id, finalGate: result.finalVerification.report.gate.status === "eligible" ? "locally_eligible" : result.finalVerification.report.gate.status, candidateRoot: result.candidateRoot, harnessConfigurationId: result.run.harnessConfigurationId, harnessConfigurationHash: result.run.harnessConfigurationHash, budgets: result.run.budgets }, null, 2)}\n`,
    );
    process.exitCode =
      result.status === "locally_eligible" ? 0 : result.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Registered experiment build did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function experimentEvaluate(
  artifactPath: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const options = parseExperimentEvaluateOptions(optionArgs);
  if (!artifactPath || !options.valid || !options.registrationPath) {
    process.stderr.write(
      "Usage: forge experiment evaluate <workspace-candidate-artifact.json> --registration <registration.json> [--timeout-ms <ms>] [--run-dir <path>] [--trace-dir <path>] [--proof-dir <path>] [--format json]\n",
    );
    process.exitCode = 2;
    return;
  }
  let bridge: StudioBridgeClient | undefined;
  try {
    const registration = await loadExperimentRegistration(options.registrationPath);
    const loaded = await loadWorkspaceCandidateArtifact(
      resolve(artifactPath),
      options.traceDirectory,
    );
    assertRegisteredCandidate(registration, loaded.artifact);
    await assertExperimentRegistrationCurrent(registration, {
      repositoryRoot: process.cwd(),
      seedRoot: loaded.artifact.seedRoot,
      runtime: {
        identity: FORGE_NATIVE_RUNTIME_IDENTITY,
        modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
      },
    });
    const definition = registration.artifacts.runtimeEvalDefinition;
    const configuration = registration.artifacts.runtimeEvaluatorConfiguration;
    const runDirectory = resolve(
      options.runDirectory ?? join(".forge/runtime-evaluations", registration.id),
    );
    const placePath = await prepareRojoPlace(
      loaded.candidateRoot,
      runDirectory,
      `${loaded.artifact.id}.rbxlx`,
    );
    printStudioSteps("registered experiment runtime evaluation", placePath);
    const discovery = await readStudioBridgeDiscovery();
    bridge = new StudioBridgeClient({
      host: discovery.host,
      port: discovery.port,
      controlToken: discovery.controlToken,
    });
    const timeoutMs = options.timeoutMs ?? 660_000;
    const session = await bridge.waitForSession(timeoutMs);
    const projectCapture = await requestStudioProjectIndex({
      connection: bridge,
      session,
      connectorEpoch: studioConnectorEpoch(session),
      timeoutMs,
    });
    assertCandidateLiveBinding(
      loaded.artifact.sourceFiles,
      studioProjectIndexView(projectCapture),
      definition.targets,
    );
    const executionPlan = createStudioExecutionPlan({
      purpose: "runtime_evaluation",
      binding: {
        runId: `runtime_run_${randomUUID()}`,
        correlationId: `runtime_correlation_${randomUUID()}`,
        sessionId: session.sessionId,
        projectId: session.projectId,
        project: session.project,
        projectRevisionHash: projectCapture.revision.hash,
        candidateHash: loaded.artifact.candidateHash,
      },
      targets: definition.targets,
      calls: definition.calls,
      budget: definition.budget,
      observationWindowMs: 0,
    });
    const agentRunId = loaded.artifact.origin.agentRunId;
    const runtimePlan = createRuntimeEvalPlan({
      definitionId: definition.id,
      definitionHash: definition.hash,
      candidateArtifactId: loaded.artifact.id,
      candidateArtifactHash: loaded.artifact.artifactHash,
      agentRunId,
      workspaceDeltaId: loaded.artifact.workspaceDelta.id,
      candidateHash: loaded.artifact.candidateHash,
      executionPlan,
    });
    const agentRun = await readJson(join(dirname(resolve(artifactPath)), `${agentRunId}.json`));
    if (!isRecord(agentRun) || typeof agentRun.creatorPromptHash !== "string")
      throw new Error(
        "Runtime proof requires the sealed originating AgentRun beside its candidate artifact",
      );
    const outcome = await executeRuntimeEvaluation({
      connection: bridge,
      session,
      runtimeEvalPlan: runtimePlan,
      definition,
      configuration,
      timeoutMs,
      ...(options.traceDirectory ? { traceDirectory: resolve(options.traceDirectory) } : {}),
      ...(options.proofDirectory ? { proofDirectory: resolve(options.proofDirectory) } : {}),
      proofInput: {
        creatorPromptHash: agentRun.creatorPromptHash,
        experimentRegistrationId: registration.id,
        experimentRegistrationHash: registration.hash,
        requirementSetId: registration.artifacts.requirementSet.id,
        requirementViewId: loaded.artifact.requirementViewId,
        evaluatorViewId: registration.artifacts.evaluatorViewId,
        harnessConfigurationId: loaded.artifact.harnessConfigurationId,
        harnessConfigurationHash: loaded.artifact.harnessConfigurationHash,
        agentRunId,
        workspaceCandidateArtifactId: loaded.artifact.id,
        workspaceCandidateArtifactHash: loaded.artifact.artifactHash,
        seedHash: loaded.artifact.seedHash,
        candidateHash: loaded.artifact.candidateHash,
        workspaceDeltaId: loaded.artifact.workspaceDelta.id,
        localVerificationReportHash: loaded.artifact.localGate.reportHash,
        localVerificationTraceId: loaded.artifact.localGate.traceId,
        runtimeEvalDefinitionId: definition.id,
        runtimeEvalDefinitionHash: definition.hash,
        runtimeEvalPlanId: runtimePlan.id,
        runtimeEvalPlanHash: runtimePlan.hash,
        studioManifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        runtimeEvaluatorConfigurationId: configuration.id,
        runtimeEvaluatorConfigurationHash: configuration.hash,
        scope: "exact_runtime_definition_manifest_projection_configuration_authoritative_run",
      },
    });
    await persistPrivateRun(outcome.run, runDirectory);
    process.stdout.write(
      `${JSON.stringify({ kind: "ForgeExperimentRuntimeEvaluation", experimentRegistrationId: registration.id, experimentRegistrationHash: registration.hash, status: outcome.run.status, meaning: "runtime_verified means only that this exact registered candidate satisfied this exact RuntimeEvalDefinition under this exact manifest-bound evidence projection and RuntimeEvaluatorConfiguration in this authoritative Studio run.", runtimeEvaluationRunId: outcome.run.id, runtimeEvalPlanId: runtimePlan.id, runtimeProofBundleId: outcome.proof?.id, traceId: outcome.trace.id }, null, 2)}\n`,
    );
    process.exitCode =
      outcome.run.status === "runtime_verified" ? 0 : outcome.run.status === "rejected" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Registered experiment evaluation did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  } finally {
    await bridge?.close();
  }
}

async function studioApiStatus(optionArgs: string[]): Promise<void> {
  if (optionArgs.length > 0) {
    process.stderr.write("Usage: forge studio api-status\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...studioCatalogSummary(),
          kind: "ForgeStudioApiStatus",
          attestation: {
            status: "not_available",
            detail:
              "This offline command reads pinned Forge evidence only; pair a Studio connector through creator serve to inspect a live attestation.",
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`Studio API status unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function studioCapabilities(optionArgs: string[]): Promise<void> {
  const options = parseStudioCapabilitiesOptions(optionArgs);
  if (!options.valid) {
    process.stderr.write(
      "Usage: forge studio capabilities [--class <RobloxClass>] [--query <text>]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const entries = [] as ReturnType<typeof studioCapabilityExplorerPage>["entries"][number][];
    let cursor = 0;
    do {
      const page = studioCapabilityExplorerPage({
        ...(options.className ? { className: options.className } : {}),
        ...(options.query ? { query: options.query } : {}),
        cursor,
        limit: 100,
      });
      entries.push(...page.entries);
      if (page.page.nextCursor === undefined) break;
      cursor = page.page.nextCursor;
    } while (true);
    const summary = studioCatalogSummary();
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "ForgeStudioCapabilities",
          catalog: summary.catalog,
          coverage: summary.coverage,
          manifest: summary.manifest,
          selection: {
            ...(options.className ? { className: options.className } : {}),
            ...(options.query ? { query: options.query } : {}),
          },
          entries,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`Studio capability exploration unavailable: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function studioCapabilityCanary(
  seedPath: string | undefined,
  optionArgs: string[],
): Promise<void> {
  const options = parseStudioCanaryOptions(optionArgs);
  if (!seedPath || !options.valid || !options.planPath) {
    process.stderr.write(
      "Usage: forge studio canary <seed> --plan <capability-canary-template.json> [--timeout-ms <ms>] [--run-dir <path>] [--format json]\n",
    );
    process.exitCode = 2;
    return;
  }
  let bridge: StudioBridgeClient | undefined;
  try {
    const template = await readJson(options.planPath);
    if (!isRecord(template))
      throw new Error("Invalid task-owned Studio capability canary template");
    const targets = template.targets as StudioRuntimeTarget[];
    const calls = template.calls as StudioCapabilityCall[];
    const budget = template.budget as StudioExecutionBudget;
    const staticTargetIds = template.staticTargetIds;
    if (
      template.kind !== "StudioCapabilityCanaryTemplate" ||
      template.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
      !Array.isArray(targets) ||
      !Array.isArray(calls) ||
      !budget ||
      !Array.isArray(staticTargetIds) ||
      staticTargetIds.length === 0 ||
      staticTargetIds.some((id) => typeof id !== "string") ||
      new Set(staticTargetIds).size !== staticTargetIds.length
    )
      throw new Error("Invalid task-owned Studio capability canary template");
    const runDirectory = resolve(options.runDirectory ?? ".forge/studio-canaries");
    const placePath = await prepareRojoPlace(
      resolve(seedPath),
      runDirectory,
      "studio-capability-canary.rbxlx",
    );
    printStudioSteps("non-evaluative capability canary", placePath);
    const discovery = await readStudioBridgeDiscovery();
    bridge = new StudioBridgeClient({
      host: discovery.host,
      port: discovery.port,
      controlToken: discovery.controlToken,
    });
    const timeoutMs = options.timeoutMs ?? 660_000;
    const session = await bridge.waitForSession(timeoutMs);
    const projectCapture = await requestStudioProjectIndex({
      connection: bridge,
      session,
      connectorEpoch: studioConnectorEpoch(session),
      timeoutMs,
    });
    const plan = createStudioExecutionPlan({
      purpose: "capability_canary",
      binding: {
        runId: `capability_canary_${randomUUID()}`,
        correlationId: `canary_correlation_${randomUUID()}`,
        sessionId: session.sessionId,
        projectId: session.projectId,
        project: session.project,
        projectRevisionHash: projectCapture.revision.hash,
      },
      targets,
      calls,
      budget,
      observationWindowMs: 0,
    });
    const result = await executeStudioCapabilityCanary({
      connection: bridge,
      session,
      executionPlan: plan,
      prePlayCapture: projectCapture,
      staticTargetIds: staticTargetIds as string[],
      timeoutMs,
    });
    await persistPrivateRun(result, runDirectory);
    process.stdout.write(
      `${JSON.stringify({ kind: result.kind, status: result.status, id: result.id, executionPlanId: plan.id, note: "Non-evaluative transport and static-position-integrity characterization only; no candidate verdict, RuntimeEvalDefinition, RuntimeProofBundle, or benchmark result exists." }, null, 2)}\n`,
    );
    process.exitCode = result.status === "completed" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`Studio capability canary did not complete: ${message(error)}\n`);
    process.exitCode = 2;
  } finally {
    await bridge?.close();
  }
}

async function verify(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseSimpleTraceOptions(optionArgs);
  if (!projectPath || !options.valid) {
    process.stderr.write(
      "Usage: forge verify <project-path> [--format json] [--trace-dir <path>]\n",
    );
    process.exitCode = 2;
    return;
  }
  const run = await verifyProject(resolve(projectPath), {
    ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}),
  });
  process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  if (run.tracePersistence.status === "written")
    process.stderr.write(
      `Forge trace: ${run.tracePersistence.traceId} (${run.tracePersistence.locator ?? "local JSON"})\n`,
    );
  process.exitCode =
    run.report.gate.status === "eligible" ? 0 : run.report.gate.status === "rejected" ? 1 : 2;
}

async function showTrace(traceId: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseSimpleTraceOptions(optionArgs);
  if (!traceId || !options.valid) {
    process.stderr.write("Usage: forge trace show <trace-id> [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(
      `${JSON.stringify(await new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory()).read(traceId), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Unable to read trace ${traceId}: ${message(error)}\n`);
    process.exitCode = 2;
  }
}

async function studioBridge(optionArgs: string[]): Promise<void> {
  if (optionArgs.length > 0) {
    process.stderr.write("Usage: forge studio bridge\n");
    process.exitCode = 2;
    return;
  }
  const bridge = new StudioBridgeServer();
  bridge.subscribe((messageValue) => {
    if (messageValue.type !== "Heartbeat")
      process.stdout.write(
        `\n[studio -> forge] ${messageValue.type}${messageValue.sessionId ? ` (${messageValue.sessionId})` : ""}\n${JSON.stringify(messageValue, null, 2)}\n`,
      );
  });
  const address = await bridge.listen();
  const discovery = {
    kind: "ForgeStudioBridgeDiscovery" as const,
    bridgeId: `bridge_${randomUUID()}`,
    host: address.host,
    port: address.port,
    controlToken: address.controlToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeStudioBridgeDiscovery(discovery);
  process.stdout.write(
    `Forge Studio bridge listening at http://${address.host}:${address.port}\nThe Forge Studio connector will pair automatically.\n`,
  );
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}
async function prepareRojoPlace(
  projectRoot: string,
  directory: string,
  name: string,
): Promise<string> {
  const destinationDirectory = resolve(directory, "places");
  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, name);
  await execFile(
    "rojo",
    ["build", resolve(projectRoot, "default.project.json"), "-o", destination],
    { timeout: 60_000 },
  );
  return destination;
}
function printStudioSteps(label: string, placePath: string): void {
  process.stdout.write(
    `Prepared ${label}.\nPlace: ${placePath}\nStudio steps:\n1. Keep \`forge studio bridge\` running in a separate terminal.\n2. Open the exact place above in Roblox Studio.\n3. Install or reload the Forge Studio connector and allow local HTTP/script injection when prompted.\n4. Wait for the connector to pair.\n5. Click \"Evaluate in Studio\" after Forge arms the plan.\n`,
  );
}
function studioConnectorEpoch(session: StudioBridgeSession): string {
  return createStudioConnectorEpoch({
    sessionId: session.sessionId,
    projectId: session.projectId,
    connectorBuildHash: session.connectorBuildHash,
  });
}
function assertCandidateLiveBinding(
  sourceFiles: readonly {
    readonly path: string;
    readonly sourceHash: string;
  }[],
  observation: {
    readonly instances: readonly {
      readonly path: string;
      readonly className: string;
    }[];
    readonly scripts: readonly { readonly sourceHash: string }[];
  },
  targets: readonly StudioRuntimeTarget[],
): void {
  for (const target of targets)
    if (
      !observation.instances.some(
        (instance) =>
          instance.path === target.path &&
          [
            "Part",
            "MeshPart",
            "UnionOperation",
            "TrussPart",
            "Seat",
            "VehicleSeat",
            "WedgePart",
            "CornerWedgePart",
          ].includes(instance.className),
      )
    )
      throw new Error(`Live Studio candidate is missing required BasePart target ${target.path}`);
  for (const source of sourceFiles)
    if (!observation.scripts.some((script) => script.sourceHash === source.sourceHash))
      throw new Error(
        `Live Studio candidate source binding is missing sealed source hash for ${source.path}`,
      );
}
async function persistPrivateRun(
  run: RuntimeEvaluationRun | StudioCapabilityCanaryRun,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${run.id}.json`);
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(run)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function loadOpenRouterApiKey(): string {
  const value = process.env.OPENROUTER_API_KEY;
  if (value) return value;
  throw new Error("OPENROUTER_API_KEY is required in the process environment or root .env");
}

/**
 * Local operator credentials belong in the ignored root `.env`. Explicit process
 * environment values always win, so CI and shell-provided secrets are never replaced.
 */
function loadRootEnvironment(): void {
  try {
    const source = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      const name = match?.[1];
      const rawValue = match?.[2];
      if (!name || rawValue === undefined || process.env[name] !== undefined) continue;
      const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
      if (value) process.env[name] = value;
    }
  } catch {
    /* Root .env is optional when the process environment is configured. */
  }
}

function parseSimpleTraceOptions(values: string[]): {
  valid: boolean;
  traceDirectory?: string;
} {
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--format" && next === "json") {
      index += 1;
      continue;
    }
    if (option === "--trace-dir" && next) {
      traceDirectory = next;
      index += 1;
      continue;
    }
    return { valid: false };
  }
  return { valid: true, ...(traceDirectory ? { traceDirectory } : {}) };
}
function parseCreatorReplayOptions(values: string[]): {
  valid: boolean;
  verificationId?: string;
  sessionDirectory?: string;
} {
  let verificationId: string | undefined;
  let sessionDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--verification" && next) verificationId = next;
    else if (option === "--session-dir" && next) sessionDirectory = next;
    else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(verificationId ? { verificationId } : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
  };
}
function parseCreatorMutationReplayOptions(values: string[]): {
  valid: boolean;
  attemptId?: string;
  sessionDirectory?: string;
} {
  let attemptId: string | undefined;
  let sessionDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--attempt" && next) attemptId = next;
    else if (option === "--session-dir" && next) sessionDirectory = next;
    else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(attemptId ? { attemptId } : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
  };
}
async function creatorRequestFromDiscovery(
  path: string,
  body: unknown,
): Promise<CreatorWorkAdmission> {
  const discovery = await readCreatorControlDiscovery();
  if (path !== "/api/control/turn" && path !== "/api/control/action")
    throw new Error("Invalid creator work endpoint");
  return submitCreatorControlWork(discovery, path, body);
}

async function creatorState(conversationId?: string): Promise<unknown> {
  const discovery = await readCreatorControlDiscovery();
  return creatorRequest(
    discovery,
    `/api/control/state${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`,
    { method: "GET" },
  );
}
async function creatorRequest(
  discovery: Awaited<ReturnType<typeof readCreatorControlDiscovery>>,
  path: string,
  input: { method: "GET" | "POST"; body?: string },
): Promise<unknown> {
  const response = await fetch(`http://${discovery.host}:${discovery.port}${path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${discovery.bearerToken}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    ...(input.body ? { body: input.body } : {}),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : `Creator service returned HTTP ${response.status}`,
    );
  return payload;
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function parseExperimentRegisterOptions(values: string[]): {
  valid: boolean;
  promptPath?: string;
  requirementsPath?: string;
  acceptancePath?: string;
  definitionPath?: string;
  configurationPath?: string;
  model?: string;
  outputPath?: string;
  name?: string;
  hypothesis?: string;
} {
  let promptPath: string | undefined;
  let requirementsPath: string | undefined;
  let acceptancePath: string | undefined;
  let definitionPath: string | undefined;
  let configurationPath: string | undefined;
  let model: string | undefined;
  let outputPath: string | undefined;
  let name: string | undefined;
  let hypothesis: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--prompt-file" && next) promptPath = next;
    else if (option === "--requirements" && next) requirementsPath = next;
    else if (option === "--acceptance" && next) acceptancePath = next;
    else if (option === "--runtime-plan" && next) definitionPath = next;
    else if (option === "--runtime-configuration" && next) configurationPath = next;
    else if (option === "--model" && next) model = next;
    else if (option === "--output" && next) outputPath = next;
    else if (option === "--name" && next) name = next;
    else if (option === "--hypothesis" && next) hypothesis = next;
    else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(promptPath ? { promptPath } : {}),
    ...(requirementsPath ? { requirementsPath } : {}),
    ...(acceptancePath ? { acceptancePath } : {}),
    ...(definitionPath ? { definitionPath } : {}),
    ...(configurationPath ? { configurationPath } : {}),
    ...(model ? { model } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(name ? { name } : {}),
    ...(hypothesis ? { hypothesis } : {}),
  };
}
function parseExperimentBuildOptions(values: string[]): {
  valid: boolean;
  registrationPath?: string;
  runDirectory?: string;
  traceDirectory?: string;
} {
  let registrationPath: string | undefined;
  let runDirectory: string | undefined;
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--registration" && next) registrationPath = next;
    else if (option === "--run-dir" && next) runDirectory = next;
    else if (option === "--trace-dir" && next) traceDirectory = next;
    else if (option === "--format" && next === "json") {
      index += 1;
      continue;
    } else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(registrationPath ? { registrationPath } : {}),
    ...(runDirectory ? { runDirectory } : {}),
    ...(traceDirectory ? { traceDirectory } : {}),
  };
}
function parseExperimentEvaluateOptions(values: string[]): {
  valid: boolean;
  registrationPath?: string;
  timeoutMs?: number;
  runDirectory?: string;
  traceDirectory?: string;
  proofDirectory?: string;
} {
  let registrationPath: string | undefined;
  let timeoutMs: number | undefined;
  let runDirectory: string | undefined;
  let traceDirectory: string | undefined;
  let proofDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--registration" && next) registrationPath = next;
    else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next);
    else if (option === "--run-dir" && next) runDirectory = next;
    else if (option === "--trace-dir" && next) traceDirectory = next;
    else if (option === "--proof-dir" && next) proofDirectory = next;
    else if (option === "--format" && next === "json") {
      index += 1;
      continue;
    } else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(registrationPath ? { registrationPath } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(runDirectory ? { runDirectory } : {}),
    ...(traceDirectory ? { traceDirectory } : {}),
    ...(proofDirectory ? { proofDirectory } : {}),
  };
}
function parseStudioCapabilitiesOptions(values: string[]): {
  valid: boolean;
  className?: string;
  query?: string;
} {
  let className: string | undefined;
  let query: string | undefined;
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || (flag !== "--class" && flag !== "--query")) return { valid: false };
    if (flag === "--class") {
      if (className !== undefined) return { valid: false };
      className = value;
    } else {
      if (query !== undefined) return { valid: false };
      query = value;
    }
  }
  return {
    valid: true,
    ...(className !== undefined ? { className } : {}),
    ...(query !== undefined ? { query } : {}),
  };
}
function parseStudioCanaryOptions(values: string[]): {
  valid: boolean;
  planPath?: string;
  timeoutMs?: number;
  runDirectory?: string;
} {
  let planPath: string | undefined;
  let timeoutMs: number | undefined;
  let runDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--plan" && next) planPath = next;
    else if (option === "--timeout-ms" && next && /^\d+$/.test(next)) timeoutMs = Number(next);
    else if (option === "--run-dir" && next) runDirectory = next;
    else if (option === "--format" && next === "json") {
      index += 1;
      continue;
    } else return { valid: false };
    index += 1;
  }
  return {
    valid: true,
    ...(planPath ? { planPath } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(runDirectory ? { runDirectory } : {}),
  };
}
function usage(): void {
  process.stdout.write(
    `Forge commands:\n  forge creator serve [--default-model <registered-model-id>]\n  forge creator state [conversation-id]\n  forge creator visual-state <workflow-id>\n  forge creator visual-act <action.json|->\n  forge creator turn [conversation-id] (--prompt <message> | --prompt-file <file-or->) [--model <registered-model-id>] [--kind <turn-kind>]\n  forge creator act <conversation-id> <action-instance-id> [--text <value> | --text-file <file-or-> | --report <value> | --report-file <file-or->] [--model <registered-model-id>] [--memory-item-id <id> --memory-revision-id <id> --memory-revision-hash <hash>] [--memory-category <category>]\n  forge creator replay-verification <session-id> [--verification <id>] [--session-dir <path>]\n  forge creator replay-mutation <session-id> [--attempt <id>] [--session-dir <path>]\n  forge creator replay-regression <manifest-artifact-hash> [--session-dir <path>]\n  forge creator timings <session-id> [--session-dir <path>]\n  forge creator asset doctor --installation <host-json>\n  forge creator asset prepare --request-file <json> --installation <host-json> --store <path>\n  forge creator asset run|status|fetch <job-id> --store <path>\n  forge creator asset reconcile <job-id> --output-sha256 <hash> --store <path>\n  forge creator asset preview <job-id> --output <absolute.html> --store <path>\n  forge creator asset review <job-id> --lock-hash <hash> --store <path>\n  forge experiment register <seed> --prompt-file <file> --requirements <file> --acceptance <file> --runtime-plan <file> --runtime-configuration <file> --model <exact-model-id> --output <registration.json>\n  forge experiment build <seed> --registration <registration.json>\n  forge experiment evaluate <artifact> --registration <registration.json>\n  forge studio api-status\n  forge studio capabilities [--class <RobloxClass>] [--query <text>]\n  forge studio canary <seed> --plan <file>\n  forge studio bridge\n  forge visual solve <scene-intent.json> --output <scene-spec.json>\n  forge visual blender-qualify --distribution <blender.dmg> --application <Blender.app> --output <installation.json>\n  forge visual blender-status --installation <installation.json>\n  forge visual compile <scene-spec.json> --installation <installation.json> --store <directory> --source-root <directory> --sources <source-list.json>\n  forge verify <project>\n  forge trace show <trace-id>\n`,
  );
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
void main();
