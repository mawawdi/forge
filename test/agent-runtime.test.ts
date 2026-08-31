import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BoundedToolHost, CandidateWorkspace, ForgeNativeAgentRuntime, INITIAL_EXPERIMENT_BUDGETS, assertHarnessConfiguration, createHarnessConfiguration, loadWorkspaceCandidateArtifact, runBoundedAgent } from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import type { ModelClient, ModelTurnRequest, ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { createRequirementSet, resolveRequirementView, type RequirementSet } from "../packages/semantic-authority/src/index.js";
import { compileAgentOrientation } from "../packages/context-compiler/src/index.js";
import { createProjectSnapshot } from "../packages/semantic-map/src/index.js";

const VULNERABLE = resolve("test/fixtures/client-controlled-authoritative-state");
const SAFE = resolve("test/fixtures/authoritative-state-safe");
const MOVING = resolve("examples/moving-platform/seed");
const CREATOR_PROMPT = "Keep authoritative state server-owned while preserving the existing request interface.";

async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), "forge-agent-runtime-")); }
function requirements(): RequirementSet {
  return createRequirementSet([
    { kind: "Requirement", schemaVersion: 1, id: "creator-authority-outcome", statement: CREATOR_PROMPT, source: "creator", authority: "policy", visibility: "builder_visible", enforcement: "blocking", verificationModes: ["static"], evidence: [{ kind: "creator_request", id: "creator-evidence", intentId: "creator-intent", requestHash: contentHash(CREATOR_PROMPT) }] },
    { kind: "Requirement", schemaVersion: 1, id: "hidden-evaluator-sentinel", statement: "HIDDEN_EXPECTED_VALUE_999", source: "benchmark_oracle", authority: "evaluation_only", visibility: "evaluator_only", enforcement: "blocking", verificationModes: ["evaluator"], evidence: [{ kind: "benchmark_fixture", id: "hidden-evidence", benchmarkId: "authority", oracleId: "oracle", fixtureHash: contentHash("hidden") }] }
  ]);
}

class ScriptedModelClient implements ModelClient {
  readonly descriptor: ModelClient["descriptor"] = {
    transport: "fake-model",
    version: "1",
    configuration: {
      aiSdk: { package: "fake-ai", version: "1" },
      providerAdapter: { package: "fake-provider", version: "1" },
      routing: { only: ["fake"], allowFallbacks: false, requireParameters: true },
      reasoning: { effort: "medium", exclude: false },
      request: { steps: 1, toolChoice: "auto", providerParallelToolCalls: "not_requested", toolBatchExecution: "atomic_validate_then_sequential", toolNameEncoding: "openai_function_slug_v1", maxRetries: 0, telemetry: false, timeoutPolicy: "remaining_runtime_budget", maxOutputTokensPerTurn: 4096 },
      continuation: { maxBytes: 256 * 1024 }
    }
  };
  private index = 0;
  constructor(private readonly results: Array<(request: ModelTurnRequest) => ModelTurnResult>) {}
  async complete(request: ModelTurnRequest): Promise<ModelTurnResult> { const factory = this.results[this.index++]; if (!factory) throw new Error("Unexpected model turn"); return factory(request); }
}

function assistant(sequence: number, toolCalls: Array<{ id: string; name: string; arguments: unknown }>, content = ""): (request: ModelTurnRequest) => ModelTurnResult {
  return (request) => ({ kind: "assistant", message: { role: "assistant", content, toolCalls }, stopReason: toolCalls.length > 0 ? "tool_calls" : "end_turn", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }, requestHash: contentHash(stableJson({ sequence, messages: request.messages })), responseHash: contentHash(stableJson({ content, toolCalls })), responseFacts: { requestedModel: request.model, resolvedModel: request.model, servingProvider: "fake", responseId: `response-${sequence}`, latencyMs: 1, retryCount: 0, finishReason: toolCalls.length > 0 ? "tool-calls" : "stop", continuationHash: null, continuationBytes: null } });
}

