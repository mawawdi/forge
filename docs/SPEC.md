# Lemonade Forge Specification

Status: M1, M1.5, M2, M2.5, M3, M3.25, M3.5, and M4.0 complete
Scope: preserved compiler-style vertical slice plus agent-harness provenance foundation

## M3.25 prompt-to-proof requirement

`forge build <clean-seed> --prompt <text>` treats schema-constrained model
output only as an untrusted proposal. Forge owns the server-authoritative
contract and compiles a `MechanicImplementationSpec` for the exact existing
remote ABI, state schema, constants, validation categories, authority
invariants, and allowed source targets. The model remains responsible for the
substantive two-file Luau implementation. Forge runs official syntax,
Roblox-aware type analysis, and M2 before Studio. `forge build` never invokes
Studio; `forge candidate studio <artifact>` may invoke the existing StudioProof
only with that prevalidated PatchSet. BuildTrace never
stores raw model output, source, or prompt; Studio remains the runtime authority.

Preserved-candidate repair has a stricter two-command boundary. `forge
candidate repair` performs exactly one repair call and emits a content-hashed
private artifact; it cannot contact Studio. `forge candidate studio <artifact>`
performs no model call and can reach StudioProof only after exact artifact,
seed, repaired-source, contract/interface/PatchSet, and fresh local-gate
validation succeeds.

M3.25 acceptance is established by verified ProofBundle
`proof_932e3d0abd04b04894b38e73`: the sealed model-repair PatchSet passed current
Luau and M2 gates, then passed 7/7 correlated assertions in real Studio under
`collect-fruit-v7` and committed. BuildTrace
`trace_596ab00b-5087-449b-8e33-a0ae0f5aee2e` records the accepted execution.

## M3.5 SellInventory requirement

`examples/core-loop/sell-inventory-seed` is the controlled incremental seed.
It pins the sealed M3.25 CollectFruit bytes and prior evidence, declares the
zero-argument `SellInventory:FireServer()` ABI, and allows model-authored
complete replacements for Sell server/client plus an optional Collect server
shared-state correction. Forge owns Inventory/Coins attribute state, SellZone
UnitPrice, the independent 20-stud server authorization limit, and exact Inventory-clear then
Coins-credit ordering. A StudioProof plan must execute 14 authoritative
correlated assertions in one run: seven CollectFruit regressions, six Sell
checks, and Collect→Sell composition. M3.5 acceptance is recorded by rejected
payout-fault ProofBundle `proof_4ec631d5d8117fee86a3292e` and fresh
model-repaired verified ProofBundle `proof_1fe98358c9d6262b92759b90`.

Production selling is a separate explicit interaction contract:
`Workspace/SellZone/SellPrompt` is a `ProximityPrompt` with
`MaxActivationDistance = 12`. A model may not replace that user action with
periodic or autonomous RemoteEvent requests. The 12-stud client activation
boundary does not weaken or redefine the server's 20-stud authorization check.

## M4.0 semantic-authority requirement

Post-M3.5, Forge is a Roblox-specific agent harness and evaluation system. It
must not scale by compiling an exact `MechanicImplementationSpec` and
handwritten harness for every possible mechanic. The M1–M3.5 objects and
verdict paths remain immutable historical regressions and may remain useful for
existing-project integration or exact benchmark fixtures.

M4.0 introduces an additive, runtime-validated Requirement layer. Every claim
that may guide generation, reject a candidate, or grade an outcome records its
source, authority, visibility, enforcement strength, verification modes, and
source-aligned evidence. A single scope resolver decides what a builder,
evaluator, or internal Forge consumer may see and enforce. Hidden benchmark
oracles and evaluator-only bodies never enter builder-visible Requirements or
AcceptanceSpec bodies.

M4.0 does not add BuildPlan, a tool-using agent, a game ontology, semantic
conflict solving, policy promotion, a general Studio action layer, or benchmark
infrastructure. It is the smallest provenance seam needed before those systems
can be evaluated honestly.

## 1. Product thesis

Lemonade Forge is a Roblox-specific harness for game-building agents. It makes
model/tool behavior observable, bounded, falsifiable, recoverable, and
empirically improvable. The agent may own novel design and implementation;
Forge owns truthful project/runtime observation, universal trust policy,
capability boundaries, verification/evaluation, evidence, rollback, tracing,
and the failure-to-regression loop.

The scalable direction is:

```text
creator request
  -> model-derived high-level requirements / BuildPlan
  -> tool-using builder over observed project state
  -> candidate game state
  -> deterministic + Studio + qualitative evaluation as applicable
  -> pass / feedback / repair
  -> trace + proof + reviewed regression
```

M1–M3.5 proved the trust boundary with this narrower compiler-style flow:

