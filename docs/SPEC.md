# Forge Specification

Status: M1–M3.5 and M4.0 are preserved historical work. M4.1 provides a
bounded builder seam but its sole real run is incomplete; it made no model or
Studio call because provider credentials were unavailable.

## Purpose

Forge is a Roblox-specific harness and evaluation system for game-building
agents. It makes the combined `model + harness + tools + environment`
observable, bounded, falsifiable, and improvable.

The agent may choose game design, implementation, and tool use. Forge owns:

- truthful project and runtime observation;
- Roblox platform and trust-boundary policy;
- bounded workspace capabilities;
- deterministic checks where they are honest;
- real-Studio evidence for engine/runtime claims;
- requirement provenance, evidence, traces, and regression discipline.

Forge must not become a compiler or ontology for every game mechanic.

## Current architecture

The preserved M1–M3.5 slice remains a regression and integration path:

```text
intent -> exact historical contract -> PatchSet -> local verification
       -> optional StudioProof -> ProofBundle
```

Post-M3.5 work is additive:

```text
creator goal + RequirementSet
  -> source-free orientation + bounded tools
  -> agent-owned BuildPlan and candidate workspace
  -> independent local gate
  -> future Studio/evaluator evidence as required
```

The historical path is evidence, not the production design for arbitrary new
mechanics. `MechanicContract`, `MechanicImplementationSpec`, exact harnesses,
and PatchSets remain valid only where their historical or integration
provenance makes them applicable.

## Requirements and authority

Any constraint that can guide generation, reject a candidate, or grade an
outcome needs source, authority, visibility, enforcement, verification modes,
and evidence. M4.0 provides this through `RequirementSet` and one scoped view
resolver.

- Creator outcomes outrank agent preferences.
- Validated platform policy cannot be overridden by creator preference.
- Project observations describe the before-state; preservation requires an
  explicit integration constraint.
- Benchmark oracle and evaluator-only material stay outside builder views.
- Agent plans are hypotheses, not policy.

See [semantic authority RFC](rfcs/semantic-authority.md) for the exact
contracts and resolver behavior.

## Evidence vocabulary

| Term | Meaning |
| --- | --- |
| `VerificationReport` | Local language/static/semantic result. It makes no engine claim. |
| `BuildTrace` | Privacy-minimized execution record with hashes and references. |
| `ProofBundle` | Compact evidence for a historical verification or commit decision. |
| `AgentRun` | Private M4.1 trajectory, tool results, budgets, and classification. |
| `locally_eligible` | M4.1 independent local gate passed. This is not fully verified. |
| `studio: not_run` | No Roblox runtime claim exists. |

Studio is authoritative for Roblox engine, replication, physics, and runtime
world behavior. Output logs, a successful tool invocation, or a local mock
never substitute for Studio proof.

## Non-goals

Forge does not currently provide a multi-agent framework, generic game
ontology, arbitrary-code Studio test interpreter, model routing system,
hosted workers, production creator UX, or asset-generation platform. These are
not implied by the presence of a tool-using builder.

## Public operation

`forge verify <project>` runs the preserved local verifier. `forge agent build
<project> --prompt ... --requirements ...` starts the M4.1 bounded-builder
experiment. The latter requires a reviewed task and a provider configuration;
the agent can only work through Forge-owned tools.

`npm test` is the repository acceptance command. It covers Node and plugin
tests, not real Studio execution.

## Reading order

Read [deep-research-report.md](deep-research-report.md) for the durable
transformation direction. Read [ARCHITECTURE.md](ARCHITECTURE.md) for current
boundaries, [ROADMAP.md](ROADMAP.md) for status, and [EVALS.md](EVALS.md) for
measurement rules. Historical evidence lives in `docs/research`; precise
implemented decisions live in `docs/rfcs`.
