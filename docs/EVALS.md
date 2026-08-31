# Forge Evaluation and Claim Policy

This document defines what Forge may claim. [ARCHITECTURE.md](ARCHITECTURE.md) defines the system, [FORGE.md](FORGE.md) defines product invariants, [ROADMAP.md](ROADMAP.md) records demonstrated evidence, and [RESEARCH.md](RESEARCH.md) indexes history.

## Evidence tiers

Forge interprets evidence in this order:

1. artifact validation establishes data-shape truth;
2. Luau and Roblox-aware analysis establishes language and loaded-host facts;
3. Forge static rules establish only explicitly modeled structural or trust properties;
4. correlated Studio snapshots establish observed edit-mode facts;
5. correlated user-triggered Play Solo capabilities establish bounded runtime facts and diagnostic counts/hashes;
6. a visible creator charter determines whether those facts pass the creator-approved machine checks;
7. a private backend evaluator may grade facts only for its exact registered treatment;
8. creator or independent human review assesses subjective product quality.

Later tiers do not retroactively strengthen earlier ones. A local pass is not Studio proof; a zero-error diagnostic count is not proof of intended gameplay; a creator acceptance is a product outcome, not a universal engine fact.

## Creator-session outcomes

- `eligible`: a local check passed its implemented rules.
- `locally_eligible`: an `AgentRun` completed its bounded local phase; for a workspace build, this additionally requires a sealed locally eligible candidate.
- `awaiting_review`: every visible machine check passed and Studio committed the exact change recording, but the creator has not accepted it.
- `creator_accepted`: the creator accepted the exact reviewed result.
- `creator_rejected`: the creator rejected a plan, change set, uncommitted result, or final reviewed result.
- `rolled_back`: the plugin undid the exact Forge checkpoint while the current Studio revision still matched.
- `recovery_required`: Forge could not safely prove commit or cancellation state and refuses to continue.
- `incomplete`: required provider, tool, connector, Studio, or environment evidence was insufficient.

A `CreatorPlan` and its `VerificationCharter` are creator-visible agent hypotheses. Forge binds the plan goal to the immutable creator prompt and requires structural closure before presentation: exact step-to-change coverage, explicit bounded initial-snapshot `inspectionPaths` that the planner actually inspected, executable create initialization, an exact class-aware existence check for every created or moved output, and a Luau syntax check for every source-bearing change. Those rules establish that the plan can be staged and that its declared outputs are checked; they do not prove the requested runtime behavior or subjective quality. Approval grants authority to proceed with the exact hash; it does not turn the plan into project fact. Likewise, `CreatorChangeSet` approval grants authority for the fixed plugin to apply those exact operations at the bound revision.

## Registered-experiment outcomes

- `runtime_verified`: the exact sealed candidate satisfied the exact runtime definition, capability set, and evaluator configuration in one authoritative Studio run.
- `rejected`: an applicable deterministic local rule or registered runtime assertion failed.
- `not_run`: the relevant gate deliberately did not execute.

`runtime_verified` is not universal mechanic correctness, subjective quality, fun, or general model quality.

## Visibility boundary

Creator agents may receive the prompt, sanitized Studio facts, ownership, allowlisted capabilities, approved plan, visible failure facts, and bounded tool results. The planner can inspect bounded properties, attributes, positions, ownership, and source hashes for exact initial paths, but not source bodies. A builder additionally receives the content-addressed `CreatorBuildContract`: the exact approved change IDs, planner-declared inspection paths, Forge-derived structural fields, approved initialization requirements, and the exact allowable property, attribute, explicit removal, source, and UTF-8 bounds. It may read a source body only when that exact existing script is already an approved `write_source` target. It does not guess or re-specify operation kind, destination path, parent, name, class, stable ID, or precondition. The contract is hash-bound in the builder `AgentRun`, trace, and creator-session history. They may not receive evaluator bodies, hidden thresholds, expected benchmark observations, answer-key source, raw reasoning bodies, secrets, or host paths.

