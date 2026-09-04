import type { AgentRun, ToolCallRecord } from "../../agent-runtime/src/index.js";
import { failedActivityDetail } from "./agent-activity.js";
import type { CreatorSessionBundle } from "../../creator-session/src/index.js";

export function preparationFailureMessage(
  preparation: NonNullable<CreatorSessionBundle["preparationFailure"]>,
): string {
  if (preparation.failure.stage === "source_analysis")
    return "Forge couldn't read the project's scripts, so this request couldn't start. No changes were made. Try again; Details contains the source-analysis error.";
  return `${preparation.execution.purpose === "planner" ? "Request" : "Build"} could not start: ${preparation.failure.detail}`;
}

/** Presentation derived from immutable runtime evidence, never an agent outcome. */
export function agentFailureMessage(input: {
  readonly failureCode?: string;
  readonly error?: string;
  readonly toolCalls: readonly ToolCallRecord[];
}): string {
  if (/^http_404:/.test(input.error ?? ""))
    return "This model is currently unavailable from the provider. Choose a different model to continue.";
  if (
    /^(provider_response_error(?:_[45][0-9]{2})?|invalid_response_schema):/.test(input.error ?? "")
  )
    return "The model provider returned an unusable response. Try again or choose a different model.";
  if (/^http_[45][0-9]{2}:/.test(input.error ?? ""))
    return "The model provider couldn't complete the request. Try again in a moment or choose a different model.";
  if (/^timeout:/.test(input.error ?? ""))
    return "The model provider did not respond before the response deadline. Try again or choose a different model.";
  if (input.failureCode === "MODEL_RESPONSE_TRUNCATED")
    return "The model's response was cut off before it finished. Try another attempt or choose a different model.";
  if (input.failureCode === "MODEL_RESPONSE_REFUSED")
    return "The model declined this request. You can revise your message or choose a different model.";
  if (input.failureCode === "REPEATED_NO_PROGRESS_TOOL_BATCH") {
    const lastFailure = [...input.toolCalls].reverse().find((call) => !call.result.ok);
    const detail = lastFailure?.result.error?.message;
    return (
      "The agent repeated a step without making progress, so work stopped." +
      (detail ? ` ${failedActivityDetail(detail)}` : "")
    );
  }
  if (input.failureCode === "RUNTIME_BUDGET_EXHAUSTED")
    return "This run reached its usage limit before the work was ready. Start another attempt to continue.";
  return (
    input.error?.slice(0, 1200) ||
    "The agent stopped before it could produce a response. Open Details to inspect the saved result."
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
