# How Forge Can Signal the Strongest Possible Hire for Lemonade

> Status: foundational transformation research. It explains why Forge moved toward an observable agent harness and evaluation system; it is not current API or protocol documentation. See [ARCHITECTURE.md](ARCHITECTURE.md), [FORGE.md](FORGE.md), [EVALS.md](EVALS.md), and [ROADMAP.md](ROADMAP.md) for current behavior and status.

## Executive finding

Your instinct about the semantics layer is correct.

After comparing the role description, Lemonade's public product, the Lemonade Studio plugin you inspected, current agent-evaluation practice, Anthropic's latest long-horizon harness work, Harbor, Fly's current agent infrastructure, and Roblox's own 2026 agentic tooling, I would **change Forge's architectural direction now**.

The strongest version of Forge is **not**:

> prompt → Forge recognizes a mechanic → Forge deterministically writes a detailed mechanic contract/ABI/constants → model fills in Luau → Forge proves it matches the handcrafted contract.

That was an excellent way to prove the vertical slice. It was also useful for building trustworthy verifier infrastructure.

But if it becomes the production architecture, Forge risks becoming a **hand-authored game-mechanics compiler**. Every new concept eventually needs someone to define `CollectFruit`, `SellInventory`, `UpgradeBasket`, `ZombieCombat`, `RoundManager`, `Fishing`, `Vehicle`, and so on. That does not fit Lemonade's apparent product breadth, and I do not think it is what this job is asking you to build. Lemonade's public product currently advertises generation across tactical shooters, zombie survival, racing, Bedwars, farming, pet games, escape games, PvP, tycoons, and many other game types. citeturn9search3

The job is much more consistent with this architecture:

```text
                       ONE GENERAL AGENT HARNESS
                                  │
                                  ▼
                    frontier / open-source model
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
                 ▼                                 ▼
        understand / plan game             inspect + modify game
                                              through tools
                 │                                 │
                 └────────────────┬────────────────┘
                                  ▼
                          candidate game state
                                  │
                    ┌─────────────┼───────────────┐
                    ▼             ▼               ▼
               deterministic   runtime         qualitative
               validators      gameplay        evaluator
               / security      verification    / game taste
                    │             │               │
                    └─────────────┼───────────────┘
                                  ▼
                             outcome / trace
                                  │
                          pass or iterate
                                  │
                                  ▼
                        production failure data
                                  │
                                  ▼
                     regression / Harbor eval
                                  │
                                  ▼
                     harness/model experiment
```

That distinction is not semantic hair-splitting. Anthropic defines an **agent harness** as the scaffold through which a model receives inputs, calls tools, acts, and returns results; importantly, evaluating the “agent” means evaluating the **model and harness together**. Its eval guidance recommends deterministic graders where possible, model or human graders where necessary, and specifically warns against overly rigid grading of the exact path an agent took rather than the outcome it produced. citeturn9search1

That wording is almost a direct match for the Lemonade role.

The most important architectural correction is therefore:

> **Do not eliminate semantics. Move semantic authority to the right places.**

I would split semantics into four categories:

```text
Creator semantics
"What game does the user want?"

        Model-derived, user-grounded.


Project semantics
"What actually exists in this Roblox project?"

        Tool-derived, factual.


Platform / trust semantics
"What must always be true for Roblox correctness/security?"

        Forge-owned, deterministic where possible.


Evaluation semantics
"What observable outcome would demonstrate this task succeeded?"

        Generated from requirements + independent evaluation,
        with hidden benchmark oracles only inside eval fixtures.
```

Your current architecture partially collapses all four into `MechanicContract` + `MechanicImplementationSpec`. That is what I would fix.

And this pivot would **increase**, not decrease, the strength of your application.

The outstanding hiring story becomes:

> “I built a deterministic verifier and real-Studio evaluation loop, then my own model eval exposed that I'd over-specified the agent's solution space. Rather than optimizing the benchmark, I separated user intent, discovered project facts, universal safety policies, and task-level evaluation. Then I measured the new harness across models and representative tasks.”

That is almost absurdly aligned with the role's stated three-month success criterion.

## What Lemonade appears to be hiring you to own

There is an important distinction between what we **know** about Lemonade and what we can **infer**.

We do not have Lemonade's private agent-backend source. So I would not tell Nicolas, “I know Lemonade uses architecture X.”

What we do have is unusually strong circumstantial evidence from three directions: the job description, Lemonade's public product, and the Studio plugin source you examined.

### The job is about harness science, not a mechanics ontology

Read the verbs in the job description carefully:

