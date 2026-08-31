# Forge

## Thesis

Forge is a Roblox-specific agent harness and runtime-evaluation system. A model may choose a design and implementation; Forge owns bounded project access, semantic authority, local verification, real-Studio observation, deterministic grading where the claim supports it, and evidence that makes a run inspectable.

The evaluated unit is the model, harness, tools, environment, and evaluator configuration together. A low score is not automatically model failure, and a passing local check is not engine proof.

## Documentation authority

- This document defines the current architecture and product thesis.
- [EVALS.md](EVALS.md) defines evaluation authority, evidence tiers, and status meanings.
- [ROADMAP.md](ROADMAP.md) records demonstrated status and the next evidence-producing task.
- [RESEARCH.md](RESEARCH.md) indexes foundational rationale and immutable historical evidence.

Research records explain how Forge reached the current design, but they do not override current contracts, protocol versions, or status claims.

## Non-goals

Forge does not compile a creator request into a universal game-mechanic ontology. It does not prescribe names, source layout, constants, or interaction architecture for greenfield work unless the creator, an observed integration constraint, or a universal Roblox policy requires them. It does not expose arbitrary code execution inside Studio, use model output as proof, or treat subjective game quality as deterministic.

The current system deliberately excludes provider-owned agent loops, `ToolLoopAgent`, AI Gateway, multiple providers behind compatibility shims, swarms, hosted workers, asset generation, and mechanic-specific Studio harnesses. Vercel AI SDK Core is used only as the one-turn OpenRouter transport adapter.

## Current flow

```text
creator request + RequirementSet
  -> builder-visible requirement view
  -> source-free project orientation
  -> ForgeNativeAgentRuntime
       -> one-turn ModelClient calls
            -> AI SDK Core generateText
            -> OpenRouter
       -> bounded Forge tools
       -> agent-owned BuildPlan
       -> isolated candidate workspace
  -> frozen WorkspaceDelta
  -> independent local verifier
  -> sealed WorkspaceCandidateArtifact
  -> generic Studio capability execution
  -> factual runtime observations
  -> backend-only grading
  -> RuntimeProofBundle + BuildTrace
```

`ForgeNativeAgentRuntime` owns turns, budgets, tool dispatch, verifier feedback, stopping, workspace freezing, and the independent final gate. `ModelClient.complete` is intentionally a one-turn inference boundary. Its isolated OpenRouter adapter uses AI SDK Core `generateText` for exactly one step; it is not an agent runtime and owns no tool execution or iteration.

The adapter preserves the AI SDK `responseMessages` from an assistant tool-call response as a bounded opaque continuation and replays them unchanged after Forge tool results. This retains OpenRouter reasoning details across tool turns without exposing AI SDK types outside the adapter. Continuation bodies are limited to 256 KiB and stay in memory; `AgentRun` and `BuildTrace` retain only continuation hashes and sizes.

## Semantic authority

Every requirement records five independent axes:

- `source`: creator, project observation, platform policy, agent plan, evaluator, or benchmark oracle;
- `authority`: fact, policy, hypothesis, or evaluation-only;
- `visibility`: builder-visible, evaluator-only, or internal;
- `enforcement`: informational, advisory, or blocking;
- evidence: source-aligned provenance with a stable hash.

Policy resolves a view for a phase, environment, and audience. Visibility and enforceability are separate: an internal isolation policy can gate a candidate without revealing evaluator implementation. Benchmark oracles and evaluator-only bodies never enter builder context or tools. Project observations describe the before-state; only explicit `IntegrationConstraint` objects require preservation. Agent plans are hypotheses, not platform policy.

The current code-owned policy descriptor prohibits production candidate source and builder-visible context from depending on evaluator instrumentation, hidden assertions, benchmark oracles, or expected observations.

## Forge-owned tools

The native builder exposes exactly these bounded operations:

- `project.list`
- `project.search`
- `project.read`
- `project.inspect`
- `plan.update`
- `workspace.write`
- `workspace.diff`
- `forge.verify`

