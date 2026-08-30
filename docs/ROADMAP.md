# Lemonade Forge Roadmap

Status: M1, M1.5, M2, M2.5, M3, M3.25, M3.5, and M4.0 complete
Principle: improve the model+harness+tools+environment through falsifiable evidence before adding scale

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
| M3.5 — SellInventory generalization ✅ | A second model-authored mechanic extends the sealed CollectFruit loop through bounded PatchSet and combined StudioProof | fresh model-repaired candidate passed 14/14; payout fault rejected and rolled back |
| M4.0 — Semantic authority / provenance pivot ✅ | Requirements state source, authority, visibility, enforcement, and evidence without a mechanic ontology | generic scope resolver and isolated M3.5 projection pass leakage/integrity tests |
| M4.1 — Tool-using builder harness | One agent edits an observed project through bounded inspect/edit/test tools | fixed tasks produce complete traces and failures can be assigned to model, context, tool, harness, verifier, grader, environment, or task |
| M4.2 — General Studio capabilities | Studio exposes reusable actions and observations rather than another mechanic harness | one unseen task is evaluated through correlated real-Studio evidence without arbitrary-code test interpretation |
| M4.3 — Eval and regression infrastructure | Repeated fixed tasks separate builder-visible inputs from hidden evaluators and preserve promotions | representative trials are reproducible and every score links to immutable task/result evidence |
| M4.4 — Unseen-game generalization | The harness attempts varied game changes without new mechanic-name hardcoding | outcome/security/runtime evidence distinguishes valid alternate implementations from real failures |
| M4.5 — Long-horizon run | One bounded multi-step build is checkpointed, recoverable, and objectively measured | interruption, retry, rollback, cost, latency, and verified outcome are all recorded |
| M4.6 — Hosted workers, if justified | Remote/parallel workers serve a demonstrated eval workload | local evidence shows isolation, persistence, or parallelism is a bottleneck before infrastructure is added |

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

Current M3 status: protocol v10, authenticated pair/unpair and loopback control,
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

`forge build` performs model work and local gates only. A separate
`forge candidate studio <artifact>` command sends that prevalidated typed
PatchSet through the existing M3 transaction and correlated evidence path with
zero model calls. It does not alter plugin, evidence, or ProofBundle semantics.
M3.25 requires an
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

The historical repair experiment remains recorded as `forge candidate repair`.
It performs
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

## M3.5 — SellInventory generalization

Forge is implementing the second bounded core-loop mechanic without replacing
model-authored code with a known-good compiler. The tracked
`examples/core-loop/sell-inventory-seed` starts from the byte-identical sealed
M3.25 CollectFruit candidate and records its source hashes, prior ProofBundle,
and BuildTrace provenance. It adds only the structural SellInventory ABI,
SellZone, UnitPrice, and empty model targets.

The follow-up model request produces a `CoreLoopExtensionDraft`; Forge keeps
GameIntent/CoreLoop identity, contract semantics, remote ABI, state bindings,
PatchSet policy, and security invariants deterministic. The model may replace
Sell and Collect server sources, production input wrappers, and their two
bounded client action modules. Collect's server change removes the private
Inventory mirror so both mechanics share the server-owned player attribute.
The bounded six-file PatchSet permits no unrelated paths.

The Studio path is protocol v10. `collect-fruit-v7` remains unchanged for
historical M3.25 evidence. The exact-hash `collect-sell-v4` harness is a
separate allow-listed server-return harness; it executes seven CollectFruit
regressions, six SellInventory assertions, and the Collect→Sell composition
assertion in one Play Solo session. A v3 StudioTestPlan explicitly binds the
prior verified CollectFruit contract and ProofBundle. A v4 ProofBundle records
the candidate artifact, intent/core-loop/spec/context references, all assertion
contract IDs, and regression provenance.

M3.5 now has an explicit `InteractionBinding` boundary. SellInventory production
initiation is `Workspace/SellZone/SellPrompt.Triggered`, with
`MaxActivationDistance = 12` and one request per explicit player action. Server
authorization remains a separate 20-stud distance check against `SellZone`.
`ProjectSemanticMap` carries the prompt, prompt properties, relevant world
positions, and both distances into required generation context. The semantic
gate rejects periodic/autonomous initiation only when the declared interaction
requires an explicit action. Production input wrappers and Studio happy paths
invoke the same model-authored client action modules; direct RemoteEvent calls
are reserved for adversarial server-boundary assertions. This avoids privileged
synthetic input while retaining runtime coverage of the production request path.

Canonical flow:

```bash
npm run plugin:build
rojo build examples/core-loop/sell-inventory-seed/default.project.json --output /tmp/ForgeFruitLoop.rbxlx
open /tmp/ForgeFruitLoop.rbxlx
node bin/forge.js studio bridge
node bin/forge.js build examples/core-loop/sell-inventory-seed --prompt "Now let players sell the fruit they collected to get coins." --format json > /tmp/forge-sell-candidate.json
node bin/forge.js candidate studio "$(jq -r '.artifactPath' /tmp/forge-sell-candidate.json)" --timeout-ms 180000
```

