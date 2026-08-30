# RFC: Forge Flight Recorder

Status: implemented in M1.5  
Date: 2026-08-29

## Context

Before M1.5, M1 emitted deterministic verification reports but discarded the execution context that explains how a result was produced. `ProofBundle` remains a future decision artifact and no execution trace was persisted.

Forge needs a narrow, game-semantic feedback loop: a build should be inspectable now, reproducible at the evidence level later, and promotable into a CoreLoopBench regression when a real failure matters. This is inspired by observability/evaluation feedback loops, not by a generic LLM tracing product.

## Decision

Introduce an internal Flight Recorder with four separate concepts:

| Object | Purpose | Mutability |
| --- | --- | --- |
| `BuildTrace` | Complete execution history: spans, events, versions, hashes, outcome, and compact failure summaries | append during a run; immutable once persisted |
| `ProofBundle` | Compact evidence supporting a verification/commit decision | immutable decision artifact; M2 assembles a static/semantic bundle |
| CoreLoopBench case | Reproducible task/regression fixture derived from an intent, contract, snapshot reference, assertions, and failure evidence | versioned fixture |
| `ExperimentResult` | Result of applying one candidate configuration to a fixed benchmark case/set | append-only result record |

`BuildTrace` is not a second ProofBundle. It records what happened. A ProofBundle records the evidence required to justify a decision. A promoted benchmark is a reusable input plus expected outcome, never a copy of a historical trace.

## M1.5 implementation

Implement now:

- versioned `BuildTrace`, span/event, outcome, model/toolchain reference, and trace persistence schemas;
- stable Forge span/event names and OpenTelemetry-compatible primitive attributes;
- deterministic `buildKey` from reproducibility inputs, plus a unique trace execution ID;
- a local atomic JSON sink at `.forge/flight-recorder` by default, configurable per invocation;
- trace spans around current Luau and replication verification work;
- compact issue summaries and report hashes, without raw source duplication;
- `forge trace show <trace-id>` for local inspection;
- serialization, deterministic hashing, persistence, failure-isolation, and M1-regression tests.

The existing `forge verify` stdout remains a deterministic `VerificationReport`. Its trace ID is emitted on stderr and the full trace is stored independently. This keeps the M1 report contract reproducible while retaining every execution locally.

## M2.5 context and semantic snapshot metadata

The recorder may store only context composition metadata: item count, required-item count, token estimates, eviction count, and a composition hash. It does not store the selected context body or raw source in telemetry. The trace's project reference also carries source, structure, and semantic snapshot hashes produced by the canonical ProjectSemanticMap. These references make later context-effectiveness and affected-cone analysis possible without claiming exact replay.

## Event and span taxonomy

The names are Forge-specific and intentionally sparse. Names that are not executed yet are reserved, not emitted.

```text
forge.project.snapshot
forge.intent.compile
forge.contract.validate
forge.agent.execute
forge.model.generate
forge.tool.call
forge.patch.create
forge.patch.apply
forge.verify.luau
forge.verify.replication
forge.verify.economy
forge.verify.structure
forge.repair.deterministic
forge.repair.model
forge.studio.start
forge.studio.playtest
forge.studio.assert
forge.commit.verified
forge.commit.rejected

forge.issue.detected
forge.build.completed
```

Spans model duration-bearing work. Events model discrete facts such as an issue or final outcome. Attributes use OpenTelemetry-compatible primitive values and established `gen_ai.*` usage keys where model usage exists. Forge-only attributes use the `forge.*` namespace.

Examples:

```text
forge.project_id
forge.project_hash_before
forge.project_hash_after
forge.contract_hash
forge.patch_hash
forge.model.provider
forge.model.name
forge.model_version
forge.agent_version
forge.toolchain_version
forge.verifier.name
forge.verifier.version
forge.issue.code
forge.issue.severity
forge.repair.type
forge.attempt
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
forge.cost.usd
```

An optional OpenTelemetry collector or Langfuse exporter may adapt the generic sink interface later. Neither is a core dependency, and no Langfuse term appears in Forge domain types.

## Reproducibility and privacy

`buildKey` is a content-derived identity for the same semantic starting state and configuration. `traceId` identifies one execution and is intentionally unique. Timing and execution IDs are nondeterministic; hashes, normalized report content, configuration references, and explicit seeds are reproducibility inputs.

M1 traces support **semantic reproduction**: a reviewer with a matching project snapshot, toolchain binary/configuration, fixture manifest, and rule set can rerun verification and compare normalized evidence. They do not support exact replay because no immutable project snapshot artifact, patch application, model response capture, or Studio environment exists yet.

Raw project source, raw prompt content, credentials, and creator identity are not persisted in trace events by default. Store content hashes, relative artifact references, normalized issue metadata, and explicit version identifiers instead. Promotion must copy only the minimized data needed for a reproducible regression fixture.

For M3.25 model generation, traces record configured provider/model and a
configuration hash, call count, known usage fields (or `null` when absent),
context summary, contract/PatchSet references, and verifier/Studio outcomes.
Validated raw proposals and generated source stay only in private local
generation-run artifacts and are never copied into the trace.

Candidate regression reverification creates a new trace that references the
historical generation run, attempt, model-response hash, contract, and exact
reconstructed PatchSet. The historical trace is immutable. A corrected verdict
records the current toolchain and rule set; it never overwrites or relabels the
original observed failure.

## Promotion to CoreLoopBench

Promotion is designed now and implemented after the patch/Studio vertical slice.

```text
BuildTrace + retained snapshot reference + contract + failure evidence
  -> reviewed CoreLoopBench promotion draft
  -> immutable fixture + assertions + metadata
  -> regression suite / future experiments
```

A valid promotion records source trace/build keys, contract and patch references, starting snapshot reference, environment/toolchain/model/agent metadata, adversarial sequence, expected result, observed failure, and any random seed. It does not copy an entire trace or accept a missing snapshot as replayable.

Promoted regressions are additive. An invalidation requires an explicit documented reason; it does not delete history or relax an assertion silently.

## CI and experiments

When executable CoreLoopBench cases exist, CI will treat these as absolute gates:

- critical security regression;
- a previously fixed promoted exploit succeeding again;
- parse/type regression on a required case.

Outcome, cost, and latency trends are configurable warn/fail policies, not hardcoded production thresholds. Experiments hold a case/dataset constant while varying model, prompt/context, agent, toolchain, verifier, or repair configuration. Routing decisions use verified outcomes, security failure rate, and cost per verified mechanic—not assumed model rankings.

## Deferred work

- immutable project snapshot/artifact storage;
- patch/repair provenance and deterministic repair execution;
- Studio spans/assertions and authoritative replay;
- `forge trace replay`, `forge eval promote`, and `forge eval run`;
- benchmark dataset runner, experiments, CI thresholds, dashboards, model routing, and Langfuse/OpenTelemetry export adapters;
- trajectory retention beyond local debug artifacts.

## Consequences

M1.5 adds a small local persistence side effect but does not add a database, queue, dashboard, vendor dependency, or network call. Trace write failure is visible in the run result/stderr but cannot alter the underlying verifier gate. The next roadmap work remains contracted patches and deeper semantic verification, then StudioProof.
