import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { JsonFileTraceSink, FlightRecorder, defaultTraceDirectory, type TraceSink } from "../../flight-recorder/src/index.js";
import { FilesystemProjectSourceAdapter, type ProjectSemanticMap, type SemanticRemoteFlow } from "../../semantic-map/src/index.js";
import { analyzeWithRobloxLuau } from "../../luau-toolchain/src/index.js";
import { assertFixtureManifest, contentHash, stableJson, type BuildOutcome, type BuildTrace, type ForgeFixtureManifest, type ForgeSpanName, type TracePersistence, type VerificationIssue, type VerificationReport } from "../../contracts/src/index.js";

const RULE_SET = "forge-generic-roblox-security-1";

export interface VerificationRun { report: VerificationReport; trace: BuildTrace; tracePersistence: TracePersistence }
export interface VerificationRunOptions {
  traceDirectory?: string;
  traceSink?: TraceSink;
  traceReferences?: Partial<BuildTrace["references"]>;
  tracePreludeSpans?: Array<{ name: ForgeSpanName; status: "ok" | "error"; attributes?: Record<string, string | number | boolean | string[]>; durationMs?: number }>;
  traceComponents?: Partial<BuildTrace["components"]>;
}

export async function verifyProject(projectPath: string, options: VerificationRunOptions = {}): Promise<VerificationRun> {
  const root = resolve(projectPath);
  const projectId = `project_${contentHash(root).slice(0, 24)}`;
  const recorder = new FlightRecorder({ projectId, ...(options.traceReferences ? { references: options.traceReferences } : {}), components: { toolchain: [], verifiers: [{ name: "forge-verifier", version: RULE_SET }], ...options.traceComponents } });
  for (const span of options.tracePreludeSpans ?? []) recorder.recordSpan(span.name, span.status, span.attributes, span.durationMs);
  let projectHash = contentHash(`unavailable:${root}`);

  try {
    const snapshotSpan = recorder.startSpan("forge.project.snapshot", { "forge.project_id": projectId });
    const manifest = await loadManifest(root);
    const adapter = new FilesystemProjectSourceAdapter();
    const map = await adapter.load({ root, manifest });
    const snapshot = adapter.snapshot(map);
    projectHash = snapshot.projectSemanticHash;
    const snapshotLatency = recorder.endSpan(snapshotSpan, "ok", { "forge.project_hash_before": snapshot.projectSemanticHash, "forge.project_hash_after": snapshot.projectSemanticHash });
    recorder.setProject({ startingSnapshotHash: snapshot.projectSemanticHash, resultingSnapshotHash: snapshot.projectSemanticHash, sourceHash: snapshot.sourceHash, structureHash: snapshot.structureHash, semanticHash: snapshot.projectSemanticHash, manifestHash: contentHash(stableJson(manifest)), snapshotRetention: "not_retained" });

    const luauSpan = recorder.startSpan("forge.verify.luau", { "forge.verifier.name": "official-luau-plus-roblox-host" });
    const luau = analyzeWithRobloxLuau(root, map.files.map((file) => file.path));
    const luauLatency = recorder.endSpan(luauSpan, luau.tiers.every((tier) => tier.status === "pass") ? "ok" : "error", { "forge.verifier.version": luau.tools.map((tool) => `${tool.name}@${tool.version}`).join(","), "forge.issue.count": luau.issues.length });
    recorder.setComponents({ toolchain: luau.tools.map((tool) => ({ name: tool.name, version: tool.version, configHash: tool.configHash })) });

    const securitySpan = recorder.startSpan("forge.verify.replication", { "forge.verifier.name": "forge-generic-security", "forge.verifier.version": RULE_SET });
    const semantic = semanticIssues(map);
    const securityLatency = recorder.endSpan(securitySpan, semantic.some(isBlockingIssue) ? "error" : "ok", { "forge.issue.count": semantic.length });
    const issues = canonicalIssues([...luau.issues, ...semantic]);
    const report = createReport(root, manifest, map, luau.tools, luau.tiers, issues);
    for (const issue of issues) recorder.addEvent("forge.issue.detected", { "forge.issue.code": issue.ruleId, "forge.issue.severity": issue.severity, "forge.issue.id": issue.id });
    return persist(report, recorder, options, outcome(report, { total: recorder.elapsedMs(), projectSnapshot: snapshotLatency, luau: luauLatency, replication: securityLatency }));
  } catch (error) {
    const report = incompleteReport(root, projectHash, error);
    recorder.addEvent("forge.issue.detected", { "forge.issue.code": "FORGE_VERIFICATION_INCOMPLETE", "forge.issue.severity": "error" });
    return persist(report, recorder, options, outcome(report, { total: recorder.elapsedMs() }));
  }
}

