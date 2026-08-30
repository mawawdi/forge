import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonFileTraceSink, FlightRecorder, defaultTraceDirectory, type TraceSink } from "../../flight-recorder/src/index.js";
import { FilesystemProjectSourceAdapter, type ProjectSemanticMap } from "../../semantic-map/src/index.js";
import { analyzeWithRobloxLuau } from "../../luau-toolchain/src/index.js";
import { assertFixtureManifest, contentHash, stableJson, type BuildOutcome, type BuildTrace, type ForgeFixtureManifest, type ForgeSpanName, type RemoteFlowDeclaration, type RemoteValidationCategory, type TracePersistence, type VerificationIssue, type VerificationReport } from "../../contracts/src/index.js";

const RULE_SET = "forge-m3.5-sell-inventory-rules-2026-08-30";

export interface VerificationRun {
  report: VerificationReport;
  trace: BuildTrace;
  tracePersistence: TracePersistence;
}

export interface VerificationRunOptions {
  traceDirectory?: string;
  traceSink?: TraceSink;
  traceReferences?: Partial<BuildTrace["references"]>;
  tracePreludeSpans?: Array<{ name: ForgeSpanName; status: "ok" | "error"; attributes?: Record<string, string | number | boolean | string[]>; durationMs?: number }>;
  traceComponents?: Partial<BuildTrace["components"]>;
  traceContextSummary?: NonNullable<BuildTrace["context"]>;
  outcomeOverrides?: Partial<BuildOutcome>;
  traceProofBundleId?: string;
}

export async function verifyProject(projectPath: string, options: VerificationRunOptions = {}): Promise<VerificationRun> {
  const root = resolve(projectPath);
  const projectId = `project_${contentHash(projectPath.replaceAll("\\", "/")).slice(0, 24)}`;
  const recorder = new FlightRecorder({ projectId, ...(options.traceReferences ? { references: options.traceReferences } : {}), components: { toolchain: [], verifiers: [{ name: "forge-verifier", version: RULE_SET }], ...options.traceComponents } });
  if (options.traceContextSummary) recorder.setContextSummary(options.traceContextSummary);
  for (const span of options.tracePreludeSpans ?? []) recorder.recordSpan(span.name, span.status, span.attributes, span.durationMs);
  let projectHash = contentHash(`unavailable:${projectPath}`);

  try {
    const snapshotSpan = recorder.startSpan("forge.project.snapshot", { "forge.project_id": projectId, "forge.attempt": 1 });
    const manifest = await loadManifest(root);
    const sourceAdapter = new FilesystemProjectSourceAdapter();
    const semanticMap = await sourceAdapter.load({ root, manifest });
    const snapshot = sourceAdapter.snapshot(semanticMap);
    projectHash = snapshot.sourceHash;
    const manifestHash = contentHash(stableJson(manifest));
    const snapshotLatency = recorder.endSpan(snapshotSpan, "ok", { "forge.project_hash_before": snapshot.projectSemanticHash, "forge.project_hash_after": snapshot.projectSemanticHash });
    recorder.setProject({ startingSnapshotHash: snapshot.projectSemanticHash, resultingSnapshotHash: snapshot.projectSemanticHash, sourceHash: snapshot.sourceHash, structureHash: snapshot.structureHash, semanticHash: snapshot.projectSemanticHash, manifestHash, snapshotRetention: "not_retained" });

    const luauSpan = recorder.startSpan("forge.verify.luau", { "forge.verifier.name": "official-luau-plus-roblox-host", "forge.attempt": 1 });
    const luau = analyzeWithRobloxLuau(root, semanticMap.files.map((file) => file.path));
    const luauHealthy = luau.tiers.every((tier) => tier.status === "pass");
    const luauLatency = recorder.endSpan(luauSpan, luauHealthy ? "ok" : "error", { "forge.verifier.version": luau.tools.map((tool) => `${tool.name}@${tool.version}`).join(","), "forge.issue.count": luau.issues.length });
    recorder.setComponents({ toolchain: luau.tools.map((tool) => ({ name: tool.name, version: tool.version, configHash: tool.configHash })) });

    const replicationSpan = recorder.startSpan("forge.verify.replication", { "forge.verifier.name": "forge-replication-contracts", "forge.verifier.version": RULE_SET, "forge.attempt": 1 });
    const semantic = semanticIssues(semanticMap);
    const replicationLatency = recorder.endSpan(replicationSpan, semantic.some(isBlockingIssue) ? "error" : "ok", { "forge.issue.count": semantic.length });

    const issues = stableIssuesOnly([...luau.issues, ...semantic]);
    const report = createVerificationReport(projectPath, projectHash, manifest, semanticMap, luau.tools, luau.tiers, issues);
    for (const issue of issues) recorder.addEvent("forge.issue.detected", { "forge.issue.code": issue.ruleId, "forge.issue.severity": issue.severity, "forge.issue.id": issue.id });
    return persistRun(report, recorder, options, { ...buildOutcome(report, { projectSnapshot: snapshotLatency, luau: luauLatency, replication: replicationLatency, total: recorder.elapsedMs() }), ...options.outcomeOverrides });
  } catch (error) {
    const report = incompleteReport(projectPath, projectHash, error);
    recorder.addEvent("forge.issue.detected", { "forge.issue.code": "FORGE_VERIFICATION_INCOMPLETE", "forge.issue.severity": "error" });
    return persistRun(report, recorder, options, { ...buildOutcome(report, { total: recorder.elapsedMs() }), ...options.outcomeOverrides });
  }
}