> own the agent harness  
> evaluate new models  
> understand which harness changes unlock performance  
> connect user failures back into evals  
> deterministic tests wherever possible  
> regression suites  
> long-horizon execution  
> multiple models  
> production traces

There is conspicuously no:

> define an exhaustive formal game-mechanics language.

Current best practice in agent engineering points the same direction. Anthropic's January 2026 eval guidance treats the model+harness pair as the unit being evaluated and advocates representative tasks, stable isolated environments, outcome-based grading, transcript inspection, production-failure-derived regressions, and a mixture of deterministic and model/human graders. citeturn9search1

The warning about task specification is particularly relevant to Forge. Anthropic describes cases where evals dramatically understated model ability because the grader or task was over-constrained; one cited CORE-Bench investigation moved an Opus 4.5 result from 42% to 95% after fixing grading/specification/scaffold problems. Their explicit lesson is that very low performance can signal **a broken task or grader**, not merely a weak model. citeturn9search1

You have already lived exactly that story.

The original Luna candidate was historically false-rejected for Roblox type errors because Forge used an analyzer without a real Roblox host environment. Once corrected, those false errors disappeared; the unchanged source retained only an actual contract discrepancy. fileciteturn0file14

That incident is not embarrassing.

**That is your strongest evidence that you actually understand eval engineering.**

You didn't say:

```text
MODEL FAILED
→ tune prompt until green
```

You did:

```text
MODEL FAILED
       ↓
inspect trace
       ↓
separate candidate failure from grader failure
       ↓
fix Roblox-aware tool boundary
       ↓
fix ABI matching
       ↓
preserve historical result
       ↓
re-run exact same candidate
       ↓
retain real remaining failure
```

That is precisely the mindset Lemonade is advertising.

### Long-horizon generation probably looks more like planning + tools + evaluation

Anthropic's March 2026 work on long-running application generation is especially relevant to Lemonade's “multiple hours per user” initiative.

Their newer harness starts with a short user request and has a **planner model expand it into a high-level product specification**. Crucially, Anthropic says it intentionally avoided having the planner over-specify detailed technical implementation because an incorrect low-level plan can cascade downstream. A generator then implements incrementally, while a separate evaluator exercises the application and sends failures back for another iteration. citeturn9search0

They even introduced a per-sprint agreement about **what “done” means** before implementation, with generator and evaluator negotiating an acceptance contract. The contract constrained deliverables and testability rather than dictating source structure or an exact implementation. citeturn9search0

That maps much better to Lemonade's wording:

```text
"high-quality game scaffold"
"not zero-shot"
"agent executes over multiple hours"
```

than a one-mechanic-at-a-time deterministic semantic compiler.

Their reported long-horizon experiment ran for nearly four hours, with planning, long build phases and iterative QA. It also found that evaluator usefulness changes as model capabilities change—a reminder that harness assumptions themselves must be reevaluated as frontier models improve. citeturn9search0

That last point is particularly important for a founding AI engineer:

> **A great harness does not freeze today's model limitations into permanent architecture.**

### Lemonade's Studio integration looks agent-tool oriented

Your direct review of Lemonade's packaged Studio plugin found a broad action/runtime interface: project inspection, mutation, stable instance identity, playtesting, capture, imports, generic actions and even arbitrary code execution in places where Lemonade accepts that capability. It looks like a general agent-to-Studio substrate, not a plugin containing a taxonomy of handcrafted mechanics. fileciteturn0file12

That does **not** prove their backend contains no semantic representations.

But combined with the product breadth and job wording, the reasonable inference is:

> Lemonade likely expects frontier models to carry much of the game/program semantics, while the harness provides tools, context, execution, evaluation, recovery, safety, and feedback.

I would state that as an inference in an interview, not as fact.

Roblox itself is moving in essentially that direction. Its current Studio MCP exposes general project search, script editing, Luau execution, playtesting, screenshots, character navigation, keyboard/mouse input and specialized `explore` and `playtest` subagents. Roblox describes the playtest subagent as capable of running gameplay scenarios and verifying results rather than requiring a handwritten mechanic-specific compiler. citeturn13search0 Roblox also stresses real client/server testing because its engine's client-server architecture makes runtime behavior something that must actually be exercised. citeturn13search9

That is a powerful reference architecture for where Forge should head.

## How strong a hire Forge signals today

Forge already signals **a much stronger fit than a normal AI wrapper project**.

Your strongest parts map almost one-to-one onto the job.

