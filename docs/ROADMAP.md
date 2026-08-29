# Lemonade Forge Roadmap

Status: M1 and M1.5 complete  
Principle: prove the semantic thesis before adding product surface or scale

## Milestone map

| Milestone | Outcome | Exit signal |
| --- | --- | --- |
| M0 — Design lock | Reviewed contracts, architecture, benchmark definitions, and open questions | four design docs accepted; no implementation assumptions hidden |
| M1 — Deterministic Luau verifier ✅ | Local CLI finds real Luau and Roblox semantic defects | `forge verify ./examples/insecure-tycoon` returns structured, deterministic diagnostics |
| M1.5 — Flight Recorder foundations ✅ | Every verifier execution has local, versioned, privacy-minimized trace evidence | BuildTrace, stable spans/events, local sink, `forge trace show`, and regression tests |
| M2 — Contracted patch and semantic loop | One mechanic can be represented as a contract, bounded patch, deeper replication verification, and deterministic repair | insecure `CollectFruit` patch is rejected, repaired, traced, and rechecked without a model |
| M3 — StudioProof vertical slice | Fruit collect -> sell -> upgrade runs in real Studio with authoritative assertions | ProofBundle contains passing Studio assertions and explicit static/preflight/Studio tiers |
| M4 — CoreLoopBench and model comparison | Ten executable cases compare candidate implementations by verified outcome | benchmark results are reproducible, hidden assertions are supported, no LLM judge is primary |
| M5 — Productization research | Decide whether Studio connector, creator UX, routing, and trajectory retention merit further work | evidence-based product decision; no automatic commitment to production scale |

## M0 — Design lock

Deliverables:

- approve `SPEC.md`, `ARCHITECTURE.md`, `ROADMAP.md`, and `EVALS.md`;
- pin the official Luau toolchain version and distribution method;
- choose the initial project fixture format;
- resolve whether the semantic map is filesystem-derived for M1;
- write the threat model for untrusted client input and tool failures;
- define JSON serialization and exit-status conventions.

Exit criteria: a reviewer can identify what is authoritative, what is preflight, and what is future without reading implementation code.

## M1 — Deterministic Luau verifier

Implementation plan:

1. Scaffold the monorepo packages and runtime schema validators.
2. Add a pinned `luau-analyze` adapter with explicit tool discovery and health errors.
3. Build a fixture manifest for `examples/insecure-tycoon`.
4. Normalize official analyzer diagnostics into `VerificationIssue` objects.
5. Build a deterministic semantic map for script contexts, remotes, handlers, and obvious mutation paths.
6. Implement only the highest-signal rules: parse/type errors, client/server context errors, missing remote validation, client-controlled reward, persistence context, and missing structural references.
7. Sort/deduplicate diagnostics and define exit statuses.
8. Add snapshot and repeatability tests.
9. Add the first 10 CoreLoopBench manifests without requiring model or Studio access.

Concrete acceptance criteria:

- From a clean checkout with documented prerequisites, `forge verify ./examples/insecure-tycoon` exits successfully as a process and emits valid JSON.
- The fixture includes at least one syntactically invalid or type-invalid Luau file; the output contains `LUAU_PARSE_ERROR` or `LUAU_TYPE_ERROR` from the official tool adapter with a relative path and location when provided.
- The fixture includes a client-to-server state-changing remote whose untrusted value reaches an authoritative reward/inventory mutation; output contains `REMOTE_CLIENT_CONTROLLED_REWARD` with `critical` or `error` severity and evidence naming the client input, remote, and server mutation path.
- Repeating the command against unchanged inputs yields byte-identical normalized JSON after excluding explicitly documented wall-clock fields; the normalized output must not depend on machine-local absolute paths or hash-map iteration order.
- Blocking issues produce a non-zero exit status. A clean control fixture produces zero blocking issues and exit status zero.
- A missing or unusable `luau-analyze` binary produces a structured tooling failure and non-zero exit; Forge never falls back to a third-party or approximate parser.
- Analyzer stdout/stderr is preserved as provenance or a content hash, while normalized diagnostics remain stable.
- Tests cover malformed project paths, path escape attempts, empty projects, analyzer non-zero exit, duplicate issue keys, stable ordering, and JSON schema validation.
- M1 does not invoke a model, Roblox Studio, a live DataStore, or a network service.
- The command and fixture instructions are documented in the repository root and can be followed by a reviewer without undocumented local state.