async function persistRun(report: VerificationReport, recorder: FlightRecorder, options: VerificationRunOptions, outcome: BuildOutcome): Promise<VerificationRun> {
  const trace = recorder.complete(outcome, {
    verificationReportHash: contentHash(stableJson(report)),
    ...(options.traceProofBundleId ? { proofBundleId: options.traceProofBundleId } : {}),
    issues: report.issues.map((issue) => ({ id: issue.id, ruleId: issue.ruleId, severity: issue.severity, category: issue.category, evidenceHash: contentHash(stableJson(issue.evidence)) }))
  }, {
    level: report.reproducibility.deterministic ? "semantic_reproduction" : "none",
    reasons: report.reproducibility.deterministic
      ? ["M1 records hashes and normalized evidence but does not retain an immutable project snapshot.", "Model, patch, repair, and Studio execution are not part of this run."]
      : ["The verification run did not reach a reproducible project state."],
    randomSeeds: {}
  });
  const sink = options.traceSink ?? new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory());
  try {
    return { report, trace, tracePersistence: await sink.persist(trace) };
  } catch (error) {
    return { report, trace, tracePersistence: { kind: "TracePersistence", schemaVersion: 1, traceId: trace.id, buildKey: trace.buildKey, status: "failed", error: `Trace persistence failed (${error instanceof Error ? error.name : "UnknownError"})` } };
  }
}

function createVerificationReport(
  projectPath: string,
  projectHash: string,
  manifest: ForgeFixtureManifest,
  semanticMap: ProjectSemanticMap,
  tools: VerificationReport["toolchain"],
  luauTiers: Array<{ name: string; status: "pass" | "fail" | "unavailable"; issueIds: string[] }>,
  issues: VerificationIssue[]
): VerificationReport {
  const blocking = issues.filter(isBlockingIssue);
  const toolingUnavailable = issues.some((issue) => issue.category === "tooling");
  const checks: VerificationReport["checks"] = [
    ...luauTiers.map((tier) => ({ name: tier.name, status: tier.status === "unavailable" ? "unknown" as const : tier.status, issueIds: tier.issueIds })),
    { name: "replication_and_authority_contracts", status: issues.some((issue) => issue.category === "replication" || issue.category === "security") ? "fail" : "pass", issueIds: issues.filter((issue) => issue.category === "replication" || issue.category === "security").map((issue) => issue.id) }
  ];
  return {
    kind: "VerificationReport",
    schemaVersion: 1,
    projectPath: projectPath.replaceAll("\\", "/"),
    projectHash,
    toolchain: tools,
    issues,
    checks,
    gate: { status: toolingUnavailable ? "incomplete" : blocking.length > 0 ? "rejected" : "verified", reasons: toolingUnavailable ? blocking.filter((issue) => issue.category === "tooling").map((issue) => issue.ruleId) : blocking.length > 0 ? blocking.map((issue) => issue.ruleId) : ["No blocking static or semantic issues"] },
    reproducibility: { inputHash: contentHash(stableJson({ manifest, files: semanticMap.files.map((file) => ({ path: file.path, source: file.source })) })), dependencyHash: contentHash(stableJson(tools)), ruleSetHash: contentHash(RULE_SET), deterministic: !toolingUnavailable }
  };
}

function incompleteReport(projectPath: string, projectHash: string, error: unknown): VerificationReport {
  return {
    kind: "VerificationReport",
    schemaVersion: 1,
    projectPath: projectPath.replaceAll("\\", "/"),
    projectHash,
    toolchain: [],
    issues: [],
    checks: [],
    gate: { status: "incomplete", reasons: [error instanceof Error ? error.message : String(error)] },
    reproducibility: { inputHash: projectHash, dependencyHash: contentHash("unavailable"), ruleSetHash: contentHash(RULE_SET), deterministic: false }
  };
}

function buildOutcome(report: VerificationReport, latencyMs: BuildOutcome["latencyMs"]): BuildOutcome {
  const staticPass = report.checks.find((check) => check.name === "official_luau_syntax")?.status === "pass" && report.checks.find((check) => check.name === "roblox_type_analysis")?.status === "pass";
  const semanticPass = report.checks.find((check) => check.name === "replication_and_authority_contracts")?.status === "pass";
  const issueCounts: BuildOutcome["issueCounts"] = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const issue of report.issues) issueCounts[issue.severity] += 1;
  return {
    status: report.gate.status === "incomplete" ? "incomplete" : report.gate.status === "verified" ? "accepted" : "rejected",
    verified: false,
    staticPass,
    semanticPass,
    studioPass: "not_run",
    attempts: 1,
    deterministicRepairs: 0,
    modelRepairs: 0,
    assertions: { total: 0, passed: 0 },
    modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs,
    issueCounts
  };
}

async function loadManifest(root: string): Promise<ForgeFixtureManifest> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, "forge.fixture.json"), "utf8");
  } catch {
    throw new Error("Missing forge.fixture.json");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid forge.fixture.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertFixtureManifest(value);
  return value;
}

