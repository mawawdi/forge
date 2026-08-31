# Forge Native Agent Runtime Rationale

Status: architectural rationale for Forge-owned model orchestration. The one-turn provider boundary remains current; dated commands, connector identities, and trial discussion below are historical. Current implementation is defined by the canonical documents linked next.

Current architecture is defined by [ARCHITECTURE.md](ARCHITECTURE.md), product invariants by [FORGE.md](FORGE.md), claim semantics by [EVALS.md](EVALS.md), and demonstrated status by [ROADMAP.md](ROADMAP.md).

## Decision

Forge owns the canonical agent loop through `ForgeNativeAgentRuntime`. Model access sits beneath it as a one-turn `ModelClient.complete` boundary. The isolated transport uses Vercel AI SDK Core `generateText` with `@openrouter/ai-sdk-provider`; it does not use `ToolLoopAgent`, an Agent SDK, AI Gateway, or SDK-owned iteration.

```text
ForgeNativeAgentRuntime
  -> one-step AI SDK Core / OpenRouter model turn
  -> Forge-owned tool dispatch
  -> normalized tool result
  -> continuation / stopping / budget decision
  -> independent final verifier
```

This boundary makes the harness measurable. Forge, rather than a provider SDK, owns turn iteration, semantic continuation decisions, tool ordering and execution, verifier feedback, budgets, failure classification, workspace freezing, the final verifier, and the evidence stored for a run. The transport preserves the SDK's opaque response messages solely so provider reasoning blocks can survive a tool round trip unchanged.

## Responsibility split

`ForgeNativeAgentRuntime` owns:

- normalized message history and multi-turn continuation;
- the eight bounded Forge tools;
- agent-plan-before-write enforcement through the tool host;
- turn, tool, write, verifier, token, cost, byte, file, line, and duration budgets;
- provider and budget failure normalization;
- stop-reason handling and same-session verifier feedback;
- whole-batch validation before any tool executes, run-wide unique tool-call IDs, and sequential valid-batch dispatch;
- normalized model-turn hashes and usage records.

`ModelClient` owns one inference request and returns normalized assistant content, structured tool calls, stop reason, usage, bounded response facts, an opaque continuation, or a bounded failure. `ModelTurnResult` is a hard union of `assistant`, `invalid_model_response`, and `provider_error`. It does not own workspace access, tool execution, iteration, verification, or persistence.

The OpenRouter adapter loads `OPENROUTER_API_KEY` only at the CLI/model boundary. The key is excluded from semantic identity, request hashes, `HarnessConfiguration`, `AgentRun`, and traces. A real build requires an explicit `--model`; the exact provider/model identifier is experiment configuration, never semantic authority.

The canonical experiment uses `ai@7.0.85`, `@openrouter/ai-sdk-provider@3.0.0`, `openai/gpt-5.6-luna`, provider allowlist `openai`, disabled fallbacks, required-parameter routing, medium reasoning with reasoning output retained, usage accounting, zero SDK retries, and one generated step. The provider request omits `parallel_tool_calls`: OpenRouter's current OpenAI endpoint metadata does not advertise that parameter, so combining it with required-parameter routing filters every endpoint. Forge instead validates each returned tool-call batch atomically and dispatches a valid batch sequentially in its returned order. Public Forge tool names remain dotted; the adapter deterministically maps them to OpenAI-compatible underscore wire names and reverses the mapping on returned calls. Tools have schemas and descriptions but no SDK execution callbacks. Forge performs semantic argument validation.

The adapter stores AI SDK `responseMessages` as `ModelContinuation { transport, payload, hash, bytes }`, limited to 256 KiB per turn. The raw payload—including reasoning/provider metadata—is replayed unchanged in memory and never enters `AgentRun` or `BuildTrace`; only its hash and size do.

## Why the native loop is canonical

- Tool schemas and descriptions are hashed harness behavior and participate in configuration identity.
- Workspace and hidden-evaluation boundaries remain enforceable without importing filesystem, shell, plugin, skill, session, or subagent behavior from a vendor runtime.
- A provider change remains an experimental variable rather than silently changing the harness.
- Provider failures can be distinguished from invalid model responses, tool, verifier, task, and environment failures.
- The final verifier is independent of whether the agent voluntarily called `forge.verify`.

Third-party agent runtimes may later be introduced as experimental treatments behind the provider-neutral `AgentRuntime` contract. They are not compatibility targets and must not introduce SDK types into core contracts, tools, or workspace packages.

## Harness identity and evidence

`HarnessConfiguration` deterministically covers:

- system prompt;
- exact tool schemas and descriptions;
- workspace/capability policy;
- initial-orientation policy and content hash;
- resolved requirement-view hash;
- budget policy;
- native runtime identity and configuration hash;
- model transport and exact model ID;
- provider routing, reasoning, retry, timeout, output, one-step, telemetry, and continuation policies, with external dependencies pinned in the lockfile.

`AgentRun` references that configuration and records normalized turns, bounded provider facts, continuation hashes/sizes, plan revisions, tool calls/results, usage, configured and consumed budgets, exhaustion, the frozen delta, `trialStarted`, and the independent final-verifier result. Raw secrets and reasoning bodies never enter these records.

For creator phases, a model `end_turn` is accepted only when the phase tool host reports a seal-ready state. AgentRun records either the sealed plan/change-set binding or an unsealed terminal outcome with its failure stage, code, detail hash, attempt hash, turns, and tool history. `LocalCreatorAgentWorker` persists that AgentRun and its BuildTrace before returning the phase result to the coordinator, so missing or invalid artifacts no longer erase a consumed model phase.

## Demonstrated evidence

Injected-fetch and fake-model tests demonstrate exact OpenRouter request policy, one HTTP attempt, ordered tool schemas, reasoning-detail replay, bounded provider facts and failures, same-session inspect/plan/write/verify/repair behavior, atomic invalid-batch recovery, run-wide duplicate-ID rejection, first-pass completion without an agent-requested verifier call, budget exhaustion, hidden-data isolation, workspace safety, and mandatory independent final verification.

The user-run capability canary completed before the model trial. Two subsequent provider requests remained pre-trial failures: required-parameter routing rejected the unadvertised `parallel_tool_calls` field with HTTP 404, then OpenAI rejected dotted public Forge tool names with HTTP 400. The corrected adapter omits the former and maps the latter deterministically at the provider boundary; both corrections passed the complete local suite before another request.

The sole real trial, `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286`, used `openai/gpt-5.6-luna` and crossed `trialStarted`. It ended `incomplete / agent_failure` after seven turns because Forge enforced `src/server` without exposing that root to the model. The model inspected the empty project, created a coherent plan, attempted two plausible write paths, received `PATH_FORBIDDEN`, requested verifier feedback, and stopped. No source changed, no candidate was sealed, and Studio remained `not_run`.

This is evidence about the harness, not a model-quality or runtime verdict. The provider-visible source-root correction is now covered by a deterministic empty-root regression; the consumed MovingPlatform trial remains ineligible for retry or prompt tuning.
