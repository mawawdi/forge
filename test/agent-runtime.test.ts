import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentHash } from "../packages/contracts/src/index.js";
import { compileAgentOrientation } from "../packages/context-compiler/src/index.js";
import { ClaudeAgentProvider, claudeLockedDownOptionSummary } from "../packages/agent-claude/src/index.js";
import { CandidateWorkspace, INITIAL_EXPERIMENT_BUDGETS, assertHarnessConfiguration, createHarnessConfiguration, runBoundedAgent, type AgentProvider } from "../packages/agent-runtime/src/index.js";
import { resolveRequirementView, type RequirementSet } from "../packages/semantic-authority/src/index.js";

const ROOT = resolve("examples/collect-fruit/vulnerable");
const TASK_PATH = resolve("tasks/m4.1-collect-authority.requirements.json");
const CREATOR_PROMPT = "Repair this project so an untrusted client cannot determine the server-owned Inventory increase. Preserve the existing collection request interface and valid collection behavior.";

async function task(): Promise<RequirementSet> { return JSON.parse(await readFile(TASK_PATH, "utf8")) as RequirementSet; }
async function runDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), "forge-m41-test-")); }

function repairingProvider(withFeedback = true): AgentProvider {
  return {
    identity: { name: "fake-agent", version: "test" },
    async run(input) {
      if (withFeedback) {
        const first = await input.tools.execute("forge.verify", {});
        assert.equal(first.ok, true);
        assert.equal((first.value as { gate: string }).gate, "rejected");
      }
      const read = await input.tools.execute("project.read", { path: "src/server/CollectFruit.server.luau" });
      assert.equal(read.ok, true);
      const source = (read.value as { lines: string[] }).lines.join("\n");
      await input.tools.execute("plan.update", { goal: "Keep authoritative state server-owned", steps: [{ id: "inspect", statement: "Inspect current server handler", status: "completed" }, { id: "repair", statement: "Move authoritative mutation to server decision", status: "in_progress" }], expectedTouchedAreas: ["src/server"], verificationIntentions: ["local static authority gate"], status: "active" });
      const write = await input.tools.execute("workspace.write", {
        path: "src/server/CollectFruit.server.luau",
        beforeHash: (read.value as { sourceHash: string }).sourceHash,
        content: source.replace("    Inventory[player] = (Inventory[player] or 0) + amount", "    if typeof(amount) ~= \"number\" then return end\n    if amount <= 0 then return end\n    Inventory[player] = (Inventory[player] or 0) + 1")
      });
      assert.equal(write.ok, true);
      if (withFeedback) assert.equal((await input.tools.execute("forge.verify", {})).ok, true);
      return { status: "completed", summary: "Applied server-owned authority repair.", usage: { turns: 3, inputTokens: 200, outputTokens: 100, costUsd: 0 } };
    }
  };
}

test("M4.1 fake agent iterates on verifier feedback and finalizes only as locally eligible", async () => {
  const directory = await runDirectory();
  const result = await runBoundedAgent({ seedRoot: ROOT, creatorPrompt: CREATOR_PROMPT, requirementSet: await task(), provider: repairingProvider(), model: { provider: "test", name: "fake" }, runDirectory: directory, traceDirectory: join(directory, "traces") });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.classification, "accepted");
  assert.equal(result.run.studio, "not_run");
  assert.equal(result.trace.outcome.verified, false);
  assert.equal(result.run.finalVerification?.gate, "verified");
  assert.deepEqual(result.run.toolCalls.filter((call) => call.name === "forge.verify").map((call) => call.result.ok), [true, true]);
  assert.equal(result.run.workspaceDelta?.operations.length, 1);
  assert.equal((await stat(resolve(result.persistence.path))).mode & 0o777, 0o600);
});

