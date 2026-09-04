# Forge Thesis and Invariants

## Thesis

Forge is a Roblox-specific creator harness and evaluation system. The eventual product begins with the open Studio place and the creator's prompt—not a hand-authored task package. A model may propose a design and implementation; Forge owns factual context, bounded tools, approvals, Studio mutation, verification, stopping, recovery, and evidence.

Registered experiments are deliberately different. They bind evaluator-only criteria, a seed, model, budgets, implementation, and runtime configuration before execution so a benchmark result is inspectable. Their JSON files are not ordinary creator inputs.

## Product contract

An ordinary creator conversation follows these principles:

- the creator sends an immutable, hash-bound turn from the local Creator
  Conversation dashboard. The host, rather than a provider, composes the
  bounded context from durable turns, creator decisions, active
  creator-authority memory, and the current project revision;
- the conversation is a strict append-only chain of immutable commits. Its
  atomically replaced private head can only point at a fully written,
  cross-bound event snapshot; restart rebuilds that durable chronology and does
  not recreate it from status strings;
- agent prose may cite only host-issued handles from the AgentRun. Forge seals
  their exact source-range or project-fact target and provenance; an agent
  cannot mint a citation, current Studio fact, memory fact, or evaluator claim;
- each provider-capable planner, builder, or repair job reserves one immutable
  AgentRun/journal slot before execution. Its hash-chained
  `AgentExecutionJournal` records request intent, response, batch, tool, and
  terminal boundaries. It does not survive as background execution: restart
  reads the exact journal. An unconfirmed request intent or a
  `tool_execution_intent` without matching completion remains
  `outcome_unknown` and needs an explicit fresh-slot **Retry work** action.
  A fully persisted response plus completed tool records instead may be
  consumed only by explicit creator **Resume work** in the same reserved
  AgentRun/journal, without re-dispatching that response or reconstructing
  opaque provider continuation. Forge never retries automatically, resends a
  persisted response, or substitutes a provider/model;
- the only initial model IDs are `meta/muse-spark-1.3-contributor`,
  `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-flash-0731`, and
  `openai/gpt-5.6-luna` (the default). Each requires tools, and model/provider
  fallback is disabled. An unavailable selection is rejected, not substituted;