async function repairingClient(withFeedback: boolean): Promise<ModelClient> {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  return new ScriptedModelClient([
    assistant(1, [
      { id: "plan", name: "plan.update", arguments: { goal: "Restore server authority", steps: [{ id: "inspect", statement: "Inspect and repair the server handler", status: "in_progress" }], verificationIntentions: ["Run the local authority gate"], status: "active" } },
      { id: "read", name: "project.read", arguments: { path: "src/server/ApplyAction.server.luau" } },
      ...(withFeedback ? [{ id: "verify-before", name: "forge.verify", arguments: {} }] : [])
    ]),
    assistant(2, [{ id: "write", name: "workspace.write", arguments: { path: "src/server/ApplyAction.server.luau", precondition: { kind: "sha256", hash: contentHash(source) }, content: repaired } }]),
    ...(withFeedback ? [assistant(3, [{ id: "verify-after", name: "forge.verify", arguments: {} }])] : []),
    assistant(withFeedback ? 4 : 3, [], "Server-owned update completed.")
  ]);
}

test("native runtime performs same-session verifier feedback repair and seals only a locally eligible candidate", async () => {
  const runDirectory = await directory();
  const result = await runBoundedAgent({ seedRoot: VULNERABLE, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(await repairingClient(true)), model: "fake/model", runDirectory, traceDirectory: join(runDirectory, "traces") });
  assert.equal(result.status, "locally_eligible"); assert.equal(result.classification, "none");
  assert.equal(result.run.trialStarted, true);
  assert.equal(result.run.finalVerification.gate, "eligible"); assert.equal(result.run.studio, "not_run");
  assert.deepEqual(result.run.toolCalls.filter((call) => call.name === "forge.verify").map((call) => (call.result.value as { gate: string }).gate), ["rejected", "locally_eligible"]);
  assert.equal(result.run.workspaceDelta?.operations.length, 1); assert.equal(result.run.modelTurns.length, 4);
  assert.equal((await stat(resolve(result.persistence.path))).mode & 0o777, 0o600);
  assert.ok(result.candidateArtifact);
  const loaded = await loadWorkspaceCandidateArtifact(resolve(result.candidateArtifact!.persistence.path), join(runDirectory, "traces"));
  assert.equal(loaded.verification.report.gate.status, "eligible");
});

test("the independent final gate succeeds when the model never invokes forge.verify", async () => {
  const runDirectory = await directory();
  const result = await runBoundedAgent({ seedRoot: VULNERABLE, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(await repairingClient(false)), model: "fake/model", runDirectory, traceDirectory: join(runDirectory, "traces") });
  assert.equal(result.status, "locally_eligible"); assert.equal(result.run.toolCalls.some((call) => call.name === "forge.verify"), false); assert.equal(result.finalVerification.report.gate.status, "eligible");
});

test("mixed invalid tool batches execute nothing, return feedback for every call, and recover in-session", async () => {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  const client = new ScriptedModelClient([
    assistant(1, [
      { id: "rejected-plan", name: "plan.update", arguments: { goal: "Repair", steps: [{ id: "repair", statement: "Repair authority", status: "in_progress" }], status: "active" } },
      { id: "", name: "project.read", arguments: { path: "src/server/ApplyAction.server.luau" } },
      { id: "bad-arguments", name: "project.read", arguments: {} },
      { id: "unknown-tool", name: "project.shell", arguments: {} }
    ]),
    (request) => {
      const feedback = request.messages.at(-1);
      assert.equal(feedback?.role, "user");
      assert.match(feedback?.role === "user" ? feedback.content : "", /forgeToolBatchRejected|TOOL_CALL_ID_EMPTY|TOOL_ARGUMENTS_INVALID|TOOL_UNKNOWN/);
      return assistant(2, [{ id: "accepted-plan", name: "plan.update", arguments: { goal: "Repair", steps: [{ id: "repair", statement: "Repair authority", status: "in_progress" }], status: "active" } }])(request);
    },
    assistant(3, [{ id: "accepted-write", name: "workspace.write", arguments: { path: "src/server/ApplyAction.server.luau", precondition: { kind: "sha256", hash: contentHash(source) }, content: repaired } }]),
    assistant(4, [], "Repair complete.")
  ]);
  const runDirectory = await directory();
  const result = await runBoundedAgent({ seedRoot: VULNERABLE, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(client), model: "fake/model", runDirectory, traceDirectory: join(runDirectory, "traces") });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.run.plans.length, 1);
  assert.deepEqual(result.run.toolCalls.slice(0, 4).map((call) => call.result.error?.code), ["TOOL_BATCH_REJECTED", "TOOL_CALL_ID_EMPTY", "TOOL_ARGUMENTS_INVALID", "TOOL_UNKNOWN"]);
  assert.equal(result.run.toolCalls[0]?.name, "plan.update");
  assert.equal(result.run.toolCalls[0]?.result.ok, false);
});