The workspace is copied from a read-only seed. Reads and writes stay inside declared source roots. Writes require either the exact prior SHA-256 or an explicit `absent` precondition, accept only regular `.lua`/`.luau` files, reject traversal and symlink escape, and are bounded by file, line, byte, call, and duration budgets. A high-level agent-owned plan is required before the first write.

Tool descriptions and schemas are versioned harness behavior. `HarnessConfiguration` hashes the system prompt, full tool surface, capability policy, initial orientation identity, requirement-view hash, budget policy, native runtime version, transport version, and exact model configuration. `AgentRun` records normalized turn and tool-result hashes without persisting the API key.

The current transport identity also covers the pinned AI SDK and OpenRouter adapter versions, provider allowlist, disabled fallbacks, required-parameter policy, reasoning effort, retry policy, one-step policy, ordered tool surface, provider wire-name encoding, timeout policy, per-turn output cap, and continuation limit. Dotted public Forge tool names are deterministically encoded as OpenAI-compatible underscore names only at the adapter boundary. The provider request omits `parallel_tool_calls` because current OpenRouter OpenAI endpoint metadata does not advertise that parameter under required-parameter routing. Forge remains authoritative: a model tool-call batch is validated atomically before execution, and a valid batch executes sequentially in returned order. An unknown tool, invalid arguments, empty ID, or ID reused anywhere in the run rejects the whole batch and executes zero tools. Bounded rejection feedback and its resource use remain part of the run evidence.

`AgentRun.trialStarted` becomes true after the first valid provider assistant envelope, including one with a semantically invalid tool request. Authentication, configuration, pre-response timeout, and malformed HTTP failures leave it false. This boundary determines whether a transport defect may be corrected before the one permitted real trial.

## Local eligibility

The local verifier uses official Luau parsing and Roblox-aware analysis when available, plus explicit Forge checks for modeled structural and client/server authority properties. Its gate is:

- `eligible`: the independent local checks passed;
- `rejected`: deterministic candidate behavior violated a modeled requirement;
- `incomplete`: required tools or evidence were unavailable.

An `AgentRun` may become `locally_eligible`, `rejected`, or `incomplete`. `locally_eligible` never means Studio-verified. The sealed candidate binds its seed, source tree, delta, requirement view, harness configuration, AgentRun, and final local report.

## Studio runtime capabilities

Protocol v12 and Forge Studio plugin 8.0.0 expose one generic data-only evaluator route. The capability set contains exactly:

1. `instance.resolve@1` — resolve an explicit `Workspace` target as a `BasePart` family identity;
2. `base_part.position@1` — observe one finite world position from a resolved part;
3. `base_part.position_series@1` — observe a bounded timestamped position series.

The backend sends one canonical JSON string and its SHA-256. Fixed trusted Forge runner source receives that payload through a tested single-string Luau encoder, decodes and validates it again, and returns only factual observations through a nonce-correlated direct `EndTest`. Plan fields never become Luau syntax, identifiers, expressions, callbacks, or arbitrary property access. Pairing, live project/source binding, correlation, bounds, timeout, cleanup, and result size fail closed.

The plugin observes facts; the backend grades them. Evaluator assertions, thresholds, expected values, and rationale never cross into Studio. Studio execution is creator-triggered. Forge automation must print the exact place path and steps, then wait for the user to perform Studio actions.

## Evidence objects

- `RequirementSet`, `RequirementView`, `AcceptanceSpec`, and `IntegrationConstraint` establish authority and audience boundaries.
- `HarnessConfiguration`, `BuildPlan`, `AgentRun`, and `WorkspaceDelta` describe the builder experiment.
- `WorkspaceCandidateArtifact` immutably binds the candidate and its independent local gate.
- `RuntimeEvalDefinition` precommits hidden evaluator semantics independently of a candidate.
- `StudioExecutionPlan` is the redacted data-only runtime projection.
- `RuntimeEvaluatorConfiguration` binds the exact capability set, assertion engine, protocol, plugin, execution policy, and definition.
- `RuntimeEvaluationRun`, `RuntimeProofBundle`, and `BuildTrace` record authoritative observations, scoped grading, links, and privacy-minimized execution evidence.

