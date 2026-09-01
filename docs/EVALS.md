# Forge Evaluation and Claim Policy

This document defines what Forge may claim. [ARCHITECTURE.md](ARCHITECTURE.md) defines the system, [FORGE.md](FORGE.md) defines product invariants, [ROADMAP.md](ROADMAP.md) records demonstrated evidence, and [RESEARCH.md](RESEARCH.md) indexes history.

## Evidence tiers

Forge interprets evidence in this order:

1. artifact validation establishes data-shape truth;
2. Luau and Roblox-aware analysis establishes language and loaded-host facts;
3. Forge static rules establish only explicitly modeled structural or trust properties;
4. complete manifest/projection-bound Studio evidence establishes observed edit-mode facts;
5. matched direct mutation readback plus complete before/after project-state evidence establishes only the exact approved state transition;
6. correlated user-triggered Play Solo evidence establishes bounded runtime facts and diagnostic counts/hashes;
7. a visible creator charter determines whether those facts pass the creator-approved machine checks;
8. a private backend evaluator may grade facts only for its exact registered treatment;
9. creator or independent human review assesses subjective product quality.

Later tiers do not retroactively strengthen earlier ones. A local pass is not Studio proof; a zero-error diagnostic count is not proof of intended gameplay; a creator acceptance is a product outcome, not a universal engine fact.

Catalog coverage is not another evidence tier. `RobloxApiCatalog` says what the pinned official source documents; `StudioCapabilityCoverageReport` says why Forge does or does not support each entry; `StudioCapabilityManifest` says which exact rows have a complete mutation/readback proof route. A catalog entry marked `authorable` still requires current connector attestation and a complete projection-bound Studio transaction. `observable_only`, `source_only`, `creator_reviewed`, and `unsupported` never count as machine proof merely because they are exhaustively classified.

Capability attestation has the same explicit-presence rule as mutation evidence.
The plugin reports raw ReflectionService facts; it does not reinterpret type
domains or decide compatibility. The generated backend expectation treats the
catalog identity, engine/storage type, Luau script type, and optional
enum/Instance constraint as separate obligations. A missing required dimension
is incomplete; a present contradictory dimension is rejected. The grader
returns `verified`, `rejected`, or `incomplete`: complete contradictory owner,
type, serialization, or permission evidence is rejected, while a missing,
unavailable, unreadable, duplicated, extra, unordered, or misbound obligation
is incomplete. Neither outcome is a Studio mutation verdict, and neither may
start a creator session or provider call.

## Creator-session outcomes

- `eligible`: a local check passed its implemented rules.
- `locally_eligible`: an `AgentRun` completed its bounded local phase; for a workspace build, this additionally requires a sealed locally eligible candidate.
- `awaiting_review`: every visible machine check passed and Studio committed the exact change recording, but the creator has not accepted it.
- `creator_accepted`: the creator accepted the exact reviewed result.
- `creator_rejected`: the creator rejected a plan, change set, uncommitted result, or final reviewed result.
- `rolled_back`: the plugin undid the exact Forge checkpoint while the current Studio revision still matched.
- `recovery_required`: a recording might exist or a settled receipt cannot yet be bound; Forge refuses to infer or automatically alter Studio state.
- `incomplete`: required provider, tool, connector, Studio, projection, or environment evidence was missing, unavailable, erroneous, duplicated, extra, unordered, or misbound.

A `CreatorPlan` and its `VerificationCharter` are creator-visible agent hypotheses. Forge binds the plan goal to the immutable creator prompt and requires structural closure before presentation: exact step-to-change coverage, explicit bounded initial-snapshot `inspectionPaths` that the planner actually inspected, executable create initialization, an exact class-aware existence check for every created or moved output, and a Luau syntax check for every source-bearing change. Those rules establish that the plan can be staged and that its declared outputs are checked; they do not prove the requested runtime behavior or subjective quality. Approval grants authority to proceed with the exact hash; it does not turn the plan into project fact. Likewise, `CreatorChangeSet` approval grants authority for the fixed plugin to apply those exact operations at the bound revision.

## Registered-experiment outcomes

