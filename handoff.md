# Forge Handoff

## Read this first

This repository is intentionally in a large dirty worktree containing the canonical runtime/evaluation rewrite. Do not reset, clean, stash, restore deleted paths, or discard untracked files. Treat every existing change as user-owned. Inspect `git status` and the relevant implementation before editing.

The single MovingPlatform experiment has been consumed. Do not retry it, tune its prompt, change its model, or run its hidden Studio evaluation. No candidate was produced.

The user performs every Roblox Studio action. Codex must never operate Studio. When Studio evidence is needed, give the user the exact commands, generated place path, plugin version, and click sequence.

## Mission and documentation authority

Forge is a Roblox-specific agent harness and runtime-evaluation system. Models may choose designs and implementations; Forge owns bounded project access, semantic authority, local verification, factual Studio observation, backend grading, evidence, and experiment discipline. The evaluated unit is model + harness + tools + environment + evaluator configuration.

Current documentation is divided by concern:

- [README.md](README.md) — setup and entry point.
- [docs/FORGE.md](docs/FORGE.md) — canonical architecture and product thesis.
- [docs/EVALS.md](docs/EVALS.md) — evaluation authority and status meanings.
- [docs/ROADMAP.md](docs/ROADMAP.md) — demonstrated status and immediate next work.
- [docs/RESEARCH.md](docs/RESEARCH.md) — research/evidence navigation.
- [docs/agent-runtime-report.md](docs/agent-runtime-report.md) — current native-runtime rationale.
- [docs/deep-research-report.md](docs/deep-research-report.md) — foundational transformation rationale.

Research records are evidence, not current APIs. Root [AGENTS.md](AGENTS.md) contains operating rules.

## Current architecture

```text
creator request + RequirementSet
  -> builder-visible RequirementView
  -> source-free AgentOrientation
  -> ForgeNativeAgentRuntime
       -> one-step ModelClient.complete
            -> Vercel AI SDK Core generateText
            -> OpenRouter
       -> eight bounded Forge-owned tools
       -> BuildPlan
       -> isolated candidate workspace
  -> frozen WorkspaceDelta
  -> mandatory independent local verifier
  -> sealed WorkspaceCandidateArtifact (only if locally eligible)
  -> protocol-v12 generic Studio capabilities
  -> factual runtime observations
  -> backend-only grading
  -> RuntimeProofBundle + BuildTrace
```

The generic packages are `contracts`, `semantic-authority`, `semantic-map`, `context-compiler`, `luau-toolchain`, `verifier`, `model-client`, `agent-runtime`, `flight-recorder`, `studio-protocol`, `studio-bridge`, `studio-capabilities`, `studio-runtime`, `proofs`, and `cli`.

The builder tools are `project.list`, `project.search`, `project.read`, `project.inspect`, `plan.update`, `workspace.write`, `workspace.diff`, and `forge.verify`. Forge owns turns, continuation, budgets, tool execution, stopping, workspace freezing, and final verification. AI SDK Core is only a one-turn transport adapter.

The supported CLI surface is exactly:

```text
forge agent build
forge candidate evaluate
forge studio canary
forge studio bridge
forge verify
forge trace show
```

Local status vocabulary is `eligible`, `locally_eligible`, `rejected`, and `incomplete`. `runtime_verified` is scoped to one exact candidate, runtime definition, capability set, evaluator configuration, and authoritative Studio run.

## Protocol-v12 capability canary

The user-run protocol-v12/plugin-8.0.0 non-evaluative canary completed successfully:

- canary: `studio_capability_canary_beef4ad696113cbf8b69de7e`;
- canary hash: `beef4ad696113cbf8b69de7e5518eae0f107630dd6f51c2a454c5db34cd426cb`;
- execution plan: `studio_execution_plan_7e138ef9465e5a60ab1aae3d`;
- record: [.forge/studio-canaries/studio_capability_canary_beef4ad696113cbf8b69de7e.json](.forge/studio-canaries/studio_capability_canary_beef4ad696113cbf8b69de7e.json).

It returned six bounded factual results: three instance resolutions, two endpoint-position observations, and one four-sample platform-position series. It established only pairing, correlation, bounded capability execution, finite observations, direct `EndTest` return, cleanup, and transport integrity. It created no candidate verdict, `RuntimeEvalDefinition`, `RuntimeProofBundle`, or benchmark result.

## Preserved pre-trial transport failures

Two OpenRouter requests failed before any valid assistant envelope. Both have `trialStarted: false`, consumed no model trial, made no writes, and remain preserved.

### Required-parameter routing failure

- AgentRun: `agent_run_abb6e8b4-a309-4a72-a62f-b863bb876490`
- HarnessConfiguration: `harness_configuration_b71182798afacbdd51cc7c03`
- BuildTrace: `trace_48bfeb73-776e-4e6c-ab04-906bb9193d9e`
- Final-verifier trace: `trace_e96457ac-6cd1-43ad-a648-a86dbbd6b1fe`
- Result: HTTP 404, `provider_failure`, `trialStarted: false`
- Record: [.forge/agent-runs/moving-platform/agent_run_abb6e8b4-a309-4a72-a62f-b863bb876490.json](.forge/agent-runs/moving-platform/agent_run_abb6e8b4-a309-4a72-a62f-b863bb876490.json)

Cause: the request combined `require_parameters: true` with `parallel_tool_calls: false`, but current OpenRouter OpenAI endpoint metadata does not advertise `parallel_tool_calls`; strict routing filtered every endpoint. Correction: omit the provider field and keep Forge's atomic whole-batch validation plus deterministic sequential dispatch as the authoritative execution boundary.

### Provider tool-name failure