| Lemonade criterion | Forge today | Signal |
|---|---|---|
| Harness is a core product | Models sit behind explicit boundaries; model output cannot certify itself | **Very strong** |
| Deterministic verifier loops | Luau, Roblox-aware typing, remote trust analysis, PatchSet gates, ProofBundle | **Exceptional** |
| Representative execution | Real Roblox Studio Play Solo, correlated server evidence | **Very strong** |
| Regression discipline | Historical candidates/proofs retained; false-positive fixes become regressions | **Exceptional** |
| Failure diagnosis | You separated model defects, verifier defects and harness defects repeatedly | **Exceptional** |
| Security / adversarial eval | Real client reward and payout faults were exploited in Studio and rejected | **Very strong** |
| Observability | BuildTrace / ProofBundle separation, hashes, provenance, outcomes | **Very strong** |
| Rollback / fail-closed behavior | Rejected runtime fault restored exact prior revision | **Very strong** |
| Model comparison | One primary model path; no meaningful model/harness matrix yet | **Weak** |
| Production failure → eval | Forge's own failures become regressions, but not real user-failure mining | **Medium** |
| Long-horizon agent | Not implemented | **Weak** |
| Multiple-model coherent harness | Boundary exists, empirical proof does not | **Weak** |
| Game taste / subjective evaluation | Almost entirely absent | **Weak** |
| Fly/Docker agent infrastructure | Designed conceptually, not central to current artifact | **Weak** |
| Broad game-generation generalization | Current acceptance is Collect + Sell | **Weak-to-medium** |

Forge's current evidence chain is genuinely impressive. M3 established real safe runs, a real runtime reward exploit, deterministic rejection and rollback rather than merely unit-test mocks. fileciteturn0file2 The M3.5 acceptance then starts from the sealed AI-authored Collect implementation, extends it with AI-authored Sell, and passes fourteen correlated Collect, Sell and composition assertions; a payout fault was separately rejected. fileciteturn0file1 fileciteturn0file3

That already says:

> **“I naturally think like your verifier/evals engineer.”**

What does *not* yet say “strongest possible hire” is breadth and experimentation.

Right now a skeptical interviewer can still ask:

> “Very cool, but how much of this succeeded because you designed the exact Collect/Sell contracts and exact test harnesses yourself?”

And unfortunately, the honest answer is:

> A meaningful amount.

The current M3.5 architecture explicitly owns a zero-argument Sell ABI, `Inventory`/`Coins` state schema, `UnitPrice`, exact state ordering, prompt identity and activation radius, server authorization radius, six allowed source targets and a fourteen-assertion exact harness. fileciteturn0file0 fileciteturn0file4

That is **fine for a benchmark fixture**.

It is not the architecture I would scale into Lemonade.

## The semantic architecture should change

The fundamental error would be concluding:

> “Forge must understand every mechanic better than the LLM.”

I don't think that's necessary, and current frontier-agent work strongly suggests the opposite architecture is more scalable.

### Keep semantic authority, but give every fact provenance

I would replace the conceptual monolith:

```text
MechanicContract
+
MechanicImplementationSpec
```

with a provenance-aware requirement system.

Something approximately like:

```ts
type RequirementSource =
  | "creator"
  | "project_observation"
  | "platform_policy"
  | "agent_plan"
  | "evaluator"
  | "benchmark_oracle";

interface Requirement {
  id: string;
  statement: string;

  source: RequirementSource;

  // Is this a hard fact, interpretation, or test-only oracle?
  authority:
    | "fact"
    | "policy"
    | "hypothesis"
    | "evaluation_only";

  confidence?: number;

  evidence?: {
    projectPath?: string;
    promptSpan?: string;
    observationId?: string;
  };

  verification:
    | "schema"
    | "static"
    | "studio"
    | "evaluator"
    | "human";

  blocking: boolean;
}
```

This solves an enormous conceptual problem.

Suppose Forge sees:

```text
MAX_DISTANCE = 20
```

Today it can end up looking like:

> Forge knows CollectFruit should have distance 20.

That's dangerous.

Under the new architecture, we ask:

```text
Why 20?
```

Possible answers:

```text
source = project_observation

SellZone already has an existing 20-stud server policy.
→ hard project integration fact.
```

or:

```text
source = creator

User explicitly said attacks should work within 20 studs.
→ hard creator requirement.
```

or:

```text
source = benchmark_oracle

Hidden eval fixture deliberately expects exactly 20.
→ valid benchmark condition,
  NEVER sent into production as universal game semantics.
```

or:

```text
source = agent_plan

The agent chose 20 while designing a new mechanic.
→ implementation/design decision;
  verify internal coherence, don't reject because Forge prefers 18.
```

That distinction is huge.

Your first Luna candidate demonstrates why it matters. Forge's corrected verifier now rejects its 12-vs-20 mismatch as a genuine interface discrepancy because the current benchmark's Forge-owned spec says 20. fileciteturn0file14 That is perfectly legitimate **inside a benchmark whose task defines that requirement**.