- Forge first validates a complete sharded index of the open Studio document, including current Script Editor buffers, before any provider call; a read-only planner then sees bounded project facts and exact authoring constraints, and Forge derives the plan goal from the immutable creator prompt rather than accepting a model-authored substitute;
- the planner may search and page source, symbols, references, and static require dependencies before selecting a target; a host-derived `CreatorSourceConsultation` binds the exact source ranges and graph closure it received, and every source-bearing plan is bound to that evidence;
- every planned step binds exact change IDs, every create or move declares its initialization contract, and every new script commits to complete source in its single create operation rather than deferring behavior to an unavailable later phase;
- the plan is executable and verification-complete before review: each created or moved output has an exact class-aware existence check and every source-bearing change has a Luau syntax check;
- the planner first inspects bounded exact-path facts, then declares the exact initial-snapshot `inspectionPaths` the builder needs for placement, integration, relationships, or preservation; Forge validates those paths before approval;
- a create or move parent is legal only when it is either a generated engine-owned `authoringContainers` entry with an exact path/class contract or an exact Studio-document-owned structural anchor from the complete initial index; containment authority never grants property, source, deletion, or other mutation authority over that parent;
- the creator approves that exact immutable plan hash;
- Forge compiles that approval into a content-addressed, evidence-bound `CreatorBuildContract` that the separate builder can see; Forge fixes each operation's kind, display path, parent, name, class, exact connector-issued object identity, precondition, and initialization mode while the builder supplies only allowlisted properties, attributes, explicit attribute removals, and source;
- a separate builder may stage typed changes but cannot mutate the live place;
- source diffs, typed operation hashes, and local-gate results remain inspectable in Details; accepting the plan authorizes automatic application only within that plan's exact bounds;
- one generated `StudioCapabilityManifest` closes every writable fact over canonicalization, validation, preflight, writing, direct reading, projection, and comparison in TypeScript and Luau, and closes the platform-parent topology consumed by planner validation and plugin preflight;
- the fixed plugin independently recompiles the exact mutation projection from the sealed change set and complete before-state evidence, runs only its scoped detached round-trip canary, and opens one ChangeHistory recording only after complete passed preflight at the unchanged revision;
- mutation projections carry one proof-requirement algebra and no duplicate project-delta authority; the allowed whole-project delta is derived from approved operations during reconciliation, and host-produced projection bytes must pass the production Luau recompiler in offline tests;
- source-bearing mutation authority requires exact request-bound acknowledgement of every immutable source blob before Prepare, and every post-approval protocol failure before recording is preserved as an incomplete mutation attempt rather than an evidence-free status;
- loopback HTTP is an at-least-once delivery substrate, not an execution receipt: the bridge retains each canonical command until the plugin acknowledges its exact content hash, the plugin replays a completed command's acknowledgement without repeating its effect, and reusing an identity with different bytes is rejected;
- unlinked project authority is pairing-scoped through one generated host/connector recipe; a heartbeat cannot silently replace that authority, and Link/Fork controls from a previous connector epoch are stale;
- a rejected Link/Fork command is not no-effect proof: only exact approved before-identity, empty transaction inventory, and a proven closed recording state release its reservation; uncertainty remains recovery-required, stale settlements cannot release other operations, and any retry needs fresh explicit creator authority;
- identity-job failures preserve bounded readable diagnostics and their exact command/settlement, and remain visible even when no recovery action is legal; old heartbeat or pairing observations never authorize retry after an ambiguous command outcome;
- control-plane presentation is not transaction evidence: reviewed changes are rendered from their immutable pre-mutation capture, current post-state is displayed separately, and a view, SSE, or socket failure after durable evidence cannot reclassify that evidence or terminate the creator service;
- a lost browser response to a state-changing action is ambiguous rather than failed: Forge observes canonical state once and never automatically repeats the action; an explicit retry sends the retained byte-identical request body with the same idempotency key;
- exact projection hashes remain provenance, while comparable state revisions exclude projection/session/approval identity and include only the manifest, semantic coverage domain, and canonical facts; Forge persists both sides before claiming drift;
- mutation stays provisional until direct engine readback and complete post-state evidence are persisted and pure reconciliation proves every projected postcondition plus the absence of observable unapproved drift;
- every manifested project-index node carries the exact generated ordered property coverage for its class; missing, extra, duplicate, unsorted, or invalid values are incomplete observer evidence and can never be graded as a Studio mismatch;
- accepting a plan authorizes Build and Apply within its exact sealed bounds; the host derives execution authority from the creator plan approval instead of fabricating approval of an unseen change set;
- Play and Stop remain optional. The plugin captures bounded server warnings/errors as advisory follow-up context, never as proof of interaction, client rendering, or gameplay correctness;
- no runtime Script, source string, print prefix, or log parser carries evidence; LogService is diagnostics-only, and `RuntimeEvalStarted` follows observer installation plus the first bounded reads;
- optional Play context cannot open or hold a mutation recording, start a model, trigger repair, or block a conversation; retained diagnostics are untrusted data, scoped to the project and connector build;
- only an exactly replayable `matched` mutation may commit; completion requires an exact finalization acknowledgement and complete post-commit state, and never implies a gameplay verdict;
- mismatched or incomplete mutation evidence cancels the exact recording and requires post-cancel state evidence; missing evidence is never converted into a fabricated mismatch;
- evidence completeness is availability and exact coverage, not agreement: authoritative `observed` and `absent` facts are complete and pure graders decide whether they match; unavailable/read-error, missing, duplicate, extra, misordered, or misbound facts are incomplete;
- a hierarchy, property, attribute, Script Editor, undo, or redo notification never claims a revision; outside a possible transaction it marks the index dirty, while inside an exact possible recording it requires a serialized read-only index confirmation against the last authoritative transaction revision before authority can change; a stable complete capture remains immutable evidence while it is transported, but becomes current command authority only if no later callback exists; a notice that precedes the transaction's post-state waits for that baseline instead of being compared with pre-Apply state; unchanged confirmation is immutable evidence, changed or incomplete confirmation fails closed, and neither path performs a Studio mutation;
- if an evidence failure occurs after a recording may have opened and the connector cannot prove the exact current-project gate required for automatic cancellation, it performs no cancellation and emits the complete bound mutation-failure receipt with `cancellationProven = false`; a generic plugin exception may never be the only durable account of that transaction boundary;
- Forge-caused change attribution is identity-, field/source-, canonical-state-, phase-, and recording-ID-bound; no broad writer-active flag or elapsed-time window may suppress an unrelated creator edit;
- restart never retries Apply or a provider call and never commits or cancels automatically; every pairing closes both dimensions of connector transaction inventory—possibly active recording cursor and possibly unacknowledged settled finalization receipt—before new work, an unrelated `none` recording report can never acknowledge a receipt, creator-authorized recovery cancellation exists only after the exact interrupted recording is freshly proven open, and a freshly proven `not_open` recording may clear only its exact stale connector cursor after durable evidence acknowledgement;
- approval-time and immediately-pre-mutation readiness checks both require that closed transaction inventory; a finalization receipt is persisted before its exact acknowledgement is sent, and only the plugin's acknowledgement-correlated fresh inventory report may release that receipt gate;
- plugin-local transaction persistence is an independently verified boundary: safe setting keys, immutable phase snapshots, and immediate readback must bind the real recording ID before any place operation; finalization persists the exact action, finalization kind, replacement provenance when applicable, current index, and detector epoch before `FinishRecording`; the sole closure primitive rechecks that durable gate immediately before one engine call and requires exact `IsRecordingInProgress(recordingId) == false` readback before persisting a finished cursor, so restart or ambiguity at any point requires observation and recovery instead of repeating the call; a stale or failed write cannot be treated as durable intent or closure;
- a clean-break connector never reads a predecessor setting schema, but Prepare still queries `ChangeHistoryService` for any unbound recording and fails closed if one exists or the query cannot be completed, so a connector upgrade cannot overlap an older open transaction;
- rollback is allowed only when the exact committed Studio revision still matches.