The Studio place in that flow is deliberately built from
`sell-inventory-seed`, not the candidate artifact's `outputRoot`. `candidate
studio` applies the sealed PatchSet itself and therefore requires the exact
seed before-state; opening the output project correctly produces a source
precondition rejection and rollback.

The first authoritative M3.5 acceptance run passed on 2026-08-30. Model-repaired
candidate `candidate_67755f37e357ba8a17f31bc6` applied bounded PatchSet
`patch_generated_1a9230403ea1d2b0b5ac1604`; all 14 correlated CollectFruit,
SellInventory, and composition assertions passed in the exact-hash
`collect-sell-v4` harness; and the Studio transaction committed. Verified
ProofBundle `proof_7a12304b1f2a1f12a5ec901a` links the candidate, prior
CollectFruit regression proof, contract-specific assertion results, and accepted
BuildTrace `trace_f732f5ad-7173-4cd0-9e2a-73289711c5fd`. The retained-candidate
Studio invocation made no model calls and performed no human source edits.

M3.5 is **complete**. The final fresh model-repaired candidate
`candidate_144cf0452d72bf415afb1ffe` applied
`patch_generated_d9821df83d8a5caba5bbcb1d`, passed all fourteen correlated
assertions in real Studio, and committed. Its verified ProofBundle is
`proof_1fe98358c9d6262b92759b90`; its Studio BuildTrace is
`trace_55d4b781-3e55-4992-bba3-c266c922abc7`; and its separate current local
verification trace is `trace_59efa7ea-1967-4ed2-a80b-70cc7b26bb4e`. Together
with the rejected payout-fault proof, this demonstrates the required
model-authored candidate → bounded PatchSet → local gates → real StudioProof →
commit/reject decision loop. UpgradeBasket, capsules, routing, UI, and product
infrastructure remain out of scope for this milestone.

The payout fault is exercised through a generic contract-scoped fault mode, not
through a Sell-only verifier exemption or a known-good replacement. Forge starts
from a sealed safe candidate, applies one bounded server `replace_text` mutation
that adds an undeclared callback input to a no-client-input economic ABI, and
then requires M2 to report both the ABI divergence and the untrusted flow into
the declared currency mutation. The same StudioProof harness calls the
production path for happy assertions and makes a direct `FireServer(999999)`
call only for the designated adversarial assertion. That fault proof is tied to
its own PatchSet, snapshot, trace, and rejected ProofBundle; it cannot be
represented as a proof of the safe candidate.

The payout fault can be reproduced with:

```bash
node bin/forge.js candidate studio \
  /absolute/path/to/candidate.json \
  --fault client-controlled-payout \
  --timeout-ms 180000