It would not be legitimate to conclude:

> every future collectible mechanic ought to have a 20-stud radius.

### ProjectSemanticMap should describe reality, not prescribe design

Your `ProjectSemanticMap` is actually one of the architectural pieces I would preserve almost intact.

It captures Instances, scripts, remotes, state, tags, attributes and dependencies and distinguishes missing knowledge from safe knowledge. fileciteturn0file9

The shift is philosophical:

```text
Current temptation:

ProjectSemanticMap
     ↓
Forge decides what mechanic should be


Better:

Project/world observation
     ↓
Agent learns what is already there
     ↓
Agent decides how to extend it
     ↓
Forge verifies consistency
```

For an existing project, Forge absolutely should say:

```text
There is already:
ReplicatedStorage.Remotes.SellInventory

There is already:
Workspace.SellZone.SellPrompt

There is already:
player attribute "Coins"
```

Those are facts.

But in a blank zombie game, Forge should not decide:

```text
RoundManager must be ServerScriptService.RoundManager
Remote must be named AttackZombie
damage must be 10
range must be 20
zombies must use tag "Enemy"
```

The agent can make those decisions.

Forge's job is to discover them afterward and ensure that the project is coherent and safe.

### Make universal semantics genuinely universal

There **is** a class of semantics that should remain handwritten.

For example:

```text
client-originated values are untrusted
authoritative currency mutation belongs server-side
DataStore access cannot be client-owned
RemoteEvent direction/arity must be coherent
referenced Instances should exist
Luau must be valid
a state-changing endpoint needs appropriate validation
unknown runtime fact ≠ safe
```

That's not a game-mechanic ontology.

That's a **Roblox policy/verifier layer**.

Your existing remote-authority work belongs here.

The best future M2 rule should know:

```text
untrusted client value
       ↓
authoritative server-owned state
```

rather than know:

```text
SellInventory claimedPayout
```

The M3.25 fix that moved RemoteEvent reasoning from local variable names to positional/semantic dataflow was exactly the right move in this direction. fileciteturn0file14

### Let the model carry much more semantic synthesis

For:

> “Create me a round-based zombie survival game.”

I now think the model should produce a **high-level BuildPlan**, not Forge compile a handwritten zombie ontology.

For example:

```text
BuildPlan

Goal:
Create a playable round-based zombie survival scaffold.

Core behaviors:
- a waiting/intermission phase
- waves start automatically
- each wave spawns server-owned zombie NPCs
- zombies pursue living players
- players can damage zombies
- dead zombies stop acting
- kills grant server-owned currency
- wave completes only when all spawned zombies are dead
- subsequent waves increase pressure
- HUD exposes wave state / enemies remaining
```

Then the agent works out:

```text
Instances
modules
events
state machines
paths
names
damage values
AI implementation
UI implementation
```

within project constraints.

This closely resembles Anthropic's current long-running harness: a planner expands a short request into product-level requirements while intentionally avoiding premature detailed implementation decisions, and the coding agent works incrementally against those outcomes. citeturn9search0

Now Forge has something sensible to verify without knowing “zombies” intrinsically.

### Replace handcrafted mechanic harnesses with test capabilities

This is the other big structural change.

Current StudioProof intentionally allows exactly two registered harnesses: Collect-only and Collect+Sell. That's excellent anti-cheating and reproducibility for your current eval artifact, but it obviously does not scale to arbitrary games. fileciteturn0file10

Do **not delete those harnesses**.

They are valuable historical regression tests.

But add a new layer:

```text
Studio Runtime Capabilities
```

These are engine actions/observations rather than mechanic definitions:

```text
spawn/start player
wait for character ready
navigate player
position player
trigger production interaction
press key
click UI
activate tool
observe Instance
observe attribute
observe Humanoid health
count tagged/classed entities
observe position
measure distance
wait for state predicate
capture screenshot
attack RemoteEvent directly for adversarial tests
restart/reset
```

Then:

```text
high-level acceptance requirement
              ↓
       Runtime Test Planner
              ↓
     bounded StudioTestPlan
              ↓
     validate plan capabilities
              ↓
         execute in Studio
              ↓
       outcome observations
```

Roblox's own current Studio MCP is already converging on this general shape: it exposes game-tree search, instance inspection, script editing, Luau execution, play start/stop, screenshots, character navigation and user input, plus dedicated explore/playtest subagents that can execute gameplay scenarios and verify results. citeturn13search0

That is much more compelling evidence than trying to hand-invent a `ZombieRoundContract`.

### Deterministic where possible does not mean deterministic everywhere

This is perhaps the single most important interpretation of the job description.

