import type { AgentRun, ToolCallRecord } from "../../agent-runtime/src/index.js";

/** Presentation derived from immutable runtime evidence, never an agent outcome. */
export function agentFailureMessage(input: {
  readonly failureCode?: string;
  readonly error?: string;
  readonly toolCalls: readonly ToolCallRecord[];
}): string {
  if (input.failureCode === "REPEATED_NO_PROGRESS_TOOL_BATCH") {
    const lastFailure = [...input.toolCalls].reverse().find((call) => !call.result.ok);
    const detail = lastFailure?.result.error?.message;
    return (
      "The agent repeated a step without making progress, so work stopped." +
      (detail ? ` Last tool error: ${detail.slice(0, 1200)}` : "")
    );
  }
  return (
    input.error?.slice(0, 1200) ||
    "The agent stopped before it could produce a response. Open run details to inspect the saved evidence."
  );
}

export function agentRunFailure(
  run: Pick<AgentRun, "creatorPhaseOutcome" | "error" | "toolCalls"> | undefined,
): {
  message: string;
  failureCode: string;
} {
  const phase = run?.creatorPhaseOutcome;
  const failureCode = phase?.status === "unsealed" ? phase.failureCode : "agent_outcome_missing";
  return {
    failureCode,
    message: agentFailureMessage({
      failureCode,
      ...(run?.error ? { error: run.error } : {}),
      toolCalls: run?.toolCalls ?? [],
    }),
  };
}
