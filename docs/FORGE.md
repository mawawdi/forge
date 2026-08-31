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
- the fixed plugin admits the live budget and applies only the approved change set after independently recollecting and matching the exact Studio revision at prepare and again at apply inside one Studio ChangeHistory recording;
- one creator-authorized check action starts the exact bound Play Solo plan and returns factual observations and bounded diagnostic hashes;
- passing checks create a guarded checkpoint, after which creator acceptance remains a distinct product judgment;
- failure cancels the recording or enters at most two visible-fact repairs;
- rollback is allowed only when the exact committed Studio revision still matches.

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

`studio.stage` records virtual operations only. Forge derives the approved operation's ID and structural fields from `CreatorBuildContract`; the builder may supply only the contract's allowlisted properties, primitive attributes, explicit `removedAttributes`, and required Script/LocalScript/ModuleScript source. The model uses natural JSON property values rather than Forge's internal tags: primitives remain primitives, vectors use `{x,y,z}`, colors use `{r,g,b}`, and CFrames use `{position,rotation}` with degree-based Euler rotation. Forge resolves them against the exact property policy, converts numeric components to Studio floats, converts colors to deterministic 8-bit channels, and presents those actual storage values for creator review. Only the resulting typed canonical operations cross into Studio, whose preflight rejects noncanonical color channels. A move can include property/attribute changes in the same atomic operation; source replacement can include attribute changes, so one stable target never needs conflicting operations. Property and UTF-8 bounds are enforced identically before staging and by Studio. A script created by the plan carries its complete initial source in that same create operation; source replacement is reserved for scripts observed in the initial snapshot, and `studio.read_source` exposes only the exact approved existing source. `studio.inspect` accepts only the planner-declared initial paths carried by the contract. Rejection feedback identifies exact invalid field paths, expected and received contract fields, and the precise applicable allowlist, while rejected batches, live budget-admission failures, identical no-progress submissions, and varied consecutive all-failed batches are retained as evidence. The plugin—not the model—interprets the final canonical change set. The allowlist excludes arbitrary code callbacks, generic property access, terrain, asset operations, and unbounded deletion.

The coordinator depends on `CreatorAgentWorker`, not directly on the model runtime. The only current implementation is `LocalCreatorAgentWorker` (`local_process`, no isolation), backed by `ForgeNativeAgentRuntime`. Studio tokens and mutation authority never enter the worker boundary. A future isolated worker changes the bound descriptor and content identity.

`CreatorControlView` is the UI-independent workflow contract. Plan review includes the exact creator prompt and prompt hash, generated initialization commitments, output-check coverage, and separately labeled creator-review judgments. Change review includes the exact typed creative payload and source diffs, not only operation hashes. The CLI and temporary plugin consume the same exact view and may request only its current primary or secondary action. A terminal plugin screen displays content-bound AgentRun/trace references and returns the primary action to **Submit New Request**. The eventual web dashboard replaces the temporary review UI over this contract; the plugin remains the trusted Studio capability adapter.

The registered file-backed builder remains separate and exposes its eight bounded project/workspace tools for experiments.

## Non-goals

Forge does not compile prompts into a universal mechanic ontology, prescribe a greenfield source layout, use model output as proof, treat subjective quality as deterministic, expose arbitrary Studio execution, or maintain compatibility readers for predecessor contracts.

Provider-owned loops, swarms, hosted workers, broad asset generation, mechanic-specific Studio harnesses, PatchSets, and concurrent Rojo/Studio writers are not current architecture.

## Identity discipline

Forge has one current artifact and message shape. `kind` discriminates unions; canonical hashes and content-addressed IDs bind exact artifacts, policies, tools, workers, capability sets, and an authenticated evidence graph. A clean break replaces the prior reader and updates the code, fixtures, and tests that use it.

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and the package inventory, [EVALS.md](EVALS.md) for what each result means, and [ROADMAP.md](ROADMAP.md) for demonstrated evidence and the next live milestone.
