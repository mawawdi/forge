# Lemonade Forge Specification

Status: M1 and M1.5 complete  
Scope: candidate proof-of-work; deterministic verifier plus local execution evidence

## 1. Product thesis

Lemonade Forge is a verified, model-agnostic compiler for Roblox game mechanics. It turns an underspecified creator goal into a typed game-design contract, proposes a bounded Luau change, verifies the change deterministically, and only then presents it as safe to commit.

The product is about completion, not code generation. Its durable object is the mechanic contract, not the prompt, model, or source diff:

```text
creator intent
  -> CoreLoop IR
  -> one MechanicContract
  -> bounded PatchSet
  -> deterministic Luau + Roblox semantic verification
  -> authoritative Studio proof (later milestone)
  -> atomic verified commit
```

The proof-of-work succeeds if it makes this claim credible:

> A replaceable model can produce useful Roblox code, but Forge is the system that decides whether the mechanic is coherent, server-authoritative, reproducible, and safe to commit.

The north-star metric is Verified Core Loop Completion Rate: the fraction of creators who start with an idea and reach a Studio-verified playable core loop. Milestone 1 does not measure this product metric yet; it establishes the deterministic verification substrate needed to measure it honestly.

## 2. Verified requirements and scope

The following are requirements for this proof-of-work because they are directly stated by the request or are necessary to make its central claim testable.

| Requirement | Initial interpretation | Evidence of completion |
| --- | --- | --- |
| Real Luau parsing/analysis | Use official `luau-analyze`; do not use an approximate Lua parser | `forge verify` invokes it and exposes its diagnostics structurally |
| Roblox client/server reasoning | Analyze remote direction, authority, validation, persistence context, and mutation paths | deterministic contract diagnostics on an intentionally insecure fixture |
| Deterministic verification | Same project and tool/rule inputs produce the same diagnostics and result | snapshot-tested JSON output with stable ordering |
| Inspectable architecture | Contracts, proof records, rule IDs, provenance, and boundaries are documented | this specification and the proposed package layout |
| Executable evals | Benchmark fixtures have inputs, assertions, expected outcomes, and budgets | CoreLoopBench fixture manifest and runner contract |
| Reproducibility | Inputs, tool versions, rule version, and project hash are recorded | ProofBundle and benchmark result metadata |
| Flight Recorder foundation | Every local verification run creates versioned, privacy-minimized execution evidence | a `BuildTrace` is persisted separately from deterministic CLI JSON |

## 3. Explicit non-goals

This project will not begin as:

- a generic chat application;
- a multi-agent planner/executor architecture;
- FirstDollar or monetization optimization;
- Trajectory Lake or a training-data platform;
- elaborate authentication, production-scale infrastructure, or a broad web product;
- a fake Roblox runtime presented as authoritative;
- a visual-polish project whose main output is UI;
- a whole-game one-shot generator;
- a replacement for Roblox Studio or Roblox's own authoritative runtime.

The model interface remains swappable, but model routing, fine-tuning, trajectory retention, and large-scale hosted infrastructure are future concerns. No compatibility layer for superseded schemas or storage formats is planned; a schema change will replace the current format and invalidate old fixtures/results when necessary.

## 4. Requirements versus speculative architecture

The report contains a strong strategic direction and several future systems. The proof-of-work must distinguish them.

| Status | Include now | Defer / record as future |
| --- | --- | --- |
| Required now | typed contracts; official Luau analysis; deterministic issue model; project semantic map sufficient for remote analysis; insecure fixture; structured CLI diagnostics; 10 benchmark definitions; reproducible rule/config metadata | — |
| Required for the thesis slice | intent-to-contract example; bounded patch representation; deterministic repair or repair recommendation; Studio-backed assertion protocol; proof bundle; one coherent collect -> sell -> upgrade loop | production creator UX and real model routing |
| Useful preflight | Lute programmable lint rules; pure Luau tests; mocked services; state-machine/economy checks; fuzzed hostile inputs | must never be labeled authoritative Roblox execution |
| Later, not required for candidate MVP | Studio plugin/MCP connection; isolated Studio workers; OpenGameEval-compatible benchmark execution; atomic Studio commit/rollback | all require environment access and operational design |
| Speculative/future | ModelArena; model posterior routing; FirstDollar; trajectory learning; performance regression gates; large-scale queues and multi-tenant services | no dependency from M1 |

## 5. Smallest vertical slice that proves the thesis

The smallest convincing end-to-end demonstration is one intentionally small fruit game, not a general compiler:

1. Creator enters: “Make a fruit game on floating islands where I get richer.”
2. Forge resolves that into `collect -> sell -> upgrade`, with one next mechanic selected.
3. Forge materializes a `CollectFruit` contract: client requests an interaction; the server validates identity and distance, computes the reward, and mutates inventory.
4. A bounded patch adds the mechanic to a tiny place.
5. Static Luau analysis and cross-script contract analysis run.
6. A development fault injects a client-controlled reward amount. The verifier catches it with a critical diagnostic.
7. A deterministic repair removes the untrusted amount and restores server-side reward calculation.
8. Studio executes assertions for collect, duplicate collect, invalid ID, impossible distance, and server-owned inventory mutation.
9. Forge emits a ProofBundle and commits only the verified delta.
10. Forge recommends `sell` as the next CoreLoop node.