test("tool-call IDs are unique for the full run and valid batches execute sequentially", async () => {
  const source = await readFile(resolve(VULNERABLE, "src/server/ApplyAction.server.luau"), "utf8");
  const repaired = source.replace("+ claimedAmount", "+ 1");
  const client = new ScriptedModelClient([
    assistant(1, [{ id: "shared-id", name: "plan.update", arguments: { goal: "Repair", steps: [{ id: "repair", statement: "Repair authority", status: "in_progress" }], status: "active" } }]),
    assistant(2, [{ id: "shared-id", name: "project.read", arguments: { path: "src/server/ApplyAction.server.luau" } }]),
    (request) => {
      const feedback = request.messages.at(-1);
      assert.match(feedback?.role === "user" ? feedback.content : "", /TOOL_CALL_ID_DUPLICATE/);
      return assistant(3, [
        { id: "read-sequential", name: "project.read", arguments: { path: "src/server/ApplyAction.server.luau" } },
        { id: "write-sequential", name: "workspace.write", arguments: { path: "src/server/ApplyAction.server.luau", precondition: { kind: "sha256", hash: contentHash(source) }, content: repaired } }
      ])(request);
    },
    assistant(4, [], "Repair complete.")
  ]);
  const runDirectory = await directory();
  const result = await runBoundedAgent({ seedRoot: VULNERABLE, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(client), model: "fake/model", runDirectory, traceDirectory: join(runDirectory, "traces") });
  assert.equal(result.status, "locally_eligible");
  assert.deepEqual(result.run.toolCalls.map((call) => call.name), ["plan.update", "project.read", "project.read", "workspace.write"]);
  assert.equal(result.run.toolCalls[1]?.result.error?.code, "TOOL_CALL_ID_DUPLICATE");
  assert.equal(result.run.toolCalls[2]?.result.ok, true);
  assert.equal(result.run.toolCalls[3]?.result.ok, true);
});

test("provider failures and model budget exhaustion normalize to incomplete outcomes", async () => {
  const failedDirectory = await directory();
  const failureClient = new ScriptedModelClient([(request) => ({ kind: "provider_error", errorClass: "http_503", message: "unavailable", retryable: true, usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestHash: contentHash(stableJson(request)), responseFacts: { requestedModel: request.model, resolvedModel: null, servingProvider: null, responseId: null, latencyMs: 1, retryCount: 0, finishReason: null, continuationHash: null, continuationBytes: null } })]);
  const failed = await runBoundedAgent({ seedRoot: MOVING, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(failureClient), model: "fake/model", runDirectory: failedDirectory, traceDirectory: join(failedDirectory, "traces") });
  assert.equal(failed.status, "incomplete"); assert.equal(failed.classification, "provider_failure");
  assert.equal(failed.run.trialStarted, false);
  const invalidDirectory = await directory();
  const invalidClient = new ScriptedModelClient([(request) => ({ kind: "invalid_model_response", errorClass: "unknown_tool", message: "invalid tool envelope", usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.0001 }, requestHash: contentHash(stableJson(request)), responseFacts: { requestedModel: request.model, resolvedModel: request.model, servingProvider: "fake", responseId: "response-invalid", latencyMs: 1, retryCount: 0, finishReason: "invalid-tool-call", continuationHash: null, continuationBytes: null } })]);
  const invalid = await runBoundedAgent({ seedRoot: MOVING, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(invalidClient), model: "fake/model", runDirectory: invalidDirectory, traceDirectory: join(invalidDirectory, "traces") });
  assert.equal(invalid.status, "incomplete"); assert.equal(invalid.classification, "agent_failure"); assert.equal(invalid.run.trialStarted, true);
  const postResponseDirectory = await directory();
  const postResponseFailure = new ScriptedModelClient([(request) => ({ kind: "provider_error", errorClass: "continuation_too_large", message: "bounded continuation exceeded", retryable: false, usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.0001 }, requestHash: contentHash(stableJson(request)), responseFacts: { requestedModel: request.model, resolvedModel: request.model, servingProvider: "fake", responseId: "response-valid-envelope", latencyMs: 1, retryCount: 0, finishReason: "tool-calls", continuationHash: null, continuationBytes: null } })]);
  const postResponse = await runBoundedAgent({ seedRoot: MOVING, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(postResponseFailure), model: "fake/model", runDirectory: postResponseDirectory, traceDirectory: join(postResponseDirectory, "traces") });
  assert.equal(postResponse.status, "incomplete"); assert.equal(postResponse.run.trialStarted, true);
  const budgetDirectory = await directory();
  const budgetClient = new ScriptedModelClient([(request) => ({ kind: "assistant", message: { role: "assistant", content: "", toolCalls: [] }, stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 10, costUsd: 0 }, requestHash: contentHash(stableJson(request)), responseHash: contentHash("limit"), responseFacts: { requestedModel: request.model, resolvedModel: request.model, servingProvider: "fake", responseId: "limit", latencyMs: 1, retryCount: 0, finishReason: "length", continuationHash: null, continuationBytes: null } })]);
  const exhausted = await runBoundedAgent({ seedRoot: MOVING, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(budgetClient), model: "fake/model", runDirectory: budgetDirectory, traceDirectory: join(budgetDirectory, "traces") });
  assert.equal(exhausted.status, "incomplete"); assert.equal(exhausted.classification, "budget_exhausted");
  assert.equal(exhausted.run.trialStarted, true);
});

