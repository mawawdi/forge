import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  FORGE_NATIVE_RUNTIME_IDENTITY,
  INITIAL_EXPERIMENT_BUDGETS,
  orderedToolDescriptionsHash,
  prepareAgentBuild,
  runBoundedAgent,
  type AgentBuildResult,
  type AgentRuntime,
  type BudgetPolicy,
  type ExperimentRegistrationBinding,
  type WorkspaceCandidateArtifact
} from "../../agent-runtime/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertRuntimeEvalDefinition,
  assertRuntimeEvaluatorConfiguration,
  STUDIO_CAPABILITY_SET,
  type RuntimeEvalDefinition,
  type RuntimeEvaluatorConfiguration
} from "../../studio-capabilities/src/index.js";
import {
  assertAcceptanceSpec,
  assertAcceptanceSpecReferences,
  assertRequirementSet,
  resolveRequirementView,
  type AcceptanceSpec,
  type RequirementSet
} from "../../semantic-authority/src/index.js";

export interface ImplementationSnapshot {
  kind: "ForgeImplementationSnapshot";
  schemaVersion: 1;
  hash: string;
  files: Array<{ path: string; hash: string }>;
}

export interface ExperimentRegistration {
  kind: "ExperimentRegistration";
  schemaVersion: 1;
  id: string;
  hash: string;
  name: string;
  hypothesis: string;
  creatorPrompt: string;
  creatorPromptHash: string;
  environment: "benchmark";
  model: { transport: string; name: string; clientVersion: string; transportConfiguration: AgentRuntime["modelClientDescriptor"]["configuration"] };
  budgets: BudgetPolicy;
  implementation: ImplementationSnapshot;
  seed: { hash: string; sourceRoots: string[] };
  artifacts: {
    requirementSet: RequirementSet;
    requirementSetHash: string;
    builderViewId: string;
    builderViewHash: string;
    evaluatorViewId: string;
    evaluatorViewHash: string;
    acceptanceSpec: AcceptanceSpec;
    acceptanceSpecHash: string;
    runtimeEvalDefinition: RuntimeEvalDefinition;
    runtimeEvaluatorConfiguration: RuntimeEvaluatorConfiguration;
  };
  expected: ExperimentRegistrationBinding["expected"];
  studio: { capabilitySetId: string; capabilitySetHash: string; protocolVersion: 12; pluginVersion: "forge-studio-plugin-8.0.0" };
  policy: { providerAdmission: "single_valid_provider_envelope_v1"; studioAdmission: "single_runtime_start_v1"; execution: "creator_triggered_play_solo_v1" };
}

export interface RegisterExperimentInput {
  repositoryRoot: string;
  seedRoot: string;
  name: string;
  hypothesis: string;
  creatorPrompt: string;
  requirementSet: RequirementSet;
  acceptanceSpec: AcceptanceSpec;
  runtimeEvalDefinition: RuntimeEvalDefinition;
  runtimeEvaluatorConfiguration: RuntimeEvaluatorConfiguration;
  runtime: Pick<AgentRuntime, "identity" | "modelClientDescriptor">;
  model: string;
  budgets?: BudgetPolicy;
}

export interface RegisteredExperimentRunInput {
  registration: ExperimentRegistration;
  repositoryRoot: string;
  seedRoot: string;
  runtime: AgentRuntime;
  runDirectory: string;
  traceDirectory: string;
}