Limits are bounded but not curated per mechanic. One default agent budget applies to creator planning/building/repair and any registered agent run without an explicitly preregistered budget. One generated Studio policy applies to creator verification, experiments, canaries, evidence collection, and direct observation. A prompt, fixture, class, or capability never selects a special limit profile.

The accepted Door Control ledger demonstrates the predecessor closed-evidence transaction end to end: manifest attestation, detached preflight, provisional apply, direct readback, complete index reconciliation, bounded Play Solo evidence, exact commit, creator report, and provider-free mutation and verification replay. Its backing store was later deliberately removed, so it is documentary evidence rather than live proof of the current project-index, source-intelligence, or Rojo-authority contracts. The demonstration does not turn the creator's statement that the interaction worked into a machine-observed fact, and it does not authorize capabilities outside the manifest. Broader Roblox coverage must preserve the same closure and authority boundaries; completeness means every official API member is explicitly accounted for, not that arbitrary engine behavior is declared automatically verifiable.

## Semantic authority

Forge keeps these sources distinct:

- creator request: desired outcome and creator authority;
- creator memory: explicitly revised creator preference, convention, vocabulary,
  goal, or unresolved item; context only, never current project fact;
- project observation: factual before-state;
- platform policy: universal security or execution constraints;
- agent plan: a hypothesis requiring creator approval;
- creator charter: visible approved checks, still not an engine fact;
- evaluator or benchmark oracle: evaluation-only authority inside one registered treatment.

Hidden evaluator bodies, expected observations, benchmark answers, successful source, private runtime observations, host paths, and secrets never enter creator planner or builder context. Studio receives typed data, never evaluator assertions.

## Ownership

The default `studio_document` authority treats the complete place currently open in Studio as the single writer domain, regardless of whether a Rojo build originally produced the file. Existing objects need no Forge metadata merely to be indexed: a connector-epoch-bound opaque identity distinguishes duplicate-named objects, and targeting one enrolls a durable Forge attribute inside the same approved ChangeHistory recording. Display paths are review aids, never mutation authority.