test("independent final gate is mandatory even when the agent does not request verification", async () => {
  const directory = await runDirectory();
  const result = await runBoundedAgent({ seedRoot: ROOT, creatorPrompt: CREATOR_PROMPT, requirementSet: await task(), provider: repairingProvider(false), model: { provider: "test", name: "fake" }, runDirectory: directory, traceDirectory: join(directory, "traces") });
  assert.equal(result.status, "locally_eligible");
  assert.equal(result.run.toolCalls.some((call) => call.name === "forge.verify"), false);
  assert.equal(result.finalVerification.report.gate.status, "verified");
});

test("builder orientation withholds evaluator and benchmark bodies", async () => {
  const set = await task();
  const workspace = await CandidateWorkspace.create(ROOT, await runDirectory(), INITIAL_EXPERIMENT_BUDGETS);
  const view = resolveRequirementView(set, { phase: "build", environment: "production", audience: "builder" });
  const semanticMap = await workspace.semanticMap();
  const orientation = compileAgentOrientation({ semanticMap, projectSnapshotHash: semanticMap.hashes.sourceHash, requirementView: view });
  const rendered = JSON.stringify(orientation);
  assert.equal(rendered.includes("Hidden benchmark sentinel"), false);
  assert.equal(rendered.includes("task evaluator outcome"), false);
  assert.ok(orientation.content.visibleRequirements.some((requirement) => requirement.id === "requirement_creator_server_authority"));
});

test("workspace refuses writes before a plan and unsafe paths", async () => {
  const directory = await runDirectory();
  const provider: AgentProvider = { identity: { name: "fake-agent", version: "test" }, async run(input) { const read = await input.tools.execute("project.read", { path: "src/server/CollectFruit.server.luau" }); const noPlan = await input.tools.execute("workspace.write", { path: "src/server/CollectFruit.server.luau", beforeHash: (read.value as { sourceHash: string }).sourceHash, content: "-- blocked" }); const traversal = await input.tools.execute("project.read", { path: "../forge.fixture.json" }); assert.equal(noPlan.error?.code, "PLAN_REQUIRED"); assert.equal(traversal.error?.code, "PATH_FORBIDDEN"); return { status: "completed", usage: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 } }; } };
  const result = await runBoundedAgent({ seedRoot: ROOT, creatorPrompt: CREATOR_PROMPT, requirementSet: await task(), provider, model: { provider: "test", name: "fake" }, runDirectory: directory, traceDirectory: join(directory, "traces") });
  assert.equal(result.status, "rejected");
  assert.equal(result.classification, "workspace_capability_violation");
});

test("HarnessConfiguration is deterministic and Claude lockdown is explicit", () => {
  const input = { systemPrompt: "one", tools: [{ name: "project.read", description: "read", schema: { type: "object" } }], capabilityPolicy: { sourceRoots: ["src"], blockedPathPrefixes: [".forge"], allowedExtensions: [".luau", ".lua"] }, orientation: { policy: "source_free_project_facts_v1" as const, contentHash: contentHash("orientation") }, requirementViewHash: contentHash("view"), budgets: INITIAL_EXPERIMENT_BUDGETS, runtimeAdapter: { name: "fake", version: "1" }, model: { provider: "fake", name: "one" } };
  const first = createHarnessConfiguration(input);
  const second = createHarnessConfiguration(input);
  const changed = createHarnessConfiguration({ ...input, tools: [{ ...input.tools[0]!, description: "changed description" }] });
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, changed.hash);
  assert.throws(() => assertHarnessConfiguration({ ...first, hash: contentHash("tampered") }));
  const locked = claudeLockedDownOptionSummary();
  assert.deepEqual(locked.tools, []);
  assert.equal(locked.strictMcpConfig, true);
  assert.equal(new ClaudeAgentProvider().identity.name, "claude-agent-sdk");
});

test("generic harness packages keep structural distance from historical adapters and fixtures", async () => {
  const sources = await Promise.all(["packages/agent-runtime/src/index.ts", "packages/agent-claude/src/index.ts", "packages/context-compiler/src/agent-orientation.ts"].map((path) => readFile(resolve(path), "utf8")));
  for (const source of sources) {
    assert.equal(/from\s+["'][^"']*(generation|repair|studio-proof|examples|fixtures|patch-model)[^"']*["']/.test(source), false);
  }
});