Stage rejection is factual feedback, not an opaque prompt hint. Forge returns the failed contract field(s), expected value(s), received value(s), and applicable allowlist; it records rejected batches, live budget-admission failures, repeated identical no-progress submissions, and three varied consecutive all-failed batches as incomplete harness/model-interface outcomes. A successful read resets the varied-failure streak. This does not weaken the fixed approved plan or disclose evaluator material.

The prompt-only path has no hidden evaluator. Every automated criterion, tolerance, sample count, interval, and diagnostic threshold must appear in the creator-visible charter before plan approval. Forge derives machine-check prose from typed fields; the model authors prose only for `creator_review`. Class-aware existence may resolve only exact allowlisted Studio service roots, while position and series observations remain limited to `Workspace` `BasePart` targets. `subtree_unchanged` compares one bounded edit-mode snapshot digest and does not establish visual equivalence. Diagnostic bounds count the whole approved playtest and are never attributed to one change. Unsupported visual or gameplay judgments belong in final creator review.

Registered experiments are different: their `AcceptanceSpec` carries references while the redacted `StudioExecutionPlan` carries only typed targets, calls, bounds, and correlation. The plugin returns facts. Backend code alone receives evaluator assertions and grades them.

## Approval and mutation evidence

An approval records creator authority, artifact ID and hash, decision, and time. Before mutation, Forge re-observes the project and fails closed on revision drift. The plugin recollects the whole bounded snapshot at prepare and again at apply; each must independently equal the approved revision. It also revalidates the change-set transport hash, authenticated session, stable identity, class/path preconditions, property and UTF-8 bounds, attributes and explicit removals, source bounds, and deletion bound.

Applied state is observed again before verification. Verification failure cancels the open ChangeHistory recording. Verification success commits a checkpoint. Post-commit rollback requires the exact current checkpoint revision and invokes only Studio Change History undo; any intervening edit makes the rollback ineligible.

## Experiment discipline

- Treat model, prompt, orientation, tools, budgets, provider transport, connector capability set, environment, and evaluator configuration as variables.
- Preserve provider and Studio outcomes after their declared irreversible boundary; do not tune around a consumed single-run treatment.
- Keep model/context/tool/harness/verifier/grader/environment/provider/task-spec failures distinct.
- Promote a failure into a regression only after review.
- Record tokens, cost, calls, changed state, latency, budgets, artifact hashes, and trace links without inventing a composite score.

## Historical evidence

The earlier capability canary and Vertical Shuttle run remain immutable predecessor evidence. Vertical Shuttle's exact historical evaluation was `runtime_verified`; it does not establish current creator authoring. The MovingPlatform trial remains `incomplete / agent_failure` because its historical builder lacked provider-visible writable roots; it produced no candidate or Studio verdict. The consumed Status Beacon builder run `agent_run_20b5f04f-8f3e-4602-931c-6679998b41e8` is `incomplete / RUNTIME_BUDGET_EXHAUSTED` and is classified as a harness/model-interface failure: it was not shown the approved plan or build contract, had to guess IDs/path/class, lacked a visible property allowlist, and received vague rejection feedback. It is not evidence of current validation or general model quality.

Exact hashes bind the orientation, ordered tools, harness, worker descriptor, connector capability set, evaluator configuration, candidates, proof artifacts, and authenticated evidence links. Creator bundles retain bounded revision-to-observation history and re-materialize plans, contracts, and change sets from the exact recorded facts; AgentRun and trace locators carry persisted content hashes and the trace build key. A creator phase is `locally_eligible` only when its reviewed artifact is sealed; an `end_turn`, provider failure, rejected tool sequence, incomplete plan coverage, missing local gate, unaffordable tool batch, or no-progress streak is an `incomplete` phase with an unsealed outcome. Historical artifacts are not relabeled as current.
