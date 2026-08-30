# AGENTS.md

## Mission

Forge is a Roblox-specific **agent harness and evaluation system**.

Its job is not to know the correct implementation of every game mechanic. Its job is to make increasingly capable game-building agents observable, testable, falsifiable, recoverable, and empirically improvable.

The model/agent may own novel game design, planning, implementation choices, and tool use. Forge owns truthful project/runtime observation, bounded capabilities, universal Roblox/platform safety policies, deterministic validators where honest, real-Studio runtime evaluation, evidence, tracing, regression promotion, rollback, and experiment discipline.

The unit we ultimately evaluate is **model + harness + tools + environment**, not the model in isolation.

## Current direction

M1 through M3.5 are completed historical vertical-slice work. Preserve them.

Post-M3.5, do **not** scale Forge by hand-authoring a new mechanic compiler, `MechanicImplementationSpec`, or exact harness for every new game feature.

The direction is:

```text
creator request
  -> model-derived high-level BuildPlan / requirements
  -> tool-using builder operating on observed project state
  -> candidate game state
  -> verification/evaluation bus
       - Luau / Roblox validation
       - universal authority/security policy
       - structural/project checks
       - real Studio gameplay checks
       - independent evaluator where judgment is genuinely subjective
  -> pass / feedback / repair
  -> trace + proof
  -> reviewed failure -> regression/eval
```

Do not turn this into a giant formal game ontology. Hand-write universal platform/trust semantics, not every possible game mechanic.

## Source of truth

This file contains durable operating rules, not the whole design.

