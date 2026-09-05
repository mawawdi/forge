# Separate game composition from optional gameplay lifecycles

Inspected September 5, 2026. This is an architectural research finding, not a
claim that the whole proposed compiler has been implemented. The draft audit below
records the state before the replacement described in the
[working implementation plan](../roadmap/game-generation.md).

## Finding

A general game IR must not require rounds, countdowns, deadlines, win/loss states,
or global replay/reset. The inspected draft was still too restrictive. Moving a fixed
set of mechanics into a catalog and replacing enum values with strings did not
remove the global timed-round model or establish modular composition.

A core gameplay loop describes repeated player behavior. Roblox's design guidance
describes interaction, repeated actions, and progression; its illustration is an
ongoing exploration/combat/upgrade cycle. That does not imply a match timer or a
reset of the experience.
[Roblox, Core loops](https://create.roblox.com/docs/production/game-design/core-loops).

Epic explicitly separates basic game administration from match state. Its default
`AGameModeBase` handles initialization and player entry, spawning, and departure;
the specialized `AGameMode` adds a match state machine. This is direct evidence for
keeping optional match semantics out of the general lifecycle contract.
[Epic, Game Mode and Game State](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-mode-and-game-state-in-unreal-engine).

General state-machine notation is also broader than a round. SCXML permits zero
top-level final states, nested machines, and parallel state regions. It specifies
what termination means when a final state is entered; it does not require every
machine to end. Forge can adopt that distinction without importing SCXML's arbitrary
script/expression execution facilities.
[W3C, SCXML sections 3.2–3.7](https://www.w3.org/TR/scxml/#scxml).

## Superseded draft audit

The inspected core schema and validator required all of the following:

- Requires one `round`, a positive duration, a countdown, and a six-name state vocabulary.
- Requires all gameplay events to occur in that round's `active` state.
- Requires terminal reachability and a global replay/reset path for every design.
- Requires every system to be included in the same reset scope.
- Measures dependency completion against a single game-wide deadline.
- Requires one scene hub and landmark, undirected connectivity from that hub, and
  references collection items as zones rather than general entities.
- Requires a fixed theme shape, safe-area policy, screens, and UI components.
- Encodes the initial solo/no-persistence product scope directly into the IR grammar.

The draft recipe catalog removed some conditional
branches from core validation, but still exposed a closed system union with narrow
common semantics: a single completion prerequisite and specific interaction lists.
An extensible string is only a name; it provides no behavioral contract by itself.

The draft cross-composition tests all inherited a timed-round helper. They proved
those variations fit that helper; they did not demonstrate support for continuous
play, independent activities, local retries, or state that outlives an activity.

## Recommended architecture

Use a small composition kernel with optional semantic modules, then lower the
resolved composition into the exact Studio authority graph. This is an inference
for Forge, supported by the following established patterns:

- MLIR lets analyses use semantic interfaces instead of knowing each operation's
  concrete kind. Its operation validation separates structural constraints from
  interface and custom semantic checks. Forge can use the same separation in
  TypeScript; this is not a recommendation to embed LLVM or MLIR.
  [MLIR interfaces](https://mlir.llvm.org/docs/Interfaces/),
  [MLIR verification ordering](https://mlir.llvm.org/docs/DefiningDialects/Operations/#verification-ordering).
- Epic Game Features encapsulate behavior and data in opt-in components, with
  explicit client/server placement and feature activation/deactivation.
  [Epic, Game Features and Modular Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-features-and-modular-gameplay-in-unreal-engine).
- Godot recommends reusable scenes with minimal environmental assumptions and
  dependencies supplied by their composing parent.
  [Godot, Scene organization](https://docs.godotengine.org/en/stable/tutorials/best_practices/scene_organization.html).

The kernel should know identities, module instances, typed connections, state
ownership, resource scopes, constraints, package locks, authority, and verification
obligations. It should have no required global gameplay state machine or genre.
Each module exposes named, typed inputs and outputs. The accepted module package
supplies its parameter schema, state schema, lifecycle contract, required engine
capabilities, expansion/lowering implementation, and validation hooks.

Module dependencies are explicit connections and requirements, not implicit reads
from a global `RoundState`. A module can be instantiated multiple times with separate
state and scope. Consequential state remains server-owned; presentation modules may
run on clients through declared replication and intent boundaries.

Round management, countdowns, timers, objectives, checkpoints, inventories, and state
machines become optional reusable modules. Larger convenience recipes can compose
smaller modules; the model need not author primitive event plumbing for every task.
Only admitted recipe definitions receive trusted host compilation. An unknown recipe
ID rejects at resolution; ordinary Luau packages are the first-class extension path
for new behavior. A novel mechanic need not add a host definition. The model cannot
register new host compiler code or broaden accepted editor capabilities.

Initialization and cleanup remain infrastructure responsibilities. Cleanup releases
owned resources; it does not imply resetting player progress or the world. A local
activity may end or retry while its containing world continues. Persistence is a
separate data-lifetime and storage contract, not a side effect of omitting reset.

The target contract sequence remains `GameDesignSpec → GamePlan → GameBuildGraph`.
Structural compilation enumerates editor objects, source slots, references,
intermediate states, locks, and required authority before acceptance. Modular gameplay
does not change fixed plugin execution or bounded verified transaction checkpoints.

## Validation follows the selected modules and declared promises

| Validation layer      | Obligations                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core, always          | Resolve IDs and locks; validate data/interfaces/connections and declared artifact dependencies; do not infer arbitrary runtime effects or lifecycle guarantees                   |
| Module, when selected | Validate that module's rules, references, finite-state transitions, configuration bounds, and required inputs                                                                    |
| Composition           | Check declared ownership, adapter requirements, prerequisite chains and lifecycle crossings where their semantics are available; unknown source behavior needs targeted evidence |
| Creator requirement   | Verify the requested interaction, progression, feedback, recovery, and completion promises for this design                                                                       |
| Platform/runtime      | Preserve server authority, source admission, initialization failure behavior, cleanup, reconciliation, and native evidence boundaries                                            |

Termination is checked when a selected module or creator requirement promises it.
Restart/reset completeness is checked for the state a declared retry owns. An idle
state, an ongoing simulation, or an intentionally absorbing completed state is not
automatically a broken game. Build dependency acyclicity must not become a ban on
intentional runtime feedback loops.

Graph reachability proves a path in a represented model, not that arbitrary Luau,
spatial conditions, networking, or player choices will realize that path. Finite,
bounded domain checks retain explicit assumptions. Native probes and creator quality
review remain separate. A generic validator cannot certify that a game is coherent
or enjoyable just because every event has a consumer.

The replacement for the universal-round guarantee is a traceable obligation: every
required feature has resolved dependencies, declared ownership/authority where
relevant, and evidence appropriate to its promised behavior. Those declarations are
inputs to checks, not proof that arbitrary source obeys them. This preserves the
intent to generate a complete experience without inventing terminal outcomes.

## Implementation implications and acceptance

Before expanding the runtime/compiler around the draft, replace the top-level round
shape and round-specific validator. Move its reusable machinery into an optional
module, then split system-specific validation from core composition. Move the first
release's solo/no-persistence limits into a compiler target/admission profile.

The next offline acceptance corpus should vary architecture, not enumerate genres:

1. A composition with no gameplay FSM, countdown, deadline, win/loss, or replay.
2. A continuous world with an independently terminating local activity.
3. Two instances of one module with separate state, ownership, and cleanup.
4. A retry that resets local activity state while preserving longer-lived state.
5. Multiple independent state machines without a required global machine.
6. A scene with no hub, plus explicit directed/conditional traversal where required.
7. A newly registered test module accepted through its contract without modifying
   core validation; unknown modules and incompatible typed connections still reject.
8. The complete-game acceptance fixture expressed entirely by composition, with its
   countdown, deadline, terminal conditions, and replay confined to that fixture's
   selected modules.

Do not implement all possible modules now or introduce an unrestricted programming
language in JSON. The architecture should accommodate extension while the shipped
compiler honestly reports which module contracts it can lower and verify.

Further research established another limit: a mandatory recipe catalog would still
cap expressiveness. The replacement plan therefore makes normal Luau source packages
first-class, with optional recipes and distinct editor/runtime/evidence contracts.
It also records analyzer process-bound gaps, experimental platform capabilities and
Cube documentation discrepancies. The linked sources support architectural choices;
they do not measure Forge quality or prove universal game correctness. No Studio or
live Forge model calls were made for this research.