export async function registerExperiment(input: RegisterExperimentInput): Promise<ExperimentRegistration> {
  assertRegistrationInput(input);
  const budgets = { ...(input.budgets ?? INITIAL_EXPERIMENT_BUDGETS) };
  const temporary = await mkdtemp(join(tmpdir(), "forge-experiment-registration-"));
  try {
    const prepared = await prepareAgentBuild({
      seedRoot: input.seedRoot,
      creatorPrompt: input.creatorPrompt,
      requirementSet: input.requirementSet,
      runtime: input.runtime as AgentRuntime,
      model: input.model,
      runDirectory: temporary,
      traceDirectory: temporary,
      environment: "benchmark",
      budgets
    });
    const builderView = prepared.requirementView;
    const evaluatorView = resolveRequirementView(input.requirementSet, { phase: "evaluate", environment: "benchmark", audience: "evaluator" });
    if (input.runtimeEvalDefinition.requirementSetId !== input.requirementSet.id || input.runtimeEvalDefinition.evaluatorViewId !== evaluatorView.id || input.runtimeEvalDefinition.evaluatorViewHash !== contentHash(stableJson(evaluatorView)) || input.runtimeEvalDefinition.acceptanceSpecId !== input.acceptanceSpec.id) throw new Error("Runtime evaluator definition does not bind the registered task artifacts");
    if (input.runtimeEvaluatorConfiguration.runtimeEvalDefinitionId !== input.runtimeEvalDefinition.id || input.runtimeEvaluatorConfiguration.runtimeEvalDefinitionHash !== input.runtimeEvalDefinition.hash) throw new Error("Runtime evaluator configuration does not bind the registered definition");
    const payload: Omit<ExperimentRegistration, "kind" | "schemaVersion" | "id" | "hash"> = {
      name: input.name,
      hypothesis: input.hypothesis,
      creatorPrompt: input.creatorPrompt,
      creatorPromptHash: contentHash(input.creatorPrompt),
      environment: "benchmark",
      model: {
        transport: input.runtime.modelClientDescriptor.transport,
        name: input.model,
        clientVersion: input.runtime.modelClientDescriptor.version,
        transportConfiguration: input.runtime.modelClientDescriptor.configuration
      },
      budgets,
      implementation: await createImplementationSnapshot(input.repositoryRoot),
      seed: { hash: prepared.workspace.seedTreeHash, sourceRoots: [...prepared.workspace.sourceRoots] },
      artifacts: {
        requirementSet: input.requirementSet,
        requirementSetHash: contentHash(stableJson(input.requirementSet)),
        builderViewId: builderView.id,
        builderViewHash: contentHash(stableJson(builderView)),
        evaluatorViewId: evaluatorView.id,
        evaluatorViewHash: contentHash(stableJson(evaluatorView)),
        acceptanceSpec: input.acceptanceSpec,
        acceptanceSpecHash: contentHash(stableJson(input.acceptanceSpec)),
        runtimeEvalDefinition: input.runtimeEvalDefinition,
        runtimeEvaluatorConfiguration: input.runtimeEvaluatorConfiguration
      },
      expected: {
        seedHash: prepared.workspace.seedTreeHash,
        sourceRoots: [...prepared.workspace.sourceRoots],
        orientationId: prepared.orientation.id,
        orientationContentHash: prepared.orientation.contentHash,
        toolDescriptionsHash: orderedToolDescriptionsHash(prepared.toolHost.definitions()),
        harnessConfigurationId: prepared.configuration.id,
        harnessConfigurationHash: prepared.configuration.hash
      },
      studio: { capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, protocolVersion: 12, pluginVersion: "forge-studio-plugin-8.0.0" },
      policy: { providerAdmission: "single_valid_provider_envelope_v1", studioAdmission: "single_runtime_start_v1", execution: "creator_triggered_play_solo_v1" }
    };
    return createExperimentRegistration(payload);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function createExperimentRegistration(input: Omit<ExperimentRegistration, "kind" | "schemaVersion" | "id" | "hash">): ExperimentRegistration {
  const canonical = canonicalRegistration(input);
  const hash = contentHash(stableJson(canonical));
  const registration: ExperimentRegistration = { kind: "ExperimentRegistration", schemaVersion: 1, id: `experiment_registration_${hash.slice(0, 24)}`, hash, ...canonical };
  assertExperimentRegistration(registration);
  return registration;
}

export function assertExperimentRegistration(value: unknown): asserts value is ExperimentRegistration {
  if (!isRecord(value) || value.kind !== "ExperimentRegistration" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !isNonEmpty(value.name) || !isNonEmpty(value.hypothesis) || !isNonEmpty(value.creatorPrompt) || !isHash(value.creatorPromptHash) || value.creatorPromptHash !== contentHash(value.creatorPrompt) || value.environment !== "benchmark" || !isRecord(value.model) || !isRecord(value.budgets) || !isRecord(value.implementation) || !isRecord(value.seed) || !isRecord(value.artifacts) || !isRecord(value.expected) || !isRecord(value.studio) || !isRecord(value.policy)) throw new Error("Invalid ExperimentRegistration");
  assertRequirementSet(value.artifacts.requirementSet);
  assertAcceptanceSpec(value.artifacts.acceptanceSpec);
  assertAcceptanceSpecReferences(value.artifacts.acceptanceSpec, value.artifacts.requirementSet);
  assertRuntimeEvalDefinition(value.artifacts.runtimeEvalDefinition);
  assertRuntimeEvaluatorConfiguration(value.artifacts.runtimeEvaluatorConfiguration);
  assertImplementationSnapshot(value.implementation);
  if (value.artifacts.requirementSetHash !== contentHash(stableJson(value.artifacts.requirementSet)) || value.artifacts.acceptanceSpecHash !== contentHash(stableJson(value.artifacts.acceptanceSpec))) throw new Error("ExperimentRegistration task artifact hash mismatch");
  const builder = resolveRequirementView(value.artifacts.requirementSet, { phase: "build", environment: "benchmark", audience: "builder" });
  const evaluator = resolveRequirementView(value.artifacts.requirementSet, { phase: "evaluate", environment: "benchmark", audience: "evaluator" });
  if (value.artifacts.builderViewId !== builder.id || value.artifacts.builderViewHash !== contentHash(stableJson(builder)) || value.artifacts.evaluatorViewId !== evaluator.id || value.artifacts.evaluatorViewHash !== contentHash(stableJson(evaluator))) throw new Error("ExperimentRegistration requirement-view identity mismatch");
  if (value.artifacts.runtimeEvalDefinition.requirementSetId !== value.artifacts.requirementSet.id || value.artifacts.runtimeEvalDefinition.evaluatorViewId !== evaluator.id || value.artifacts.runtimeEvalDefinition.evaluatorViewHash !== contentHash(stableJson(evaluator)) || value.artifacts.runtimeEvalDefinition.acceptanceSpecId !== value.artifacts.acceptanceSpec.id || value.artifacts.runtimeEvalDefinition.capabilitySetId !== STUDIO_CAPABILITY_SET.id || value.artifacts.runtimeEvalDefinition.capabilitySetHash !== STUDIO_CAPABILITY_SET.hash) throw new Error("ExperimentRegistration runtime definition mismatch");
  if (value.artifacts.runtimeEvaluatorConfiguration.runtimeEvalDefinitionId !== value.artifacts.runtimeEvalDefinition.id || value.artifacts.runtimeEvaluatorConfiguration.runtimeEvalDefinitionHash !== value.artifacts.runtimeEvalDefinition.hash) throw new Error("ExperimentRegistration evaluator configuration mismatch");
  if (!isHash(value.seed.hash) || !isCanonicalRoots(value.seed.sourceRoots) || stableJson(value.seed) !== stableJson({ hash: value.expected.seedHash, sourceRoots: value.expected.sourceRoots }) || !isExpected(value.expected) || value.studio.capabilitySetId !== STUDIO_CAPABILITY_SET.id || value.studio.capabilitySetHash !== STUDIO_CAPABILITY_SET.hash || value.studio.protocolVersion !== 12 || value.studio.pluginVersion !== "forge-studio-plugin-8.0.0" || value.policy.providerAdmission !== "single_valid_provider_envelope_v1" || value.policy.studioAdmission !== "single_runtime_start_v1" || value.policy.execution !== "creator_triggered_play_solo_v1") throw new Error("ExperimentRegistration treatment mismatch");
  if (!isModel(value.model) || stableJson(value).includes("OPENROUTER_API_KEY") || stableJson(value).includes("apiKey")) throw new Error("ExperimentRegistration must not contain secrets");
  const { kind: _kind, schemaVersion: _schemaVersion, id: _id, hash: _hash, ...payload } = value;
  const canonical = canonicalRegistration(payload as Omit<ExperimentRegistration, "kind" | "schemaVersion" | "id" | "hash">);
  const expectedHash = contentHash(stableJson(canonical));
  if (value.hash !== expectedHash || value.id !== `experiment_registration_${expectedHash.slice(0, 24)}`) throw new Error("Invalid ExperimentRegistration identity");
}

export async function assertExperimentRegistrationCurrent(registration: ExperimentRegistration, input: Omit<RegisterExperimentInput, "name" | "hypothesis" | "creatorPrompt" | "requirementSet" | "acceptanceSpec" | "runtimeEvalDefinition" | "runtimeEvaluatorConfiguration" | "model" | "budgets">): Promise<void> {
  assertExperimentRegistration(registration);
  const fresh = await registerExperiment({
    ...input,
    name: registration.name,
    hypothesis: registration.hypothesis,
    creatorPrompt: registration.creatorPrompt,
    requirementSet: registration.artifacts.requirementSet,
    acceptanceSpec: registration.artifacts.acceptanceSpec,
    runtimeEvalDefinition: registration.artifacts.runtimeEvalDefinition,
    runtimeEvaluatorConfiguration: registration.artifacts.runtimeEvaluatorConfiguration,
    model: registration.model.name,
    budgets: registration.budgets
  });
  if (fresh.hash !== registration.hash) throw new Error("ExperimentRegistration drift detected before external execution");
}

export async function runRegisteredExperiment(input: RegisteredExperimentRunInput): Promise<AgentBuildResult> {
  assertExperimentRegistration(input.registration);
  if (input.runtime.identity.name !== FORGE_NATIVE_RUNTIME_IDENTITY.name || input.runtime.identity.version !== FORGE_NATIVE_RUNTIME_IDENTITY.version || stableJson(input.runtime.modelClientDescriptor) !== stableJson({ transport: input.registration.model.transport, version: input.registration.model.clientVersion, configuration: input.registration.model.transportConfiguration })) throw new Error("Registered experiment runtime or transport configuration drifted");
  const current = { repositoryRoot: input.repositoryRoot, seedRoot: input.seedRoot, runtime: input.runtime };
  await assertExperimentRegistrationCurrent(input.registration, current);
  const binding: ExperimentRegistrationBinding = { id: input.registration.id, hash: input.registration.hash, expected: input.registration.expected };
  return runBoundedAgent({
    seedRoot: input.seedRoot,
    creatorPrompt: input.registration.creatorPrompt,
    requirementSet: input.registration.artifacts.requirementSet,
    runtime: input.runtime,
    model: input.registration.model.name,
    runDirectory: input.runDirectory,
    traceDirectory: input.traceDirectory,
    environment: "benchmark",
    budgets: input.registration.budgets,
    experiment: binding,
    beforeModelInvocation: async () => assertExperimentRegistrationCurrent(input.registration, current)
  });
}

export function assertRegisteredCandidate(registration: ExperimentRegistration, candidate: WorkspaceCandidateArtifact): void {
  assertExperimentRegistration(registration);
  if (candidate.origin.kind !== "registered_experiment" || candidate.origin.experimentRegistrationId !== registration.id || candidate.origin.experimentRegistrationHash !== registration.hash || candidate.requirementSetId !== registration.artifacts.requirementSet.id || candidate.requirementViewId !== registration.artifacts.builderViewId || candidate.harnessConfigurationId !== registration.expected.harnessConfigurationId || candidate.harnessConfigurationHash !== registration.expected.harnessConfigurationHash || candidate.seedHash !== registration.seed.hash) throw new Error("Candidate does not bind the supplied ExperimentRegistration");
}

export async function persistExperimentRegistration(registration: ExperimentRegistration, path: string): Promise<{ path: string; hash: string }> {
  assertExperimentRegistration(registration);
  const destination = resolve(path);
  const serialized = `${stableJson(registration)}\n`;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return { path: relative(process.cwd(), destination), hash: contentHash(serialized) };
}

export async function loadExperimentRegistration(path: string): Promise<ExperimentRegistration> {
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  assertExperimentRegistration(value);
  return value;
}

export async function createImplementationSnapshot(repositoryRoot: string): Promise<ImplementationSnapshot> {
  const root = resolve(repositoryRoot);
  const files: Array<{ path: string; hash: string }> = [];
  for (const path of ["bin/forge.js", "package.json", "package-lock.json", "tsconfig.json", "plugin/default.project.json"]) files.push(await hashFile(root, path));
  for (const directory of ["packages", "plugin/src"]) await collectImplementationFiles(root, directory, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = contentHash(stableJson(files));
  const snapshot: ImplementationSnapshot = { kind: "ForgeImplementationSnapshot", schemaVersion: 1, hash, files };
  assertImplementationSnapshot(snapshot);
  return snapshot;
}

function canonicalRegistration(input: Omit<ExperimentRegistration, "kind" | "schemaVersion" | "id" | "hash">): Omit<ExperimentRegistration, "kind" | "schemaVersion" | "id" | "hash"> {
  return {
    ...input,
    model: { ...input.model, transportConfiguration: structuredClone(input.model.transportConfiguration) },
    budgets: { ...input.budgets },
    implementation: { ...input.implementation, files: input.implementation.files.map((file) => ({ ...file })).sort((left, right) => left.path.localeCompare(right.path)) },
    seed: { hash: input.seed.hash, sourceRoots: [...input.seed.sourceRoots] },
    artifacts: { ...input.artifacts, requirementSet: structuredClone(input.artifacts.requirementSet), acceptanceSpec: structuredClone(input.artifacts.acceptanceSpec), runtimeEvalDefinition: structuredClone(input.artifacts.runtimeEvalDefinition), runtimeEvaluatorConfiguration: structuredClone(input.artifacts.runtimeEvaluatorConfiguration) },
    expected: { ...input.expected, sourceRoots: [...input.expected.sourceRoots] },
    studio: { ...input.studio },
    policy: { ...input.policy }
  };
}

function assertRegistrationInput(input: RegisterExperimentInput): void {
  if (!isNonEmpty(input.name) || !isNonEmpty(input.hypothesis) || !isNonEmpty(input.creatorPrompt) || input.model !== "openai/gpt-5.6-luna" || input.runtime.identity.name !== FORGE_NATIVE_RUNTIME_IDENTITY.name || input.runtime.identity.version !== FORGE_NATIVE_RUNTIME_IDENTITY.version) throw new Error("Invalid experiment registration input");
  assertRequirementSet(input.requirementSet);
  assertAcceptanceSpec(input.acceptanceSpec);
  assertAcceptanceSpecReferences(input.acceptanceSpec, input.requirementSet);
  assertRuntimeEvalDefinition(input.runtimeEvalDefinition);
  assertRuntimeEvaluatorConfiguration(input.runtimeEvaluatorConfiguration);
}

async function collectImplementationFiles(root: string, relativeDirectory: string, files: Array<{ path: string; hash: string }>): Promise<void> {
  const directory = resolve(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) await collectImplementationFiles(root, relativePath, files);
    else if (entry.isFile()) files.push(await hashFile(root, relativePath));
  }
}

async function hashFile(root: string, path: string): Promise<{ path: string; hash: string }> {
  if (!isSafeRelative(path)) throw new Error("Implementation manifest path is not canonical");
  return { path, hash: contentHash(await readFile(resolve(root, path), "utf8")) };
}

function assertImplementationSnapshot(value: unknown): asserts value is ImplementationSnapshot {
  if (!isRecord(value) || value.kind !== "ForgeImplementationSnapshot" || value.schemaVersion !== 1 || !isHash(value.hash) || !Array.isArray(value.files) || !value.files.every((file) => isRecord(file) && isSafeRelative(String(file.path)) && isHash(file.hash))) throw new Error("Invalid implementation snapshot");
  const files = value.files as Array<{ path: string; hash: string }>;
  if (new Set(files.map((file) => file.path)).size !== files.length || files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0) || value.hash !== contentHash(stableJson(files))) throw new Error("Invalid implementation snapshot identity");
}

function isExpected(value: unknown): value is ExperimentRegistrationBinding["expected"] {
  return isRecord(value) && isHash(value.seedHash) && isCanonicalRoots(value.sourceRoots) && isId(value.orientationId) && isHash(value.orientationContentHash) && isHash(value.toolDescriptionsHash) && isId(value.harnessConfigurationId) && isHash(value.harnessConfigurationHash);
}

function isModel(value: unknown): value is ExperimentRegistration["model"] {
  return isRecord(value) && value.transport === "openrouter-ai-sdk-core" && value.name === "openai/gpt-5.6-luna" && value.clientVersion === "1.0.0" && isRecord(value.transportConfiguration);
}

function isCanonicalRoots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && isSafeRelative(entry)) && value.every((entry, index) => index === 0 || value[index - 1]!.localeCompare(entry) < 0);
}

function isSafeRelative(path: string): boolean { return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".."); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isId(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(value); }
function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