- AgentRun: `agent_run_19908dfb-14b7-4476-88f3-3b20c68341c8`
- HarnessConfiguration: `harness_configuration_e6d37bc36e056b95b03947ce`
- BuildTrace: `trace_b2c3f30b-d287-4d31-b325-a35e249dca07`
- Final-verifier trace: `trace_a1b78d15-dd6b-4c61-970f-2193fa9c6cd2`
- Result: HTTP 400, `provider_failure`, `trialStarted: false`
- Record: [.forge/agent-runs/moving-platform/agent_run_19908dfb-14b7-4476-88f3-3b20c68341c8.json](.forge/agent-runs/moving-platform/agent_run_19908dfb-14b7-4476-88f3-3b20c68341c8.json)

Cause: dotted public names such as `project.list` are invalid OpenAI function names. Correction: the isolated OpenRouter adapter deterministically maps public names to underscore wire names, reverses returned calls, validates collisions, and records `toolNameEncoding: openai_function_slug_v1` in harness identity. Public runtime/tool contracts remain dotted and provider-neutral.

Both corrections passed the complete deterministic suite before another provider request.

## Consumed MovingPlatform trial

The sole real trial is permanently preserved:

- AgentRun: `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286`
- AgentRun record: [.forge/agent-runs/moving-platform/agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286.json](.forge/agent-runs/moving-platform/agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286.json)
- AgentRun file SHA-256: `0646e6d333f984d1cc7e1ffb13be5db6e2115130ca4929c89e6d41abe4423421`
- HarnessConfiguration: `harness_configuration_bca40ea4ef667a18a61089e9`
- HarnessConfiguration hash: `bca40ea4ef667a18a61089e977cb7858205d71011f0981cab14fdf62f7579f5a`
- BuildTrace: `trace_c762aefb-5e68-4372-85aa-529c88e44c81`
- BuildTrace record: [.forge/flight-recorder/trace_c762aefb-5e68-4372-85aa-529c88e44c81.json](.forge/flight-recorder/trace_c762aefb-5e68-4372-85aa-529c88e44c81.json)
- Final-verifier trace: `trace_17bca836-76cf-4db4-ba1d-93fb3727a851`
- Final-verifier trace record: [.forge/flight-recorder/trace_17bca836-76cf-4db4-ba1d-93fb3727a851.json](.forge/flight-recorder/trace_17bca836-76cf-4db4-ba1d-93fb3727a851.json)
- Model: `openai/gpt-5.6-terra`, OpenAI-only routing, medium reasoning, no fallback
- Result: `incomplete / agent_failure`
- `trialStarted: true`
- Studio: `not_run`
- Final local gate: `incomplete`
- Usage: 7 model turns, 6 tool calls, 1 requested verifier call, 16,217 input tokens, 1,817 output tokens, USD 0.0338551, 26,880 ms
- Workspace effect: 0 successful writes, 0 changed files, no exhausted budget
- Output: no sealed `WorkspaceCandidateArtifact`, no runtime evaluation, no runtime proof

The model inspected the project, authored a coherent BuildPlan, and planned a server-side controller. It attempted these paths:

1. `ServerScriptService/MovingPlatformController.server.lua`
2. `MovingPlatformController.server.lua`

Both writes were rejected with `PATH_FORBIDDEN`. It then invoked `forge.verify` and ended the session. The independent final verifier ran and remained incomplete on the unchanged seed.

## Root-cause diagnosis

This is a harness/context failure, not evidence of model implementation failure or MovingPlatform runtime failure.

Forge correctly enforced the relative writable root `src/server`, but that root existed only inside private `HarnessConfiguration.capabilityPolicy`. It was absent from:

- provider-visible `AgentOrientation`;
- `project.list` (which returned `[]` because the root contained only `.gitkeep`);
- `project.inspect` (which returned world facts but no source roots);
- the `workspace.write` description and result guidance.

The model therefore had no valid evidence from which to infer `src/server`. The security boundary worked, but the capability was unusable for an empty greenfield root.

Do not repair this failure by weakening path validation, accepting Roblox service paths as filesystem paths, moving evaluator data into context, prompt-tuning, or retrying the consumed run.

## Immediate next task

Implement the smallest reviewed harness correction:

1. Add a deterministic regression with an empty declared source root proving the builder can discover the writable relative root before planning or writing.
2. Add sanitized source-root capability facts to the provider-visible orientation or an equivalently explicit generic tool result. Expose only canonical relative roots such as `src/server`; never expose absolute host paths.
3. Make `workspace.write` guidance explicitly say that paths are candidate-relative and must begin with one of the declared source roots.
4. Keep path traversal, symlink, extension, stale-hash, absent-file, budget, evaluator-leakage, and hidden-data protections unchanged.
5. Prove an empty-root fake-provider trajectory can plan, create `src/server/<agent-chosen-name>.server.lua`, receive verifier feedback, and finish locally eligible.
6. Record the new orientation/tool-description/configuration hashes. Do not mutate old AgentRuns or traces.

Stop after the deterministic harness fix and complete local validation. Do not make another model request. Any future real run must be a separately reviewed experiment with a new identity and explicit authorization; it is not a retry of this MovingPlatform trial.

## Validation baseline

Immediately before the consumed trial and after each transport correction:

- `git diff --check` passed;
- 39/39 Node tests passed;
- plugin parse, `luau-analyze`, and Lune module tests passed;
- no budget was exhausted;
- all three AgentRuns retained the same seed hash `a382f25f29dbdb1b7dde7e2b134ffe011c60edb993a81506030e450e1e1890ef`.

Use the repository runners:

```sh
npm test
git diff --check
```

Tests must not make a real model request or run Studio. Preserve all `.forge` evidence and the intentionally dirty worktree.