- `runtime_verified`: the exact sealed candidate satisfied the exact runtime definition, manifest-bound evidence projection, and evaluator configuration in one authoritative Studio run.
- `rejected`: an applicable deterministic local rule or registered runtime assertion failed.
- `not_run`: the relevant gate deliberately did not execute.

`runtime_verified` is not universal mechanic correctness, subjective quality, fun, or general model quality.

## Visibility boundary

Creator agents may receive the prompt, sanitized Studio facts, ownership, allowlisted capabilities, approved plan, visible failure facts, and bounded tool results. Planner and builder may search at most 20 rows per call from the pinned official Roblox API catalog; returned signatures, security/capability metadata, provenance, and coverage disposition are source context, not evidence that an API call succeeded. The planner can inspect bounded properties, attributes, positions, ownership, and source hashes for exact initial paths, but not source bodies. A builder additionally receives the content-addressed `CreatorBuildContract`: the exact approved change IDs, planner-declared inspection paths, Forge-derived structural fields, approved initialization requirements, and the exact allowable property, attribute, explicit removal, source, and UTF-8 bounds. It may read a source body only when that exact existing script is already an approved `write_source` target. It does not guess or re-specify operation kind, destination path, parent, name, class, stable ID, or precondition. The contract is hash-bound in the builder `AgentRun`, trace, and creator-session history. They may not receive evaluator bodies, hidden thresholds, expected benchmark observations, answer-key source, raw reasoning bodies, secrets, or host paths.

Stage rejection is factual feedback, not an opaque prompt hint. Forge returns the failed contract field(s), expected value(s), received value(s), and applicable allowlist; it records rejected batches, live budget-admission failures, repeated identical no-progress submissions, and three varied consecutive all-failed batches as incomplete harness/model-interface outcomes. A successful read resets the varied-failure streak. This does not weaken the fixed approved plan or disclose evaluator material.

The prompt-only path has no hidden evaluator. Every automated criterion, tolerance, sample count, interval, observation window, and diagnostic threshold must appear in the creator-visible charter or generated execution artifact before plan approval or mutation. Forge derives machine-check prose from typed fields; the model authors prose only for `creator_review`. Class-aware existence may resolve only exact allowlisted Studio service roots, while position and series observations remain limited to `Workspace` `BasePart` targets. Human-triggered creator checks reserve a 90-second observation window, and the complete sequential schedule must fit the common generated five-minute execution ceiling; merely leaving Play Solo open after approved evidence collection ends does not upgrade later creator interaction into machine evidence. `subtree_unchanged` compares one bounded edit-mode snapshot digest and does not establish visual equivalence. Diagnostic bounds count the whole approved playtest and are never attributed to one change. Unsupported visual or gameplay judgments belong in final creator review.

Registered experiments are different: their `AcceptanceSpec` carries references while the redacted `StudioExecutionPlan` carries only typed targets, calls, bounds, and correlation. The plugin returns facts. Backend code alone receives evaluator assertions and grades them.

## Approval and mutation evidence

An approval records creator authority, artifact ID and hash, decision, and time. It binds the generated manifest, exact mutation projection, build contract, revision, session, and dashboard review. Before mutation, Forge obtains and persists a complete projected before-state. Projection identity proves which request produced the evidence; it is not state identity. State equality requires the same semantic coverage-domain hash and the same manifest-and-facts state hash, so rebinding identical evidence to the approved change cannot manufacture drift. If those comparable hashes differ, the immutable attempt retains the observed projection, envelope, revision, expected revision, and exact failure fact before Forge reports `project_drift`. The connector independently recompiles the projection from the sealed change set and that state, rejects byte/hash inequality, then runs only the requested detached round-trip canary. No ChangeHistory recording may exist during preflight.

The recording opens only after passed preflight and a repeated exact revision check. Direct readback comes from the provisionally changed objects; a separate complete project-state envelope closes the observable delta. Pure reconciliation has exactly three outcomes:

The plugin's local recovery cursor is not evidence merely because `SetSetting` returned. Forge requires a fresh immutable settings snapshot and immediate readback of the exact phase and opaque recording ID before mutation. A missing or stale cursor, incomplete post-state, or failed provisional-evidence retention is an incomplete transaction failure; when the same call can prove cancellation it must also retain and emit complete post-cancel evidence, otherwise the session is `recovery_required`. None of these failures is a mutation mismatch.