“Wherever possible, replace subjective judgment with deterministic tests” does **not** mean:

> convert the game into a fully deterministic ontology.

It means:

```text
Question:
"Did killing the last zombie advance the wave?"

→ deterministic Studio state test


Question:
"Can the client grant itself 99,999 coins?"

→ deterministic security/dataflow + adversarial test


Question:
"Does this map feel fun, readable and appropriately paced?"

→ not honestly deterministic
→ evaluator model + screenshots/playtest + human calibration
```

Anthropic explicitly recommends deterministic graders when possible, LLM graders when flexibility or subjectivity requires them, and human calibration for model graders. It also says outcome grading is often preferable to forcing a specific implementation path. citeturn9search1

Their recent long-horizon harness similarly uses a dedicated evaluator for visual design and subjective quality because the generating agent tends to overrate its own work; the evaluator interacts with the actual application rather than merely reading the source. citeturn9search0

For games, Forge should eventually have:

```text
Correctness
        deterministic

Security / trust
        deterministic + adversarial

Runtime gameplay
        deterministic observations + gameplay agent

Game taste
        skeptical evaluator model

Creator satisfaction
        human/product signal
```

That is far more sophisticated than pretending game quality can all be statically proven.

## The Forge architecture I would build toward

I would stop presenting the system primarily as:

> **“a model-agnostic compiler for Roblox mechanics.”**

Internally that metaphor helped.

For Lemonade, I would present Forge as:

> **“a Roblox-specific agent harness and evaluation system that turns vague game requests into iterative builds, verifies what can be verified deterministically, exercises the result in the actual engine, and turns failures into regressions.”**

That is closer to the role and, honestly, to what your best engineering already is.

The revised architecture would look like this:

```text
                     CREATOR
                        │
    "Make me a round-based zombie survival game"
                        │
                        ▼
               ┌─────────────────┐
               │ PLANNER / AGENT │
               └─────────────────┘
                        │
                        ▼
                    BuildPlan
           goals / features / constraints
             NOT exact implementation
                        │
                        ▼
        ┌──────────────────────────────┐
        │      LONG-HORIZON HARNESS    │
        │                              │
        │ project tools                │
        │ source tools                 │
        │ Roblox Studio tools          │
        │ asset tools                  │
        │ git/checkpoints              │
        │ budgets / stop conditions    │
        └───────────────┬──────────────┘
                        │
             repeated incremental work
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
       Project Facts          Agent trajectory
       / live state                 │
             │                      │
             └──────────┬───────────┘
                        ▼
               VERIFICATION BUS

        ┌───────────────────────────────────┐
        │ Luau syntax/type                  │
        │ Roblox API validation             │
        │ universal authority/dataflow      │
        │ structural integrity              │
        │ task acceptance predicates        │
        │ Studio gameplay tests             │
        │ adversarial tests                 │
        │ visual/gameplay evaluator         │
        └────────────────┬──────────────────┘
                         │
                    pass / feedback
                         │
                  ┌──────┴──────┐
                  ▼             ▼
                commit       agent repair
                                │
                                └──────┐
                                       │
                                       ▼

                         Flight Recorder
                               │
                    production / eval failure
                               │
                               ▼
                         Failure Miner
                               │
                               ▼
                      reviewed regression
                               │
                               ▼
                             Harbor
                               │
          ┌────────────────────┼──────────────────┐
          ▼                    ▼                  ▼
       Model A             Model B            Model C
      Harness X           Harness X          Harness X

          or

       Model A             Model A
      Harness X           Harness Y

                               │
                               ▼
                   verified outcome comparison
```

### The semantic boundary in concrete terms

I would keep or introduce these objects:

```text
GameIntent
    model interpretation of creator request

BuildPlan
    editable / revisable high-level decomposition

ProjectFacts
    discovered from files + live Studio

PolicySet
    universal Forge/Roblox trust invariants

AcceptanceSpec
    observable outcomes expected from the current task

Patch / working tree
    what the agent actually changed

EvaluationPlan
    how this particular acceptance spec will be tested

Evidence
    static + runtime + evaluator observations

BuildTrace
    what happened

ProofBundle
    only claims for which evidence exists
```

Then I would **demote** `MechanicImplementationSpec`.

It should survive in two narrow roles.

For a benchmark fixture:

```text
hidden benchmark oracle
```

where you intentionally want a known exact interface.

For extending an existing project:

```text
IntegrationConstraints
```

derived from real project facts:

```text
existing RemoteEvent
existing datastore schema
existing state representation
existing public Module API
existing UI binding
```

But it should no longer mean:

> Forge writes the correct design of every new mechanic before the model gets to work.

