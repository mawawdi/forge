# Forge Roadmap

This document is the canonical status and next-work record. [FORGE.md](FORGE.md) defines the system, [EVALS.md](EVALS.md) defines claim semantics, and [RESEARCH.md](RESEARCH.md) indexes the evidence behind the direction.

## Demonstrated foundation

The repository currently contains:

- provenance-aware requirements, visibility, enforcement, evidence, and scoped requirement views;
- source-free project orientation and eight bounded Forge-owned builder tools;
- a provider-neutral `AgentRuntime`, Forge-owned multi-turn loop, and isolated one-step AI SDK Core/OpenRouter `ModelClient` that preserves bounded opaque reasoning continuation;
- atomic tool-call batch validation, run-wide unique call IDs, sequential Forge-owned dispatch, bounded response facts, and an explicit `trialStarted` boundary;
- isolated candidate workspaces, agent-owned plans, deterministic harness configuration identity, budget accounting, independent local verification, and sealed candidate artifacts;
- protocol v12/plugin 8.0.0 with the three generic Studio capabilities `instance.resolve@1`, `base_part.position@1`, and `base_part.position_series@1`;
- candidate-independent runtime definitions, data-only Studio execution plans, backend grading, runtime runs, scoped runtime proofs, and privacy-minimized traces;
- one unseen MovingPlatform seed/task/evaluator split with evaluator thresholds kept outside builder-visible inputs.

The current local suite passes 39 Node tests plus plugin parsing, analysis, and module tests. The CLI exposes only the six canonical commands.

## Demonstrated Studio substrate

The user-run protocol-v12/plugin-8.0.0 non-evaluative canary completed as `studio_capability_canary_beef4ad696113cbf8b69de7e`, bound to `studio_execution_plan_7e138ef9465e5a60ab1aae3d`. It demonstrated:

- successful pairing and correlated Start/Result/Stop lifecycle;
- finite typed endpoint and platform observations;
- static endpoint integrity across edit mode and Play Solo;
- direct nonce-correlated `EndTest` return;
- bounded output and cleanup.

The canary created no candidate verdict, `RuntimeEvalDefinition`, `RuntimeProofBundle`, or benchmark pass.

## Single MovingPlatform trial

Two provider requests failed before `trialStarted` and remain preserved as transport evidence:

- `agent_run_abb6e8b4-a309-4a72-a62f-b863bb876490`: HTTP 404 under the initial required-parameter/`parallel_tool_calls` combination;
- `agent_run_19908dfb-14b7-4476-88f3-3b20c68341c8`: HTTP 400 from dotted public Forge names sent directly as OpenAI function names.

After deterministic transport corrections and full-suite validation, the one permitted trial ran as `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286` under `harness_configuration_bca40ea4ef667a18a61089e9`. It crossed `trialStarted` and ended `incomplete / agent_failure`: seven model turns, six tool calls, one verifier request, zero writes, no exhausted budget, no sealed candidate, final local gate `incomplete`, and Studio `not_run`.

The root cause is harness/context: `src/server` was enforced as the writable root but was not visible in orientation, `project.list`, `project.inspect`, or the write-tool description. The model could not infer the valid path from an empty source tree. Its two writes were rejected with `PATH_FORBIDDEN`. The consumed experiment will not be retried or tuned.

## Immediate next task

Add a deterministic regression for an empty declared source root, then expose source-root capability facts to the builder without revealing absolute host paths, hidden evaluator data, or fixture internals. A future model run must be a separately reviewed experiment, not a retry of this MovingPlatform trial. There is no MovingPlatform runtime verdict.

## Deferred

- broader generic Studio actions and observations justified by concrete evaluations;
- repeated unseen-task trials and calibrated subjective evaluation;
- reviewed failure-to-regression promotion;
- optional third-party agent runtimes as experimental treatments;
- remote workers, reproducible job infrastructure, or hosted execution only after local experiments demonstrate a measured need;
- asset-provider tools and qualitative asset evaluation.
