# Forge Roadmap

This document is the canonical status and next-work record. [ARCHITECTURE.md](ARCHITECTURE.md) defines the implemented and target architecture, [FORGE.md](FORGE.md) defines thesis and invariants, [EVALS.md](EVALS.md) defines claim semantics, and [RESEARCH.md](RESEARCH.md) indexes the evidence behind the direction.

## Demonstrated foundation

The repository currently contains:

- provenance-aware requirements, visibility, enforcement, evidence, and scoped requirement views;
- source-free project orientation with builder-visible canonical source roots and eight bounded Forge-owned builder tools;
- a provider-neutral `AgentRuntime`, Forge-owned multi-turn loop, and isolated one-step AI SDK Core/OpenRouter `ModelClient` that preserves bounded opaque reasoning continuation;
- atomic tool-call batch validation, run-wide unique call IDs, sequential Forge-owned dispatch, bounded response facts, and an explicit `trialStarted` boundary;
- isolated candidate workspaces, agent-owned plans, deterministic harness configuration identity, budget accounting, independent local verification, and sealed candidate artifacts;
- protocol v12/plugin 8.0.0 with the three generic Studio capabilities `instance.resolve@1`, `base_part.position@1`, and `base_part.position_series@1`;
- candidate-independent runtime definitions, data-only Studio execution plans, backend grading, runtime runs, scoped runtime proofs, and privacy-minimized traces;
- one unseen MovingPlatform seed/task/evaluator split with evaluator thresholds kept outside builder-visible inputs.

The current local suite passes 44 Node tests plus plugin parsing, analysis, and module tests. The CLI exposes eight canonical commands, including the registration/build/evaluate experiment path.

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

The root cause was harness/context: `src/server` was enforced as the writable root but was not visible in orientation, `project.list`, `project.inspect`, or the write-tool description. The model could not infer the valid path from an empty source tree. Its two writes were rejected with `PATH_FORBIDDEN`. The consumed experiment will not be retried or tuned.

## Completed harness correction

- `AgentOrientation` v2 exposes sorted, unique canonical candidate-relative `sourceRoots` before the first builder turn. Absolute, backslash, dot-segment, traversal, duplicate, and non-canonical roots fail closed.
- `workspace.write` now describes candidate-relative root requirements and explicitly directs the builder to `orientation.content.sourceRoots`.
- A dedicated empty-root fixture and scripted provider prove the builder observes `src/server`, publishes a plan, creates `src/server/Bootstrap.server.luau` with an absent-file guard, receives `locally_eligible` verifier feedback, and seals a candidate. The test makes no provider or Studio call.
- The corrected treatment records orientation content hash `292532c19fd966796c62c6af4ef0e4d6ebd298c9e3bd645ad197064424d1ffbd`, ordered tool-description hash `b84ebc2580666fb7c8711d9d81ad08525b72b9b1ad2b29641d92ef9df0a72d8b`, and harness configuration `harness_configuration_9c8fa37507f13c2a7f8aa837` / `9c8fa37507f13c2a7f8aa837167bf668ba5f48a9608a8229480de75028731f98`.

The historical MovingPlatform records remain unchanged. There is still no MovingPlatform candidate, hidden Studio evaluation, runtime proof, or runtime verdict.

## Registered Vertical Shuttle build

The fresh Vertical Shuttle treatment has `Shuttle`, `LowerStop`, `UpperStop`, and an empty `src/server` root. It is not a MovingPlatform retry.

`ExperimentRegistration` v1 is now the canonical pre-provider treatment identity. The preserved Vertical Shuttle registration is `experiment_registration_60857fefe801607baa1f6b7d` / `60857fefe801607baa1f6b7d7efb20a568e58aeef8779389ff8eba48fa724185`. It binds the task/evaluator artifacts, `src/server`, seed snapshot `59b4a8ff59327ad1a373b4786dbd3796041bb9b190fa1c48b8436893bc7504bb`, implementation snapshot `9fdc4e6d34057ff3c70ad1d3cbf8ba84cfe8a265be8d97f103fd81bb5529463d`, exact model transport, budgets, and Studio identity. Its expected orientation is `agent_orientation_23f6d0349747779eb09aff49` / `bcb5bc1f95455caa6519c3ed9b8a3a2abf0ffc1240bd69c7a250e0b699ad2ac0`; its ordered-tool description hash is `b84ebc2580666fb7c8711d9d81ad08525b72b9b1ad2b29641d92ef9df0a72d8b`; and its harness configuration is `harness_configuration_073e0763a3c9c35393da67c9` / `073e0763a3c9c35393da67c90c1506c60a47c595480dee8d3ca2fda1c641f9fb`.

The one admitted `openai/gpt-5.6-luna` AgentRun is `agent_run_ba3716f8-4ecc-4bf8-9689-45f41700f179`. It crossed `trialStarted`, ended `locally_eligible`, and consumed six turns, eight tool calls, one verifier call, one write, 21 added lines, and no exhausted budget. It sealed candidate `workspace_candidate_79937cb8767b18d553850b63`; its build and final-verifier traces are `trace_1ea5ad92-d4b1-4212-ba8c-34e9257f26ab` and `trace_e0e5afaa-2b4b-4f1a-abc4-18e3e25d5847`.

The user-triggered, single Studio evaluation completed `runtime_verified` for that exact candidate. The separate runtime evaluation run is `runtime_evaluation_run_35b4ef7f3f9c482d82d498bc` / `35b4ef7f3f9c482d82d498bc1b2c34b79220a4adb6e7f37bbbbbd975aef79295`; its runtime plan is `runtime_eval_plan_5d7c1c5236342ae56fe30ecf` / `5d7c1c5236342ae56fe30ecfc62c4b796829ff075f5ee2e15fe179c7de00542b`; its runtime proof is `runtime_proof_84e4e26fda34ee4dd937597e` / `84e4e26fda34ee4dd937597e40cf849af8c1cf22e012f8653fe053e870fd6ded`; and its evaluation trace is `trace_2d563481-71d9-46ea-b425-bf776d6180a2`. This is evidence only that the exact registered candidate satisfied its exact hidden runtime definition, capability set, and evaluator configuration in this authoritative Studio run—not a general model, harness, or MovingPlatform claim.

## Deferred

- broader generic Studio actions and observations justified by concrete evaluations;
- repeated unseen-task trials and calibrated subjective evaluation;
- reviewed failure-to-regression promotion;
- optional third-party agent runtimes as experimental treatments;
- remote workers, reproducible job infrastructure, or hosted execution only after local experiments demonstrate a measured need;
- asset-provider tools and qualitative asset evaluation.