Project-conversation continuity is separate from object enrollment and authoring
authority. A published place is identified only by its exact universe/place
pair. A local place is unlinked until the dedicated identity transaction writes
the reserved `_forgeProjectId` Workspace attribute: **Link** requires an absent
attribute, while **Fork** requires an observed local ID and replaces it with a
new one. Both are host-issued exact-state ChangeHistory transactions with
direct readback, finalization receipt, acknowledgement, and fail-closed
recovery. Saving a linked local place under another filename copies its ID and
therefore continues the same local conversation until the creator explicitly
forks. Publishing never silently carries that local identity forward: platform
identity takes precedence and the embedded local ID is observational only. The
current dashboard exposes Link, Fork, and the creator-facing
local-to-published continuity choice as separate hash-bound actions. None is an
automatic inference.

An optional `rojo_source` adapter is declared by one private `--project-authority` manifest. Forge starts only the verified pinned Rojo 7.7.0 `sourcemap` command at service startup to generate the map; it never starts `rojo serve`, runs live sync, or accepts a user-authored sourcemap as authority. Exact mapped script paths and representable mapped script parents become Rojo-owned while every ordinary indexed object remains Studio-owned. Forge derives and seals one writer per plan/build/change set: mapped Luau work selects `rojo_source`, generic model/property work selects `studio_document`, and mixed authority is rejected before approval. Guarded filesystem writes require exact hash/absence preconditions and immutable receipts; success requires a later complete Studio index proving the mapped hashes and allowed delta. Timeout remains `awaiting_source_sync`, and reversion is a separate creator-authorized guarded transaction. A Studio or source transaction changes its authority state only; the creator must explicitly use **File → Save to File** to produce an `.rbxlx` output.

## Model and tool ownership

`ForgeNativeAgentRuntime` owns turns, tool dispatch, budgets, feedback, and stopping. A provider adapter performs one replaceable inference turn. Provider SDK types do not enter runtime or evidence contracts.

A normal model `end_turn` is not completion when the tool host reports that its required plan or change artifact is unsealed. Forge returns the exact failure to the same run and requires continued tool use, bounded to two completion-repair attempts before preserving an incomplete AgentRun. This is phase-generic and does not special-case a fixture or provider.

The planner has bounded `studio.inspect`, `studio.api_lookup`, `source.search`, `source.read`, `source.symbols`, `source.references`, `source.dependencies`, and `creator.propose_plan`. Source results are static-analysis context, never Studio observation or behavioral proof. A declared builder inspection path must already have been inspected, and source-bearing plans must bind the exact host-authored consultation and dependency closure. The builder has five mutation-oriented tools plus read access to the approved source closure:

- `studio.inspect`
- `source.read`
- `studio.stage`
- `studio.diff`
- `forge.verify`

`studio.stage` records virtual operations only. Forge derives the approved operation's ID and structural fields from `CreatorBuildContract`; the builder may supply only the contract's allowlisted properties, primitive attributes, explicit removals, complete source for a new script, or sorted non-overlapping UTF-8-safe byte edits for an existing script. Forge materializes the final source host-side, checks the final hash and byte count, and Studio uses `ScriptEditorService:UpdateSourceAsync` only if the current editor-source hash still matches. One current proposal exists per approved `planChangeId`: a later valid proposal atomically replaces it for repair, while a rejected replacement leaves it untouched. The builder may read any source in the exact approved consultation closure; reading outside that closure fails with `source_context_outside_approved_closure` and requires a new plan. Model-facing properties remain natural JSON and are canonicalized through the sealed property policy before Studio. Local Luau verification analyzes the exact projected hierarchy and approved dependency closure without executing project source. Diagnostics use stable logical Studio locations; temporary host paths never define identity.

