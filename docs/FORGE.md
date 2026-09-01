# Forge Thesis and Invariants

## Thesis

Forge is a Roblox-specific creator harness and evaluation system. The eventual product begins with the open Studio place and the creator's prompt—not a hand-authored task package. A model may propose a design and implementation; Forge owns factual context, bounded tools, approvals, Studio mutation, verification, stopping, recovery, and evidence.

Registered experiments are deliberately different. They bind evaluator-only criteria, a seed, model, budgets, implementation, and runtime configuration before execution so a benchmark result is inspectable. Their JSON files are not ordinary creator inputs.

## Product contract

An ordinary creator session follows these principles:

- the creator enters one prompt in Studio;
- a read-only planner sees bounded project facts and exact authoring constraints; Forge derives the plan goal from the immutable creator prompt rather than accepting a model-authored substitute;
- every planned step binds exact change IDs, every create or move declares its initialization contract, and every new script commits to complete source in its single create operation rather than deferring behavior to an unavailable later phase;
- the plan is executable and verification-complete before review: each created or moved output has an exact class-aware existence check and every source-bearing change has a Luau syntax check;
- the planner first inspects bounded exact-path facts, then declares the exact initial-snapshot `inspectionPaths` the builder needs for placement, integration, relationships, or preservation; Forge validates those paths before approval;
- the creator approves that exact immutable plan hash;
- Forge compiles that approval into a content-addressed, evidence-bound `CreatorBuildContract` that the separate builder can see; Forge fixes each operation's kind, path, parent, name, class, stable identity, precondition, and initialization mode while the builder supplies only allowlisted properties, attributes, explicit attribute removals, and source;
- a separate builder may stage typed changes but cannot mutate the live place;
- the creator sees exact source diffs, typed operation hashes, and the local gate before approval;
- one generated `StudioCapabilityManifest` closes every writable fact over canonicalization, validation, preflight, writing, direct reading, projection, and comparison in TypeScript and Luau;
- the fixed plugin independently recompiles the exact mutation projection from the sealed change set and complete before-state evidence, runs only its scoped detached round-trip canary, and opens one ChangeHistory recording only after complete passed preflight at the unchanged revision;
- exact projection hashes remain provenance, while comparable state revisions exclude projection/session/approval identity and include only the manifest, semantic coverage domain, and canonical facts; Forge persists both sides before claiming drift;
- mutation stays provisional until direct engine readback and complete post-state evidence are persisted and pure reconciliation proves every projected postcondition plus the absence of observable unapproved drift;
- Forge compiles the complete dependency-ordered runtime proof program before place mutation, reserves one 90-second creator-observation window inside the generated five-minute Studio ceiling, and persists the exact post-revision-bound plan before offering the check action;
- one creator-authorized check action starts that already-validated Play Solo artifact, keeps Studio open for its explicit bounded creator-observation window, and returns factual observations and bounded diagnostic hashes;
- only an exactly replayable `matched` mutation may enter checks; passing checks may commit only when the exact acknowledgement and post-commit state are persisted, after which creator acceptance remains a distinct product judgment;
- mismatch or incomplete evidence cancels the exact recording and requires post-cancel state evidence; missing evidence is never converted into a fabricated mismatch;
- restart never retries Apply or a provider call and never commits or cancels automatically; every pairing reports the connector's transaction inventory before new work, creator-authorized recovery cancellation exists only after the exact interrupted recording is freshly proven open, and a freshly proven `not_open` recording may clear only its exact stale connector cursor after durable evidence acknowledgement;
- plugin-local transaction persistence is an independently verified boundary: safe setting keys, immutable phase snapshots, and immediate readback must bind the real recording ID before any place operation; a stale or failed write cannot be treated as durable intent;
- rollback is allowed only when the exact committed Studio revision still matches.

Limits are bounded but not curated per mechanic. One default agent budget applies to creator planning/building/repair and any registered agent run without an explicitly preregistered budget. One generated Studio policy applies to creator verification, experiments, canaries, evidence collection, and the fixed runner. A prompt, fixture, class, or capability never selects a special limit profile.

The accepted Door Control session demonstrates this current contract end to end: manifest attestation, detached preflight, provisional apply, direct readback, complete state reconciliation, bounded Play Solo evidence, exact commit, creator report, and provider-free mutation and verification replay. That demonstration does not turn the creator's statement that the interaction worked into a machine-observed fact, and it does not authorize capabilities outside the manifest. Broader Roblox coverage must preserve the same closure and authority boundaries; completeness means every official API member is explicitly accounted for, not that arbitrary engine behavior is declared automatically verifiable.

## Semantic authority

Forge keeps these sources distinct:

- creator request: desired outcome and creator authority;
- project observation: factual before-state;
- platform policy: universal security or execution constraints;
- agent plan: a hypothesis requiring creator approval;
- creator charter: visible approved checks, still not an engine fact;
- evaluator or benchmark oracle: evaluation-only authority inside one registered treatment.

Hidden evaluator bodies, expected observations, benchmark answers, successful source, private runtime observations, host paths, and secrets never enter creator planner or builder context. Studio receives typed data, never evaluator assertions.

## Ownership

Studio is the only persistent writer in a creator session. Forge does not need or implement dual Rojo/Studio ownership. Optional externally managed Rojo roots are read-only exclusion zones. This avoids concurrent-writer merge semantics while allowing Forge to operate safely around an existing workflow.

## Model and tool ownership

`ForgeNativeAgentRuntime` owns turns, tool dispatch, budgets, feedback, and stopping. A provider adapter performs one replaceable inference turn. Provider SDK types do not enter runtime or evidence contracts.