```text
creator intent
  -> CoreLoop IR
  -> one MechanicContract
  -> bounded PatchSet
  -> deterministic Luau + Roblox semantic verification
  -> authoritative Studio proof (later milestone)
  -> atomic verified commit
```

That preserved proof-of-work succeeds if it makes this claim credible:

> A replaceable model can produce useful Roblox code, but Forge is the system that decides whether the mechanic is coherent, server-authoritative, reproducible, and safe to commit.

The unit evaluated is `model + harness + tools + environment`. The north-star
metric remains Verified Core Loop Completion Rate, supported by separate
security, runtime, repair, cost, latency, and rollback measures rather than one
invented composite score.

## 2. Verified requirements and scope

The following are requirements for this proof-of-work because they are directly stated by the request or are necessary to make its central claim testable.

| Requirement | Initial interpretation | Evidence of completion |
| --- | --- | --- |
| Real Luau parsing/analysis | Use official Luau syntax tooling and a Roblox-host-aware official-language analyzer; do not use an approximate Lua parser or host-less Roblox fallback | `forge verify` reports separate syntax/type tiers and records pinned definitions/sourcemap provenance |
| Roblox client/server reasoning | Analyze remote direction, authority, validation, persistence context, and mutation paths | deterministic contract diagnostics on an intentionally insecure fixture |
| Deterministic verification | Same project and tool/rule inputs produce the same diagnostics and result | snapshot-tested JSON output with stable ordering |
| Inspectable architecture | Contracts, proof records, rule IDs, provenance, and boundaries are documented | this specification and the proposed package layout |
| Executable evals | Benchmark fixtures have inputs, assertions, expected outcomes, and budgets | CoreLoopBench fixture manifest and runner contract |
| Reproducibility | Inputs, tool versions, rule version, and project hash are recorded | ProofBundle and benchmark result metadata |
| Flight Recorder foundation | Every local verification run creates versioned, privacy-minimized execution evidence | a `BuildTrace` is persisted separately from deterministic CLI JSON |
| Canonical project semantics | Verification and future Studio work share a normalized representation of Roblox structure and source relationships | versioned `ProjectSemanticMap` and layered `ProjectSnapshot` hashes |
| Semantic authority | Every requirement that can guide, reject, or grade has explicit provenance, visibility, enforcement, and evidence | runtime-validated RequirementSet, scope resolver, leakage tests, and historical M3.5 projection |

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
- a hand-authored compiler or ontology for every Roblox game mechanic;
- a replacement for Roblox Studio or Roblox's own authoritative runtime.

The model interface remains swappable, but model routing, fine-tuning, trajectory retention, and large-scale hosted infrastructure are future concerns. No compatibility layer for superseded schemas or storage formats is planned; a schema change will replace the current format and invalidate old fixtures/results when necessary.

## 4. Requirements versus speculative architecture

The report contains a strong strategic direction and several future systems. The proof-of-work must distinguish them.

| Status | Include now | Defer / record as future |
| --- | --- | --- |
| Required now | typed contracts; official Luau analysis; deterministic issue model; project semantic map; requirement provenance/visibility; structured diagnostics; 10 benchmark concepts; reproducible rule/config metadata | — |
| Required for the thesis slice | intent-to-contract example; bounded patch representation; deterministic repair or repair recommendation; Studio-backed assertion protocol; proof bundle; one coherent collect -> sell -> upgrade loop | production creator UX and real model routing |
| Useful preflight | Lute programmable lint rules; pure Luau tests; mocked services; state-machine/economy checks; fuzzed hostile inputs | must never be labeled authoritative Roblox execution |
| M3 implementation now | Forge Studio Plugin, typed Studio protocol, live semantic observation, bounded PatchSet execution, ChangeHistory transaction boundary, and authoritative CollectFruit test harness | requires real Studio installation/run; no mock may satisfy the gate |
| Post-M4.0 evidence tasks | tool-using builder harness; general Studio actions/observations; isolated hidden evaluation; repeated unseen-game trials | exact consumer design follows measured failures rather than a new mechanic compiler |
| Later, not required for candidate MVP | isolated/hosted Studio workers; production auth; distributed relay | all require demonstrated long-horizon or parallel workload |
| Speculative/future | ModelArena; model posterior routing; FirstDollar; trajectory learning; performance regression gates; large-scale queues and multi-tenant services | no dependency from M1 |

## 5. Preserved vertical slice that proved the trust boundary

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