The plugin—not the model—interprets the final canonical change set. Roblox API completeness and Studio authority are separate: the pinned catalog records the complete official surface, the generated coverage report gives every entry exactly one disposition/reason, and only the proof-closed manifest grants authoring. Nondeprecated script-accessible classes, members, datatypes, and enums are available to creator agents as bounded `source_only` official metadata; that permits source authoring context, never a direct write or proof claim. Deprecated, hidden/NotScriptable, and security-gated rows remain explicitly restricted. The manifest's writer, direct reader, detached preflight, evidence projection, comparator domains, and runtime dispatch are generated from that manifest. Catalog type namespaces are preserved so a same-named enum and datatype cannot share an implementation route. A reflected property confirms only availability and exact expected shape under the plugin's current security context; reflection never discovers or enables authoring capability. The plugin is a raw reflection collector, not a compatibility judge. For every manifest row, one generated backend contract keeps the catalog type, engine/storage type, Luau script type, optional enum/Instance constraint, property-level nullability, and property-specific value bounds distinct and checks every required dimension. Missing or unreadable reflection evidence is incomplete; only a present contradictory fact is rejected. Every fact is explicitly `observed`, `absent`, `unavailable`, or `read_error`, so false, zero, empty strings, a declared nullable property value, instance absence, and failed reads cannot collapse together. A non-reference nil is canonical only when its exact manifest row declares `nullable: true`, and its material binds the expected codec; nil is never inferred from a codec globally. The current manifest excludes arbitrary callbacks, generic method access, property access outside the generated manifest, terrain, content-bearing asset identifiers without an asset-authority policy, and unbounded deletion.

The coordinator depends on `CreatorAgentWorker`, not directly on the model runtime. The only current implementation is `LocalCreatorAgentWorker` (`local_process`, no isolation), backed by `ForgeNativeAgentRuntime`. Studio tokens and mutation authority never enter the worker boundary. A future microVM worker isolates model-generated code, local tools, and evaluator execution; it does not emulate Roblox or replace the plugin-security Play Solo authority. Changing that worker changes the bound descriptor and content identity.

The public `CreatorControlView` is the sole workflow-legality contract. The lower `CreatorTransactionControlView` and its bounded ordered action array stay inside transaction coordination; they are not a second public contract. Plan review includes the exact creator prompt and prompt hash, generated initialization commitments, output-check coverage, and separately labeled creator-review judgments. Change review includes the exact typed creative payload and source diffs, not only operation hashes. The local React dashboard renders the public contract in the conversation timeline and may request only the exact action instance it currently authorizes; project rail, context rail, evidence seam, and Technical Details are read models, never alternate action logic. The Technical Details sheet may load raw JSON only for sealed attachments and returns keyboard focus to its source control. Those read models are reconstructed from durable lifecycle evidence after restart: an interrupted or terminal session must identify its proven boundary and next legal step, never masquerade as ready merely because an in-memory view was lost. Final acceptance or rejection requires a bounded free-form `CreatorReviewReport`. Forge preserves that canonical creator-authority report without parsing it into machine claims. The standalone loopback creator control server owns dashboard authentication, state, invalidations, evidence retrieval, and replay. The plugin remains the trusted Studio capability adapter for pairing, observation, typed mutation, Play Solo, diagnostics, commit/cancel, and guarded undo.

The registered file-backed builder remains separate and exposes its eight bounded project/workspace tools for experiments.

## Non-goals

Forge does not compile prompts into a universal mechanic ontology, prescribe a greenfield source layout, use model output as proof, treat subjective quality as deterministic, expose arbitrary Studio execution, or maintain compatibility readers for predecessor contracts.

Provider-owned loops, swarms, hosted workers, broad asset generation, mechanic-specific Studio harnesses, PatchSets, and concurrent Rojo/Studio writers are not current architecture.

## Identity discipline

Forge has one current artifact and message shape. `kind` discriminates unions; canonical tagged and length-delimited hashes plus content-addressed IDs bind exact artifacts, policies, tools, workers, the Studio manifest, projections, evidence envelopes, and the authenticated graph. The manifest itself binds the generated and host evidence algebra, so changing canonical material cannot retain the prior manifest identity. A clean break replaces the prior reader and updates the code, fixtures, and tests that use it.

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and the package inventory, [EVALS.md](EVALS.md) for what each result means, and [ROADMAP.md](ROADMAP.md) for demonstrated evidence and the next live milestone.