Likewise `InteractionBinding` should become mostly **derived project evidence**:

```text
ProximityPrompt.Triggered
     ↓
client action module
     ↓
RemoteEvent
```

rather than requiring someone to manually define the interaction mode for every novel mechanic.

This is a crucial difference:

```text
FOR EXISTING GAME:

Forge:
"I discovered this exact interface.
Don't break it."

GOOD.


FOR BRAND-NEW GAME:

Forge:
"I have decided the exact interface
you must invent."

BAD.
```

### Context should increasingly become tool-driven

Your current Context Compiler is deterministic P0/P1/P2 selection with no retrieval or learned ranking. That was the right bounded design for a two-source generation experiment. fileciteturn0file5

For a multi-hour agent, I would evolve from:

```text
Forge precomputes perfect context
→ sends giant package
```

toward:

```text
agent starts with high-level task
      │
      ├─ search game tree
      ├─ grep/read source
      ├─ inspect remote
      ├─ inspect instance
      ├─ inspect runtime state
      └─ ask specialized project-search tool
```

with context compiler remaining underneath as an optimization/cache/provenance layer.

Roblox's current MCP explicitly offers `search_game_tree`, `inspect_instance`, script search/grep and an `explore` subagent for this kind of targeted project investigation. citeturn13search0 Anthropic's long-horizon work similarly emphasizes maintaining coherent task state and carefully controlling context over long builds rather than assuming the initial prompt can contain everything the agent will need. citeturn9search0

That is much closer to Lemonade's likely world.

## How to turn Forge from “strong hire” into “strongest hire”

I would radically change the roadmap.

**Do not do UpgradeBasket next just because CLB-003 exists.**

**Do not build capsules.**

**Do not build 3D generation.**

**Do not build a product dashboard.**

The strongest hiring artifact now is an **empirical harness/eval project**.

### Make the first milestone a semantic de-hardcoding audit

Take Forge as it exists and classify every authoritative field.

For every value currently owned by Forge:

```text
Remote path
ABI
state name
distance
interaction mode
unit price
mutation order
validation rule
assertion
source allowlist
```

label it:

```text
PROJECT FACT
CREATOR REQUIREMENT
UNIVERSAL PLATFORM POLICY
MODEL/AGENT DESIGN DECISION
EVALUATION ORACLE
```

Then enforce a rule:

> Production Forge may deterministically reject an agent for violating a project fact, creator requirement or universal policy. It may not reject an otherwise valid design merely because it differs from a hidden Forge design preference.

That alone is a legitimately interesting AI-engineering contribution.

I would name this something like:

> **Provenance-Typed Requirements**

And I would make the Luna 12/20 case one of its motivating examples.

### Turn CoreLoopBench into a real agent eval suite

You already have ten case definitions spanning acquisition, conversion, upgrades, persistence, UI, moving platforms, combat, repair and composition. fileciteturn0file1

That's a strong starting dataset.

But instead of writing the correct implementation contract for all ten, build each case as:

```text
starting project
creator request
visible project facts
universal policies
allowed environment/tools

HIDDEN:
outcome assertions
adversarial cases
grader implementation
```

Then let the same general harness solve them.

This is precisely what Harbor is designed to support. Harbor currently runs arbitrary agents such as Claude Code and Codex, packages tasks/environments, supports Docker execution and multiple verifier configurations, and can execute large numbers of trials in parallel. citeturn10search1 Harbor's task system also explicitly supports separating the agent environment from a hidden verifier environment—extremely useful for preserving hidden assertions—and supports multi-step tasks whose state persists between phases. citeturn10search7turn10search8

You could therefore make:

```text
CoreLoopBench
      ↓
Harbor adapter
      ↓
same task

Claude / harness A
Claude / harness B
Gemini / harness A
Luna / harness A
...
```

with Forge's StudioProof becoming the Roblox-specific runtime grader rather than the entire benchmark system.

That directly signals:

> “You said likely Harbor. I didn't merely import it. I understood where it belongs in a Roblox eval architecture.”

### Run actual harness experiments, not model demos

This is probably the single highest-value hiring signal you are currently missing.

Take a fixed set of tasks.

Then hold the model constant and vary:

```text
Harness A
current bounded context + two-call proposal

vs

Harness B
tool-using project exploration + planning

vs

Harness C
planning + independent evaluator
```

Measure:

```text
verified success
first-pass verified success
security defects
Studio failures
retries
cost
latency
tool calls
context tokens
```

Then hold the harness constant and vary models.

This matters because Lemonade explicitly wants someone who can answer:

> Which model is actually better **inside our harness**, and which harness changes unlock a particular model?

