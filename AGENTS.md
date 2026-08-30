# AGENTS.md

## Mission

Forge is a verified, model-agnostic compiler for Roblox game mechanics.

The model may interpret intent and propose implementation. Forge owns contracts, bounded changes, verification, Studio truth, evidence, and commit/reject decisions.

`intent -> CoreLoop -> MechanicContract -> PatchSet -> verify -> StudioProof -> ProofBundle -> verified commit`

Optimize for **Forge making the correct decision about model output**, not for making the model look good.

## Source of truth

This file is a map plus durable rules, not a second specification.

Read only the docs relevant to the task:

- `docs/SPEC.md` — requirements/non-goals.
- `docs/ARCHITECTURE.md` — component/trust boundaries.
- `docs/ROADMAP.md` — current milestone and deferred scope.
- `docs/EVALS.md` — benchmark/evidence rules.
- `docs/rfcs/*` — subsystem decisions.
- `docs/research/m3-real-studio-runs.md` — real-Studio evidence.
- `docs/research/studio-test-service-blocker.md` — characterized Studio behavior.
- `docs/research/lemonade-plugin-review.md` — implementation reference only.

Milestone status belongs only in `ROADMAP.md`. A deeper `AGENTS.md` overrides this file for its subtree.

## Working method

Before editing:

- inspect relevant implementation/tests;
- inspect current package/workspace scripts before choosing commands;
- run the smallest relevant baseline checks; use the full suite for cross-cutting work;
- preserve user work, historical traces/proofs, regression fixtures, and failed-run evidence;
- avoid unrelated refactors.

If docs and code disagree, investigate and report it. Do not silently choose the easier interpretation.

## Non-negotiable principles

### Model is candidate; Forge is authority

- Models never decide whether their own output passed.
- Core semantic contracts stay provider-neutral.
- Prefer one context-rich execution path over agent swarms unless measured evidence justifies otherwise.

### Deterministic before probabilistic

Prefer: schema/compiler invariant -> static/semantic verification -> deterministic repair -> bounded model repair -> real Studio runtime proof.

If code or environment can prove/repair something deterministically, do not ask an LLM.

Do not replace substantive model-authored implementation with a hidden golden mechanic compiler merely to make an eval pass.

### Never weaken evidence

Never relax/delete a legitimate assertion, change expected values to match bad output, suppress an issue without understanding it, or turn `unknown` / `not_run` / `incomplete` / tooling failure into pass.

HTTP success, plugin connection, logs, or process exit are not proof of game behavior.

If an eval is invalid, document why and preserve historical results.

### Unknown is not safe

For security-sensitive facts distinguish: proven safe, proven violation, unresolved/unknown, and contractually not-applicable.

Missing source/graph/tool/parser/runtime evidence never implies safety.

## Verification trust hierarchy

1. Schema/IR invariants — data-shape truth.
2. Luau analysis — only language facts it actually models.
3. Forge semantic analysis — only modeled project/data-flow facts.
4. Lute/Lune/pure-Luau preflight — modeled execution, not engine truth.
5. Real Roblox Studio — authoritative for engine, replication, physics, stateful runtime behavior.
6. Human acceptance — product feedback only.

Never claim mocks prove Roblox engine behavior.

## Luau and Roblox analysis

- Use the repo’s pinned official Luau syntax/language tooling.
- Roblox-aware type analysis must use the repo’s pinned Roblox definitions/platform configuration and project sourcemap where required.
- Missing Roblox globals/classes in a host-less analyzer are tooling/environment failures, not automatically source defects.
- Never silently fall back to approximate Lua/regex parsing.
- Semantic correctness must not depend on comments, strings, or local variable spelling.
- Remote ABI/data flow is positional/semantic; local names are not protocol identity.
- High-value diagnostics need inspectable evidence and source locations when available.
- Semantic auto-fixes should use structurally identified ranges, then reparse/reverify.

## Roblox security

For client -> server state-changing mechanics, reason only about contract-applicable requirements: type/value validation, context validation, permission/ownership, rate control, and server-authoritative calculation/mutation.

Do not mechanically require every category for every mechanic.

Client-controlled reward, price, currency, inventory amount, ownership, or other authoritative state is blocking unless explicitly allowed by the contract.

## Project, patches, generation

