# Forge Product Principles

Forge helps creators build and improve Roblox places through a persistent
conversation. The creator supplies intent; the agent proposes a design and
implementation; Forge owns factual context, approvals, bounded execution,
verification, recovery, and evidence.

## Product contract

The ordinary workflow is **ask → review a read-only plan → accept → build and
apply → receive the result**. Changing or rejecting a plan does not edit Studio.
Accepting it authorizes changes only within its exact approved bounds. The result
is the model's Markdown response backed by the host's completed transaction.
Optional Play diagnostics inform follow-ups without blocking completion.

Projects follow saved identity, and each project can contain independent chats.
Display names are cosmetic. Conversations retain their history, explicit creator
preferences, and model-written compaction handoffs. The dashboard keeps project
settings and technical evidence available on demand rather than filling the chat
with internal status records.

Registered benchmarks are a separate developer workflow. Their evaluator files
and treatment configuration are not ordinary creator inputs.

## Authority stays explicit

| Source                    | Authority                                                    |
| ------------------------- | ------------------------------------------------------------ |
| Creator request           | Desired outcome and explicit constraints                     |
| Creator memory            | Preferences and conventions; never current project facts     |
| Studio/source observation | What the host actually read, with revision and provenance    |
| Platform policy           | Universal execution and security constraints                 |
| Agent plan                | A proposed design requiring approval                         |
| Local verifier            | Only the implemented static rules it evaluated               |
| Runtime evaluator         | Only the facts and criteria in its declared evaluation scope |
| Creator review            | What the creator observed or judged                          |

A current complete project revision takes precedence over remembered project
state. Agent hypotheses cannot promote themselves to policy or engine fact.
Hidden evaluator bodies, benchmark answers, successful solutions, private host
paths, and credentials never enter builder-visible context.

## Engineering invariants

- **One writer per change set.** Use the Studio document or explicitly declared
  Rojo source roots. Do not merge concurrent authority.
- **Approval is exact.** Bind the plan, project revision, capability policy, and
  target identities. Names and prose are not mutation authority.
- **Planning is read-only.** Builders stage virtual changes; only the fixed plugin
  or guarded source adapter writes persistent state.
- **Capabilities are closed.** Enable an operation only when validation, writing,
  reading, canonicalization, preflight, and comparison agree across host and plugin.
- **Evidence is immutable.** Preserve original observations, journals, failures,
  and outcomes. Derived views must not alter their meaning.
- **Missing evidence is incomplete.** Do not translate an unavailable fact into
  a pass, a mismatch, a cancelled recording, or a completed model request.
- **Recovery never guesses.** Ambiguous requests and recordings require fresh
  evidence and the appropriate explicit action. Restart does not retry effects.
- **The host owns orchestration.** Provider adapters execute one inference turn;
  the native runtime owns tools, budgets, stopping, and continuation.
- **Context stays useful and bounded.** Compact conversation history with a
  durable handoff, preserve the transcript, and retrieve large evidence through tools.
- **No compatibility layers.** Replace superseded schemas and storage formats
  outright. Keep one current path and archive evidence before an authorized reset.
- **Claims match evidence.** Successful editing, static checks, runtime facts,
  visual quality, and gameplay correctness are different claims.

## Scope

Forge currently runs as a local service and Studio plugin. It has a fixed model
registry, typed authoring policy, optional declared Rojo support, and a separate
registered-experiment path. It does not provide cloud collaboration, arbitrary
plugin execution, an unrestricted Studio scripting endpoint, general asset search,
or automatic proof of game quality.

[Architecture](ARCHITECTURE.md) describes implementation,
[Creator experience](CREATOR-EXPERIENCE.md) describes the interface, and
[Roadmap](ROADMAP.md) defines the next work.