Anthropic's eval guidance likewise says “the agent” being measured is the model+harness combination, not the model in isolation. citeturn9search1

A compelling README graph would be much stronger than another 5,000 lines of architecture:

```text
                     Verified pass@1

Claude + baseline         40%
Claude + project tools    65%
Claude + evaluator        75%

Gemini + baseline         45%
Gemini + project tools    52%
Gemini + evaluator        54%
```

Those numbers are illustrative—**do not invent them**. The artifact should contain your real results.

Then inspect the traces and explain **why**.

That's founding-AI-engineer work.

### Demonstrate the failure → regression loop you already naturally do

You already have outstanding raw material.

For example:

```text
Failure:
host-less Luau environment falsely rejects valid Roblox source

Fix:
Roblox-aware analyzer

Regression:
preserved Luna candidate
```

Then:

```text
Failure:
M2 matched local parameter name rather than positional ABI

Fix:
position/dataflow semantics

Regression:
renaming parameter cannot change verdict
```

Then:

```text
Failure:
Sell client used Heartbeat to repeatedly FireServer

Root cause:
harness never specified/tested production interaction
and Studio happy path bypassed actual client initiation

Fix:
production-path test + explicit project interaction evidence

Regression:
secure server + wrong client initiation must fail
```

These are **exactly** the stories Lemonade's three-month success statement is asking for.

Your Flight Recorder already has the right conceptual separation: `BuildTrace` records what happened, `ProofBundle` records decision evidence, a benchmark fixture is a promoted reproducible failure, and an experiment varies configurations against fixed tasks. fileciteturn0file6

What is missing is simply completing the loop:

```text
real failure
→ minimized fixture
→ Harbor case
→ before/after experiment
→ measured disappearance of failure class
```

Build that.

### Then do one genuinely unseen game request

Only after de-hardcoding the semantics.

And **this is where your zombie prompt becomes extremely valuable**.

Use:

> **“Create me a round-based game where the player fights zombies and earns coins for kills.”**

Do **not** create `ZombieMechanicContract.json` manually beforehand.

Let the planner produce something like:

```text
Round lifecycle
Zombie spawning
Zombie lifecycle
Player combat
Kill rewards
Wave progression
HUD
```

Let the agent inspect/build the project.

Then have an evaluator derive a gameplay test plan from the requested outcomes.

The deterministic portion might test things such as:

```text
✓ Wave actually transitions into running state
✓ enemies actually spawn
✓ living enemy count matches observed world
✓ valid attack reduces server-owned health
✓ client cannot choose damage
✓ out-of-range attack does nothing
✓ dead zombie cannot reward twice
✓ all zombies dead causes wave transition
✓ next wave actually starts
```

The qualitative evaluator might inspect:

```text
Does the player understand what to do?
Is the wave state visible?
Are zombies obviously distinguishable?
Does combat respond in a usable way?
Does the generated map look like an intentional scaffold
rather than random parts?
```

If Forge handles this without you handwriting the semantic solution beforehand, the “fruit-game compiler” objection disappears almost instantly.

And it does not need gorgeous zombies.

Lemonade's job explicitly says **game scaffold, not zero-shot finished product**. The artifact should optimize for coherent gameplay and an eval loop, not final asset polish.

### Add a small long-horizon run

After the unseen game works at all, let the same harness run for an hour or several hours.

Not because hours are magically impressive.

Because you can demonstrate:

```text
short user prompt
     ↓
planner
     ↓
persistent plan/checkpoint
     ↓
feature
     ↓
evaluation
     ↓
repair
     ↓
next feature
     ↓
evaluation
     ↓
...
```

Anthropic's current long-running harness work specifically found value in decomposition, structured handoffs/context state and a separate evaluator for multi-hour application builds. citeturn9search0

That maps directly onto Lemonade's incubation project.

### Fly comes in here, not before

Now Fly suddenly has a real reason to exist.

The job explicitly names Fly and Docker. Fly's current agent architecture centers around hardware-isolated Firecracker environments: Sprites provide persistent isolated Linux execution with checkpoint/restore, while Fly Machines can host long-lived agent services. Fly specifically recommends separating the agent host from the untrusted code execution environment. citeturn11search2

Fly's public site also currently lists **Lemonade** among the teams building on Fly. That confirms a real relationship with Fly infrastructure, although it does **not** reveal Lemonade's private deployment topology. citeturn12search0

For Forge, the natural eventual split is:

```text
Fly Machine
    long-running harness/controller

        ↓

isolated Sprite / Docker environment
    repo
    coding agent
    Luau tools
    tests
    checkpoints

        ↓ artifact

StudioProof worker
    real Roblox Studio
    runtime/gameplay evaluation
```

