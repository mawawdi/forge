# Forge Roadmap

## Status at a glance

| Milestone | Status | Meaning |
| --- | --- | --- |
| M1–M2.5 | Complete, preserved | Local verifier, trace foundation, bounded patch loop, project semantics. |
| M3–M3.5 | Complete, preserved | Correlated StudioProof and the historical Collect/Sell vertical slice. |
| M4.0 | Complete | Requirement provenance, visibility, authority, and historical projection. |
| M4.1 | Code seam complete; experiment incomplete | Bounded single-agent builder exists; sole real adapter run had no provider key. |
| M4.2 | Next | General reusable Studio capabilities. |
| M4.3–M4.6 | Deferred | Eval infrastructure, unseen-game work, long-horizon evidence, then hosting only if measured. |

## Preserved history

M1–M3.5 are immutable historical evidence, not templates for scaling a
mechanic compiler. Their contracts, candidates, PatchSets, Studio harnesses,
ProofBundles, traces, and regression fixtures remain runnable and inspectable.

The evidence record is intentionally not repeated here:

- [M3 Studio acceptance runs](research/m3-real-studio-runs.md)
- [M3.25 candidate diagnosis](research/m3.25-luna-candidate-diagnosis.md)
- [M4.0 provenance audit](research/m4-semantic-authority-audit.md)

## M4.1 — bounded builder seam

Delivered code:

- a provider-neutral runtime plus isolated Claude adapter;
- source-free orientation from the M4.0 builder view;
- bounded list/search/read/inspect/plan/write/diff/verify tools over a copied
  workspace;
- deterministic HarnessConfiguration, private AgentRun, WorkspaceDelta, and
  additive BuildTrace references;
- an external Collect authority task and fake-agent iteration tests.

The sole reviewed real attempt is
`agent_run_5b51deb4-a2ea-4a31-bbde-786c91a26cb5`. It used
`claude-agent-sdk@0.3.251` and `claude-sonnet-5`, but stopped as
`incomplete` / `provider_failure` because `ANTHROPIC_API_KEY` was absent. It
made zero model and tool calls; its unchanged candidate was locally rejected;
Studio was not run. The result, `trace_44b27d1f-cac9-4363-b4ab-c45326619f1c`,
and final verifier trace `trace_545bc6af-5a90-4a5c-ae6c-4f2babacadf4` are
preserved. Do not retry or tune that task without a new reviewed experiment.

## M4.2 — general Studio capabilities

Add small, typed actions and observations—such as locating an instance,
executing a production interaction, moving a character, observing state/UI,
and designated adversarial remote calls—while preserving correlation,
snapshot binding, cleanup, and fail-closed lifecycle behavior. Do not build an
arbitrary-code test interpreter or a new mechanic-specific harness per task.

Exit evidence: one non-Collect/Sell M4.1-style task gains authoritative runtime
evidence through reusable capabilities.

## M4.3–M4.6

- **M4.3:** representative repeatable tasks, isolated hidden evaluators, and
  controlled configuration experiments.
- **M4.4:** unseen-game and greenfield/existing-project generalization without
  mechanic-specific compiler growth.
- **M4.5:** one bounded long-horizon run with interruption/recovery evidence.
- **M4.6:** Docker, Harbor, Fly, queues, or workers only for a measured
  reproducibility, isolation, parallelism, or persistence need.

## Stop conditions

Pause expansion when project observation is incomplete, a benchmark does not
correlate with runtime evidence, a deterministic rule produces false
confidence, an artifact cannot be reproduced, or a model failure could instead
be a harness/tool/environment/task problem. Improve evidence or narrow the
claim before adding infrastructure or agents.