The planner has two read-only tools: bounded exact-path `studio.inspect` and `creator.propose_plan`. A declared builder inspection path must already have been inspected by the planner. The builder has five tools:

- `studio.inspect`
- `studio.read_source`
- `studio.stage`
- `studio.diff`
- `forge.verify`

`studio.stage` records virtual operations only. Forge derives the approved operation's ID and structural fields from `CreatorBuildContract`; the builder may supply only the contract's allowlisted properties, primitive attributes, explicit `removedAttributes`, and required Script/LocalScript/ModuleScript source. The model uses natural JSON property values rather than Forge's internal tags. The current proof boundary supports primitive scalars plus bounded vector, color, CFrame, UDim2, Rect, range, sequence, enum, and stable Instance-reference shapes. Forge resolves each shape against the exact sealed property policy, canonicalizes it to the engine storage domain, and presents those actual typed values for creator review. A non-nil Instance value binds stable ID, canonical path, exact observed class, and a manifest-declared ancestor constraint; the target must exist in the bound Studio-owned observation. A nil Instance value is a separate class-bound canonical value, not absent or unreadable evidence. Only the resulting typed canonical operations cross into Studio. A move can include property/attribute changes in the same atomic operation; source replacement can include attribute changes, so one stable target never needs conflicting operations. A script created by the plan carries its complete initial source in that same create operation; source replacement is reserved for scripts observed in the initial state, and `studio.read_source` exposes only the exact approved existing source. `studio.inspect` accepts only the planner-declared initial paths carried by the contract. Rejection feedback identifies exact invalid field paths, expected and received contract fields, and the precise applicable allowlist, while rejected batches and no-progress guards remain evidence.

The plugin—not the model—interprets the final canonical change set. Roblox API completeness and Studio authority are separate: the pinned catalog records the complete official surface, the generated coverage report gives every entry exactly one disposition/reason, and only the proof-closed manifest grants authoring. Nondeprecated script-accessible classes, members, datatypes, and enums are available to creator agents as bounded `source_only` official metadata; that permits source authoring context, never a direct write or proof claim. Deprecated, hidden/NotScriptable, and security-gated rows remain explicitly restricted. The manifest's writer, direct reader, detached preflight, evidence projection, comparator domains, and runtime dispatch are generated from that manifest. Catalog type namespaces are preserved so a same-named enum and datatype cannot share an implementation route. A reflected property confirms only availability and exact expected shape under the plugin's current security context; reflection never discovers or enables authoring capability. The plugin is a raw reflection collector, not a compatibility judge. For every manifest row, one generated backend contract keeps the catalog type, engine/storage type, Luau script type, and optional enum/Instance constraint distinct and checks every required dimension. Missing or unreadable reflection evidence is incomplete; only a present contradictory fact is rejected. Every fact is explicitly `observed`, `absent`, `unavailable`, or `read_error`, so false, zero, empty strings, a property whose value is nil, instance absence, and failed reads cannot collapse together. The current manifest excludes arbitrary callbacks, generic method/property access, terrain, content-bearing asset identifiers without an asset-authority policy, and unbounded deletion.

The coordinator depends on `CreatorAgentWorker`, not directly on the model runtime. The only current implementation is `LocalCreatorAgentWorker` (`local_process`, no isolation), backed by `ForgeNativeAgentRuntime`. Studio tokens and mutation authority never enter the worker boundary. A future microVM worker isolates model-generated code, local tools, and evaluator execution; it does not emulate Roblox or replace the plugin-security Play Solo authority. Changing that worker changes the bound descriptor and content identity.

`CreatorControlView` is the sole workflow-legality contract. Plan review includes the exact creator prompt and prompt hash, generated initialization commitments, output-check coverage, and separately labeled creator-review judgments. Change review includes the exact typed creative payload and source diffs, not only operation hashes. The local React dashboard renders this contract and may request only its current primary or secondary action; history and five-stage progress are coordinator-produced read models, never alternate action logic. Those read models are reconstructed from durable lifecycle evidence after restart: an interrupted or terminal session must identify its proven boundary and next legal step, never masquerade as ready merely because an in-memory view was lost. Final acceptance or rejection requires a bounded free-form `CreatorReviewReport`. Forge preserves that canonical creator-authority report without parsing it into machine claims. The standalone loopback creator control server owns dashboard authentication, state, invalidations, evidence retrieval, and replay. The plugin remains the trusted Studio capability adapter for pairing, observation, typed mutation, Play Solo, diagnostics, commit/cancel, and guarded undo.

The registered file-backed builder remains separate and exposes its eight bounded project/workspace tools for experiments.

## Non-goals

Forge does not compile prompts into a universal mechanic ontology, prescribe a greenfield source layout, use model output as proof, treat subjective quality as deterministic, expose arbitrary Studio execution, or maintain compatibility readers for predecessor contracts.

Provider-owned loops, swarms, hosted workers, broad asset generation, mechanic-specific Studio harnesses, PatchSets, and concurrent Rojo/Studio writers are not current architecture.

## Identity discipline

Forge has one current artifact and message shape. `kind` discriminates unions; canonical tagged and length-delimited hashes plus content-addressed IDs bind exact artifacts, policies, tools, workers, the Studio manifest, projections, evidence envelopes, and the authenticated graph. A clean break replaces the prior reader and updates the code, fixtures, and tests that use it.

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and the package inventory, [EVALS.md](EVALS.md) for what each result means, and [ROADMAP.md](ROADMAP.md) for demonstrated evidence and the next live milestone.