- `matched`: all projected postconditions match and no observable fact outside the evidence-derived allowed delta changed;
- `mismatched`: complete authoritative evidence proves a concrete difference;
- `incomplete`: any required fact, binding, projection, read, inventory, order, or state observation is unavailable or invalid.

An unavailable fact can never match. For an Instance-valued property, the class-bound canonical nil value is an observed value and can match; it is distinct from an absent instance, omitted fact, or read error. Runtime evidence cannot substitute for mutation proof, and verification requires a linked provider-free replayable `matched` attempt. A mismatch or incomplete observation triggers exact cancellation and requires cancellation acknowledgement plus post-cancel state evidence. A passing verification may commit only after its evidence is persisted; checkpoint and review require the exact commit acknowledgement and post-commit state. Post-commit rollback requires the exact current checkpoint revision and invokes only Studio Change History undo.

`replayCreatorMutation` verifies the immutable artifact store, validates the attempt's stored manifest and sealed build-policy snapshot, recompiles the projection against that exact manifest, regrades direct readback and the complete state delta, and reproduces status and failure-fact hashes without Studio, a provider, or network access. Later capability growth cannot silently reinterpret an accepted attempt through the new global manifest; live authoring still admits only the current generated manifest. Exit `0` means exact reproduction, `1` means the stored graph no longer reproduces its recorded result, and `2` means missing or incomplete evidence. A recorded `mismatched` result is a successful replay when the exact mismatch reproduces.

## Experiment discipline

- Treat model, prompt, orientation, tools, budgets, provider transport, connector build/manifest, evidence projection, environment, and evaluator configuration as variables.
- Preserve provider and Studio outcomes after their declared irreversible boundary; do not tune around a consumed single-run treatment.
- Keep model/context/tool/harness/verifier/grader/environment/provider/task-spec failures distinct.
- Promote a failure into a regression only after review.
- Record tokens, cost, calls, changed state, latency, budgets, artifact hashes, and trace links without inventing a composite score.

## Historical evidence

The current Door Control session `creator_session_fa375f4e-00ad-481e-af8c-ddd502d6d0a2` is accepted live evidence for the current closed-evidence path. Mutation attempt `creator_mutation_attempt_14f0457ba6b75e3f03da1cd6_1` reconciled as `matched` and finalized as `committed`; verification `creator_verification_af0034c8cc325141a11ae352` passed; checkpoint `creator_checkpoint_dbf22bfdacef48ffe9e60fb1` was created; creator report `creator_review_report_44e97f0e8f0aadd7df9fca60` records `accepted`; and both provider-free replays returned `exact_match`. Machine evidence establishes only the exact approved mutation, bounded runtime facts, and absence of recorded diagnostics. The creator report “It works completely.” is creator-authority evidence and does not upgrade unsupported visual, interaction, networking, or general gameplay claims.

The earlier capability canary and Vertical Shuttle run remain immutable predecessor evidence. Vertical Shuttle's exact historical evaluation was `runtime_verified`; it does not establish current creator authoring. The MovingPlatform trial remains `incomplete / agent_failure` because its historical builder lacked provider-visible writable roots; it produced no candidate or Studio verdict. The consumed Status Beacon builder run `agent_run_20b5f04f-8f3e-4602-931c-6679998b41e8` is `incomplete / RUNTIME_BUDGET_EXHAUSTED` and is classified as a harness/model-interface failure: it was not shown the approved plan or build contract, had to guess IDs/path/class, lacked a visible property allowlist, and received vague rejection feedback. It is not evidence of current validation or general model quality.

Exact hashes bind the orientation, ordered tools, harness, worker descriptor, connector manifest and evidence projection, evaluator configuration, candidates, proof artifacts, and authenticated evidence links. Creator bundles retain bounded revision-to-observation history and re-materialize plans, contracts, and change sets from the exact recorded facts; AgentRun and trace locators carry persisted content hashes and the trace build key. A creator phase is `locally_eligible` only when its reviewed artifact is sealed; an `end_turn`, provider failure, rejected tool sequence, incomplete plan coverage, missing local gate, unaffordable tool batch, or no-progress streak is an `incomplete` phase with an unsealed outcome. Historical artifacts are not relabeled as current.
