# Lemonade Forge Roadmap

Status: M1, M1.5, M2, M2.5, M3, and M3.25 complete; M3.5 next
Principle: prove the semantic thesis before adding product surface or scale

## Milestone map

| Milestone | Outcome | Exit signal |
| --- | --- | --- |
| M0 — Design lock | Reviewed contracts, architecture, benchmark definitions, and open questions | four design docs accepted; no implementation assumptions hidden |
| M1 — Deterministic Luau verifier ✅ | Local CLI finds real Luau and Roblox semantic defects | `forge verify ./examples/insecure-tycoon` returns structured, deterministic diagnostics |
| M1.5 — Flight Recorder foundations ✅ | Every verifier execution has local, versioned, privacy-minimized trace evidence | BuildTrace, stable spans/events, local sink, `forge trace show`, and regression tests |
| M2 — Contracted patch and semantic loop ✅ | One mechanic can be represented as a contract, bounded patch, deeper replication verification, and deterministic repair | insecure `CollectFruit` patch is rejected, repaired, traced, and rechecked without a model |
| M2.5 — Semantic state foundations ✅ | The verifier has a canonical, hashed project representation and a model-neutral context boundary | ProjectSemanticMap, ProjectSnapshot, affected cones, context provenance, and capsule schema tests pass |
| M3 — Forge Studio Plugin + StudioProof vertical slice ✅ | CollectFruit runs through the first-class plugin in real Studio with authoritative assertions; sell/upgrade remain contract-level follow-ons | Showcase evidence includes safe pass, fault rejection, exact rollback, repaired rerun, and interrupted incomplete run |
| M3.25 — Prompt-to-proof generation ✅ | One OpenRouter proposal path produces a bounded CollectFruit candidate that must pass M1/M2 then the unchanged M3 StudioProof | model-authored repair -> sealed artifact -> typed PatchSet -> 7/7 real Studio assertions -> verified ProofBundle |
| M3.5 — Context and capsule promotion | Context composition and reusable capability promotion are backed by real Studio evidence | context metrics are tied to verified outcomes; first capsule has authoritative provenance |
| M4 — CoreLoopBench and model comparison | Ten executable cases compare candidate implementations by verified outcome | benchmark results are reproducible, hidden assertions are supported, no LLM judge is primary |
| M4.5 — Capability adaptation research | Compare fresh generation with re-verified capsule adaptation | adaptation never bypasses verification; evidence supports or rejects reuse |
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
2. Add pinned official Luau syntax and Roblox-aware type-analysis adapters with explicit tool discovery and health errors.
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
- A missing or unusable syntax analyzer, Roblox-aware analyzer, definitions snapshot, or sourcemap capability produces a structured tooling failure and non-zero exit; Forge never falls back to a third-party, approximate, or host-less Roblox parser.
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

## M2 — Contracted patch loop ✅

Implementation plan:

- add `GameIntent`, `CoreLoop`, and `MechanicContract` fixture files for `CollectFruit`;
- define a bounded patch operation set and validate expected effects;
- represent a vulnerable patch and a repaired patch as separate immutable fixtures;
- implement deterministic repair for the specific client-controlled reward defect;
- assemble a static/semantic `ProofBundle` with `preflight` and `studio` marked `not_run`;
- attach contract, patch, deterministic-repair, and resulting snapshot references to the existing BuildTrace;
- add atomicity semantics to the patch API design without pretending filesystem replacement is Studio commit.

Concrete acceptance criteria:

- `GameIntent`, `CoreLoop`, `MechanicContract`, and `StudioAssertion` fixtures validate at schema boundaries.
- `PatchSet` supports a bounded exact replacement operation with before-hash, project-hash, file-count, and line-count bounds.
- Applying a patch stages a complete project copy and publishes it only after all checks pass; stale hashes and failed bounds publish no destination.
- `forge repair examples/collect-fruit/vulnerable --contract examples/collect-fruit/contracts/MechanicContract.json --out <directory>` exits zero only after the repaired output passes official Luau and Forge semantic verification.
- The vulnerable run reports `REMOTE_CLIENT_CONTROLLED_REWARD` and `REMOTE_UNVALIDATED_INPUT`; the repaired run reports neither.
- The repaired BuildTrace references the mechanic contract and PatchSet, includes patch/repair spans, and records one deterministic repair with no model usage.
- The ProofBundle reports static and semantic checks explicitly and keeps pure-Luau preflight and Studio assertions `not_run`.

Exit criteria: a local run shows reject -> deterministic repair -> reverify, with no frontier model call and no false Studio claim. **Met.**

## M2.5 — Semantic state foundations ✅

Implementation delivered:

- formalize the existing M2 script/remote graph inside a versioned `ProjectSemanticMap`;
- derive canonical Instance, script, module, remote, state, UI, contract, and dependency metadata;
- add `ProjectSnapshot` with source, structure, contract, semantic, and canonical-map hashes;
- expose conservative affected verification cones for future incremental checks;
- add a filesystem/Rojo-style adapter boundary for future Studio and optional rbx-dom adapters;
- add deterministic context compilation with provenance and Flight Recorder composition summaries;
- add the candidate-only `VerifiedMechanicCapsule` schema with authoritative provenance requirements;
- document capability boundaries, Studio truth, and adapter/tooling decisions.

Exit criteria: M1/M1.5/M2 behavior is unchanged, canonical semantic projects hash consistently, relevant context is explainable, and M3 can consume the same contract/map boundary. **Met.**

## M3 — StudioProof vertical slice

Current gate: **M3-P0 through M3-P3 passed.** A temporary standalone API canary,
whose findings are retained in `docs/research/studio-test-service-blocker.md`, produced exact server
roundtrips through both `ExecuteRunModeAsync` and `ExecutePlayModeAsync` on the
target Studio build, then proved a real Play Solo LocalScript-to-server
RemoteEvent roundtrip. Real CollectFruit requests then verified inventory
`0 -> 1`, consumed state, duplicate inventory remaining `1`, a client claim of
`999999` producing only server reward `1`, and a measured distance of `6.71`
studs. Those canaries informed the production seven-assertion correlated StudioProof, which is now complete for the project showcase.

These P0-P3 canaries are non-authoritative characterization tests. They do not
emit a ProofBundle, do not count as CoreLoopBench passes, and will not become a
parallel hard-coded verification system. Their successful kernel is reintegrated
through the versioned mechanic-runner and StudioTestPlan boundaries.

Implementation plan:

- create the smallest `CollectFruit` place and keep sell/upgrade as contract-level follow-ons until the authority boundary is proven;
- consume `ProjectSemanticMap` as the static baseline and merge it with a live Studio DataModel view through an adapter;
- use the Forge Studio Plugin as the product integration; built-in Studio MCP remains optional development/debugging infrastructure;
- define the versioned `StudioTestPlan` and `StudioRunController` boundary, with an explicit plugin-triggered Play Solo adapter as the M3 path;
- execute valid collect, exact inventory `0 -> 1`, fruit unavailability, duplicate-request, invalid-ID, impossible-distance, and client-reward-spoof assertions through one real Studio server and client;
- isolate test data and record Studio version/session/run metadata;
- emit a proof report where Studio is the authoritative tier for engine/network assertions;
- make commit conditional on the required assertion set.

Exit criteria: the same bounded mechanic that passed static verification passes authoritative Studio assertions in an isolated test place. Pure Luau/Lune/Lute tests are supplementary only.

Concrete M3 acceptance criteria:

- The Rojo-built `plugin/ForgeStudioPlugin.rbxmx` automatically discovers the loopback bridge and exchanges an internal one-use credential; plugin messages require the resulting session token, while CLI bridge-control calls read their separate credential from an owner-only ephemeral discovery file.
- A real plugin `ProjectObservation` includes the live DataModel identity, relevant instances, scripts, remotes, attributes, and tags; the backend maps it through `mergeStudioObservation()` and is the only component that creates canonical `ProjectSnapshot` hashes.
- The plugin accepts only versioned, validated PatchSet operations, checks target/precondition identity, groups changes with `ChangeHistoryService`, and emits an explicit apply/reject result with a post-operation snapshot.
- The real `examples/collect-fruit/studio` place runs a temporary harness in one explicit `ExecutePlayModeAsync` action and produces correlated results for valid collect, inventory `0 -> 1`, fruit unavailability, duplicate rejection, spoofed ID rejection, impossible-distance rejection, and client reward spoof rejection.
- Arming and execution are separate. `forge studio verify` patches, gates, and arms the run; it never launches Studio. The creator selects **Verify in Studio** in the plugin. The edit-mode root plugin then owns the yielding Play Solo request, and the sole server harness emits one structured JSON string directly through `EndTest(JSON)`. Output is not a protocol message. The plugin and backend independently validate the envelope before acceptance.
- The bridge process is explicitly user-owned: `forge studio bridge` is started once, while both the plugin and `forge studio verify` discover and attach to its loopback channels automatically. Neither launches a competing listener or asks the creator to copy a token. Disconnect pauses plugin discovery; Connect resumes it with a fresh internal pairing exchange.
- A `ProofBundle` is verified only when every required assertion result is present, authoritative, correlated to the plan/run/snapshots, and passing; incomplete or failed Studio runs remain explicit and preservable.
- A faulted or stale transaction is rejected or canceled, and no mock bridge, MCP-only run, pure Luau run, or successful HTTP response can satisfy the Studio gate.

