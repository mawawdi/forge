import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonFileTraceSink, FlightRecorder, defaultTraceDirectory, type TraceSink } from "../../flight-recorder/src/index.js";
import { createProjectSnapshot, FilesystemProjectSourceAdapter, type ProjectSemanticMap } from "../../semantic-map/src/index.js";
import { analyzeWithOfficialLuau } from "../../luau-toolchain/src/index.js";
import { assertFixtureManifest, contentHash, stableJson, type BuildOutcome, type BuildTrace, type ForgeFixtureManifest, type TracePersistence, type VerificationIssue, type VerificationReport } from "../../contracts/src/index.js";

const RULE_SET = "forge-m1-rules-2026-08-29";

export interface VerificationRun {
  report: VerificationReport;
  trace: BuildTrace;
  tracePersistence: TracePersistence;
}

export interface VerificationRunOptions {
  traceDirectory?: string;
  traceSink?: TraceSink;
  traceReferences?: Partial<BuildTrace["references"]>;
  tracePreludeSpans?: Array<{ name: "forge.patch.create" | "forge.patch.apply" | "forge.repair.deterministic"; status: "ok" | "error"; attributes?: Record<string, string | number | boolean | string[]>; durationMs?: number }>;
  traceComponents?: Partial<BuildTrace["components"]>;
  traceContextSummary?: NonNullable<BuildTrace["context"]>;
  outcomeOverrides?: Partial<BuildOutcome>;
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

    const luauSpan = recorder.startSpan("forge.verify.luau", { "forge.verifier.name": "luau-analyze", "forge.attempt": 1 });
    const luau = analyzeWithOfficialLuau(root, semanticMap.files.map((file) => file.path));
    const luauLatency = recorder.endSpan(luauSpan, luau.exitCode === 0 ? "ok" : "error", { "forge.verifier.version": luau.tool.version, "forge.issue.count": luau.issues.length });
    recorder.setComponents({ toolchain: [{ name: luau.tool.name, version: luau.tool.version, configHash: luau.tool.configHash }] });

    const replicationSpan = recorder.startSpan("forge.verify.replication", { "forge.verifier.name": "forge-replication-contracts", "forge.verifier.version": RULE_SET, "forge.attempt": 1 });
    const semantic = semanticIssues(semanticMap);
    const replicationLatency = recorder.endSpan(replicationSpan, semantic.some(isBlockingIssue) ? "error" : "ok", { "forge.issue.count": semantic.length });