Read only what is relevant:

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/EVALS.md`
- `docs/rfcs/*`
- the post-M3.5 deep-research report in `docs/`
- `docs/research/m3-real-studio-runs.md`
- `docs/research/m3.25-luna-candidate-diagnosis.md`
- `docs/research/lemonade-plugin-review.md`

Milestone status belongs in `ROADMAP.md`. A deeper `AGENTS.md` overrides this file for its subtree.

If docs and implementation disagree, investigate and report the discrepancy. Never silently choose whichever makes a task easier.

## Preserve history

Historical runs are evidence, not debris.

Never rewrite, delete, or relabel an old BuildTrace, ProofBundle, candidate artifact, PatchSet, failed Studio run, regression fixture, or verifier result because a later harness, verifier, model, or toolchain improves.

A corrected system creates a **new** result linked to the old one.

M1–M3.5 behavior may remain as legacy regression coverage while new architecture is introduced beside it.

## Semantic authority: provenance is mandatory

Every requirement or constraint that can affect generation, rejection, or grading must have a reason it is authoritative.

Conceptual sources:

- `creator` — explicitly requested by the user.
- `project_observation` — factual state discovered from files or live Studio.
- `platform_policy` — universal Roblox/Forge correctness or safety rule.
- `agent_plan` — design/implementation decision proposed by the agent.
- `evaluator` — acceptance interpretation for the current task.
- `benchmark_oracle` — hidden condition belonging only to an eval fixture.

Conceptual authority classes:

- `fact`
- `policy`
- `hypothesis`
- `evaluation_only`

Forge may deterministically reject a production candidate for violating a validated creator requirement, observed existing-project integration fact, universal platform/security policy, or explicit acceptance requirement with legitimate provenance.

Forge must **not** reject a novel implementation merely because it differs from an unstated Forge design preference.

An `agent_plan` decision is not universal truth. Verify it for internal coherence, platform safety, and observed outcome.

A `benchmark_oracle` is valid inside its benchmark only. It must never silently become production semantics.

## Existing project vs greenfield design

For an existing project, Forge may enforce discovered facts such as an existing RemoteEvent path, public module/API, state representation, prompt/UI binding/tag/world object, or schema compatibility required to preserve verified behavior.

For a greenfield game, let the agent choose names, paths, constants, decomposition, and implementation details unless the creator or universal policy constrains them.

Do not confuse **integration constraints** with **game design authority**.

## Legacy semantic objects

`MechanicContract`, `MechanicImplementationSpec`, `InteractionBinding`, and the exact Collect/Sell harnesses remain valuable historical/eval artifacts.

Post-M3.5:

- do not delete them merely because architecture is evolving;
- do not require them as the production architecture for every new mechanic;
- `MechanicImplementationSpec` should increasingly mean benchmark oracle or existing-project integration constraint, not “Forge pre-designs every mechanic”;
- `InteractionBinding` should increasingly be derived from project facts or agent-authored design and then verified;
- exact mechanic harnesses remain regression fixtures, not the scalable Studio testing model.

Any new mechanic-name-specific hardcoding requires explicit justification.

## Outcome over implementation path

Prefer grading observable outcomes over requiring one exact source structure.

Exact implementation/path constraints are appropriate only when they come from existing-project compatibility, security/capability boundaries, creator requirements, or benchmark conditions intentionally testing that interface.

Do not leak expected implementation into the agent environment. Do not make an eval harder by requiring irrelevant implementation details.

If a model appears to fail badly, investigate whether the failure is in the model, harness, context, tool, environment, grader/eval, or task specification.

Low score is not automatically model failure.

## Deterministic where honest

Use deterministic checks where they truly answer the question:

- Luau syntax/type validity;
- Roblox API misuse;
- path/instance existence;
- RemoteEvent direction/arity;
- untrusted client data reaching authoritative state;
- DataStore/client boundary violations;
- exact state transitions observable in Studio;
- regression assertions.

Do not pretend subjective questions are deterministic: map quality, pacing, readability, game feel, visual coherence, fun, or comprehensibility may require an independent evaluator model and/or human calibration.

An evaluator model cannot override a failed deterministic security/runtime invariant.

## Model freedom and harness responsibility

Do not freeze today's model limitations into permanent architecture.

The agent should increasingly receive the creator goal, high-level acceptance outcomes, tools for project search/inspection/editing/testing, observed project facts, universal policies, and budgets/checkpoint rules.

It should increasingly discover needed context through tools instead of Forge attempting to precompute a perfect giant prompt.

The Context Compiler remains useful for provenance, deterministic context, caching, and experiments. It is not required to be the only way an agent learns about a project.

Do not add an agent swarm by default. Add planner/builder/evaluator roles only when an experiment or long-horizon requirement justifies the separation.

## Verification trust hierarchy

1. schema/data validation — data-shape truth;
2. official Luau + Roblox-aware analysis — language/loaded-host facts;
3. Forge static/semantic policy checks — only explicitly modeled properties;
4. pure-Luau/Lute/Lune preflight — modeled execution, never engine truth;
5. real Roblox Studio — authoritative for engine, replication, physics, and runtime world behavior;
6. independent evaluator/human signal — subjective/product judgment only.

Unknown is not safe.

Missing source, project facts, tooling, runtime evidence, or unsupported dynamic behavior remains unknown/incomplete rather than passing.

## StudioProof

Preserve the hard-won Studio trust boundary.

- The Forge Studio Plugin is the product-specific Studio execution boundary.
- Output/`LogService` is diagnostics, never proof.
- Only validated and correlated real-Studio evidence may satisfy runtime claims.
- Temporary harness/driver code is instrumentation, not candidate game state.
- Interrupted, stale, malformed, disconnected, timed-out, partial, duplicated, or mismatched runs fail closed.
- Rollback/restoration claims require observed revision/state evidence.
- `ChangeHistoryService` is an undo facility, not database atomicity.
- Never use production persistence to make an eval pass.

The current Collect and Collect+Sell registered harnesses remain immutable historical regressions.

The scalable future direction is **general Studio capabilities/actions/observations**, not one handcrafted authoritative harness per mechanic. Do not build a universal arbitrary-code test interpreter.

## Security and Roblox policy

Universal rules belong in Forge.

For state-changing client -> server flows, reason about applicable trust properties such as input/value validation, context/range/state validation, permission/ownership when applicable, rate/cooldown control when applicable, server-owned calculation/mutation, and persistence boundaries.

Rules should be based on dataflow/semantics, not comments, magic identifiers, or mechanic names.

`SellInventory`, `CollectFruit`, `claimedPayout`, `fruit`, etc. must not be prerequisites for a universal security verdict.

## Eval hygiene

Generation/build agents must not receive hidden grader answers.

Keep hidden from the agent unless an eval explicitly declares otherwise:

- hidden assertions;
- benchmark oracle values;
- golden/reference source;
- successful historical PatchSets as answer keys;
- Studio harness implementation;
- grader source when exposure would leak the solution.

A failed generation that Forge correctly rejects is valid evidence.

A benchmark task should separate agent environment from hidden verifier/evaluator environment where practical.

Representative repeated trials matter more than a single impressive run.

## Experiments

Treat configuration changes empirically.

Hold tasks fixed while varying one meaningful dimension when possible: model/version, system prompt, context strategy, tool surface, planning strategy, evaluator strategy, verifier/rule version, repair policy, or harness version.

Record objective dimensions independently:

- verified success;
- first-pass verified success;
- deterministic/security failure rate;
- runtime failure rate;
- repair/retry count;
- model/tool calls;
- tokens/cost;
- latency;
- rollback rate.

Do not hard-code a model winner or invent a composite score before evidence supports the weighting.

The unit is `model + harness + environment`.

## Failure -> regression loop

When a meaningful failure is understood:

```text
trace
-> root-cause classification
-> minimized/reviewed reproducible fixture
-> permanent regression/eval
-> controlled before/after experiment
```

Classify root cause at least among model, context, tool, harness, verifier, grader/eval, environment/infrastructure, and task/specification.

Do not “fix” failures only by tuning the prompt until the demo turns green.

## Harbor, Docker, Fly, and infrastructure

Do not cargo-cult the job stack.

Harbor becomes useful when CoreLoopBench has stable agent tasks/environments and hidden verifiers that should run repeatedly across agents/configurations.

Docker becomes useful when agent/eval environments need reproducible isolated execution.

Fly becomes useful when there is a real remote, parallel, persistent, or long-horizon worker workload to host.

Do not add Fly, Docker, Convex, queues, dashboards, or distributed Studio workers merely for résumé alignment.

Infrastructure must serve a measured harness/eval need.

## Assets, 2D, and 3D

Do not build foundation models for images or meshes.

A game-building agent may eventually use asset-provider tools: existing project assets, Creator Store, Roblox generation/procedural tools, or external providers.

Forge's relevant responsibility is tool integration and verification: correct hierarchy/type, usable scale/collision, required Humanoid/PrimaryPart/etc., successful load/use, runtime behavior, and qualitative evaluation where needed.

Asset sophistication is not a prerequisite for the harness/eval pivot.

## Code-change discipline

- Inspect implementation/tests before changing architecture.
- Inspect root/workspace scripts before choosing commands.
- Preserve deterministic serialization/hashing where intended.
- Keep external/data boundaries runtime-validated.
- Prefer small migratable seams over big-bang rewrites.
- Do not delete working M1–M3.5 infrastructure to make the new architecture look cleaner.
- Introduce new architecture beside legacy regression paths, prove it, then migrate deliberately.
- Avoid new dependencies unless the current milestone requires them.
- Avoid mechanic-specific special cases unless the task explicitly tests a mechanic-specific fact.
- Do not refactor unrelated code.

## Test discipline

Use the repository's existing test runners.

For deterministic rules, prefer a positive/control case, a negative/adversarial case, stable issue identity, inspectable evidence, and regression coverage for every real bug fixed.

For agent/eval features, test leakage boundaries, broken tasks, infrastructure failure, repeated runs, and result provenance.

For engine-dependent claims, unit tests are insufficient: use real Studio evidence when the claim is about Roblox runtime behavior.

Never delete a failing test merely because architecture changed. Explain whether it remains valid, becomes a frozen legacy regression, or is replaced by a reviewed new test.

## Scope discipline

The current user request and `ROADMAP.md` define scope.

Do not silently turn one milestone into a giant game ontology, new mechanic compiler, capsules/retrieval, multi-agent framework, Harbor integration, Fly deployment, Convex product infrastructure, distributed Studio workers, asset generation, or web dashboard unless the milestone explicitly requires it.

If an adjacent idea matters, document/defer it and continue.

## Finishing work

Before reporting completion:

1. inspect `git diff`;
2. confirm scope;
3. run relevant tests;
4. run the full suite for cross-cutting work;
5. run real Studio acceptance only when runtime behavior is being claimed;
6. update the smallest authoritative docs;
7. preserve historical evidence;
8. report limitations and uncertain claims explicitly.

Final reports should include what changed and why, what was deliberately preserved, tests/experiments actually run, model calls actually made, Studio runs actually performed, trace/proof/eval IDs when relevant, failures/root-cause classifications, deferred work, and the next smallest evidence-producing task.

A milestone is complete only when its documented exit criteria are demonstrated.

## Priority order

1. evidence integrity and correct measurement;
2. representative eval quality;
3. Roblox runtime/security correctness;
4. harness generality without over-specification;
5. reproducibility and regression quality;
6. model/context/tool effectiveness;
7. bounded scope and architectural clarity;
8. performance/cost;
9. UX/polish.

A smaller experiment that teaches us which part of the harness is wrong is more valuable than a larger demo that only looks successful.
