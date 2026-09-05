# Forge open creation harness — implementation plan

Revised September 5, 2026 after repository inspection and primary-source research.
This replaces the earlier game-generation plan, including mandatory rounds and the
closed mechanic vocabulary. This is the working implementation plan;
[Architecture](../ARCHITECTURE.md) records implemented behavior.

## Objective

Forge should support the range of experiences Roblox can express, including novel
mechanics, evolving worlds, custom interfaces, independent activities and multiple
places. The kernel must not require a genre, round, countdown, win/loss, score,
reset, objective, solo play, hub, world layout or particular screen inventory.

Ordinary Luau source and asset composition provide the extension path. Optional
recipes accelerate familiar work and provide stronger checks where their semantics
are known. Novel behavior or content composed from admitted capabilities must not
require a trusted host change, a new kernel enum, a fixed effect opcode, a plugin
extension or membership in a curated kit catalog.

Open-ended expression does not mean arbitrary programs can be proven correct or
that Forge can evade Roblox permissions and resource limits. Keep four questions
separate: can the design represent it; can this Forge build install it; does the
target execution context permit it; what evidence establishes its behavior?

## Research findings

These consequences are architectural judgments drawn from primary sources, not
claims that the cited systems implement Forge's proposed contracts.

| Evidence                                                                                                                                                                                                                                                                                                                                                                                                      | Consequence                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Roblox modules support general implementations; placement and RunContext determine execution/visibility. [Modules](https://create.roblox.com/docs/scripting/module), [locations](https://create.roblox.com/docs/scripting/locations)                                                                                                                                                                          | Make ordinary server/client/shared source packages first-class. Shared source does not imply shared state. A reducer is optional.              |
| Roblox supports runtime Instance construction, streaming, persistence and multiple places. [Instance](https://create.roblox.com/docs/reference/engine/datatypes/Instance), [streaming](https://create.roblox.com/docs/workspace/streaming), [data stores](https://create.roblox.com/docs/cloud-services/data-stores), [places](https://create.roblox.com/docs/production/publishing/publish-games-and-places) | Exact editor inventory cannot enumerate all future gameplay objects. World, player, entity and activity lifetimes may be independent.          |
| Source editing is privileged and differs from ordinary game execution. [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService)                                                                                                                                                                                                                                     | The fixed plugin installs approved source/data but never evaluates generated code. The user runs the installed experience normally.            |
| Luau types are structural and gradual; successful analysis is not runtime validation. [Types](https://luau.org/types/), [module analysis](https://luau.org/types/considerations/)                                                                                                                                                                                                                             | Analyze staged imports and chosen interfaces. Keep behavioral and security evidence separate.                                                  |
| Script Capabilities are experimental, with incomplete API coverage and cross-container subtleties. [Capabilities](https://create.roblox.com/docs/scripting/capabilities)                                                                                                                                                                                                                                      | Do not require all creative source to depend on this feature or claim that an injected context table enforces confinement.                     |
| MLIR separates extensible operations, interfaces, verification and target legality. [Interfaces](https://mlir.llvm.org/docs/Interfaces/), [conversion](https://mlir.llvm.org/docs/DialectConversion/)                                                                                                                                                                                                         | Use a small composition kernel and optional semantic knowledge. Unknown recipe IDs are not automatically compilable. Do not embed MLIR itself. |
| Godot recommends self-contained scenes with supplied dependencies; Unreal distinguishes base lifecycle from optional match lifecycle. [Godot](https://docs.godotengine.org/en/stable/tutorials/best_practices/scene_organization.html), [Unreal](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-mode-and-game-state-in-unreal-engine)                                                       | Modules state local assumptions; no global round or universal reset.                                                                           |
| Teleport behavior cannot be tested in Studio playtesting. [Teleport](https://create.roblox.com/docs/projects/teleport)                                                                                                                                                                                                                                                                                        | Distinguish offline, Studio edit, Studio Play and published-client evidence. No invented universal Studio verification.                        |

The [modular IR research](../research/modular-game-ir.md) preserves the earlier schema
audit. The initial inspection found a draft IR disconnected from the creator workflow
and unvalidated GamePlan/GameBuildGraph interfaces. The implementation now replaces
those placeholders with executable contracts and creator-workflow consumers, reusing
the existing topology compiler for generated parents and references.

## Contract architecture

The target chain is `GameDesignSpec → GamePlan → GameBuildGraph`:

- **GameDesignSpec:** intent, stable component identities, ordinary source-package
  manifests, optional pinned recipe instances, dependencies/connections and requested
  evidence. An optional semantic architecture maps named game concepts to implementation
  components for creator review and visualization. No prescribed gameplay lifecycle.
- **GamePlan:** pure structural compilation, complete editor inventory, observed
  revision, exact authority, source/value slots, dependencies and intermediate
  partition states. Creator acceptance binds this exact artifact.
- **GameBuildGraph:** fully materialized immutable artifacts, final hashes, checks
  and bounded partitions. Receipts form a separate verified prefix bound to it.

Introduce executable validators and consumers together; remove premature interface
placeholders. Replace superseded formats outright. No compatibility readers,
migration layer or second creator workflow.

### Composition kernel

The kernel owns stable IDs, bounded strict JSON, definition/source locks, typed
connections, dependency integrity and canonical identity. It has no mechanic union.
Admission profiles hold resource limits; they are not the meaning of a game.

A source-package node describes normal Luau files, static imports, execution
contexts, entrypoints and content identity. A recipe-instance node resolves an exact
host-admitted definition with a configuration schema and ABI. Models cannot upload
host compiler code or manufacture authority with an arbitrary schema hash.
Source-only designs need no recipe. Recipe expansion produces normal editable
artifacts; provenance does not permanently restrict reviewed replacements.

Source manifests distinguish locked bytes, observed modules and new source-authoring
slots. Build derives final hashes from actual bytes and checks declared imports against
the staged topology. Never ask a model to invent a future source hash or treat a
declared hash as evidence that the corresponding bytes exist.

Connections identify interfaces and direction. Artifact/build dependencies must be
acyclic. Runtime event feedback, recursive data, mutually referencing Instances and
gameplay graphs have different semantics; do not use one cycle rule for all of them.

Validate bounded plain JSON before hashing or recursive schemas: finite values,
regular data objects, no accessors/cycles, depth/UTF-8 budgets, unique IDs, resolved
references, exact definition pins and compatible interfaces. A hash proves identity,
not behavior. Initial design admission grants no approval or mutation authority.

### Project composition and reuse

Support composition and reuse of arbitrary project content. Permit optional libraries
without requiring kit membership or a new host recipe for novel content. A creator
or model can author a unique object, interface or source package first, then reuse
it where the project benefits. One-off content remains a first-class path.

The required infrastructure is stable content identity, explicit dependencies and
parameters, and the ability to reference shared content or instantiate independently
owned copies. Instance-local references must resolve within each copy; shared
resources stay explicitly shared. Placements and overrides expand into the same
reviewable editor inventory, source slots and canonical operations as other work.
Updates preserve creator edits as constraints or reviewed hash conflicts.

Use ordinary source manifests and admitted instance/asset composition. A special
kit schema or catalog is not required. Trusted compiler recipes remain optional
lowerings with demonstrated value; content reuse cannot authorize candidate host
code, unsupported Studio operations or unreviewed asset dependencies.

Roblox packages can contain arbitrary instance branches and configurable copies.
This supports general project reuse without prescribing a thematic content library.
[Roblox packages](https://create.roblox.com/docs/projects/assets/packages).
Forge still binds exact content and updates to accepted authority.

Curated room sets, interface libraries and gameplay templates are optional product
expansion. Their absence is not a core completion gap or a dependency of the proof.
Add them only when creator work demonstrates repeated demand or authoring cost;
measure quality and efficiency against ordinary composition. Keep outputs editable.
Pinned runtime utilities are a separate infrastructure choice. Content reuse is also
distinct from the compiler's artifact cache: unchanged dependency reuse and affected
closure rebuilding remain engineering requirements regardless of content libraries.

### Ordinary source packages

Normal Luau can implement algorithms, physics, networking, dynamic construction,
procedural content, persistence and novel UI. Use statically resolvable imports and
reviewed hashes. Utility modules need no artificial startup method. Active modules
can choose typed initialization/cleanup interfaces; bootstrap wiring follows them.

Reducers, effect unions, state machines, generated network schemas and Forge.Scope
are optional tools. A closed effect union can strengthen one subsystem's checks; it
must not define the effects available to every experience.

Keep private code/configuration server-side. Consequential shared state needs
appropriate server authority and contextual validation; local presentation can run
on clients. Distinguish declared intent, statically observed usage, actual enforcement
and exercised behavior. [Roblox boundary validation](https://create.roblox.com/docs/scripting/security/client-server-boundary).

Never require candidate modules to discover exports or dependencies. Candidate source
does not execute in the trusted host/plugin. Offline execution needs an isolated,
resource-bounded worker. Unrestricted Lune is neither a candidate sandbox nor a full
Roblox emulator. [Luau sandboxing](https://luau.org/sandbox/), [Lune](https://github.com/lune-org/lune).

### Editor authority and runtime effects

Acceptance enumerates every editor-created, updated, moved and deleted Instance,
parent/reference, installed source and allowed slot. Reuse canonical Studio operation
types, transaction-topology, source blobs, Prepare, preflight, fixed writes and
reconciliation. Source bodies remain outside mutation operations.

Future runtime Instances are program effects. Their templates, ownership, budgets
and evidence may be declared, but an editor plan cannot enumerate an unbounded future
population. Ordinary game code does not authorize hidden editor execution that
bypasses an unsupported authoring operation.

The authoring manifest and ordinary source API coverage are separate. Report missing
authoring adapters, target permission/configuration, budget exhaustion and unverified
behavior distinctly. No arbitrary editor executor is introduced as an escape hatch.

## Scale and recovery

Identity is independent of names and array order. Record semantic/source provenance
for every artifact. Reuse unchanged content-addressed dependencies and applicable
checks; rebuild affected closures. Creator edits become explicit constraints or
source-hash conflicts, never silent overwrites or source splicing.

Use bounded working sets, graph/index shards, revision-bound evidence retrieval and
host summaries. A prompt need not contain the entire project. Agent-written memory
has separate provenance. Large games should grow through incremental revisions.

Preserve transaction limits: 128 operations, 16,384 facts, 2 MiB evidence. The earlier
8,192 operations / 64 MiB graph / 128 partitions are proposed measurement-profile
limits, not universal game maxima. Report the limiting resource and measure larger
profiles without changing the semantic language.

Check the complete accepted candidate before its first write. Partition by actual
encoded evidence cost and dependencies. Cross-partition references bind authoritative
checkpoints. Explicitly approve allocation/configuration stages where needed.
Activation barriers apply to components requiring coordinated startup; not every
project needs a single global entrypoint or reset boundary.

Writes remain serialized. Missing receipts, external edits and uncertain Apply halt
progress. Preserve an explicitly incomplete verified prefix. Only the current safely
cancellable recording may be automatically cancelled; committed checkpoints are not
one atomic transaction. Resume requires explicit recovery of the same graph/prefix.
Undo of committed checkpoints is a separate authorized operation.

## Optional scene, UI and asset compilers

Scene definitions can describe rooms, open regions, directed routes, teleports,
independent spaces or runtime generation. No universal hub, connected undirected
graph, footprint or landmark. Validate only declared requirements and represented
geometry. Compose project-authored or reviewed imported content with explicit
placements and references; reusable assemblies need no curated kit identity.
Static route checks are distinct from native traversal.

UI definitions compose tokens/components into materialized trees and selected
binding/motion code. Ordinary source supports unfamiliar interfaces. CanvasGroup,
UIStroke, UIGradient, UIPadding, UIListLayout and UIAspectRatioConstraint are tools,
not mandatory decoration. Use the repository UI/UX and design-system skills during
presentation implementation. Relevant UI defaults include safe areas, 48×48 primary
touch targets, contrast, wrapping, input/focus adaptation, larger text and reduced
motion. Native TextBounds and targeted viewport evidence establish actual fit.

AssetRegistry/AssetLock track source hashes, provenance, nested dependencies,
permissions, universe, readiness and accepted substitutions. Workers are host-owned,
bounded jobs; credentials stay outside model context. An ambiguous external POST is
a recovery obligation. Downloaded model scripts are not trusted content.

### Cube 3D specification

An optional customProp recipe declares description, bounds, clearance, collision
fidelity, named parts and requested sockets/attachments. Pin Cube code/checkpoints
and configuration or select an explicitly accepted connected provider.

Cube currently accepts `--bounding-box-xyz X Y Z`, normalizes the tuple, and exports
OBJ. It does not guarantee exact stud fit or collision clearance. Inspect vertices
and indices, measure bounds, center/fit with an approved transform, then recheck
clearance, sockets and neighbors. FBX conversion is a separate pinned stage.
[Cube implementation](https://raw.githubusercontent.com/Roblox/cube/main/cube3d/generate.py).

CubePart takes an input mesh and named parts in a separate decomposition pipeline;
retain the coordinate frame and verify returned inventory.
[CubePart](https://github.com/Roblox/cube/blob/main/cubepart/README.md).

Connected generation targets GenerateModelAsync after native context/permission
admission. GenerateMeshAsync is deprecated and is not a fallback. The API reference
shows custom schema groups while the guide describes presets: resolve that conflict
with a bounded native probe rather than making presets a permanent language limit.
[API](https://create.roblox.com/docs/reference/engine/classes/GenerationService),
[guide](https://create.roblox.com/docs/parts/model-generation).

Journal intent before launch; use fixed executables/argument arrays, bounded roots,
resources, timeout and cancellation. Preserve output bytes: seeds do not guarantee
cross-device bit reproducibility. Generation/downloads/uploads happen outside open
recordings and automated regression tests.

Use admitted mesh constructors and asset permissions, not a MeshPart.MeshId setter.
Attach prompts, lights, sockets, collision and source bindings only when declared.
Materialize the prop before mutation. Inseparable wrappers fit one transaction or
need a revised staging plan. Native loading, collision, rendering and persistence
remain distinct evidence. Cube is optional and cannot block source-only creation.

## Milestones

| Milestone                         | Concrete work                                                                                                                                                                                       | Acceptance and current status                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — capability/evidence honesty  | Finish studio-evidence/generator/StudioAuthoring repairs, phase timings, revision evidence retrieval, conformance fixture integration and authoritative docs.                                       | Local six-field codecs, final scratch reads, canonical setter families and derived reconciliation implemented. Native conformance and timing overhead remain open.                        |
| M1 — replace restrictive IR       | Replace game-ir round schema/recipe union with composition admission, ordinary source manifests, trusted optional definitions and explicit resource policy. Delete premature plan/graph interfaces. | Implemented: source-only/no-round/no-UI/no-scene inputs, optional extensions, typed connections, canonical identity, bounded malformed-input checks and semantic game maps.               |
| M2 — structural compiler          | Add game-compiler using existing transaction-topology and mutation-evidence contracts. Resolve generated parents before paths. Introduce executable GamePlan inventory/slot/ownership validators.   | Implemented: executable plan/inventory/slot validators, generated topology, observed sources, exact imports and reproducible artifacts. Planning remains read-only.                       |
| M3 — creator workflow cutover     | Replace CreatorPlan/CreatorBuildContract surfaces in session, worker, control, runtime tools and dashboard in one cutover. Small changes use the same path.                                         | Implemented clean creator cutover: exact acceptance, host-compiled source/value slots, immediate completion, fresh default store and no legacy reader.                                    |
| M4 — checked builds/checkpoints   | Introduce executable GameBuildGraph, partition orchestration, artifact closure, aggregate reconciliation and explicit recovery above existing transactions.                                         | Implemented sealed graph, evidence-cost partitions, exact checkpoint replay and explicit recovery. Native interrupted/reopen evidence remains user-run.                                   |
| M5 — source/runtime packages      | Complete staged-topology strict analysis and isolated workers; admit optional content-addressed Scope/Event/Task/StateMachine bundles with license/ABI/source locks.                                | Implemented optional locked runtime, pinned strict analyzer and AST import validation. Lifecycle tests pass; OS sandbox and native lifecycle evidence remain open.                        |
| M6 — composition compilers/assets | Support arbitrary project scene/UI/asset composition and reuse, explicit references/overrides, asset locks and optional Cube workers. Curated kits are not required.                                | Partial foundations: primitive scene/UI/patch recipes, asset registry and recorded-output Cube worker. General assembly reuse, creator asset integration and native evidence remain open. |
| M7 — breadth and quality proof    | Exercise diverse compositions through the ordinary workflow, then Last Light as one fixture. Preserve clean seeds, prompts/plans, artifacts, receipts, timings and observations.                    | Solution-free Last Light seed and production-shaped specification compile structurally. Full generated gameplay, quality, device measurements and comparable model runs remain unproved.  |

Implementation status: M1–M4 now have executable contracts, creator consumers and
offline checkpoint coverage. M0 has six-field codecs and complete derived-alias
reconciliation for the three declared setter families; native conformance and
timing overhead remain open. M5 injects the optional locked runtime and checks
staged source with pinned strict analysis and AST import validation. Its process
deadline/output bounds are implemented; an OS candidate sandbox is not. M6 has
generic primitive scene, responsive UI and patch recipes, an asset registry and a
bounded recorded-output Cube worker. Native generation/upload/mesh admission and
viewport observations remain gated. General project assembly reuse still needs
creator-workflow integration and the acceptance cases below; curated kit delivery
does not count toward core completion. M7 has a solution-free Last Light seed and a
production-shaped specification with source slots, not a proven playable generation.

M0 native evidence does not prevent independent M1 host work. M2–M4 use only admitted
lowerings. Analyzer hardening can proceed alongside M2. Optional Cube work does not
block the procedural proof.

## Acceptance and claims

Test independent axes, not genre names:

- Source-only package with no recipe/round/UI/scene; client UI with no Workspace output.
- Ongoing world with no termination/reset; two independently scoped activities.
- Server/client/shared packages and a novel ordinary Luau mechanic.
- Runtime spawning with exact editor inventory and separate behavioral evidence.
- Directed/teleport/disconnected spaces when intended; recipe/source hybrids.
- Creator-edited generated source, existing-project patches and large incremental graphs.
- Project-authored content reused with separate placements and overrides, without
  registering a new recipe or selecting a catalog kit. Internal references remain
  local to each copy; declared shared resources retain their identity.
- A reviewed update to reused content preserves independently owned copies and
  creator overrides, or reports an exact conflict before writing. Reordered input
  produces identical compiled identities and bytes; new copies receive distinct IDs.

Freeze trusted host/compiler/plugin hashes for the decisive extension test. Introduce
behavior with no recipe and compile/install its source package without changing those
hashes. M1 proves only admission; the full test must use the ordinary creator workflow.
Apply the same frozen-host test to novel scene/UI assemblies built from admitted
operations. Exercise both one-off and reused content. A curated library is neither
required test input nor evidence that arbitrary project composition works.

Last Light has fixture-local round/objective/replay/UI requirements. Its terminal
reachability and ten-cycle cleanup obligations are not universal. Keep fixture
definitions and hidden evaluator material outside generic packages/builder context.
Declared finite state graphs permit scoped checks; arbitrary code cannot receive
equivalent guarantees from graph inspection.

Tests/replay are provider-neutral with zero live model calls. Preserve failed traces
and classifications; convert reproducible failures into bounded offline fixtures
with provenance. Unreproduced failures remain recorded, not falsely fixed. Never
stuff hidden answers or entire private traces into prompts.

Separate schema consistency, source analysis, isolated tests, native observations,
performance and creator judgment. Local gates remain eligible/rejected/incomplete.
runtime_verified requires the exact registered authoritative evaluation. Source
hashes and declarations do not prove runtime confinement, cleanup or determinism.

## Performance and unresolved research

Keep orchestration in ForgeNativeAgentRuntime, transports one-turn, continuation and
immediate completion. The provider-turn deadline stays 1,200,000 ms. No permanent
planner/coder/critic chain. Measure context/schema/serialization, analysis/compiler,
checks, transfer, preflight, writes/readback, reconciliation and publication separately.
Host spans do not yet isolate all engine work; under-2% replay overhead is unmeasured.

Four-minute median/eight-minute p95, eight requests and 200,000 input/30,000 output
tokens remain proposed fixed-proof targets, not limits for arbitrarily large games.
Use a pilot and at least 20 comparable authorized runs before interpreting p95.

Remaining targeted work:

- Analyzer processes now share an invoked-process deadline and output budget. Full
  descendant isolation and an OS resource/filesystem/network sandbox remain open.
  Negative probes show that tested unannotated Workspace lookups accept a wrong
  Part.Size value, whereas explicit Part typing rejects it. A pinned official AST
  pass now rejects effective `--!nocheck` and `--!nonstrict` directives and checks
  static imports; stronger topology typing remains open. Luau type functions execute
  during analysis.
  [Type functions](https://luau.org/types/type-functions/),
  [Luau LSP](https://github.com/JohnnyMorganz/luau-lsp).
- Source-index and analyzer admission budgets differ materially. Measure document
  bytes/dependencies, memory and elapsed time before expanding closure profiles.
- Native coupled-property derived effects, service scratch strategies, generation
  permissions, mesh persistence and device rendering costs remain unproved slices.
- Metadata-only source contracts cannot prove confinement; future sandbox claims
  require implemented enforcement and adversarial evidence.

## Verification and work log

After implementation changes, run without live provider calls:

```sh
git diff --check
npm run build
npm run dashboard:build
npm run plugin:test
npm run rojo:check
npm run formal:check
npm test
npm run plugin:build
```

The last command installs the connector at
`/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`. Temporary Rojo builds
do not replace it. The user operates Studio; supply exact place/connector paths and
the relevant sequence. No automated Studio operation, uploads, publication or live
model benchmarks.

- September 5: inspected IR, creator authority, topology, source analysis and evidence
  seams; researched the linked primary sources and saved this replacement plan.
- M1 composition admission removed the restrictive round schema and central
  mechanic union. M2–M4 now compile and consume exact plans/build graphs through
  the ordinary creator path. Tests cover generated parents, observed source,
  import authority, content identity, partition limits and verified recovery.
- M0 local checks passed: 144 datatype round trips, nine detached-preflight cases,
  and coupled-alias mutation replay. Native engine/save-reopen evidence remains
  separate. All nine existing formal models passed.
- The optional ForgeRuntime bundle contains four Forge-owned modules with retained
  licenses and exact source locks. Twelve real Lune lifecycle cases passed. Pinned
  official AST admission rejects dynamic/undeclared imports and disabled strictness
  without executing candidate source.
- A predecessor implementation checkpoint passed 439 Node, 65 dashboard and 39
  browser checks. Those counts do not describe the expanded current implementation.
  Subsequent focused checks and final aggregate gate results are recorded below.
- No live Forge provider runs, Studio operations, uploads, publication or Cube
  inference occurred. User-run native conformance and ordinary creator generation
  remain evidence-producing tasks; the Last Light specification contains no hidden
  completed gameplay implementation.
- The current backend build and complete Node corpus passed: **507/507**, no skips.
  The 8,192-operation fixture produces 64 bounded partitions and byte-identical
  output from reordered input. Profiling exposed repeated topology scans; indexed
  lookups preserve every duplicate sibling identity and require all occupants to
  leave before a replacement. The original slow scale probe was deliberately
  stopped; it is not counted as a passing run.
- Independent review added a preflight-substitution regression: even a canonically
  hashed canary with the same binding cannot stand in for the approved operation
  values. Both host and generated connector ordering tests cover duplicate slots.
- Failed persistence now captures discoverable immutable regression manifests.
  Rojo checkpoints cover guarded creation, exact synchronization, bounded map
  refresh and subsequent source edits. A plan mixing Studio and Rojo writer domains
  remains rejected; supporting that requires explicit per-operation authority.
- The dashboard map now opens beside Settings in an expandable window and renders
  declared gameplay systems/components with expandable branches and authored icons.
  Build metadata remains in the separate Technical details panel. The visual fixture
  is test-only; it does not supply game behavior to the compiler.
- The UI/UX Pro Max pass uses the creator's graph reference and the existing Forge
  typography, with shared workspace tokens, stronger node hierarchy, responsive
  inspection panels and visible map navigation. Saved artifacts expose a human
  preview before raw JSON. Keyboard navigation excludes collapsed controls, search
  preserves context, and loading failures can retry the exact saved artifact.
  Generated marketing-page recommendations were unsuitable and were not adopted.
- The first aggregate run passed 507 Node and 93 dashboard tests, then reported
  13 browser failures because screenshot baselines were absent. The broad PNG
  ignore rule excluded those files. Nineteen macOS Chromium baselines were generated
  and individually reviewed; a narrow ignore exception now retains them. This is
  baseline admission, not a claim of visual equivalence to a previous screenshot.
  The failed run and browser traces are retained at
  `/var/folders/76/2lc82tt94msdt45f439zns8h0000gn/T/forge-ui-missing-baselines-lch40l1s`.
- Final aggregate `npm test` completed at exit 0. It ran formatting, lint, catalog,
  generated capability/coverage, documentation, TypeScript build, pinned source-tool
  verification, temporary Rojo builds, runtime manifest and dashboard production
  build checks; **507 Node tests**, **93 dashboard tests**, **45 browser checks**,
  plugin parse/analyze/module checks, **144 codec round trips**, **nine detached
  preflight regressions**, authority/persistence vectors and **nine formal models**
  passed. The browser suite retains **18 intentional duplicate-layout skips**.
  The full log is `/tmp/forge-full-final2.log`. Final `git diff --check` passed.
- The final `npm run plugin:build` installed
  `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx` directly, exit 0.
  SHA-256: `e27bdd6dfcd1f3520bb031ac2900208b69033cf137376f95aebc69c5be232f90`.
  No model, Studio, upload or generation-service calls were made by these checks.
  The next dashboard check is to refresh it and open **Game map** beside Settings;
  the next native capability evidence remains the user-run sequence below.

### Next native capability evidence

The generated verification place is `/tmp/forge-native-conformance.rbxlx`. Rebuild it
from the current sources with:

```sh
rojo build test/fixtures/studio-native-conformance/default.project.json -o /tmp/forge-native-conformance.rbxlx
```

After the final connector installation, the user closes/reopens Studio, opens that
place in Edit mode and opens View → Command Bar. Run the fixed fixture:

```luau
require(game:GetService("ServerStorage").ForgeNativeConformance).run()
```

Save the place, close it, reopen the saved file, then run:

```luau
require(game:GetService("ServerStorage").ForgeNativeConformance).verifyReopen()
```

Save again and export to a previously absent output file:

```sh
lune run scripts/export-native-conformance.luau /tmp/forge-native-conformance.rbxlx /tmp/forge-native-conformance-evidence.json
```

Return the fixed report for review. This fixture establishes only the recorded
native preflight/value/save-reopen observations; it is not full transaction or
gameplay verification. The agent does not operate Studio or run these native steps.