function semanticIssues(map: ProjectSemanticMap): VerificationIssue[] {
  return map.remoteFlows.flatMap((flow) => {
    const issues: VerificationIssue[] = [];
    if (!flow.client.source) issues.push(issue("REMOTE_CLIENT_SOURCE_MISSING", "error", "structure", `Client source is missing for ${flow.declaration.name}.`, flow.client.path, "The declared client endpoint has no readable source."));
    if (!flow.server.source) issues.push(issue("REMOTE_SERVER_SOURCE_MISSING", "error", "structure", `Server source is missing for ${flow.declaration.name}.`, flow.server.path, "The declared server endpoint has no readable source."));
    if (flow.client.source && flow.server.source && flow.declaration.remote.preserveExisting) {
      const remoteName = basename(flow.declaration.remote.path);
      if (!flow.client.source.includes(remoteName) || !flow.server.source.includes(remoteName)) issues.push(issue("REMOTE_BINDING_UNRESOLVED", "error", "replication", `The declared remote ${flow.declaration.remote.path} is not bound on both sides.`, flow.server.path, "Static source observation could not connect both endpoints to the declared remote."));
    }
    if (flow.declaration.direction === "client_to_server" && flow.server.source) issues.push(...clientAuthorityIssues(flow));
    return issues;
  });
}

function clientAuthorityIssues(flow: SemanticRemoteFlow): VerificationIssue[] {
  const handler = /OnServerEvent\s*:\s*Connect\s*\(\s*function\s*\(([^)]*)\)([\s\S]*?)\n\s*end\s*\)/m.exec(flow.server.source);
  if (!handler) return [issue("REMOTE_SERVER_HANDLER_UNRESOLVED", "error", "replication", `The server handler for ${flow.declaration.name} could not be resolved.`, flow.server.path, "No direct OnServerEvent callback was observed.")];
  const parameters = handler[1]!.split(",").map((parameter) => parameter.trim().split(/[:=]/)[0]!.trim()).filter(Boolean);
  const body = handler[2]!;
  const issues: VerificationIssue[] = [];
  for (const input of flow.declaration.clientInputs.filter((candidate) => candidate.trust === "untrusted")) {
    const parameter = parameters[input.position];
    if (!parameter) {
      issues.push(issue("REMOTE_ABI_UNRESOLVED", "error", "replication", `Client input ${input.role} has no matching server parameter.`, flow.server.path, `Position ${input.position} was not present in the observed server handler.`));
      continue;
    }
    const escapedParameter = escapeRegExp(parameter);
    const guarded = new RegExp(`(?:typeof|type)\\s*\\(\\s*${escapedParameter}\\s*\\)|${escapedParameter}\\s*(?:<=|>=|<|>|==|~=)|(?:if|assert)\\s+[^\\n]*${escapedParameter}`, "m").test(body);
    for (const mutation of flow.declaration.stateMutations.filter((candidate) => candidate.authority === "server")) {
      const escapedField = escapeRegExp(mutation.field);
      const authoritativeAssignment = new RegExp(`${escapedField}[^\\n=]*=[^\\n]*\\b${escapedParameter}\\b`, "m").test(body);
      const declaredClientSource = mutation.sourceExpression === input.role || mutation.sourceExpression === parameter;
      if (authoritativeAssignment || declaredClientSource) issues.push(issue("REMOTE_CLIENT_CONTROLLED_STATE", "critical", "security", `Untrusted client input ${input.role} reaches authoritative state ${mutation.field}.`, flow.server.path, `The observed server mutation uses client parameter ${parameter}${guarded ? " after validation" : " without a validating guard"}; validation does not grant the client authority to choose the state value.`));
    }
    for (const requirement of flow.declaration.validationRequirements.filter((candidate) => candidate.subjectRole === input.role && candidate.applicability === "required")) {
      if (!guarded && ["type", "value", "context"].includes(requirement.category)) issues.push(issue(`REMOTE_${requirement.category.toUpperCase()}_VALIDATION_MISSING`, "error", "security", `Required ${requirement.category} validation is missing for ${input.role}.`, flow.server.path, requirement.rationale));
    }
  }
  return issues;
}