```

It is expected to exit nonzero after a valid rejection. The expected outcomes
are `REMOTE_ABI_ARITY_MISMATCH`, `REMOTE_UNDECLARED_CLIENT_INPUT`, and
`ECONOMY_CLIENT_CONTROLLED_PAYOUT` locally; a failed adversarial payout
assertion in Studio; a rejected ProofBundle; and observed rollback.

The first real payout-fault attempt is retained as diagnostic evidence:
`patch_studio_dbcd7e5f-f089-40ac-a8ac-f40e68256dda`, ProofBundle
`proof_8504a3036f25ef3984665901`, and BuildTrace
`trace_affe594a-4dcf-4469-a813-26dbc5f5de65` were rejected and rolled back.
It showed that the initial mutation incorrectly treated the normal zero-argument
production call as invalid, causing non-adversarial Sell assertions to fail as
well. The corrected fault now preserves the server-derived payout when no extra
argument is supplied and trusts only an explicitly supplied adversarial payout.
The historical proof and trace remain unchanged; the corrected run has its own
separate evidence.

The corrected authoritative fault run then passed its intended regression shape:
safe baseline `candidate_67755f37e357ba8a17f31bc6` received fault PatchSet
`patch_studio_f2d12703-7c6e-4f72-af43-a31f14c4d3f9`; thirteen of fourteen
assertions passed, while the sole direct payout-spoof assertion observed
`1000009` instead of the server-derived `20`. M2 emitted
`REMOTE_ABI_ARITY_MISMATCH`, `REMOTE_UNDECLARED_CLIENT_INPUT`, and
`ECONOMY_CLIENT_CONTROLLED_PAYOUT`; Studio rolled back to the exact prior
snapshot; ProofBundle `proof_4ec631d5d8117fee86a3292e` and BuildTrace
`trace_b332b0ae-ea9f-40de-b37f-a62df52bfc23` are rejected evidence. Because
this fault was Forge-owned test instrumentation rather than model-authored
candidate source, the follow-up is a new model-authored candidate from the
unchanged seed and a new StudioProof—not a claim that the model repaired its
own safe baseline.

## M4.0 — Semantic authority / provenance pivot ✅

Delivered:

- implementation-grounded audit of generation, context, PatchSet, verifier,
  Studio, and proof gates;
- accepted semantic-authority RFC with conflict and conceptual temporal rules;
- runtime-validated Requirement, RequirementSet, AcceptanceSpec,
  IntegrationConstraint, and RequirementView contracts;
- canonical ordering, deterministic serialization/hashing, source-aligned
  evidence, and immutable source/authority identity checks;
- one production/benchmark build/evaluate scope resolver separating visibility
  from enforcement;
- isolated historical M3.5 projection with all fourteen assertion IDs and no
  copied evaluator bodies/oracles;
- positive, malformed, adversarial, leakage, alternate-greenfield-plan, and
  historical hash/registry tests.

Exit criteria: the focused tests and full existing suite pass; M1–M3.5
generation, verifier, Studio protocol, harness registry, plans, proofs, traces,
candidates, and regressions remain unchanged; no model or Studio run is used.
**Met.**

## M4.1 — Tool-using builder harness

Next smallest evidence-producing task:

- define a high-level BuildPlan/requirement consumer only after exercising the
  M4.0 scope boundary;
- give one builder bounded project search, inspection, structured editing,
  verification, and checkpoint tools;
- preserve ProjectSemanticMap as observation infrastructure and Context
  Compiler as provenance/caching infrastructure without requiring a giant
  precomputed prompt;
- run a small fixed task set and retain complete tool/repair trajectories;
- classify every failure among model, context, tool, harness, verifier,
  grader/eval, environment/infrastructure, and task/specification.

Exit criteria: at least one useful greenfield change and one existing-project
change are attempted without adding mechanic-name-specific compiler code, and
their results are fully attributable.

## M4.2 — General Studio capabilities

- expose bounded project/runtime actions and observations such as finding an
  instance, invoking a production interaction, moving a character, observing
  attributes/UI/state, capturing screenshots, and attacking a RemoteEvent in
  designated adversarial evaluation;
- preserve correlation, exact project/snapshot binding, fail-closed lifecycle,
  instrumentation cleanup, and server-return evidence;
- do not build a universal arbitrary-code test interpreter;
- keep Collect and Collect+Sell exact harnesses immutable.

Exit criteria: an M4.1 task that is not CollectFruit or SellInventory gains
authoritative runtime evidence through reusable capabilities rather than a new
mechanic harness.

## M4.3 — Eval and regression infrastructure

- turn the ten CoreLoopBench concepts into representative agent tasks over
  stable environments;
- separate builder-visible requests, facts, policies, and outcomes from hidden
  assertion bodies, benchmark oracles, grader code, and answer artifacts;
- repeat trials and record verified success, first-pass success, deterministic
  and runtime failure, repair/retry count, model/tool calls, cost, latency, and
  rollback independently;
- implement reviewed failure-to-regression promotion only when a real failure
  and consumer justify it;
- evaluate whether Harbor or a comparable runner is useful only after task and
  environment contracts stabilize.

Exit criteria: one controlled experiment can vary a single model/harness/tool
dimension against fixed tasks and every result is reproducible or explicitly
classified as infrastructure failure.

## M4.4 — Unseen-game generalization

- evaluate varied genres and task shapes that were not represented by the
  Collect/Sell compiler;
- include greenfield and existing-project tasks;
- accept multiple safe implementations that satisfy observable creator
  outcomes;
- add deterministic checks only for honest language, platform, security,
  project, or regression claims;
- use evaluator/human signal for subjective quality without overriding failed
  deterministic safety/runtime invariants.

Exit criteria: Forge measures meaningful outcomes across unseen tasks without
adding a per-mechanic schema or treating benchmark details as production law.

## M4.5 — Long-horizon run

- attempt one multi-step game build with bounded budgets and explicit
  checkpoints;
- exercise interruption, resumption, tool failure, rollback, and repair;
- retain trace/proof linkage without rewriting earlier attempts;
- measure outcome, attempts, cost, latency, and recovery behavior.

Exit criteria: the run either verifies or fails with an evidence-backed root
cause and a minimized next regression; duration alone is not success.

## M4.6 — Hosted workers, only if evidence justifies them

- add Docker, Harbor, Fly, queues, or remote Studio workers only for a measured
  reproducibility, isolation, persistence, parallelism, or long-horizon need;
- keep local and hosted task/evidence contracts equivalent;
- fail closed on lost, stale, partial, or mismatched worker evidence.

Exit criteria: a documented local bottleneck is improved by hosted execution
without weakening proof integrity. If no such bottleneck exists, M4.6 remains
deferred rather than manufacturing infrastructure.

## Review gates and kill criteria

Pause expansion if any of these are true:

- static rules produce frequent false confidence because the project graph is incomplete;
- the team cannot reproduce a diagnostic from recorded inputs/tool versions;
- a mock runtime is being used to make claims about Roblox physics or replication;
- benchmark gains do not correlate with Studio assertion outcomes;
- deterministic repair changes behavior outside the contract’s bounded scope;
- cost/latency makes authoritative verification unusable and no risk-based policy exists.

The correct response is to improve evidence or narrow claims, not to add more agents or UI.