    const issues = stableIssuesOnly([...luau.issues, ...semantic]);
    const report = createVerificationReport(projectPath, projectHash, manifest, semanticMap, luau.tool, luau.exitCode, luau.issues, issues);
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

function createVerificationReport(projectPath: string, projectHash: string, manifest: ForgeFixtureManifest, semanticMap: ProjectSemanticMap, tool: VerificationReport["toolchain"][number], luauExitCode: number, luauIssues: VerificationIssue[], issues: VerificationIssue[]): VerificationReport {
  const blocking = issues.filter(isBlockingIssue);
  const checks: VerificationReport["checks"] = [
    { name: "official_luau_analysis", status: luauExitCode !== 0 || luauIssues.length > 0 ? "fail" : "pass", issueIds: luauIssues.map((issue) => issue.id) },
    { name: "replication_and_authority_contracts", status: issues.some((issue) => issue.category === "replication" || issue.category === "security") ? "fail" : "pass", issueIds: issues.filter((issue) => issue.category === "replication" || issue.category === "security").map((issue) => issue.id) }
  ];
  return {
    kind: "VerificationReport",
    schemaVersion: 1,
    projectPath: projectPath.replaceAll("\\", "/"),
    projectHash,
    toolchain: [tool],
    issues,
    checks,
    gate: { status: blocking.length > 0 ? "rejected" : "verified", reasons: blocking.length > 0 ? blocking.map((issue) => issue.ruleId) : ["No blocking static or semantic issues"] },
    reproducibility: { inputHash: contentHash(stableJson({ manifest, files: semanticMap.files.map((file) => ({ path: file.path, source: file.source })) })), dependencyHash: contentHash(tool.version), ruleSetHash: contentHash(RULE_SET), deterministic: true }
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
  const staticPass = report.checks.find((check) => check.name === "official_luau_analysis")?.status === "pass";
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
    if (!clientEvidence) {
      issues.push(makeIssue("REMOTE_CLIENT_REQUEST_NOT_FOUND", "warning", "replication", `Declared client request for remote ${declaration.name} was not found in ${client.path}.`, client.path, "The fixture declaration and source do not agree."));
      continue;
    }
    if (!serverEvidence) {
      issues.push(makeIssue("REMOTE_MISSING_HANDLER_OR_MUTATION", "error", "replication", `Remote ${declaration.name} has no discoverable server handler and authoritative mutation in ${server.path}.`, server.path, "The server-side contract cannot be verified."));
      continue;
    }
    if (declaration.direction === "client_to_server" && declaration.mutation.authority !== "server") {
      issues.push(makeIssue("REMOTE_NON_SERVER_MUTATION", "critical", "security", `Client-to-server remote ${declaration.name} reaches ${declaration.mutation.field}, but the declared mutation authority is ${declaration.mutation.authority}.`, server.path, `${serverEvidence.handler}; ${serverEvidence.mutation}`));
    }
    if (declaration.direction === "client_to_server" && new RegExp(`\\b${escapeRegExp(declaration.clientInput.name)}\\b`).test(serverEvidence.mutationExpression)) {
      const line = lineOf(server.source, serverEvidence.mutation);
      issues.push(makeIssue("REMOTE_CLIENT_CONTROLLED_REWARD", "critical", "security", `Untrusted client input ${declaration.clientInput.name} reaches authoritative mutation ${declaration.mutation.field} through ${declaration.name}.`, server.path, `Client evidence: ${clientEvidence.remoteCall}; server evidence: ${serverEvidence.mutation}; allowed server validations: ${declaration.serverValidations.join(", ") || "none"}.`, line));
    }
    const missingValidations = declaration.serverValidations.filter((validation) => !hasServerValidation(server.source, declaration.clientInput.name, validation));
    if (missingValidations.length > 0) {
      issues.push(makeIssue("REMOTE_UNVALIDATED_INPUT", "error", "security", `Remote ${declaration.name} is missing server-side ${missingValidations.join(", ")} validation for client input ${declaration.clientInput.name}.`, server.path, `Handler: ${serverEvidence.handler}`));
    }
  }
  return issues;
}

function hasServerValidation(source: string, inputName: string, validation: ForgeFixtureManifest["remoteFlows"][number]["serverValidations"][number]): boolean {
  const input = escapeRegExp(inputName);
  if (validation === "type") return new RegExp(`typeof\\s*\\(\\s*${input}\\s*\\)`).test(source);
  if (validation === "value") return new RegExp(`\\b${input}\\b\\s*[<>!=]=?`).test(source);
  if (validation === "context") return /Distance|distance|Magnitude|magnitude|Position|position/.test(source);
  if (validation === "permission") return /permission|role|UserId|userId/.test(source);
  if (validation === "rate_limit") return /cooldown|rate.?limit|last.?request/i.test(source);
  if (validation === "ownership") return /owner|ownership|UserId|userId/.test(source);
  return false;
}

function makeIssue(ruleId: string, severity: VerificationIssue["severity"], category: VerificationIssue["category"], message: string, path: string, evidenceStatement: string, line?: number): VerificationIssue {
  return { kind: "VerificationIssue", schemaVersion: 1, id: `${ruleId}:${contentHash(`${ruleId}|${path}|${line ?? 0}|${message}`).slice(0, 16)}`, ruleId, severity, category, message, path, ...(line ? { location: { line, column: 1 } } : {}), evidence: [{ type: "semantic_graph", statement: evidenceStatement }], remediation: { kind: "deterministic", steps: ["Remove client-controlled state values from the request contract.", "Recompute the reward or mutation from server-owned state.", "Re-run Forge verification before committing the patch."] }, authoritativeTier: "static" };
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