function createReport(root: string, manifest: ForgeFixtureManifest, map: ProjectSemanticMap, tools: VerificationReport["toolchain"], tiers: Array<{ name: string; status: "pass" | "fail" | "unavailable"; issueIds: string[] }>, issues: VerificationIssue[]): VerificationReport {
  const blocking = issues.filter(isBlockingIssue);
  const toolingUnavailable = issues.some((candidate) => candidate.category === "tooling");
  return {
    kind: "VerificationReport",
    schemaVersion: 2,
    projectPath: root.replaceAll("\\", "/"),
    projectHash: map.hashes.semanticHash,
    toolchain: tools,
    issues,
    checks: [
      ...tiers.map((tier) => ({ name: tier.name, status: tier.status === "unavailable" ? "unknown" as const : tier.status, issueIds: [...tier.issueIds].sort() })),
      { name: "replication_and_authority", status: issues.some((candidate) => ["replication", "security", "structure"].includes(candidate.category)) ? "fail" : "pass", issueIds: issues.filter((candidate) => ["replication", "security", "structure"].includes(candidate.category)).map((candidate) => candidate.id) }
    ],
    gate: toolingUnavailable ? { status: "incomplete", reasons: issues.filter((candidate) => candidate.category === "tooling").map((candidate) => candidate.ruleId) } : blocking.length > 0 ? { status: "rejected", reasons: blocking.map((candidate) => candidate.ruleId) } : { status: "eligible", reasons: ["No blocking local verification issues"] },
    reproducibility: { inputHash: contentHash(stableJson({ manifest, files: map.files.map((file) => ({ path: file.path, source: file.source })) })), dependencyHash: contentHash(stableJson(tools)), ruleSetHash: contentHash(RULE_SET), deterministic: !toolingUnavailable }
  };
}

function incompleteReport(root: string, projectHash: string, error: unknown): VerificationReport { return { kind: "VerificationReport", schemaVersion: 2, projectPath: root.replaceAll("\\", "/"), projectHash, toolchain: [], issues: [], checks: [], gate: { status: "incomplete", reasons: [error instanceof Error ? error.message : String(error)] }, reproducibility: { inputHash: projectHash, dependencyHash: contentHash("unavailable"), ruleSetHash: contentHash(RULE_SET), deterministic: false } }; }

function outcome(report: VerificationReport, latencyMs: BuildOutcome["latencyMs"]): BuildOutcome {
  const counts: BuildOutcome["issueCounts"] = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const candidate of report.issues) counts[candidate.severity] += 1;
  return { status: report.gate.status === "eligible" ? "locally_eligible" : report.gate.status, localGate: report.gate.status, runtimeGate: "not_run", assertions: { total: 0, passed: 0 }, modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs, issueCounts: counts };
}

async function persist(report: VerificationReport, recorder: FlightRecorder, options: VerificationRunOptions, buildOutcome: BuildOutcome): Promise<VerificationRun> {
  const trace = recorder.complete(buildOutcome, { verificationReportHash: contentHash(stableJson(report)), issues: report.issues.map((candidate) => ({ id: candidate.id, ruleId: candidate.ruleId, severity: candidate.severity, category: candidate.category, evidenceHash: contentHash(stableJson(candidate.evidence)) })) }, { level: report.reproducibility.deterministic ? "semantic_reproduction" : "none", reasons: report.reproducibility.deterministic ? ["Inputs, toolchain, rule set, and local results are content-addressed."] : ["Local verification did not reach a reproducible state."], randomSeeds: {} });
  const sink = options.traceSink ?? new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory());
  try { return { report, trace, tracePersistence: await sink.persist(trace) }; }
  catch (error) { return { report, trace, tracePersistence: { kind: "TracePersistence", schemaVersion: 1, traceId: trace.id, buildKey: trace.buildKey, status: "failed", error: `Trace persistence failed (${error instanceof Error ? error.name : "UnknownError"})` } }; }
}

async function loadManifest(root: string): Promise<ForgeFixtureManifest> { const value = JSON.parse(await readFile(resolve(root, "forge.fixture.json"), "utf8")) as unknown; assertFixtureManifest(value); return value; }
function issue(ruleId: string, severity: VerificationIssue["severity"], category: VerificationIssue["category"], message: string, path: string, statement: string): VerificationIssue { return { kind: "VerificationIssue", schemaVersion: 1, id: `${ruleId}:${contentHash(`${ruleId}|${path}|${message}`).slice(0, 16)}`, ruleId, severity, category, message, path, evidence: [{ type: "semantic_graph", statement }], remediation: { kind: "deterministic", steps: ["Keep authoritative state values server-owned.", "Validate untrusted request data before use.", "Run Forge verification again."] }, authoritativeTier: "static" }; }
function canonicalIssues(values: VerificationIssue[]): VerificationIssue[] { return [...new Map(values.map((value) => [value.id, value])).values()].sort((left, right) => left.id.localeCompare(right.id)); }
function isBlockingIssue(candidate: VerificationIssue): boolean { return candidate.severity === "error" || candidate.severity === "critical"; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
