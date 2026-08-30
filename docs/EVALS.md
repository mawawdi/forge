# Forge Evaluation Policy

## What Forge measures

Forge evaluates the combined system, not a model in isolation:

```text
model + prompt/configuration + tools + workspace policy + verifier + environment
```

A run records outcome, failure class, model/tool calls, token and cost use,
latency, changed source, verification result, and Studio/evaluator evidence
when those tiers run. Do not collapse these into one invented score.

## Evidence tiers

| Tier | Honest claim |
| --- | --- |
| Schema | A supplied artifact has the expected shape. |
| Luau / static | The loaded source passes modeled language and security checks. |
| Preflight | A modeled non-engine execution behaved as expected. |
| Studio | A correlated real Roblox session observed the runtime claim. |
| Evaluator / human | A subjective outcome was assessed. |

Studio evidence is required for engine, replication, physics, and runtime-world
claims. A static pass, tool success, or log line is not runtime proof.

## Task information boundary

Every executable task separates what the builder may learn from what an
evaluator may use:

```text
builder:   creator goal, visible outcomes, observed project facts,
           visible policy, bounded tools
evaluator: evaluator-only requirements, hidden assertions/oracles,
           adversarial inputs, grader implementation, answer artifacts
```

M4.0 `RequirementSet` and `resolveRequirementView` enforce the boundary.
Requirements and `AcceptanceSpec` never embed hidden assertion bodies or
expected values in builder-visible material.

## Status vocabulary

- `locally_eligible`: M4.1’s independent static/semantic gate passed.
- `verified`: only use when the required evidence tiers for that task passed;
  a Studio-required task cannot be verified with `studio: not_run`.
- `rejected`: an applicable deterministic gate failed.
- `incomplete`: evidence, tools, provider, environment, or budget was missing
  or interrupted.

Failure classification distinguishes agent, tool, workspace capability,
provider, verifier, harness, evaluation, environment, and task/specification
causes. A low outcome is not automatically model failure.

## CoreLoopBench direction

The ten historical CoreLoopBench concepts remain a useful coverage map:
collection, conversion, progression, remote wiring, persistence, UI state,
physics, cooldown/combat, repair, and composition. Their M1–M3.5 contracts,
harnesses, constants, and assertions are historical fixture scope—not general
production semantics.

M4.3 will turn representative concepts into repeatable agent tasks with
isolated hidden evaluators. Before that, Forge should prefer a small number of
well-instrumented experiments over a synthetic leaderboard.

## Experiment rules

Hold the task fixed while changing one material dimension where practical:
model/version, system prompt, orientation, tool surface, capability policy,
verifier/rule version, or evaluator configuration. Record the exact
`HarnessConfiguration` and task/view identities.

Initial M4.1 budgets are conservative experimental caps, not optimized
thresholds. Retain configured value, consumption, and exhaustion reason.
Preserve failed runs; promote a failure to regression only after diagnosis and
review.

## Current M4.1 evidence

Fake-provider integration tests prove same-session verifier feedback and a
mandatory independent final local gate. The sole reviewed Claude-adapter run
used `claude-sonnet-5` with SDK `0.3.251` and stopped before any model call
because `ANTHROPIC_API_KEY` was unavailable. It is `incomplete` /
`provider_failure`, with zero tool calls and `studio: not_run`. No retry or
tuning followed it.

Detailed historical Studio runs, faults, and recovery evidence are retained in
[research/m3-real-studio-runs.md](research/m3-real-studio-runs.md).