function semanticIssues(map: ProjectSemanticMap): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const flow of map.remoteFlows) {
    const { declaration, client, server, clientEvidence, serverEvidence } = flow;
    issues.push(...interactionBindingIssues(map, flow));
    if (!clientEvidence) {
      issues.push(makeIssue("REMOTE_CLIENT_REQUEST_NOT_FOUND", "warning", "replication", `Declared client request for remote ${declaration.name} was not found in ${client.path}.`, client.path, "The fixture declaration and source do not agree."));
      continue;
    }
    if (!serverEvidence) {
      issues.push(makeIssue("REMOTE_MISSING_HANDLER_OR_MUTATION", "error", "replication", `Remote ${declaration.name} has no discoverable server handler and authoritative mutation in ${server.path}.`, server.path, "The server-side contract cannot be verified."));
      continue;
    }
    if (!remotePathIsPreserved(declaration, client.source, server.source)) {
      issues.push(makeIssue("REMOTE_ABI_PATH_MISMATCH", "error", "replication", `Remote ${declaration.name} is not bound through its declared path ${declaration.remote.path}.`, server.path, `The project interface requires ${declaration.remote.className} ${declaration.remote.path}; local variable names are irrelevant.`));
    }
    if (declaration.remote.preserveExisting && /Instance\.new\s*\(\s*["']Remote(?:Event|Function)["']\s*\)/.test(`${client.source}\n${server.source}`)) {
      issues.push(makeIssue("REMOTE_PRESERVE_EXISTING_VIOLATION", "error", "replication", `Remote ${declaration.name} must be preserved, but candidate source creates a new remote instance.`, server.path, `Declared stable remote ${declaration.remote.stableId} at ${declaration.remote.path} is immutable interface state.`));
    }
    const abi = bindRemoteAbi(declaration, clientEvidence, serverEvidence);
    if (!abi.complete) {
      issues.push(makeIssue("REMOTE_ABI_ARITY_MISMATCH", "error", "replication", `Remote ${declaration.name} does not preserve the declared positional argument contract.`, server.path, abi.statement));
    } else {
      issues.push(...implementationConstantIssues(declaration, client.source, server.source, server.path));
    }
    const missingMutations = declaration.stateMutations.filter((mutation) => !serverEvidence.mutations.some((observed) => observed.field === mutation.field));
    if (missingMutations.length > 0) issues.push(makeIssue("REMOTE_MISSING_STATE_MUTATION", "error", "replication", `Remote ${declaration.name} does not perform required authoritative state mutations: ${missingMutations.map((mutation) => mutation.field).join(", ")}.`, server.path, `Declared mutations: ${declaration.stateMutations.map((mutation) => `${mutation.field}:${mutation.operation}`).join(", ")}.`));
    for (const mutation of declaration.stateMutations.filter((mutation) => mutation.authority !== "server")) {
      issues.push(makeIssue("REMOTE_NON_SERVER_MUTATION", "critical", "security", `Client-to-server remote ${declaration.name} reaches ${mutation.field}, but declared mutation authority is ${mutation.authority}.`, server.path, serverEvidence.handler));
    }
    const declaredClientPositions = new Set(declaration.serverArguments.filter((argument) => argument.source === "client").map((argument) => argument.position));
    const undeclaredParameters = serverEvidence.parameters.filter((parameter) => parameter.position > 0 && !declaredClientPositions.has(parameter.position)).map((parameter) => parameter.name);
    if (undeclaredParameters.length > 0) issues.push(makeIssue("REMOTE_UNDECLARED_CLIENT_INPUT", "error", "security", `Remote ${declaration.name} accepts undeclared client callback parameters.`, server.path, `Undeclared server callback parameters: ${undeclaredParameters.join(", ")}.`));
    const taintedParameters = [...abi.bindings.filter((binding) => binding.input.trust === "untrusted").map((binding) => binding.serverParameter), ...undeclaredParameters];
    const taintedValues = propagateTaint(server.source, taintedParameters, trustedWorldLookupReceivers(server.source, taintedParameters));
    for (const mutation of serverEvidence.mutations.filter((candidate) => expressionUsesAny(candidate.expression, taintedValues))) {
      const roles = abi.bindings.filter((binding) => taintedValues.has(binding.serverParameter)).map((binding) => binding.input.role);
      const code = declaration.name === "SellInventory" && mutation.field === "Coins" ? "ECONOMY_CLIENT_CONTROLLED_PAYOUT" : "REMOTE_CLIENT_CONTROLLED_REWARD";
      issues.push(makeIssue(code, "critical", "security", `Untrusted client input reaches authoritative mutation ${mutation.field} through ${declaration.name}.`, server.path, `Positional ABI binding: ${abi.statement}; mutation: ${mutation.statement}. Roles: ${roles.concat(undeclaredParameters).join(", ") || "undeclared"}.`, lineOf(server.source, mutation.statement)));
    }
    const validationResults = declaration.validationRequirements.map((requirement) => evaluateValidation(requirement, declaration, server.source, abi.bindings, serverEvidence.parameters));
    const unresolved = validationResults.filter((result) => result.status === "unresolved" || result.status === "violated");
    if (unresolved.length > 0) {
      issues.push(makeIssue("REMOTE_UNVALIDATED_INPUT", "error", "security", `Remote ${declaration.name} has unresolved required safeguards: ${unresolved.map((result) => `${result.category}:${result.subjectRole}`).join(", ")}.`, server.path, validationResults.map((result) => `${result.category}/${result.subjectRole}=${result.status} (${result.statement})`).join("; ")));
    }
    issues.push(...economicConversionIssues(declaration, server.source, server.path, serverEvidence));
  }
  issues.push(...sharedAttributeMirrorIssues(map));
  return issues;
}

function interactionBindingIssues(map: ProjectSemanticMap, flow: ProjectSemanticMap["remoteFlows"][number]): VerificationIssue[] {
  const binding = flow.declaration.interactionBinding;
  if (!binding) return [];
  const issues: VerificationIssue[] = [];
  const initiations = flow.interactionEvidence?.initiations ?? [];
  const autonomous = initiations.filter((initiation) => initiation.kind === "autonomous_event");
  if (autonomous.length > 0) {
    issues.push(makeIssue(
      "CLIENT_AUTONOMOUS_INTERACTION",
      "error",
      "replication",
      `Remote ${flow.declaration.name} is initiated autonomously even though its interaction binding requires an explicit user action.`,
      flow.interactionClient.path,
      `Observed periodic initiators: ${autonomous.map((entry) => entry.event ?? "unknown").join(", ")}.`,
      autonomous[0]?.statement ? lineOf(flow.interactionClient.source, autonomous[0].statement) : undefined,
      ["Initiate the request from the declared production interaction event.", "Keep server authorization independent from client activation distance."]
    ));
  }
  const expectedEvent = binding.production.event;
  const explicit = initiations.some((initiation) => initiation.kind === "explicit_event" && initiation.event === expectedEvent);
  if (!explicit) issues.push(makeIssue("CLIENT_INTERACTION_BINDING_MISMATCH", "error", "replication", `Remote ${flow.declaration.name} does not originate from its declared ${expectedEvent} production interaction.`, flow.interactionClient.path, `Expected explicit ${binding.production.kind} event ${expectedEvent}; observed ${initiations.map((entry) => entry.event ?? entry.kind).join(", ") || "no production action call"}.`));

  if (binding.clientAction.kind === "module_function") {
    const action = binding.clientAction;
    const moduleVisible = action.modulePath.split("/").filter(Boolean).every((segment) => new RegExp(`(?:["']${escapeRegExp(segment)}["']|\\.${escapeRegExp(segment)}\\b)`).test(flow.interactionClient.source));
    if (flow.client.path !== action.sourcePath || !moduleVisible || !flow.interactionEvidence) issues.push(makeIssue("CLIENT_ACTION_MODULE_MISMATCH", "error", "replication", `Remote ${flow.declaration.name} does not use its declared production client action module.`, flow.interactionClient.path, `Expected ${action.modulePath}.${action.functionName} backed by ${action.sourcePath}.`));
    const actionArguments = flow.interactionEvidence?.arguments ?? [];
    const argumentsMatch = action.argumentMode === "none"
      ? actionArguments.length === 0
      : actionArguments.length === 1 && resolvesInteractionTarget(flow.interactionClient.source, actionArguments[0] ?? "");
    if (!argumentsMatch) issues.push(makeIssue("CLIENT_ACTION_ARGUMENT_MISMATCH", "error", "replication", `Remote ${flow.declaration.name} does not pass the declared production interaction context to its client action.`, flow.interactionClient.path, `Expected ${action.argumentMode}; observed ${actionArguments.join(", ") || "no arguments"}.`));
  }

  const semanticBinding = map.interactionBindings.find((candidate) => candidate.mechanicName === flow.declaration.name);
  if (!semanticBinding) {
    issues.push(makeIssue("INTERACTION_WORLD_BINDING_MISSING", "error", "structure", `Remote ${flow.declaration.name} has no resolved ProjectSemanticMap interaction binding.`, flow.interactionClient.path, "The declared production interaction could not be connected to project structure."));
    return issues;
  }
  if (binding.production.kind === "proximity_prompt") {
    const authorizationBinding = binding.serverAuthorization;
    const prompt = semanticBinding.productionInstance;
    const pathVisible = binding.production.path.split("/").filter(Boolean).every((segment) => new RegExp(`(?:["']${escapeRegExp(segment)}["']|\\.${escapeRegExp(segment)}\\b)`).test(flow.interactionClient.source));
    if (!prompt || prompt.className !== binding.production.className || prompt.properties.MaxActivationDistance !== binding.production.maxActivationDistance) issues.push(makeIssue("INTERACTION_PROMPT_CONTRACT_MISMATCH", "error", "structure", `Remote ${flow.declaration.name} does not resolve the declared ProximityPrompt activation boundary.`, flow.interactionClient.path, `Expected ${binding.production.path} MaxActivationDistance=${binding.production.maxActivationDistance}; observed ${prompt?.className ?? "missing"} ${String(prompt?.properties.MaxActivationDistance ?? "missing")}.`));
    if (!pathVisible) issues.push(makeIssue("CLIENT_INTERACTION_TARGET_MISMATCH", "error", "replication", `Remote ${flow.declaration.name} does not bind its production client to ${binding.production.path}.`, flow.interactionClient.path, "The declared ProximityPrompt path is not resolved by the interaction source."));
    const authorization = semanticBinding.authorizationInstance;
    if (authorizationBinding.target !== "bound_instance" || !authorization || authorization.path !== authorizationBinding.path) issues.push(makeIssue("INTERACTION_AUTHORIZATION_TARGET_MISSING", "error", "structure", `Remote ${flow.declaration.name} has no resolved server authorization target.`, flow.server.path, `Expected ${authorizationBinding.target === "bound_instance" ? authorizationBinding.path : "a bound instance"}.`));
  } else if (!`${flow.interactionClient.source}\n${flow.client.source}`.includes(binding.production.targetTag)) {
    issues.push(makeIssue("CLIENT_INTERACTION_TARGET_MISMATCH", "error", "replication", `Remote ${flow.declaration.name} does not bind its pointer interaction to the declared target category.`, flow.client.path, `Expected target tag ${binding.production.targetTag}.`));
  }
  return issues;
}

function resolvesInteractionTarget(source: string, expression: string, seen = new Set<string>()): boolean {
  if (/\.Target\b/.test(expression)) return true;
  const identifier = expression.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) || seen.has(identifier)) return false;
  seen.add(identifier);
  const assignment = source.match(new RegExp(`(?:local\\s+)?${escapeRegExp(identifier)}(?:\\s*:[^=\\n]+)?\\s*=\\s*([^\\n]+)`));
  if (!assignment?.[1]) return false;
  if (/\.Target\b/.test(assignment[1])) return true;
  for (const dependency of assignment[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (resolvesInteractionTarget(source, dependency, seen)) return true;
  return false;
}

/**
 * A shared player attribute is the declared authority boundary between two
 * mechanics. Keeping a second private per-player table in only one handler
 * creates two sources of truth: the next mechanic can correctly read the
 * attribute while the first continues to overwrite it from its stale mirror.
 */
function sharedAttributeMirrorIssues(map: ProjectSemanticMap): VerificationIssue[] {
  const attributes = new Map<string, number>();
  for (const flow of map.remoteFlows) {
    for (const binding of flow.declaration.implementation?.stateBindings ?? []) {
      if (binding.subject === "player" && binding.storage === "attribute" && binding.authority === "server") {
        attributes.set(binding.name, (attributes.get(binding.name) ?? 0) + 1);
      }
    }
  }
  const shared = new Set([...attributes].filter(([, count]) => count > 1).map(([name]) => name));
  const issues: VerificationIssue[] = [];
  for (const flow of map.remoteFlows) {
    const source = flow.server.source;
    for (const field of shared) {
      if (!new RegExp(`SetAttribute\\s*\\(\\s*["']${escapeRegExp(field)}["']`).test(source)) continue;
      for (const match of source.matchAll(/local\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*\[\s*Player\s*\]\s*:\s*[^}]+\}\s*=\s*\{\}/g)) {
        const table = match[1];
        if (!table || !new RegExp(`${escapeRegExp(table)}\\s*\\[\\s*player\\s*\\]\\s*=`).test(source)) continue;
        issues.push(makeIssue(
          "ECONOMY_CONFLICTING_STATE_REPRESENTATION",
          "error",
          "economy",
          `Remote ${flow.declaration.name} mirrors shared ${field} state in a private per-player table.`,
          flow.server.path,
          `Shared player attribute ${field} is also written through private table ${table}; dependent mechanics must observe one authoritative representation.`,
          lineOf(source, match[0]),
          [`Remove private ${table} state for ${field}.`, `Read and write player:SetAttribute("${field}", ...) as the sole authoritative representation.`]
        ));
      }
    }
  }
  return issues;
}