test("opaque model continuation is never persisted in AgentRun or BuildTrace", async () => {
  const secretReasoning = "PRIVATE_REASONING_SENTINEL";
  const runDirectory = await directory();
  const client = new ScriptedModelClient([(request) => ({
    kind: "assistant",
    message: { role: "assistant", content: "No change required.", toolCalls: [], continuation: { transport: "fake-model", payload: [{ role: "assistant", content: secretReasoning }], hash: contentHash(secretReasoning), bytes: Buffer.byteLength(secretReasoning) } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    requestHash: contentHash(stableJson(request)), responseHash: contentHash(secretReasoning),
    responseFacts: { requestedModel: request.model, resolvedModel: request.model, servingProvider: "fake", responseId: "private-response", latencyMs: 1, retryCount: 0, finishReason: "stop", continuationHash: contentHash(secretReasoning), continuationBytes: Buffer.byteLength(secretReasoning) }
  })]);
  const result = await runBoundedAgent({ seedRoot: MOVING, creatorPrompt: CREATOR_PROMPT, requirementSet: requirements(), runtime: new ForgeNativeAgentRuntime(client), model: "fake/model", runDirectory, traceDirectory: join(runDirectory, "traces") });
  assert.doesNotMatch(stableJson(result.run), new RegExp(secretReasoning));
  assert.doesNotMatch(stableJson(result.trace), new RegExp(secretReasoning));
  assert.equal(result.run.modelTurns[0]?.responseFacts?.continuationHash, contentHash(secretReasoning));
});

test("workspace requires a plan, safe relative source paths, fresh hashes, and explicit absent creation", async () => {
  const workspace = await CandidateWorkspace.create(SAFE, await directory(), INITIAL_EXPERIMENT_BUDGETS);
  const tools = new BoundedToolHost(workspace, INITIAL_EXPERIMENT_BUDGETS);
  const read = await tools.execute("project.read", { path: "src/server/ApplyAction.server.luau" });
  assert.equal((await tools.execute("workspace.write", { path: "src/server/ApplyAction.server.luau", precondition: { kind: "sha256", hash: (read.value as { sourceHash: string }).sourceHash }, content: "-- blocked" })).error?.code, "PLAN_REQUIRED");
  assert.equal((await tools.execute("project.read", { path: "../forge.fixture.json" })).error?.code, "PATH_FORBIDDEN");
  await tools.execute("plan.update", { goal: "Add source", steps: [{ id: "create", statement: "Create a file", status: "in_progress" }], status: "active" });
  assert.equal((await tools.execute("workspace.write", { path: "src/server/NewModule.luau", precondition: { kind: "absent" }, content: "return true" })).ok, true);
  assert.equal((await tools.execute("workspace.write", { path: "src/server/NewModule.luau", precondition: { kind: "absent" }, content: "return false" })).error?.code, "PATH_ALREADY_EXISTS");
  assert.equal((await tools.execute("workspace.write", { path: "src/server/missing/New.luau", precondition: { kind: "absent" }, content: "return true" })).error?.code, "PATH_NOT_REGULAR_DIRECTORY");
  assert.equal((await tools.execute("workspace.write", { path: "src/server/ApplyAction.server.luau", precondition: { kind: "sha256", hash: contentHash("stale") }, content: "-- stale" })).error?.code, "STALE_WRITE");
  const outside = await directory();
  await writeFile(join(outside, "Escape.luau"), "return 'outside'", "utf8");
  await symlink(outside, join(workspace.candidateRoot, "src/server/link"), "dir");
  assert.equal((await tools.execute("project.read", { path: "src/server/link/Escape.luau" })).error?.code, "PATH_FORBIDDEN");
  assert.equal((await tools.execute("workspace.write", { path: "src/server/link/New.luau", precondition: { kind: "absent" }, content: "return true" })).error?.code, "PATH_NOT_REGULAR_DIRECTORY");
});

test("builder orientation withholds benchmark bodies and HarnessConfiguration hashes tool behavior", async () => {
  const workspace = await CandidateWorkspace.create(MOVING, await directory(), INITIAL_EXPERIMENT_BUDGETS);
  const map = await workspace.semanticMap();
  const view = resolveRequirementView(requirements(), { phase: "build", environment: "benchmark", audience: "builder" });
  const orientation = compileAgentOrientation({ semanticMap: map, projectSnapshotHash: createProjectSnapshot(map).projectSemanticHash, requirementView: view });
  assert.doesNotMatch(stableJson(orientation), /HIDDEN_EXPECTED_VALUE_999|hidden-evaluator-sentinel/);
  const input = { systemPrompt: "one", tools: [{ name: "project.read", description: "read", schema: { type: "object" } }, { name: "project.list", description: "list", schema: { type: "object" } }], capabilityPolicy: { sourceRoots: ["src"], blockedPathPrefixes: [".forge"], allowedExtensions: [".lua", ".luau"] }, orientation: { policy: orientation.policy, contentHash: orientation.contentHash }, requirementViewHash: contentHash("view"), budgets: INITIAL_EXPERIMENT_BUDGETS, runtime: { name: "forge-native", version: "1" }, model: { transport: "fake", name: "fake/model", clientVersion: "1", transportConfiguration: new ScriptedModelClient([]).descriptor.configuration } };
  const first = createHarnessConfiguration(input); const second = createHarnessConfiguration(input); const changed = createHarnessConfiguration({ ...input, tools: input.tools.map((item, index) => index === 0 ? { ...item, description: "different" } : item) }); const reordered = createHarnessConfiguration({ ...input, tools: [...input.tools].reverse() });
  assert.equal(first.hash, second.hash); assert.notEqual(first.hash, changed.hash); assert.notEqual(first.hash, reordered.hash); assert.throws(() => assertHarnessConfiguration({ ...first, hash: contentHash("tampered") }));
  assert.doesNotThrow(() => createHarnessConfiguration({ ...input, systemPrompt: "A reward, sell action, door, and fruit are ordinary domain words." }));
});

test("generic packages do not import deleted mechanics, adapters, fixtures, or Studio harness registries", async () => {
  const paths = [
    "packages/agent-runtime/src/index.ts", "packages/cli/src/index.ts", "packages/context-compiler/src/agent-orientation.ts", "packages/context-compiler/src/index.ts",
    "packages/contracts/src/index.ts", "packages/flight-recorder/src/index.ts", "packages/luau-toolchain/src/index.ts", "packages/model-client/src/contracts.ts", "packages/model-client/src/index.ts",
    "packages/proofs/src/index.ts", "packages/proofs/src/runtime.ts", "packages/semantic-authority/src/index.ts", "packages/semantic-authority/src/policies.ts",
    "packages/semantic-map/src/index.ts", "packages/studio-bridge/src/index.ts", "packages/studio-capabilities/src/index.ts", "packages/studio-protocol/src/index.ts",
    "packages/studio-runtime/src/index.ts", "packages/verifier/src/index.ts"
  ];
  for (const path of paths) {
    const source = await readFile(resolve(path), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(agent-claude|generation|repair|studio-proof|patch-model|examples|fixtures|HarnessRegistry)[^"']*["']/);
    assert.doesNotMatch(source, /from\s+["'](?:ai|@openrouter\/ai-sdk-provider)["']/);
  }
  const adapter = await readFile(resolve("packages/model-client/src/openrouter-ai-sdk.ts"), "utf8");
  assert.match(adapter, /from "ai"/); assert.match(adapter, /from "@openrouter\/ai-sdk-provider"/);
});
