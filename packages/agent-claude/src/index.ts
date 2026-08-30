import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, AgentProviderInput, AgentProviderResult } from "../../agent-runtime/src/index.js";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.251";

type Query = typeof query;

/**
 * The sole M4.1 production adapter. All Claude SDK imports stay in this
 * package so AgentRuntime remains replaceable and provider-neutral.
 */
export class ClaudeAgentProvider implements AgentProvider {
  readonly identity = { name: "claude-agent-sdk", version: CLAUDE_AGENT_SDK_VERSION };
  constructor(private readonly model = "claude-sonnet-5", private readonly queryImpl: Query = query) {}

  async run(input: AgentProviderInput): Promise<AgentProviderResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "failed", error: "ANTHROPIC_API_KEY is required for the Claude Agent SDK adapter", usage: emptyUsage() };
    const controlDirectory = await mkdtemp(join(tmpdir(), "forge-m41-claude-control-"));
    try {
      const server = createSdkMcpServer({
        name: "forge",
        version: "m4.1",
        alwaysLoad: true,
        timeout: 30_000,
        tools: input.tools.definitions().map((definition) => tool(definition.name, definition.description, definition.inputShape, async (args) => {
          const result = await input.tools.execute(definition.name, args);
          return { content: [{ type: "text", text: JSON.stringify(result.value ?? result.error ?? { ok: result.ok, resultHash: result.resultHash }) }], isError: !result.ok };
        }, { alwaysLoad: true }))
      });
      const stream = this.queryImpl({
        prompt: renderTask(input),
        options: {
          model: this.model,
          cwd: controlDirectory,
          env: { ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: "forge-m4.1" },
          tools: [],
          allowedTools: input.tools.definitions().map((definition) => `mcp__forge__${definition.name}`),
          permissionMode: "dontAsk",
          strictMcpConfig: true,
          settingSources: [],
          skills: [],
          plugins: [],
          agents: {},
          persistSession: false,
          maxTurns: input.budgets.maxTurns,
          maxBudgetUsd: input.budgets.maxBudgetUsd,
          systemPrompt: input.systemPrompt,
          mcpServers: { forge: server }
        }
      });
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      for await (const message of stream) if (message.type === "result") result = message;
      if (!result) return { status: "failed", error: "Claude SDK ended without a result", usage: emptyUsage() };
      const usage = usageFrom(result);
      if (usage.inputTokens !== null && usage.inputTokens > input.budgets.maxInputTokens || usage.outputTokens !== null && usage.outputTokens > input.budgets.maxOutputTokens) return { status: "budget_exhausted", error: "Post-step token budget exhausted", usage };
      const errorText = "errors" in result ? result.errors.join("; ") : result.subtype === "success" ? result.result : "Claude SDK execution failed";
      if (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd") return { status: "budget_exhausted", error: errorText, usage };
      if (result.subtype !== "success" || result.is_error) return { status: "failed", error: errorText, usage };
      return { status: "completed", summary: result.result, usage };
    } finally {
      await rm(controlDirectory, { recursive: true, force: true });
    }
  }
}

export function claudeLockedDownOptionSummary(model = "claude-sonnet-5"): Record<string, unknown> {
  return { model, tools: [], permissionMode: "dontAsk", strictMcpConfig: true, settingSources: [], skills: [], plugins: [], agents: {}, persistSession: false, mcpServer: "forge", builtInFilesystemOrShell: false };
}

function renderTask(input: AgentProviderInput): string {
  return `Creator outcome:\n${input.prompt}\n\nInitial source-free orientation:\n${JSON.stringify(input.orientation.content)}\n\nUse only the Forge MCP tools. Make a BuildPlan before workspace.write. You may request forge.verify, but the harness will always run an independent final local gate. Do not claim Studio execution.`;
}
function emptyUsage(): AgentProviderResult["usage"] { return { turns: 0, inputTokens: null, outputTokens: null, costUsd: null }; }
function usageFrom(result: Extract<SDKMessage, { type: "result" }>): AgentProviderResult["usage"] {
  const usage = result.usage;
  return { turns: result.num_turns, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: result.total_cost_usd };
}