function implementationConstantIssues(declaration: RemoteFlowDeclaration, clientSource: string, serverSource: string, serverPath: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const constant of declaration.implementation?.constants ?? []) {
    if (constant.role !== "max_interaction_distance" || constant.type !== "number" || typeof constant.value !== "number") continue;
    const observed = resolveDistanceThreshold(serverSource);
    if (observed === constant.value) continue;
    issues.push(makeIssue(
      "IMPLEMENTATION_CONSTANT_MISMATCH",
      "error",
      "replication",
      `Remote ${declaration.name} does not preserve the Forge-owned ${constant.role} constant.`,
      serverPath,
      `MechanicImplementationSpec requires ${constant.value}; the server distance guard resolves to ${observed ?? "no statically resolvable threshold"}. Client source hash=${contentHash(clientSource).slice(0, 16)}.`,
      distanceGuardLine(serverSource),
      [`Preserve ${constant.role} exactly as ${constant.value}.`, "Re-run official syntax, Roblox-aware type analysis, and M2 before StudioProof."]
    ));
  }
  return issues;
}

function resolveDistanceThreshold(source: string): number | undefined {
  const operandPattern = "([A-Za-z_][A-Za-z0-9_]*|-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";
  const direct = source.match(new RegExp(`\\.Magnitude\\s*(?:>|>=)\\s*${operandPattern}`));
  const reversed = source.match(new RegExp(`${operandPattern}\\s*(?:<|<=)\\s*[^\\n;]*\\.Magnitude`));
  let operand = direct?.[1] ?? reversed?.[1];
  if (!operand) {
    for (const assignment of source.matchAll(/(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][A-Za-z0-9_?]*)?\s*=\s*([^\n;]*\.Magnitude)\b/g)) {
      const distanceName = assignment[1];
      if (!distanceName) continue;
      const forward = source.match(new RegExp(`\\b${escapeRegExp(distanceName)}\\b\\s*(?:>|>=)\\s*${operandPattern}`));
      const backward = source.match(new RegExp(`${operandPattern}\\s*(?:<|<=)\\s*\\b${escapeRegExp(distanceName)}\\b`));
      operand = forward?.[1] ?? backward?.[1];
      if (operand) break;
    }
  }
  if (!operand) return undefined;
  const literal = Number(operand);
  if (Number.isFinite(literal)) return literal;
  const declaration = source.match(new RegExp(`(?:local\\s+)?${escapeRegExp(operand)}\\s*(?::\\s*(?:number|any))?\\s*=\\s*(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\b`));
  const value = Number(declaration?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

function distanceGuardLine(source: string): number | undefined {
  const guard = source.match(/\.Magnitude\s*(?:>|>=)\s*/)?.[0];
  return guard ? lineOf(source, guard) : undefined;
}

interface AbiBinding {
  input: RemoteFlowDeclaration["clientInputs"][number];
  clientExpression: string;
  serverParameter: string;
}

function bindRemoteAbi(declaration: RemoteFlowDeclaration, clientEvidence: NonNullable<ProjectSemanticMap["remoteFlows"][number]["clientEvidence"]>, serverEvidence: NonNullable<ProjectSemanticMap["remoteFlows"][number]["serverEvidence"]>): { complete: boolean; bindings: AbiBinding[]; statement: string } {
  const bindings: AbiBinding[] = [];
  for (const input of [...declaration.clientInputs].sort((left, right) => left.position - right.position)) {
    const clientArgument = clientEvidence.arguments.find((argument) => argument.position === input.position);
    const declaredServerArgument = declaration.serverArguments.find((argument) => argument.source === "client" && argument.position === input.position);
    const serverParameter = serverEvidence.parameters.find((parameter) => parameter.position === input.position);
    if (!clientArgument || !declaredServerArgument || declaredServerArgument.role !== input.role || !serverParameter?.name) return { complete: false, bindings, statement: `role=${input.role} position=${input.position} client=${clientArgument?.expression ?? "missing"} server=${serverParameter?.name ?? "missing"}` };
    bindings.push({ input, clientExpression: clientArgument.expression, serverParameter: serverParameter.name });
  }
  const player = declaration.serverArguments.find((argument) => argument.source === "roblox_server" && argument.position === 0);
  const playerParameter = serverEvidence.parameters.find((parameter) => parameter.position === 0);
  const expectedServerArity = declaration.serverArguments.length;
  const complete = Boolean(player && playerParameter) && clientEvidence.arguments.length === declaration.clientInputs.length && serverEvidence.parameters.length === expectedServerArity;
  return { complete, bindings, statement: bindings.map((binding) => `${binding.input.role}[${binding.input.position}]: ${binding.clientExpression} -> ${binding.serverParameter}`).join("; ") };
}

function economicConversionIssues(declaration: RemoteFlowDeclaration, source: string, path: string, evidence: NonNullable<ProjectSemanticMap["remoteFlows"][number]["serverEvidence"]>): VerificationIssue[] {
  const bindings = declaration.implementation?.stateBindings ?? [];
  const inventory = bindings.find((binding) => binding.role === "inventory" && binding.storage === "attribute");
  const coins = bindings.find((binding) => binding.role === "currency" && binding.storage === "attribute");
  const unitPrice = bindings.find((binding) => binding.role === "unit_price" && binding.storage === "attribute");
  if (!inventory || !coins || !unitPrice) return [];
  const issues: VerificationIssue[] = [];
  const inventoryWrite = evidence.mutations.find((mutation) => mutation.field === inventory.name);
  const coinWrite = evidence.mutations.find((mutation) => mutation.field === coins.name);
  const inventoryRead = sourceReadsAttribute(source, inventory.name);
  const priceRead = sourceReadsAttribute(source, unitPrice.name);
  if (!inventoryRead) issues.push(makeIssue("ECONOMY_AUTHORITATIVE_INVENTORY_READ_MISSING", "error", "economy", `Sell conversion ${declaration.name} does not read authoritative ${inventory.name} state.`, path, `Required player attribute: ${inventory.name}.`));
  if (!priceRead) issues.push(makeIssue("ECONOMY_AUTHORITATIVE_PRICE_READ_MISSING", "error", "economy", `Sell conversion ${declaration.name} does not read server-owned ${unitPrice.name}.`, path, `Required sell-station attribute: ${unitPrice.name}.`));
  if (!inventoryWrite || !isExactZero(inventoryWrite.expression)) issues.push(makeIssue("ECONOMY_INVENTORY_CLEAR_MISSING", "error", "economy", `Sell conversion ${declaration.name} does not clear ${inventory.name} exactly to zero.`, path, inventoryWrite?.statement ?? "No inventory clear was found."));
  if (!coinWrite || !expressionDerivesFromAttribute(source, coinWrite.expression, coins.name) || !expressionDerivesFromAttribute(source, coinWrite.expression, inventory.name) || !expressionDerivesFromAttribute(source, coinWrite.expression, unitPrice.name)) issues.push(makeIssue("ECONOMY_CURRENCY_MUTATION_MISSING", "error", "economy", `Sell conversion ${declaration.name} does not derive ${coins.name} from authoritative ${inventory.name} and ${unitPrice.name}.`, path, coinWrite?.statement ?? "No currency mutation was found."));
  if (inventoryWrite && coinWrite && inventoryWrite.index > coinWrite.index) issues.push(makeIssue("ECONOMY_UNSAFE_STATE_ORDER", "error", "economy", `Sell conversion ${declaration.name} credits currency before clearing inventory.`, path, `${coins.name} mutation precedes ${inventory.name} clear.`));
  if (inventoryWrite && coinWrite) {
    const transition = source.slice(inventoryWrite.index, coinWrite.index);
    if (/(?:task\.wait|wait\s*\(|yield\s*\()/.test(transition)) issues.push(makeIssue("ECONOMY_YIELD_BETWEEN_MUTATIONS", "error", "economy", `Sell conversion ${declaration.name} yields between clearing inventory and crediting currency.`, path, "A yield can make a conversion replayable."));
  }
  return issues;
}

function isExactZero(expression: string): boolean {
  return /^\s*\(?\s*0\s*\)?\s*$/.test(expression);
}

function sourceReadsAttribute(source: string, field: string): boolean {
  return new RegExp(`GetAttribute\\s*\\(\\s*["']${escapeRegExp(field)}["']\\s*\\)`).test(source);
}

/**
 * Accept direct reads and short local derivation chains. Roblox implementations
 * routinely snapshot player attributes before an atomic state transition; that
 * remains server-owned and must not be mistaken for a client-defined payout.
 */
function expressionDerivesFromAttribute(source: string, expression: string, field: string): boolean {
  const derived = new Set<string>();
  for (const match of source.matchAll(new RegExp(`(?:local\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*([^\\n;]+)`, "g"))) {
    if (match[1] && match[2] && sourceReadsAttribute(match[2], field)) derived.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(/(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+)/g)) {
      const target = match[1];
      const value = match[2];
      if (target && value && !derived.has(target) && expressionUsesAny(value, derived)) { derived.add(target); changed = true; }
    }
  }
  return sourceReadsAttribute(expression, field) || expressionUsesAny(expression, derived);
}

type ValidationStatus = "satisfied" | "violated" | "unresolved" | "not_applicable";

function evaluateValidation(requirement: RemoteFlowDeclaration["validationRequirements"][number], declaration: RemoteFlowDeclaration, source: string, bindings: AbiBinding[], parameters: Array<{ position: number; name: string }>): { category: RemoteValidationCategory; subjectRole: string; status: ValidationStatus; statement: string } {
  if (requirement.applicability === "not_applicable") return { category: requirement.category, subjectRole: requirement.subjectRole, status: "not_applicable", statement: requirement.rationale };
  const binding = bindings.find((candidate) => candidate.input.role === requirement.subjectRole);
  if (requirement.category === "type") return validationResult(requirement, binding ? hasRuntimeTypeCheck(source, binding.serverParameter, binding.input.type) : false, binding ? `runtime type evidence for positional parameter ${binding.serverParameter}` : "subject role is not bound to the ABI");
  if (requirement.category === "value") return validationResult(requirement, binding ? hasValueConstraint(source, binding.serverParameter) : false, binding ? `value constraint evidence for positional parameter ${binding.serverParameter}` : "subject role is not bound to the ABI");
  if (requirement.category === "context") return validationResult(requirement, hasInteractionContext(source), "collectible/world membership and runtime position relationship");
  if (requirement.category === "permission") {
    const playerDeclaration = declaration.serverArguments.find((argument) => argument.source === "roblox_server" && argument.position === 0);
    const playerParameter = parameters.find((parameter) => parameter.position === 0)?.name;
    return validationResult(requirement, Boolean(playerDeclaration && playerParameter && expressionUsesIdentifier(source, playerParameter) && /\.Character\b/.test(source)), "server-supplied Player is used for character context and authoritative state");
  }
  if (requirement.category === "rate_limit") return validationResult(requirement, /os\.clock\s*\(\)|time\s*\(\)/.test(source) && /\[[^\]]+\]\s*=/.test(source) && /[<>]=?/.test(source), "server clock, actor-keyed state, and threshold comparison");
  if (requirement.category === "ownership") {
    const playerParameter = parameters.find((parameter) => parameter.position === 0)?.name;
    return validationResult(requirement, Boolean(playerParameter && new RegExp(`(?:GetAttribute\\s*\\(\\s*["']OwnerUserId["']\\s*\\)|\\.OwnerUserId)\\s*==\\s*${escapeRegExp(playerParameter)}\\.UserId`).test(source)), "target owner identity compared with the server-supplied Player UserId");
  }
  return { category: requirement.category, subjectRole: requirement.subjectRole, status: "unresolved", statement: "unsupported validation category" };
}

function validationResult(requirement: RemoteFlowDeclaration["validationRequirements"][number], satisfied: boolean, statement: string): { category: RemoteValidationCategory; subjectRole: string; status: ValidationStatus; statement: string } {
  return { category: requirement.category, subjectRole: requirement.subjectRole, status: satisfied ? "satisfied" : "unresolved", statement };
}

function hasRuntimeTypeCheck(source: string, parameter: string, expectedType: string): boolean {
  const name = escapeRegExp(parameter);
  if (new RegExp(`typeof\\s*\\(\\s*${name}\\s*\\)\\s*(?:==|~=)\\s*["']${escapeRegExp(expectedType)}["']`).test(source)) return true;
  for (const helper of helperCalls(source, parameter)) {
    const match = source.match(new RegExp(`local\\s+function\\s+${escapeRegExp(helper)}\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)[^)]*\\)([\\s\\S]*?)\\nend`));
    if (match?.[1] && match[2] && new RegExp(`typeof\\s*\\(\\s*${escapeRegExp(match[1])}\\s*\\)\\s*(?:==|~=)\\s*["']${escapeRegExp(expectedType)}["']`).test(match[2])) return true;
  }
  return false;
}

function hasValueConstraint(source: string, parameter: string): boolean {
  const name = escapeRegExp(parameter);
  if (new RegExp(`(?:#\\s*${name}|\\b${name}\\b)\\s*(?:==|~=|<=|>=|<|>)`).test(source) || new RegExp(`(?:==|~=|<=|>=|<|>)\\s*${name}\\b`).test(source)) return true;
  return helperCalls(source, parameter).some((helper) => {
    const match = source.match(new RegExp(`local\\s+function\\s+${escapeRegExp(helper)}\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)[^)]*\\)([\\s\\S]*?)\\nend`));
    return Boolean(match?.[1] && match[2] && new RegExp(`(?:#\\s*${escapeRegExp(match[1])}|\\b${escapeRegExp(match[1])}\\b)\\s*(?:==|~=|<=|>=|<|>)`).test(match[2]));
  });
}

function helperCalls(source: string, parameter: string): string[] {
  return [...source.matchAll(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\(\\s*${escapeRegExp(parameter)}\\s*\\)`, "g"))].map((match) => match[1]).filter((value): value is string => Boolean(value));
}

function hasInteractionContext(source: string): boolean {
  const targetMembership = /(?:Workspace|workspace):(?:FindFirstChild|WaitForChild)\s*\(|FindFirstChild\s*\([^)]*true\s*\)|IsDescendantOf\s*\(\s*(?:Workspace|workspace)\s*\)|CollectionService:HasTag\s*\(/.test(source);
  return targetMembership && /\.Character\b/.test(source) && /HumanoidRootPart/.test(source) && /\.Position\b/.test(source) && /\.Magnitude\b/.test(source);
}

function remotePathIsPreserved(declaration: RemoteFlowDeclaration, clientSource: string, serverSource: string): boolean {
  const segments = declaration.remote.path.split("/").filter(Boolean).slice(1);
  return segments.every((segment) => new RegExp(`(?:["']${escapeRegExp(segment)}["']|\\.${escapeRegExp(segment)}\\b)`).test(`${clientSource}\n${serverSource}`));
}

function propagateTaint(source: string, initial: string[], trustedAttributeReceivers: Set<string> = new Set()): Set<string> {
  const tainted = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(/(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+)/g)) {
      const target = match[1];
      const expression = match[2];
      if (target && expression && !tainted.has(target) && expressionUsesAny(expression, tainted) && !isTrustedAttributeRead(expression, trustedAttributeReceivers)) { tainted.add(target); changed = true; }
    }
  }
  return tainted;
}

/**
 * An untrusted identifier may select a world object, but only a server lookup
 * that is subsequently checked for Workspace membership and a required tag is
 * allowed to declassify attributes read from that object. The ID itself stays
 * tainted, so mutation through an unchecked lookup remains blocking.
 */
function trustedWorldLookupReceivers(source: string, inputParameters: string[]): Set<string> {
  const trusted = new Set<string>();
  for (const parameter of inputParameters) {
    for (const match of source.matchAll(new RegExp(`local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:Workspace|workspace):(?:FindFirstChild|WaitForChild)\\s*\\(\\s*${escapeRegExp(parameter)}\\b`, "g"))) {
      const receiver = match[1];
      if (!receiver) continue;
      const inWorkspace = new RegExp(`\\b${escapeRegExp(receiver)}:IsDescendantOf\\s*\\(\\s*(?:Workspace|workspace)\\s*\\)`).test(source);
      const tagged = new RegExp(`CollectionService:HasTag\\s*\\(\\s*${escapeRegExp(receiver)}\\s*,`).test(source);
      if (inWorkspace && tagged) trusted.add(receiver);
    }
  }
  return trusted;
}

function isTrustedAttributeRead(expression: string, trustedReceivers: Set<string>): boolean {
  return [...trustedReceivers].some((receiver) => new RegExp(`\\b${escapeRegExp(receiver)}:GetAttribute\\s*\\(`).test(expression));
}

function expressionUsesAny(expression: string, identifiers: Set<string>): boolean {
  return [...identifiers].some((identifier) => expressionUsesIdentifier(expression, identifier));
}

function expressionUsesIdentifier(expression: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(expression);
}

function makeIssue(ruleId: string, severity: VerificationIssue["severity"], category: VerificationIssue["category"], message: string, path: string, evidenceStatement: string, line?: number, remediationSteps?: string[]): VerificationIssue {
  return { kind: "VerificationIssue", schemaVersion: 1, id: `${ruleId}:${contentHash(`${ruleId}|${path}|${line ?? 0}|${message}`).slice(0, 16)}`, ruleId, severity, category, message, path, ...(line ? { location: { line, column: 1 } } : {}), evidence: [{ type: "semantic_graph", statement: evidenceStatement }], remediation: { kind: "deterministic", steps: remediationSteps ?? ["Remove client-controlled state values from the request contract.", "Recompute the reward or mutation from server-owned state.", "Re-run Forge verification before committing the patch."] }, authoritativeTier: "static" };
}

function lineOf(source: string, fragment: string): number | undefined {
  const index = source.indexOf(fragment);
  return index < 0 ? undefined : source.slice(0, index).split("\n").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableIssuesOnly(issues: VerificationIssue[]): VerificationIssue[] {
  const unique = new Map(issues.map((issue) => [issue.id, issue]));
  return [...unique.values()].sort((a, b) => `${a.path ?? ""}|${a.location?.line ?? 0}|${a.location?.column ?? 0}|${a.ruleId}|${a.message}`.localeCompare(`${b.path ?? ""}|${b.location?.line ?? 0}|${b.location?.column ?? 0}|${b.ruleId}|${b.message}`));
}

function isBlockingIssue(issue: VerificationIssue): boolean {
  return issue.severity === "error" || issue.severity === "critical";
}