Current M3 status: protocol v7, authenticated pair/unpair and loopback control,
complete observations, typed patching, explicit arm/run separation, proof
assembly, and local tests are implemented. M3-P0 is empirically green for both
Run and Play server return values. Forge now uses the canary-proven direct
result shape and no longer passes `timeoutSeconds` as a test argument. The
abandoned multiplayer adapter spawned separate Studio workers and remains
removed. The core-three canary and all three required safe production runs have
passed. The real client-controlled-reward run is now also green as a rejection:
M2 reported the critical authority flow, CF-007 demonstrated its runtime
consequence, the ProofBundle was rejected, and the inverse-backed rollback
restored the exact starting live revision. A fresh safe PatchSet then passed
static, M2, and all seven Studio assertions and produced a new verified
ProofBundle. A user-stopped real Studio run now persists as an explicit
non-authoritative `PLAYTEST_INTERRUPTED` incomplete result. M3 is complete for
the showcase; remaining interruption tests are post-showcase hardening.

Real acceptance progress: **safe runs 3/3 verified.** Each run produced seven
authoritative passes, committed its transaction, and persisted a distinct
ProofBundle and BuildTrace linked to fresh run/session/correlation identities.
The exact evidence ledger is in `docs/research/m3-real-studio-runs.md`. M3 is
closed for the showcase, with its production-hardening boundary documented.

## M3.25 — Prompt-to-proof generation

`forge build examples/collect-fruit/generated-seed --prompt "..."` uses one
strict OpenRouter structured-output call for `IntentDraft`; Forge then compiles
the security-sensitive CollectFruit contract and a second strict call may
propose exactly two source replacements. Forge fills all PatchSet preconditions
and rejects unsupported paths, source capabilities, and policy violations. A
candidate is materialized under private local run state and must pass official
Luau plus M2 before it can attach to Studio.

`forge build ... --studio` sends that prevalidated typed PatchSet through the
existing M3 transaction and correlated evidence path. It does not alter plugin,
harness, evidence, or ProofBundle semantics. M3.25 requires an
OpenRouter-authored candidate to pass all seven real Studio assertions without
manual source edits, followed by a fresh repeat run.

Current correction result: the exact first Luna proposal from
`generation_65a285b6-1b69-4e59-8851-cabc2857e056` is preserved unchanged as
`examples/collect-fruit/regressions/luna-first-pass`. Reverification reconstructs
the same PatchSet ID. Official syntax and Roblox-aware type analysis pass, which
removes the historical host-environment false positives. M2 now binds the
RemoteEvent ABI by argument position and semantic role and does not demand
inapplicable ownership checks. The candidate is still correctly rejected for
one genuine model defect: its server distance threshold is `12`, while the
Forge-owned implementation interface requires exactly `20`. It is therefore
not eligible for StudioProof. No replacement model candidate or deterministic
complete mechanic implementation was generated.

The next experiment is implemented as `forge candidate repair`. It performs
one schema-constrained repair call against the immutable regression, with no
intent call and no fresh initial proposal. The command records source
generation/attempt/trace/response/PatchSet identities, compiles complete repair
context, writes a new candidate outside both regression and seed, runs local
gates, and emits a content-hashed candidate artifact. It never connects to
Studio. A separate `forge candidate studio <artifact>` command revalidates the
sealed source, seed preconditions, interface linkage, and current local gate,
then reuses the existing M3 path without another model call. A rejected or
modified artifact cannot enter StudioProof.

M3.25 exit evidence: Luna made one schema-constrained repair call against the
immutable first-pass regression. Forge sealed candidate
`candidate_repair_f3e69e1e-2067-432e-8b3b-0f2c86a3964f` as artifact hash
`fecd5adfe0fcb4392b5e8953186ac213676c6670c104f2e0d4a175ccd4bb7d63`
and PatchSet `patch_generated_f3213dc3e71fe0050d4e19a2`. Two fresh real
Studio runs with `collect-fruit-v7` passed all seven correlated assertions and
committed. The final content-identified evidence is ProofBundle
`proof_932e3d0abd04b04894b38e73`, linked to accepted BuildTrace
`trace_596ab00b-5087-449b-8e33-a0ae0f5aee2e`. No manual candidate source edit
or second model call occurred between repair and StudioProof.

## M3.5 — Context and capsule promotion

Implementation plan:

- attach context composition metadata to Studio-backed runs and compare selected evidence with verification outcomes;
- review the first `CollectFruit` result as a candidate capsule rather than auto-promoting it;
- promote only when the ProofBundle contains the required authoritative assertion evidence and runtime provenance;
- keep capsule reuse behind the same contract, adapter, and complete applicable verification path.

Exit criteria: one capsule has authoritative provenance, its context/evidence relationship is inspectable, and no reuse path can bypass verification.

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

## M4.5 — Capability adaptation research

Implementation plan:

- compare fresh generation with adaptation from the first verified capsule on fixed CoreLoopBench cases;
- measure verified completion, security regressions, repair attempts, latency, and cost independently;
- require every adapted output to become a new candidate and pass the applicable static, semantic, preflight, and Studio tiers;
- record evidence for or against capsule reuse without hard-coding a winner.

Exit criteria: the experiment can show whether verified capability reuse improves verified outcomes without weakening the evidence gate.

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