`runtime_verified` means only that one exact candidate satisfied one exact `RuntimeEvalDefinition` under one exact `StudioCapabilitySet` and `RuntimeEvaluatorConfiguration` in one authoritative Studio run. It is not universal mechanic correctness, complete physics verification, subjective quality, or general game quality.

## Hidden-evaluation boundary

The builder receives the creator request, visible requirements, sanitized project facts, universal policy outcomes, and bounded tools. It cannot read evaluator directories, benchmark oracle bodies, expected observations, fixture solutions, Studio runner source, secrets, or hidden thresholds. `AcceptanceSpec` carries only requirement, assertion, and artifact IDs. Private runtime observations remain outside public AgentRun and BuildTrace content.

## MovingPlatform experiment

The only repository example is `examples/moving-platform`:

- `seed` contains an anchored `MovingPlatform`, `EndpointA`, `EndpointB`, and an empty server source root;
- `task` contains creator and observation provenance plus an internal evaluator-isolation policy;
- `task/evaluator` contains benchmark-scoped runtime assertions and configuration outside the seed.

The creator asks for continuous back-and-forth movement taking about two seconds each way while preserving the three world objects. The agent chooses its script name and implementation. Runtime endpoint coordinates come from authoritative `base_part.position@1` observations. Sample counts, tolerances, timing windows, and the `src/server` task restriction are evaluator constraints, not universal MovingPlatform semantics or platform policy.

## Honest status

The provider-neutral contracts, native multi-turn harness, one-step AI SDK Core/OpenRouter adapter, reasoning-safe continuation, atomic tool-batch enforcement, safe workspace, verifier, sealed candidate, protocol v12, generic capability executor, backend grading, proof linkage, and fake-transport tests are implemented. The current suite passes 39 Node tests plus plugin parsing, analysis, and module tests.

The user-run protocol-v12/plugin-8.0.0 capability canary completed as `studio_capability_canary_beef4ad696113cbf8b69de7e`, bound to `studio_execution_plan_7e138ef9465e5a60ab1aae3d`. It returned six bounded factual results and established only the generic Studio transport/capability substrate; it created no candidate verdict, runtime proof, or benchmark result.

The sole MovingPlatform model trial is `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286` under `harness_configuration_bca40ea4ef667a18a61089e9`. It crossed `trialStarted`, used seven model turns, six tool calls, one requested verifier call, 16,217 input tokens, 1,817 output tokens, USD 0.0338551, and 26,880 ms. The run ended `incomplete / agent_failure`, with `studio: not_run`, no writes, no sealed candidate, and final local gate `incomplete`.

The failure is classified as a harness/context defect. The allowed `src/server` root was present in private capability configuration but absent from provider-visible orientation and tool results. Because the seed contained no source files, `project.list` returned an empty list and `project.inspect` exposed world facts but no writable root. The model created a coherent plan, attempted `ServerScriptService/MovingPlatformController.server.lua` and `MovingPlatformController.server.lua`, received `PATH_FORBIDDEN` for both, invoked `forge.verify`, and stopped. This result is not evidence that the candidate failed at runtime: no candidate existed and Studio evaluation was not run.

## Immediate next task

Minimize the missing-source-root disclosure into a deterministic harness regression, then expose declared writable roots through the provider-visible capability/orientation boundary without leaking host paths or evaluator data. Do not retry or tune the consumed MovingPlatform experiment. Any later real trial requires a separately reviewed experiment identity and task policy.

## Deferred

- broader Studio actions and observations justified by concrete evals;
- repeated unseen-task trials and calibrated subjective evaluation;
- reviewed failure-to-regression promotion;
- remote workers or reproducible job infrastructure only after local experiments create a measured need.