M1 is not complete if it merely greps for `FireServer`, parses with a JavaScript library, or reports “secure” because a handler exists.

## M1.5 — Flight Recorder foundations

Implement now because these fields are cheap before patch/repair/Studio state exists:

- `BuildTrace` and objective `BuildOutcome` schemas with schema versions;
- deterministic build keys, unique execution trace IDs, snapshot/configuration hashes, and stable Forge span/event names;
- local JSON trace persistence, trace inspection, serialization validation, and non-gating sink-failure behavior;
- Luau and replication verifier timing/metadata propagation;
- documented relation among trace, ProofBundle, CoreLoopBench, and future experiments.

Explicitly defer:

- immutable source snapshot storage, model/tool execution, patches, repairs, Studio spans, exact replay, promotion CLI, benchmark runner, experiment UI, routing, dashboards, remote OpenTelemetry/Langfuse export, and trajectory infrastructure.

Exit criteria: existing M1 reports remain deterministic; every CLI verifier invocation emits a local trace or an explicit non-gating persistence failure; no raw source is written to the trace; `forge trace show <trace-id>` validates and displays a stored trace.

## M2 — Contracted patch loop

Implementation plan:

- add `GameIntent`, `CoreLoop`, and `MechanicContract` fixture files for `CollectFruit`;
- define a bounded patch operation set and validate expected effects;
- represent a vulnerable patch and a repaired patch as separate immutable fixtures;
- implement deterministic repair for the specific client-controlled reward defect;
- assemble a static/semantic `ProofBundle` with `preflight` and `studio` marked `not_run`;
- attach contract, patch, deterministic-repair, and resulting snapshot references to the existing BuildTrace;
- add atomicity semantics to the patch API design without pretending filesystem replacement is Studio commit.

Exit criteria: a local run shows reject -> deterministic repair -> reverify, with no frontier model call and no false Studio claim.

## M3 — StudioProof vertical slice

Implementation plan:

- create the smallest `FruitLoop` place with collect, sell, and upgrade;
- define Studio setup/actions/observations for one and two clients;
- execute server-authority, duplicate-request, invalid-ID, distance, and state-transition assertions in real Studio;
- isolate test data and record Studio version/session/run metadata;
- emit a proof report where Studio is the authoritative tier for engine/network assertions;
- make commit conditional on the required assertion set.

Exit criteria: the same bounded mechanic that passed static verification passes authoritative Studio assertions in an isolated test place. Pure Luau/Lune/Lute tests are supplementary only.

## M4 — CoreLoopBench and model comparison

Implementation plan:

- implement the 10 cases in `EVALS.md` as executable fixtures;
- implement reviewed `BuildTrace -> CoreLoopBench` promotion and experiment result records;
- split visible smoke assertions from hidden assertions;
- measure verified success, first-pass rate, repair efficiency, exploit rejection, latency, and cost;
- add model adapters only behind one proposal interface;
- compare models by domain and verified outcome; do not hard-code a winner;
- cache immutable verification results using source, dependency, tool, and rule hashes.

Exit criteria: a model scorecard can say “not enough evidence” and every claimed pass links to a reproducible fixture/proof result.

## M5 — Productization research

Candidate investigations, not commitments:

- interactive Studio connection and creator-facing proof cards;
- risk-based verification depth;
- model routing based on cost-adjusted verified success;
- privacy-preserving trajectory retention;
- production regression mining;
- performance and MicroProfiler evidence;
- monetization readiness only after a free loop is verified.

FirstDollar, Trajectory Lake, elaborate auth, and production-scale infrastructure remain out of scope until M3/M4 show that verification materially improves completed loops.

## Review gates and kill criteria

Pause expansion if any of these are true:

- static rules produce frequent false confidence because the project graph is incomplete;
- the team cannot reproduce a diagnostic from recorded inputs/tool versions;
- a mock runtime is being used to make claims about Roblox physics or replication;
- benchmark gains do not correlate with Studio assertion outcomes;
- deterministic repair changes behavior outside the contract’s bounded scope;
- cost/latency makes authoritative verification unusable and no risk-based policy exists.

The correct response is to improve evidence or narrow claims, not to add more agents or UI.