- `ProjectSemanticMap` is the canonical relevant project representation; Roblox state is not “just Luau files.”
- Missing world facts remain unknown.
- Canonical hashes exclude irrelevant machine-local/nondeterministic data.
- PatchSets are typed, bounded, inspectable, provenance-bearing, and bound to project/snapshot preconditions.
- Reject stale/over-broad/unsupported patches; prefer narrow structured edits over whole-file rewrites.
- `MechanicContract` is the durable semantic object.
- `MechanicImplementationSpec` is exact ABI/state scaffolding, never known-good source.
- Models may author substantive implementation inside Forge-owned constraints.
- Context must be bounded, provenance-bearing, explainable, and sufficient before being minimized.
- Model repair receives the candidate, relevant contract/spec, normalized diagnostics, semantic evidence, and relevant project context—not issue codes alone.

## Eval leakage and regressions

Generation/repair context must not receive answer keys unless explicitly declared visible.

Do not expose hidden assertions, StudioProof harness source, known repaired/golden implementations, reference PatchSets, or successful proof results as answer keys.

A failed generation correctly rejected by Forge is valid evidence.

When Forge itself is wrong: preserve the old run, fix Forge, add a regression, and create a new trace/proof against the preserved candidate. Never rewrite history.

## Studio / plugin

The Forge Studio Plugin is the product-specific Studio boundary. Roblox Studio MCP is development/debugging infrastructure only.

Follow `docs/rfcs/studio-plugin-protocol.md`.

- Output/`LogService` is diagnostics only, never proof.
- Only validated, correlated real-Studio results satisfy the Studio tier.
- Temporary harness code is instrumentation, not candidate game state.
- Interrupted/stale/malformed/disconnected/timed-out/partial runs fail closed.
- Rollback/restoration claims require observed revision/state evidence.
- `ChangeHistoryService` is an undo boundary, not database atomicity.
- Never touch production persistence to make tests pass.
- Do not resurrect abandoned Studio execution paths without explicit evidence/approval.

## Proof / trace

`BuildTrace` = what happened. `ProofBundle` = evidence supporting a decision. Benchmark case = reusable input + expected behavior.

Historical traces/proofs are immutable. Trace sink failures are visible but do not alter verifier truth.

Do not persist credentials, creator identity, raw prompts, or raw source in telemetry by default.

## Code and tests

- Follow local style; do not introduce incidental formatter/test-runner migrations.
- Keep core contracts serializable and I/O-free.
- Use runtime validation at external/data boundaries.
- Keep serialized output, diagnostics, hashes, and fixtures deterministic.
- Avoid new dependencies/infrastructure unless the task requires them.
- Do not invent broad abstractions from one example when another concrete mechanic can reveal the real shared boundary.

The test runner is an implementation choice. Use existing repo scripts; do not migrate Jest/Vitest/node:test/TestEZ for preference.

For verifier/security behavior, prefer positive + negative/adversarial fixtures with stable rule IDs/evidence.

For engine-dependent claims, unit tests are necessary but insufficient: run real Studio acceptance when required.

Never delete a failing test without explaining why it is invalid.

## CLI

Use current `--help` as authority. Known surfaces:

```sh
node bin/forge.js verify <project-path> [--format json]
node bin/forge.js repair <project-path> --contract <path> --out <directory>
node bin/forge.js trace show <trace-id>
node bin/forge.js studio bridge
node bin/forge.js studio verify <project-path> [--timeout-ms <ms>]
node bin/forge.js build <project-path> --prompt "<creator request>" [--studio] [--timeout-ms <ms>] [--format json]
```

Discover build/lint/test commands from current package scripts; do not invent alternate runners.

## Scope discipline

The user request plus `ROADMAP.md` defines scope.

Do not silently expand a focused milestone into deferred systems such as capsule platforms, ModelArena, creator SaaS, 2D/3D generation, distributed Studio infrastructure, database migrations, dashboards, or agent frameworks.

If an adjacent idea matters, note/defer it and continue the current milestone.

## Finish criteria

Before claiming completion:

1. inspect `git diff`;
2. confirm scope;
3. run relevant checks;
4. run the full suite for cross-cutting work;
5. run real Studio acceptance when runtime behavior is claimed;
6. update the smallest authoritative docs if actual behavior changed;
7. report failures/limitations truthfully.

Final reports state: what changed, checks actually run, Studio runs if any, proof/trace IDs when relevant, remaining limitations, deferred work, and the next recommended task.

A milestone is complete only when its documented exit criteria are demonstrated.

## Priority order

1. correctness and evidence integrity;
2. Roblox semantic/security depth;
3. reproducibility/regression quality;
4. bounded scope and architectural clarity;
5. model/context quality;
6. performance;
7. UX/polish.

A smaller honest system that proves its claim beats a larger system with ambiguous authority.