You don't need to force Roblox Studio into a Linux Fly Machine. Roblox runtime proof remains its own execution environment.

Fly also exposes fast-lifecycle Machines through an API, which is useful once you need independent agent/eval workers rather than one local process. citeturn11search0turn11search1

If time is limited, Docker + Harbor matters more for your immediate proof.

Fly becomes a great **second** infrastructure signal once you have a real long-horizon workload to place there.

### Do not build your own 2D/3D foundation model

For this role, that would actually dilute the signal.

Roblox's current AI tooling already exposes image/asset workflows and procedural-model integrations through its broader AI/MCP surface. citeturn13search0

Your problem is:

```text
Can the AGENT decide:
"I need a zombie model"

Can it:
find / generate / insert one

Can Forge evaluate:
correct hierarchy?
Humanoid?
PrimaryPart?
animations load?
collision usable?
scale sane?
NPC actually moves?
visual result acceptable?
```

not:

> Can you train a mesh diffusion model?

The first is directly relevant to Lemonade.

The second is a separate ML company/research problem.

## The strongest possible candidate story

If you stopped today, I think Forge already signals:

> **“This person understands deterministic verification and real-engine evaluation unusually deeply.”**

That's strong.

To signal **STRONGEST**, I'd want the repository to tell a slightly different story:

```text
I started with a model-generated mechanic.

I built:
- deterministic Luau/Roblox analysis
- authority/dataflow validation
- exact transaction/rollback
- real Studio runtime evaluation
- reproducible traces and proof artifacts.

Then I actually evaluated it.

The eval caught model bugs.

It also caught MY bugs:
- invalid host typing
- brittle ABI matching
- a harness readiness race
- happy-path tests bypassing production behavior
- overly prescriptive mechanic semantics.

I didn't tune around them.

I promoted them into regressions.

Then I redesigned the harness so:
- models own implementation/game design;
- project facts are discovered;
- universal safety policy remains deterministic;
- task success is outcome-based;
- Studio executes real gameplay;
- subjective game quality gets an independent evaluator;
- production/eval failures become Harbor tasks.

Then I ran multiple models and harness variants
against the exact same tasks and measured what actually improved.

Finally I gave the system a game it had never seen:
"build me a round-based zombie survival game"

and let the general harness build/evaluate it incrementally
without a handwritten zombie contract.
```

**That** signals the person in the Lemonade job posting.

Not because Forge looks exactly like Lemonade.

Because it demonstrates that you can walk into Lemonade and do the work they describe:

```text
observe agent failures
        ↓
understand whether failure came from:
model / context / tool / harness / grader / runtime
        ↓
design a representative eval
        ↓
replace subjective checks with deterministic ones where honest
        ↓
keep model-dependent flexibility where necessary
        ↓
run controlled experiments
        ↓
change the harness
        ↓
prove the failure class went away
        ↓
do it again
```

And this is where I would make one non-obvious recommendation:

> **Do not hide Forge's architectural mistakes from Nicolas. Feature them.**

The Luna false rejection is excellent.

The Sell Heartbeat/harness blind spot is excellent.

The rollback bug from M3 is excellent.

Those stories prove you don't treat eval output as gospel. You inspect trajectories, question your verifier, distinguish infrastructure noise from model behavior, preserve history and make your measurement system better. Your real Studio ledger already documents that one early runtime exploit run exposed both a semantic-analyzer defect and a rollback defect; Forge fixed both and then reproduced a correct fail-closed run. fileciteturn0file13

That is much more compelling to someone hiring a Founding AI Engineer than:

> “My demo passed every time.”

The job does not ask for a demo engineer.

It asks for someone who can make an AI creation system **reliably better over time**.

My concrete priority order from here would be:

```text
NOW
│
├── Semantic authority / provenance refactor
│
├── General agent harness
│      planner → tool-using builder → evaluator
│
├── CoreLoopBench → Harbor
│
├── Real model × harness experiments
│
├── Generic Studio gameplay test capabilities
│
├── Failure promotion pipeline
│
├── unseen zombie-game capability eval
│
├── one long-horizon run
│
└── Fly/Docker execution once the workload justifies it

LATER
│
├── asset-provider sophistication
├── capsules
├── routing
├── product UI
└── 2D/3D model research
```

The deepest change is this:

> **Forge should not be the thing that knows how every game works. Forge should be the thing that makes an increasingly capable game-building agent observable, testable, falsifiable, recoverable, and empirically improvable.**

That is a far more scalable architecture.

And based on the job description, it is also a much more direct signal that you are not merely a good hire for Lemonade's Founding AI Engineer role—you understand the actual problem they are hiring someone to own.
