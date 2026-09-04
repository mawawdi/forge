# Forge Evaluation and Claim Policy

A Forge result states what its evidence establishes, within that evidence's scope.
It does not combine static checks, engine observations, or creator satisfaction
into a general score. [Architecture](ARCHITECTURE.md) defines the execution paths;
this document defines their interpretation.

## Evidence tiers

| Evidence                     | What it establishes                                     | What it does not establish                       |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Schema and unit tests        | Behavior under their supplied inputs                    | Live provider or Studio behavior                 |
| Local Luau and source checks | The implemented static rules passed                     | Runtime authorization or gameplay correctness    |
| Browser/plugin UI checks     | Tested layout, accessibility, and interactions          | A working generated game                         |
| Capability attestation       | The declared reflection obligations were observed       | Permission for APIs outside the generated policy |
| Matched Studio mutation      | Approved postconditions and allowed observed delta      | Interaction, client rendering, or visual quality |
| Bounded runtime evidence     | Exact observed facts within its projection and interval | Unobserved events or causal behavior             |
| Passive Play diagnostics     | Captured server warnings/errors in that Play interval   | A passing playtest or attribution to one change  |
| Creator review               | The creator's reported observations and judgment        | Machine verification of those claims             |

An empty diagnostic list means no diagnostics were captured within its bounds,
not that the game is correct. Finishing a conversation means the approved edit
transaction completed; ordinary completion does not wait for a gameplay verdict.

## Outcome vocabulary

| Outcome             | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `eligible`          | A local gate passed its applicable implemented rules                               |
| `rejected`          | An applicable deterministic rule or evaluation criterion failed                    |
| `incomplete`        | Required execution or evidence is missing, invalid, or unavailable                 |
| `locally_eligible`  | An AgentRun/candidate completed its required local phase                           |
| `matched`           | Complete mutation evidence satisfies the approved postconditions and allowed delta |
| `mismatched`        | Complete mutation evidence proves a concrete difference                            |
| `recovery_required` | A transaction or receipt is uncertain; new work is blocked                         |
| `outcome_unknown`   | An execution intent lacks a confirmed durable outcome                              |
| `runtime_verified`  | The exact registered candidate passed its authoritative Studio evaluation          |
| `not_run`           | The relevant gate did not execute                                                  |

Explicit creator acceptance/rejection and checkpoint rollback are creator decisions
or transaction outcomes, not interchangeable with machine eligibility. Lower-level
verification APIs can retain awaiting/retry states; these are not mandatory stages
of the dashboard conversation flow.

## Completeness and comparison

Evidence is complete when every required key appears exactly once, in canonical
order, with the correct binding and authoritative presence. `observed` and `absent`
are both complete facts. Missing, extra, duplicate, unordered, unavailable,
read-error, or misbound facts are incomplete. Expected-value comparison happens
only after that completeness check.

An absent instance can satisfy an absence requirement or fail a presence
requirement. A canonical nullable property is an observed value only when the
exact manifest row permits it; it is not an omitted fact or failed read.

Each manifested project-index node must include exactly its generated property
coverage. Incomplete observation cannot become `approved_property_not_reflected`
or another claim about what Studio stored. Whole-project comparison uses complete
before/after revision graphs; request/projection identity remains provenance and
must not manufacture state drift.

## Plan, build, and mutation claims

A plan is an agent hypothesis. Host validation establishes that its operations can
be constructed against observed targets and the current capability policy. The
host generates structural existence and Luau syntax checks and retains explicit
behavioral/preservation criteria. Those internal checks remain inspectable in
Details; the main plan is concise. Approval authorizes the exact plan without
turning it into an observed fact.

The builder's local gate establishes only static eligibility. Virtual staging is
not a Studio write. Preparation errors before provider dispatch keep their original
stage and diagnostic and receive no fabricated AgentRun or provider receipt.

Before mutation, source transfer, canonical Prepare, detached preflight, current
revision, and clear transaction inventory are separate obligations. Failure at
one of these boundaries is an incomplete attempt, not proof that a recording
opened. After writing, direct readback and the complete project delta determine
`matched`, `mismatched`, or `incomplete`.

A matched mutation may commit when its exact finalization and post-state are
acknowledged. Cancellation requires the current transaction safety gate and
post-cancel evidence. If cancellation or closure cannot be proven, preserve the
recording obligation for recovery. Neither an exception nor a plugin settings
write proves that Studio rolled back.

Passive Play context cannot open a recording, authorize repair, start a model,
or upgrade a completed edit to a gameplay pass. Explicit projected runtime checks
retain their own lifecycle receipts and bounded observation semantics. Unsupported
visual, client, interaction, and causal judgments remain creator review.

## Execution journals and recovery

An execution journal records model/tool boundaries, not Studio success.
`never_dispatched` means no durable provider intent exists for that reserved run.
A request intent without a response, or tool intent without completion, is uncertain.
An explicit retry reserves a fresh execution slot; it does not claim that the
original request failed at the provider.

A fully persisted response and completed tool boundary can support explicit resume
without resending that response. A terminal journal can publish its already-sealed
outcome. None of these records authorizes an unrelated model, tool, or Studio action.

Tool rejection is factual feedback. Batch validation executes no rejected calls;
semantic repetition is measured by normalized issues and accepted host progress.
Changing argument spelling without resolving the failure is not progress. A
completed host artifact ends the phase without purchasing another model response.

## Registered experiments

Register the seed, source roots, requirement views, model/transport, budgets,
implementation, evaluator, environment, and runtime projection before execution.
Treat each as an experimental variable. A consumed run is not silently retried,
rewritten, or tuned around while retaining its original treatment identity.

The builder receives only its declared visible context. Hidden evaluator bodies,
benchmark oracles, expected observations, and solutions stay outside it. The plugin
collects typed facts; backend grading alone applies evaluator assertions.
`runtime_verified` applies to that exact candidate and treatment, not to general
mechanic correctness, visual quality, fun, or model quality.

Record elapsed time, requests, tokens, reported cost, changed state, limits, and
artifact/trace identities. Nullable reasoning/cache counts mean the provider did
not report them. Compare like-for-like workloads and disclose differences; a small
property edit is not a benchmark for a full generated game.

## Replay and evidence retention

Mutation replay validates immutable artifacts and the attempt's stored manifest
and build policy, recompiles its projection, and reproduces reconciliation and
failure hashes without Studio or a provider. Verification replay has its own
matched-mutation and runtime-evidence prerequisites. Exact reproduction of a
recorded mismatch is a successful replay, not a passed mutation.

Keep model, context, tool, harness, verifier, evaluator, provider, environment, and
task-specification failures distinct. Promote a failure into a regression only
when its cause and expected behavior are understood. Preserve exact run identities
and classifications when consolidating research; never relabel historical artifacts
as current-schema evidence or imply they survived an authorized store reset.

Historical observations live only in the [research index](RESEARCH.md). Current
quality gates are listed in [Development](DEVELOPMENT.md).
