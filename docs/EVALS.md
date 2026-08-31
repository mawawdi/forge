# Forge Evaluation Policy

This document is the canonical policy for what Forge may claim from a build or evaluation. [FORGE.md](FORGE.md) defines the architecture; [ROADMAP.md](ROADMAP.md) records demonstrated status; [RESEARCH.md](RESEARCH.md) indexes the evidence and rationale behind those decisions.

## Semantic authority

Every requirement that can influence generation, rejection, or grading records five independent dimensions:

- source: creator, project observation, platform policy, agent plan, evaluator, or benchmark oracle;
- authority: fact, policy, hypothesis, or evaluation-only;
- visibility: builder-visible, evaluator-only, or internal;
- enforcement: informational, advisory, or blocking;
- source-aligned evidence with a stable identity or hash.

Creator requirements outrank agent design preferences. Platform policy cannot be overridden by creator or agent preference. Project observations describe the observed before-state; they require preservation only when an explicit, evidenced `IntegrationConstraint` says so. Evaluator criteria and benchmark oracles have authority only inside their declared evaluation scope.

## Evidence tiers

Forge interprets evidence in this order:

1. schema validation establishes data-shape truth;
2. official Luau and Roblox-aware analysis establishes language and loaded-host facts;
3. Forge static checks establish only explicitly modeled structural and trust properties;
4. a sealed candidate and independent local verifier establish local eligibility;
5. correlated real-Studio observations establish engine/runtime facts;
6. backend assertions grade those observations under one exact evaluator configuration;
7. independent evaluator or human judgment may assess subjective product quality.

Later tiers do not retroactively strengthen earlier claims. A local pass is not Studio evidence, and an evaluator model cannot override a deterministic security or runtime failure.

## Status vocabulary

- `eligible`: the independent local verifier passed.
- `locally_eligible`: an `AgentRun` produced a sealed candidate whose independent local gate passed.
- `runtime_verified`: the exact candidate satisfied the exact `RuntimeEvalDefinition` under the exact `StudioCapabilitySet` and `RuntimeEvaluatorConfiguration` in one authoritative Studio run.
- `rejected`: deterministic candidate or project behavior failed an applicable modeled requirement or runtime assertion.
- `incomplete`: required provider, tool, project, protocol, Studio, environment, or evaluator evidence was insufficient.
- `not_run`: the relevant gate was deliberately not executed.

`runtime_verified` is not universal mechanic correctness, complete physics verification, subjective quality, fun, or general game quality.

## Hidden-evaluation boundary

Builder inputs may contain the creator request, builder-visible requirements, sanitized project facts, universal policy outcomes, and bounded tool results. They must not contain hidden assertion bodies, expected observations, benchmark oracle values, evaluator implementation, successful answer-key source, Studio runner source, or private runtime observations.

`AcceptanceSpec` carries references only. Studio receives a redacted `StudioExecutionPlan` containing typed targets, calls, bounds, and correlation data—not assertions or expected values. The plugin reports factual observations; backend code performs grading.

## Experiment discipline

- Treat model, prompt, harness configuration, tool descriptions, budget policy, provider transport, runtime adapter, evaluator definition, capability set, and environment as explicit experimental variables.
- Change one meaningful variable at a time when possible.
- Preserve failures and classify them among model, context, tool, harness, verifier, grader/evaluator, environment, provider, and task specification.
- Do not tune or retry around the single-run MovingPlatform experiment.
- Promote a failure into a regression only after its cause and fixture have been reviewed.
- Record tokens, cost, tool calls, verifier calls, changed files, latency, budget consumption, and exhaustion without inventing a composite score.
- Treat `AgentRun.trialStarted` as the irreversible real-trial boundary. It becomes true only after a valid provider assistant envelope; provider authentication, configuration, malformed-envelope, and pre-response timeout failures remain transport setup failures.
- Once `trialStarted` is true for the single MovingPlatform run, preserve the result without retrying, prompt tuning, or changing the model. A semantically invalid tool request still starts the trial.

## Current evidence boundary

Local tests exercise provenance filtering, native multi-turn tool use, reasoning-detail continuation, atomic invalid-batch rejection, verifier-feedback repair, provider and budget failures, workspace safety, protocol correlation, malicious payload containment, backend runtime grading, and scoped proof construction. Provider response facts are bounded and normalized; API keys, headers, raw reasoning bodies, and unsanitized provider pipeline data are not run or trace evidence.

The protocol-v11 characterization in the [Studio capability evidence ledger](research/studio-capability-evidence.md) remains evidence only for that historical substrate. Protocol-v12/plugin-8.0.0 readiness is established separately by completed non-evaluative canary `studio_capability_canary_beef4ad696113cbf8b69de7e`, which returned six bounded factual observations. That canary establishes no candidate verdict or runtime proof.

The sole real MovingPlatform trial, `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286`, crossed `trialStarted` and ended `incomplete / agent_failure` before producing a candidate. Its enforced `src/server` capability was absent from all provider-visible orientation and tool results, so two plausible writes were rejected with `PATH_FORBIDDEN`. This is classified as a harness/context defect. There is no sealed candidate, hidden Studio evaluation, `RuntimeProofBundle`, or `runtime_verified` MovingPlatform result. The trial must not be retried or reinterpreted as model or runtime failure.