This slice proves intent reconstruction, typed game semantics, bounded code
change, Roblox security reasoning, repair, authoritative runtime verification,
proof, and next-step guidance. It deliberately excludes monetization, model
competition, persistent user accounts, and a generalized autonomous
architecture. Post-M3.5 work preserves this evidence but does not reproduce the
same compiler and exact harness for every new mechanic.

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
2. Official Luau syntax plus Roblox-host-aware type analysis: authoritative for the language and host declarations actually loaded; missing host tooling is incomplete, not source blame.
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
- `ProofBundle` remains the compact immutable evidence for a verification/commit decision. M1 emits a `VerificationReport`; M2 assembles a static/semantic ProofBundle with preflight and Studio explicitly marked `not_run`.

BuildTrace persistence is local JSON in M1.5 and contains no raw source tree, raw creator prompt, credentials, or creator identity by default. Its content-derived `buildKey` supports semantic reproduction; its unique `traceId` identifies one observed execution. A trace is not an exact replay guarantee unless snapshot artifacts, all model responses, and runtime environment versions are retained.

The Flight Recorder is required plumbing now because it is cheap to attach to the verifier and expensive to reconstruct after patches, repairs, and Studio execution exist. CoreLoopBench promotion, experiment runs, model routing, dashboards, and remote telemetry backends remain later work.

## 10. Semantic state and context foundations

Forge does not define a Roblox project as only Luau source. The M2.5 `ProjectSemanticMap` captures the relevant Instance hierarchy, script execution contexts and hashes, modules, remotes and M2 graph relationships, persistent-state declarations, UI bindings, mechanic-contract IDs, and dependency edges. The current filesystem adapter infers only what the fixture and path conventions establish; missing world knowledge remains unknown.

`ProjectSnapshot` separates source, structure, contract, and aggregate semantic hashes. Ordering, paths, tags, attributes, and metadata are canonicalized before hashing. The source hash remains the patch/verifier precondition; the aggregate semantic hash is the comparison key for semantically equivalent starting states. A future Studio adapter must produce the same shape without pretending static data is live truth.

The historical `ContextCompiler` selects only context relevant to one bounded
mechanic task and records provenance for every item. M2.5 implements
deterministic P0/P1/P2 selection and composition metadata, not retrieval,
budget optimization, or a model runtime. It remains useful for deterministic
context, caching, and experiments beneath future tool-driven exploration; it
is not required to precompute everything an agent may discover. A
`VerifiedMechanicCapsule` is candidate-only until a ProofBundle contains
authoritative Studio evidence; reuse always triggers re-verification.

## 11. Studio Plugin and StudioProof boundary

Forge owns Studio integration through a first-class, thin Roblox Studio Plugin. The backend remains the reasoning/compiler boundary; the plugin executes only validated, correlated operations against the current Studio project. Roblox Studio MCP is optional development/debugging infrastructure, not Forge's product interface.

The M3 authoritative path is:

```text
MechanicContract
  -> StudioTestPlan
  -> arm exact run (no Studio launch)
  -> explicit Run StudioProof plugin action
  -> temporary injected server/client harness
  -> Play Solo client/server simulation / server EndTest envelope
  -> one structured correlated StudioTestResult
  -> existing ProofBundle + BuildTrace

PatchSet application and the ChangeHistory transaction precede arming and remain bound to the starting and post-patch snapshots.
```

A connected plugin, successful HTTP request, emitted Output line, or successful patch application alone is never proof. Arming does not start Studio; the creator explicitly selects **Run StudioProof** in the plugin, which injects one server harness and client driver before calling `StudioTestService:ExecutePlayModeAsync`. The sole server harness returns one atomic JSON string directly through `EndTest(JSON)`; Output is not a protocol message. The Studio tier is verified only when that envelope is authoritative, correlated to the exact contract/patch/snapshots and active run, and all required happy-path and adversarial assertions pass. Future lifecycle adapters must preserve the same server-return evidence semantics.

## 12. Open questions

These questions are intentionally unresolved rather than silently guessed:

- How should the pinned Roblox definition snapshot be upgraded and reviewed when Studio APIs change?
- Which M2 relationships should next move from conservative source evidence to a native Luau AST/type sidecar?
- Which Roblox project interchange format is available to the eventual Studio connector: Rojo tree, place snapshot, Studio API, or another representation?
- What is the minimum semantic map needed to avoid false confidence when a remote or instance is dynamically created?
- Should a missing source location be an error, warning, or separate tool-health issue?
- How will Luau analyzer diagnostics be normalized across pinned tool upgrades?
- What exact definition of “atomic commit” is supported by the Studio integration?
- Which public OpenGameEval components can be reused under their repository terms?
- What privacy, retention, and consent review is required before any creator trajectory is stored?
- Which immutable project snapshot format should become the promotion/replay artifact in M2 or M3?
- What review policy decides that a failed trace is a legitimate permanent CoreLoopBench regression?
- Which current Studio test harness can expose server/client observations without making test hooks authoritative themselves?
- Can the plugin's permitted source-edit path provide stable source hashes without sending unnecessary raw source over the local bridge?