This slice proves intent reconstruction, typed game semantics, bounded code change, Roblox security reasoning, repair, authoritative runtime verification, proof, and next-step guidance. It deliberately excludes monetization, model competition, persistent user accounts, and a generalized autonomous architecture.

Milestone 1 is the deterministic foundation of this slice. It must end with:

```bash
forge verify ./examples/insecure-tycoon
```

The command must run real Luau parsing/analysis and return structured diagnostics. The full Studio-backed slice is a later milestone; M1 must not claim to prove engine behavior.

## 6. User-visible behavior

Forge has two audiences:

- a novice creator sees a small mechanic proposal, a plain-language result, and an actionable explanation;
- an engineer can inspect the contract, source locations, rule IDs, tool versions, evidence, and proof artifacts.

Every proposed change has a bounded scope and an explicit status: `proposed`, `rejected`, `verified`, or `committed`. A failed verification cannot be represented as verified by changing presentation text.

For M1, the CLI is the only surface. Human-readable output is optional, but the machine-readable result is mandatory. The default output should be JSON to stdout, with logs/errors on stderr and a non-zero exit code when any error-level issue exists.

## 7. Verification trust model

Forge uses a strict evidence hierarchy:

1. Schema and IR invariants: deterministic and authoritative for data shape.
2. Official Luau parse/type/lint: authoritative for language/tool diagnostics.
3. Forge semantic rules: authoritative only for the properties they explicitly model.
4. Lute/Lune/pure Luau preflight: evidence for modeled code paths, not Roblox engine truth.
5. Roblox Studio execution: authoritative for engine, replication, physics, and stateful world behavior.
6. Human creator acceptance: product signal, not a substitute for security or runtime proof.

A ProofBundle must name which tiers ran. A missing Studio run is an explicit `not_run`, never an implied pass.

## 8. Milestone 1 acceptance summary

Milestone 1 is complete only when all of the following are true:

- `forge verify ./examples/insecure-tycoon` works from a clean checkout after documented tool setup;
- the project contains valid and invalid Luau files and the invalid files produce parse/type/lint diagnostics from official tooling;
- at least one diagnostic is a Forge semantic client/server authority issue, not merely a text match;
- output conforms to the documented structured schema, is deterministic across repeated runs, and includes file/line/column when available;
- the command exits non-zero for blocking issues and zero for a clean fixture;
- no result claims Studio, physics, replication, or persistence behavior was executed;
- tests cover fixture discovery, analyzer failure, issue normalization, ordering, exit status, and path traversal safety;
- the 10 CoreLoopBench case definitions exist and can be referenced without a model or network service.

The detailed checklist lives in `ROADMAP.md`; the benchmark contract lives in `EVALS.md`.

## 9. Flight Recorder decision

Every Forge build has two evidence products:

- `BuildTrace` is the complete execution history: build key, execution ID, spans, events, versions, hashes, objective outcome dimensions, and compact issue summaries.
- `ProofBundle` remains the compact immutable evidence for a verification/commit decision. M1 emits a `VerificationReport`; M2 will assemble the first ProofBundle rather than duplicating it in the trace.

BuildTrace persistence is local JSON in M1.5 and contains no raw source tree, raw creator prompt, credentials, or creator identity by default. Its content-derived `buildKey` supports semantic reproduction; its unique `traceId` identifies one observed execution. A trace is not an exact replay guarantee unless snapshot artifacts, all model responses, and runtime environment versions are retained.

The Flight Recorder is required plumbing now because it is cheap to attach to the verifier and expensive to reconstruct after patches, repairs, and Studio execution exist. CoreLoopBench promotion, experiment runs, model routing, dashboards, and remote telemetry backends remain later work.

## 10. Open questions

These questions are intentionally unresolved rather than silently guessed:

- Which exact Luau distribution/version will be pinned for CI and local development?
- Should custom semantic analysis initially be a TypeScript orchestration layer over analyzer output, a native Luau AST sidecar, or both?
- Which Roblox project interchange format is available to the eventual Studio connector: Rojo tree, place snapshot, Studio API, or another representation?
- Which Studio assertion runner and isolation model will be used when authoritative execution begins?
- What is the minimum semantic map needed to avoid false confidence when a remote or instance is dynamically created?
- Should a missing source location be an error, warning, or separate tool-health issue?
- How will Luau analyzer diagnostics be normalized across pinned tool upgrades?
- What exact definition of “atomic commit” is supported by the Studio integration?
- Which public OpenGameEval components can be reused under their repository terms?
- What privacy, retention, and consent review is required before any creator trajectory is stored?
- Which immutable project snapshot format should become the promotion/replay artifact in M2 or M3?
- What review policy decides that a failed trace is a legitimate permanent CoreLoopBench regression?
