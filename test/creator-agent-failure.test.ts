import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRun, ToolCallRecord } from "../packages/agent-runtime/src/index.js";
import {
  agentFailureMessage,
  agentRunFailure,
} from "../packages/creator-control/src/agent-failure.js";

test("failed planner publication and journal activity preserve the actual stopping reason", () => {
  // Reproduce the observed failure boundary, without invoking a model or Studio.
  const toolCall: ToolCallRecord = {
    sequence: 39,
    toolCallId: "failed-inspection",
    disposition: "executed",
    name: "project.children",
    input: { rootPath: "Workspace", parentObjectId: "root", cursor: "0" },
    inputHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    truncated: false,
    bytes: 100,
    startedAt: "2026-09-03T21:25:31.000Z",
    endedAt: "2026-09-03T21:25:31.001Z",
    durationMs: 1,
    result: {
      ok: false,
      resultHash: "b".repeat(64),
      bytes: 100,
      truncated: false,
      error: {
        code: "PROJECT_PARENT_INVALID",
        message: "project.children requires exactly one parentObjectId or rootPath",
      },
    },
  };
  const failure: Pick<AgentRun, "creatorPhaseOutcome" | "error" | "toolCalls"> = {
    creatorPhaseOutcome: {
      status: "unsealed",
      intendedArtifactKind: "creator_outcome",
      failureStage: "runtime",
      failureCode: "REPEATED_NO_PROGRESS_TOOL_BATCH",
      detailHash: "c".repeat(64),
      attemptHash: "d".repeat(64),
    },
    error:
      "Model repeated an identical tool batch within the same accepted host state; no progress was possible.",
    toolCalls: [toolCall],
  };
  const before = structuredClone(failure);
  const published = agentRunFailure(failure);
  assert.equal(published.failureCode, "REPEATED_NO_PROGRESS_TOOL_BATCH");
  assert.match(published.message, /without making progress/);
  assert.match(published.message, /exactly one parentObjectId or rootPath/);
  assert.equal(
    agentFailureMessage({ ...failure, failureCode: published.failureCode }),
    published.message,
  );
  assert.deepEqual(failure, before, "diagnostics must not rewrite the failed evidence");
  assert.equal(
    agentRunFailure({
      ...failure,
      error: "Provider request timed out.",
      creatorPhaseOutcome: {
        ...failure.creatorPhaseOutcome!,
        status: "unsealed",
        intendedArtifactKind: "creator_outcome",
        failureStage: "runtime",
        failureCode: "MODEL_PROVIDER_FAILURE",
        detailHash: "c".repeat(64),
        attemptHash: "d".repeat(64),
      },
    }).message,
    "Provider request timed out.",
  );
  assert.ok(
    Buffer.byteLength(agentRunFailure({ toolCalls: [], error: "界".repeat(20_000) }).message) <
      4096,
  );
});
