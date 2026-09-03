# Forge Creator Experience

Status: final-product experience specification, grounded in the current
existing-project, evidence, transaction, verification, and recovery contracts.

This document defines how Forge should feel, speak, and organize creator work
over the long horizon. It is subordinate to
[ARCHITECTURE.md](ARCHITECTURE.md), [FORGE.md](FORGE.md), and
[EVALS.md](EVALS.md). Those documents define workflow legality, semantic
authority, evidence completeness, and Studio safety. This document does not
weaken those rules to make the interface appear simpler.

The current evidence-workbench dashboard is an implementation foundation, not
the final product shape. The final product is a persistent conversation with a
project-aware agent. Exact plans, source, diffs, evidence, replay, and recovery
remain available as an audit layer behind that conversation.

## North star

Forge should feel like returning to a Roblox collaborator who knows the project,
remembers the decisions that matter, can inspect the current place before
speaking, and never pretends that an unobserved result is true.

The product promise is:

> Open any valid Roblox place, tell Forge what you want, work through it with an
> agent that knows the project, test the result in Studio, and keep a durable
> record of every decision and proof.

The desired ease is Lemonade-like: prompt first, clear agent presence, inline
plans and approvals, ordinary Play as the test boundary, and a conversation that
continues after one build finishes. Forge's distinct value is that this simple
surface is backed by complete existing-project indexing, source intelligence,
transactional mutation, explicit evidence, provider-free replay, and visible
recovery.

This is inspiration, not imitation. Forge does not copy Lemonade's brand,
layout, voice, or visual identity.

## What “an agent you know” means

The agent relationship is built from durable, inspectable continuity—not a
claim of human memory.

The agent should retain:

- the project's accepted goals, vocabulary, architecture, and conventions;
- creator-stated preferences that were explicitly saved;
- accepted and rejected changes, including the creator's final reports;
- source areas and dependency closures previously consulted;
- unresolved questions, deferred work, and known evidence gaps;
- the latest complete Studio revision and later creator-edit notifications.

The agent must distinguish:

- **current project fact:** read from the latest complete Studio index;
- **static-analysis result:** derived from hash-verified source;
- **prior decision:** preserved in an accepted or rejected work episode;
- **creator preference:** explicitly stated or corrected by the creator;
- **agent inference:** a hypothesis that may be wrong;
- **machine observation:** produced by a complete bound evidence envelope;
- **creator observation:** written in the creator's report.

Project memory is reviewable. The creator can inspect, correct, pin, or forget a
remembered preference. Forge never stores hidden evaluator material as memory,
never treats a rejected proposal as project truth, and never uses an old project
fact when a newer complete revision disagrees.

## Experience principles

1. **Conversation is the product.** Requests, project exploration, plans,
   revisions, progress, decisions, playtest guidance, results, and recovery form
   one chronological project conversation.
2. **The open Studio place is the source of project truth.** Forge reads the
   complete current place and current Script Editor contents before planning.
3. **The agent explains what it learned.** Important source and project facts
   appear as concise citations, not an unexplained assertion of understanding.
4. **Authority appears at the decision.** Approvals and destructive actions are
   embedded in the exact conversation card they authorize.
5. **The useful answer leads; proof remains one step away.** Plans, changed
   objects, source diffs, failed checks, and next actions come before hashes,
   projections, receipts, and raw JSON.
6. **Manual creator work is respected.** A creator edit makes stale work visible
   and offers refresh-and-replan. Forge never silently merges or overwrites it.
7. **Mismatch and missing evidence are different experiences.** Complete facts
   that prove a behavior wrong are failed checks. Missing or unreadable required
   facts are incomplete evidence.
8. **The happy path is calm.** A successful build does not feel like monitoring
   a distributed system. Technical complexity becomes prominent only when it
   changes a decision or recovery path.
9. **Recovery is explicit.** Restart and transport loss never trigger an
   implicit provider retry, Apply, commit, cancel, rollback, or Play re-arm.
10. **The creator chooses the engine.** The selected model is visible before a
    turn begins, remains fixed for that turn, and never changes through a silent
    fallback.
11. **One product path.** The conversation shell replaces the evidence
    workbench as the primary route. The old workbench is not preserved as a
    second mode.

## Current foundation and target boundary

The codebase already provides the safety and evidence foundation for the final
experience:

- loopback Studio bridge and separate creator control server;
- one-time dashboard launch grant and host-only session cookie;
- complete sharded project indexing with content-addressed source blobs;
- opaque identities for pre-existing and duplicate-named Studio objects;
- current Script Editor source reads and hash-guarded source edits;
- source search, paged reads, symbols, references, and dependency traversal;
- immutable source-consultation evidence;
- dirty-project detection and explicit refresh with predecessor/successor
  sessions;
- exact plan and change approval;
- detached preflight, provisional Apply, direct readback, state-delta
  reconciliation, and guarded finalization;
- silent arming of ordinary Studio Play, direct observation, explicit retry,
  and creator review;
- optional single-writer Rojo source authority and Studio sync proof;
- immutable artifacts and provider-free mutation/verification replay;
- restart-safe recording recovery.

The current dashboard presents those contracts as a three-column evidence
workbench using `PromptComposer`, `SessionHistory`, `EvidenceSpine`,
`ArtifactWorkbench`, `SourceExplorer`, `CapabilityExplorer`, and
`StudioConsentDock`.

The following final-product capabilities do not exist yet and must not be
implied by current UI:

- a durable multi-turn conversation read model;
- free-form plan refinement within one continuing thread;
- project and creator memory with inspect/correct/forget controls;
- conversation-native citations to indexed source and project facts;
- a conversation shell that reconstructs its full history after restart;
- background continuation beyond the current local task lifecycle.

Until those contracts exist, one creator session still begins with one immutable
request. Current approvals and refresh successors remain the legal boundary.

## Final information architecture

The final desktop product has one project conversation and two supporting
layers:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Forge                  Orbital Freight Airlock                     Studio│
├────────────────┬───────────────────────────────────────┬─────────────────┤
│ Projects       │ Project conversation                  │ Project context │
│                │                                       │                 │
│ Door Control   │ creator request                       │ Studio health   │
│ Airlock        │ agent exploration + source citations  │ current revision│
│ Status Beacon  │ inline plan + decision                │ active work     │
│                │ build activity                        │ remembered facts│
│ Threads /      │ exact changes + source diff summary   │                 │
│ milestones     │ Play guidance and result              │                 │
│                │ creator report + decision             │                 │
│                │ next creator message                  │                 │
│                ├───────────────────────────────────────┤                 │
│                │ [GPT-5.6 Luna ▾]  Message Forge…          Send         │
└────────────────┴───────────────────────────────────────┴─────────────────┘
                       Technical details opens as a drawer or full-height sheet
```

- The **project rail** lists long-lived project conversations, not raw
  transaction sessions. Milestones and failed attempts are nested history.
- The **conversation canvas** is the primary workspace. It holds creator and
  agent turns plus inline plan, change, Play, review, refresh, sync, and
  recovery cards.
- The **project context rail** shows the paired Studio project, current revision,
  index health, active work, and small inspectable memory set.
- The **composer** remains anchored to the conversation. It accepts new work,
  clarification, plan refinement, and follow-up only when the backend has a
  corresponding hash-bound turn contract. Its model selector applies to the
  next agent turn and keeps the current engine visible without turning provider
  configuration into the primary task.
- **Technical details** opens from any evidence-bearing event. It contains the
  source explorer, full plan, exact diff, API coverage, evidence graph, raw JSON,
  timing, and replay.

On narrower desktop layouts, project context becomes a drawer. On mobile, the
project rail becomes navigation, the conversation occupies the full width, and
technical details becomes a full-height sheet.

## The conversational model

The final conversation must be reconstructed from durable project and session
evidence. React may not fabricate a transcript from current status strings.

The product model has five distinct objects:

| Object               | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| project conversation | long-lived relationship around one Studio project identity    |
| conversation turn    | immutable creator or agent communication                      |
| work episode         | one bounded plan/build/apply/verify/review transaction        |
| conversation event   | durable status, decision, refresh, evidence, or recovery fact |
| project memory item  | explicit, inspectable continuity across work episodes         |

A conversation event binds to the exact project revision and, where relevant,
the exact creator session, plan, change set, evidence artifact, or control-view
hash. Ephemeral typing and animation may disappear after restart; durable
conversation history may not.

`CreatorControlView` remains the sole action-legality contract. A conversation
card can render only the primary and secondary actions present in that view.
Changing a label or moving an action into a conversational card does not permit
React to infer that the action is legal.

### Turn semantics

The final product supports four kinds of creator turn:

- **new work:** begins a new work episode from the latest complete revision;
- **clarification:** supplies requested information before a plan is published;
- **plan refinement:** invalidates the prior candidate and requests a new
  immutable plan revision without Studio mutation;
- **follow-up:** begins later work in the same project conversation after a
  terminal decision.

A free-form message never substitutes for a structured approval, rejection,
refresh, retry, recovery, or rollback action. Those remain explicit controls.

### Agent presence

Forge speaks as one consistent collaborator:

- concise and direct during routine work;
- specific about what it read and what remains uncertain;
- willing to recommend a direction and explain tradeoffs;
- calm during technical failure;
- never celebratory before the corresponding durable result;
- never personifying background work that is not actually running.

The agent should use first person sparingly and naturally: “I found the airlock
state machine in these three scripts” is useful when backed by citations. “I
remember everything about your game” is not.

### Model selection

Forge is the stable project agent; the selected model is the engine used for a
specific turn or work episode. Changing the engine must not create a second
persona, discard project memory, or rewrite which model made an earlier
decision.

The composer includes a compact **Model** selector with these initial choices:

| Display name      | Exact model ID                    |
| ----------------- | --------------------------------- |
| Muse Spark 1.3    | `meta/muse-spark-1.3-contributor` |
| GLM 5.3 Flash     | `z-ai/glm-5.3-flash`              |
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash-0731` |
| GPT-5.6 Luna      | `openai/gpt-5.6-luna`             |

`openai/gpt-5.6-luna` is the initial default because it matches the current
creator-service launch path. The list must not be hardcoded inside a React
component: the control server supplies the ordered available-model registry,
stable labels, selected default, and availability state.

Selection rules:

- the selected model is visible before the creator sends a message or starts a
  work episode;
- selection becomes immutable for the resulting AgentRun and is recorded in
  its trace and conversation event;
- changing the selector while no agent turn is active applies to the next turn;
- an in-flight planner, builder, or repair is never restarted or transferred
  because the selector changed;
- a plan refinement may use a newly selected model, but its new plan revision
  records that model explicitly;
- planner and builder use the selected work-episode model unless a future
  reviewed policy explicitly exposes separate role choices;
- model unavailability produces a directed error and preserves the unsent
  message; Forge never falls back to another model silently;
- every model receives the same authority-bounded context for its role.
  Selecting a model never expands source access, tool access, Studio authority,
  budgets, or hidden evaluator access;
- conversation continuity and project memory belong to Forge's durable host
  state, not to a provider session.

The collapsed selector shows the friendly display name. The menu shows both the
display name and exact provider/model ID so a technical creator can distinguish
similarly named releases. Technical details records provider, model ID, role,
turn interval, token and latency evidence when available, and the exact
AgentRun.

## End-to-end conversation

### 1. Open and connect a project

The creator starts `forge creator serve`, opens the one-time dashboard URL, and
opens the Forge connector beside any platform-valid Studio place.

The header communicates the ordinary state in creator language:

- **Studio ready** when project, connector, manifest, attestation, and durable
  transaction inventory are compatible;
- **Connecting to Studio** while those checks are pending;
- **Studio connector needs an update** when build or manifest identities differ;
- **Studio needs attention** when a retained recording or finalization receipt
  requires exact recovery.

Pairing is not mutation consent.

### 2. Ask for a change

The empty conversation asks:

> What do you want to make?
>
> Describe a feature, fix, or change for the open Studio project.

The creator's message is preserved exactly. Forge collects a complete project
index before the planner proposes anything. During a long collection, one
activity event explains that Forge is reading the project; the interface does
not append polling chatter or invent a percentage.

Before sending, the creator may choose the model for this work episode from the
composer. The resulting request event shows that choice as quiet metadata so
later history accurately attributes the plan and build.

### 3. Explore the existing project

The agent can search and read hash-verified source, inspect symbols and
references, and traverse static dependencies before choosing what should
change. The conversation shows only the important result:

> I found the server authority in `AirlockService`, the shared state contract in
> `AirlockTypes`, and the client display in `AirlockController`.

Each cited path opens the exact indexed source range and source hash in
Technical details. Dynamic or unresolved dependencies remain visibly
unresolved; Forge does not guess.

Static analysis is labeled as code understanding, never machine-observed
gameplay.

### 4. Review and refine the plan

The plan card answers:

1. What will change?
2. Why these parts of the project?
3. How will Forge check the result?
4. What will still require creator judgment?

The collapsed view stays concise. **View full plan** opens exact paths,
initialization commitments, source consultation, output-check coverage, and
charter clauses.

Target actions are:

- **Build this**;
- **Change the plan**;
- **Don't build this**.

**Change the plan** requires a new durable plan-revision contract. It cannot be
implemented as a cosmetic relabeling of current rejection.

### 5. Build and review the exact change

One activity card updates in place while the builder works. When ready, the
change card groups operations in creator language:

- add a server script;
- update two existing modules;
- add interaction prompts;
- change three properties;
- preserve the scenery subtree.

Affected scripts open directly into a focused source diff. The creator should
not have to copy an operation ID into a technical form.

The detailed view retains exact opaque target identities, display paths,
properties, UTF-8 edits, hashes, local-gate status, mutation authority, and
projected readback obligations.

Target actions are **Apply changes** and **Don't apply**.

### 6. Handle creator edits

If the creator changes Studio while Forge is planning or waiting for approval,
the conversation receives one **Project changed** event. It explains what is
stale and offers **Refresh project**.

An unchanged complete Merkle root clears the advisory notice. A changed root
records the delta and starts a successor work episode with the same creator
goal but no inherited plan, consultation, approval, change set, or action
authority. The technical session boundary is visible in history without
splitting the creator's project conversation.

Activity during a possible Forge recording enters recovery instead of refresh.

### 7. Apply provisionally

The successful path is one approved operation from the creator's perspective:

1. Forge rechecks the exact project revision.
2. Studio performs detached capability preflight.
3. Studio opens one ChangeHistory recording.
4. The approved change is applied provisionally.
5. Forge persists direct readback and a complete post-apply project index.
6. Pure reconciliation proves whether the approved delta matched.

The conversation shows one activity event, followed by **Changes applied** only
after complete matched evidence. Mismatch and incomplete evidence produce
different cards and never commit.

### 8. Test with ordinary Play

After matched provisional Apply, Forge silently arms the next ordinary Studio
Play session. The creator presses Play, performs the interaction, and presses
Stop.

The Play card has four truthful moments:

- **Ready to test:** the provisional mutation matched and the next Play is armed;
- **Waiting for Play:** Studio has not reported runtime start;
- **Watching your test:** the exact runtime-start lifecycle message arrived;
- **Checks complete:** Stop sealed a pass, behavioral failure, or incomplete
  technical result.

Forge does not show invented live fact progress. Creator-only checks are labeled
**Check this yourself**. Visual quality, client-only behavior, causal experience,
and unsupported interaction claims remain creator judgment.

Outcomes:

- complete pass advances to commit;
- complete behavioral failure follows the bounded cancellation-and-repair path;
- incomplete technical evidence preserves the provisional recording and offers
  **Try the test again** and **Undo changes**;
- uncertain recording state enters visible recovery.

Retry is explicit. Forge never silently re-arms after an incomplete Play.

### 9. Review and decide

After exact commit acknowledgement and matching post-commit state, the final
card asks:

> How did it feel?

The creator writes a required 1–4096-byte report. Approved creator-review
prompts appear as suggestions, not machine assertions.

Target actions are **Keep changes** and **Undo changes**. The same report is
required for both. The report is creator-authority evidence and is never parsed
into machine-observed claims.

### 10. Continue the relationship

After the decision, the composer remains available for a follow-up in the same
project conversation:

- “Make the warning lights less intense.”
- “Now add a second airlock using the same server state machine.”
- “Explain why you put this module in ReplicatedStorage.”
- “I changed the controls myself—read the project again.”

Each new work episode starts from a fresh complete index. Prior context helps the
agent orient itself, but current project evidence wins over memory.

### 11. Export the place

An accepted Studio transaction is not yet a host filesystem output. The
terminal card says:

> The accepted result is in Studio. Use **File → Save to File**, choose a new
> destination, and save as `.rbxlx`.

Forge does not claim a place file exists until the creator performs that Studio
action.

## Optional Rojo source conversation

The default `studio_document` authority treats the open place as the writer,
regardless of its origin.

When the creator explicitly launches Forge with a verified
`--project-authority` manifest, mapped Luau source may use `rojo_source`.
Generic instance/property work remains Studio-owned, and one work episode has
exactly one mutation authority.

After a guarded filesystem write, the conversation shows **Waiting for Studio
sync** rather than claiming success. It offers **Check Studio sync** and, only
when exact post-write hashes permit it, **Revert source changes**. Forge never
starts Rojo live sync or presents mixed Studio/filesystem work as atomic.

## Conversation cards

### Creator message

Preserve the creator's authored line breaks. Show its time and project-revision
boundary on demand, not as noisy default metadata.

### Agent exploration

Summarize what Forge inspected and why it matters. Source citations open exact
immutable ranges. Do not dump tool transcripts into the conversation.

### Plan

Lead with the outcome, changed systems, check strategy, and creator-review
boundary. Full charter and consultation details are secondary.

### Changes

Summarize creates, edits, moves, deletes, and source changes. Show affected
scripts and risk-relevant properties. Exact operations and proof obligations
remain inspectable.

### Activity

One card updates in place for indexing, planning, building, preflight, Apply,
Play observation, repair, cancellation, commit, refresh, or source sync. It may
show elapsed time when useful but never synthetic completion percentage.

### Playtest

Show what to try, when Play actually starts, what Stop sealed, which checks were
machine-observed, and which remain creator-reviewed.

### Project changed

Explain that Forge noticed an edit, what work became stale, and what explicit
refresh will do. Show predecessor, delta, and successor in Technical details.

### Final review

Collect the required report beside the exact keep/undo decision. Preserve the
approved creator-review prompts as writing aids.

### Recovery

State:

1. what Forge knows;
2. what remains uncertain;
3. whether Studio might contain an open provisional change;
4. the one exact legal action, if any.

Only a freshly proven exact open recording may expose **Undo interrupted
changes**.

## Target terminology

Internal names remain valid in code and Technical details. The primary
conversation uses creator language.

| Internal concept            | Conversation term                       |
| --------------------------- | --------------------------------------- |
| complete project index      | project read / current project revision |
| source consultation         | code Forge inspected                    |
| plan approval               | Build this                              |
| change approval             | Apply changes                           |
| mutation projection         | exact changes Studio must prove         |
| preflight                   | checking Studio compatibility           |
| provisional mutation        | changes applied, not final yet          |
| matched reconciliation      | Studio matches the approved changes     |
| creator verification arm    | ready to test                           |
| runtime lifecycle started   | watching your test                      |
| incomplete runtime evidence | Forge couldn't confirm everything       |
| refresh successor           | refreshed work episode                  |
| `awaiting_source_sync`      | waiting for Studio sync                 |
| creator review report       | what you observed                       |
| provider-free replay        | recheck saved evidence                  |
| recovery cancellation       | undo interrupted changes                |

Technical words such as artifact, attestation, manifest, projection, mutation,
reconciliation, receipt, binding, hash, and replay belong in Technical details
unless the technical distinction itself changes the creator's decision.

Action labels are coordinator-produced and included in the control-view hash.
The final conversational labels must therefore be implemented in the
coordinator contract, not translated opportunistically in React.

## Technical details

Technical details retains Forge's full auditability:

- complete project-index identity, health, roots, counts, bytes, and artifacts;
- current editor-source hashes and chunk manifests;
- source search, reads, symbols, references, and dependencies;
- exact source consultation and unresolved edges;
- full plan, charter, build contract, and output-check coverage;
- exact operation list and source edits;
- Studio manifest, connector build, capability coverage, and attestation;
- preflight, direct readback, before/after delta, and reconciliation;
- runtime plan, facts, diagnostics, and creator-only claim boundary;
- agent runs, provider turns, tool calls, timings, and build traces;
- finalization, checkpoint, creator report, and recovery receipts;
- mutation and verification replay.

Raw JSON is lazy-loaded. Monospace is reserved for source, paths, hashes,
timings, identities, and compact data. Every technical view links back to the
conversation event it supports.

The current `SourceExplorer` and `CapabilityExplorer` become views inside this
layer. Source-edit cards link directly to their sealed diff; creators should not
need to copy operation IDs manually.

## Truth and evidence boundaries

| Evidence                          | May support                                                                    | May not claim                                          |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| project index                     | indexed structure, covered properties, attributes, tags, current source hashes | unsupported property preservation or gameplay behavior |
| source analysis                   | facts about hash-verified text, symbols, references, and static dependencies   | code execution or runtime correctness                  |
| local gate                        | syntax, static policy, and bounded host checks                                 | Studio mutation or Play success                        |
| direct readback and project delta | exact provisional mutation postconditions                                      | player-visible experience                              |
| runtime evidence                  | sealed, projection-bound Play Server facts and diagnostics                     | client-only visuals or creator intent                  |
| creator report                    | what the creator says they observed and decided                                | machine or Studio facts                                |
| project memory                    | prior accepted decisions and explicit preferences                              | current facts contradicted by a newer revision         |

Complete evidence that disagrees with the expected result is a replayable
failure. Missing, duplicated, extra, unavailable, read-error, invalidly ordered,
stale, or tampered required evidence is incomplete and cannot receive an
invented verdict.

## Failure and recovery writing

Every failure card answers, in order:

1. What stopped?
2. Did Studio remain unchanged, stay provisional, commit, or become uncertain?
3. What can the creator do now?
4. Where is the exact technical evidence?

Use a human consequence before a technical code:

- **Forge couldn't finish the plan**, then the precise planner boundary;
- **These changes did not pass the local checks**, then the rejected gate;
- **Forge couldn't confirm everything**, then missing or unreadable Play facts;
- **Studio connector needs an update**, then the build/manifest mismatch;
- **Reconnect Studio to safely finish this change**, then the retained
  transaction detail.

Do not apologize, celebrate prematurely, hide a meaningful failure behind
“Something went wrong,” or place an unbounded stack trace in the primary card.

## Visual direction: Night Blueprint

The final surface combines a focused creative workspace with the precision of
an engineering drawing. The conversation lives in a dark Studio-like shell;
evidence opens as crisp, light blueprint sheets. This carries the current
evidence-workbench identity forward without making the audit UI the whole
product.

### Palette

| Token         | Value     | Use                                           |
| ------------- | --------- | --------------------------------------------- |
| Night         | `#0B1018` | application canvas                            |
| Slate         | `#131C29` | project rail, context rail, recessed cards    |
| Paper         | `#E7EDF2` | plans, diffs, evidence sheets                 |
| Blueprint     | `#5E82F3` | creator authority, focus, links, active state |
| Forge copper  | `#C86B32` | agent activity and restrained warmth          |
| Verdict green | `#2D7B68` | proven completion and healthy Studio state    |

Failure red `#B44750` is semantic, not a brand accent. Every semantic color has
a text or icon companion.

### Typography

- Spline Sans Variable remains the interface and conversation family.
- IBM Plex Mono is reserved for source, paths, hashes, timings, and evidence
  metadata.
- Agent messages use weight and spacing—not a novelty typeface—to establish a
  recognizable voice.
- Body copy stays within a readable conversation measure rather than spanning
  the full desktop canvas.

### Signature: the evidence seam

The current five-stage evidence spine becomes a vertical **evidence seam**
running through the conversation. Request, plan, change, Studio, and review
events attach to it with their real authority color. Ordinary discussion sits
beside the seam without pretending to be an approval or proof event.

The seam makes a long conversation navigable and preserves Forge's defining
idea: every important claim has an owner and a place in the chain.

### Shape and motion

- Creator messages are compact and direct; Forge work appears as structured
  cards, not a wall of identical chat bubbles.
- Plans and evidence sheets use crisp borders and restrained depth.
- The active evidence joint receives one blue-to-copper pulse when a real phase
  changes. It never simulates percentage progress.
- Success uses one short settle animation. Failure and recovery do not shake,
  flash, or demand attention through motion.
- `prefers-reduced-motion: reduce` removes travel, shimmer, smooth scrolling,
  and transform-based transitions.

## Accessibility and responsive behavior

- Preserve visible focus on every control, citation, disclosure, and source
  body.
- Use semantic buttons, headings, lists, forms, dialogs, and status regions.
- Announce one bounded durable event without rereading the full conversation.
- Do not rely on color, motion, or position alone.
- Return focus to the originating event when Technical details closes.
- Keep touch targets at least 44 px in both dimensions.
- Support browser zoom, long prompts, long paths, and long reports without
  clipped actions or horizontal page scrolling.
- Keep final actions reachable without covering the creator report.
- Preserve the last durable conversation when the control API is temporarily
  unavailable.

## Frontend data and event rules

The current module-level store, `useSyncExternalStore`, single SSE invalidation
source, and one-refetch-per-invalidation behavior remain. The redesign must not
open one event stream per card.

The final product needs a durable coordinator-produced conversation read model.
It should include:

- project conversation identity and current Studio project identity;
- ordered immutable turns and workflow events;
- exact project revision at each event;
- work-episode and predecessor/successor relationships;
- evidence attachments and source citations;
- current activity;
- inspectable project memory;
- ordered available models, current next-turn selection, and immutable model
  attribution on every agent-authored event;
- the current canonical `CreatorControlView`.

The read model is presentation data, not alternate workflow authority. The UI
may render history and memory from it, but may render a state-changing action
only from the exact current control view.

## Current-to-target component cutover

| Current component    | Final responsibility                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PromptComposer`     | `ChatComposer` with model selection and real new-work, clarification, refinement, and follow-up turn contracts |
| `SessionHistory`     | project conversation rail with nested work episodes                                                            |
| `EvidenceSpine`      | vertical evidence seam inside the conversation                                                                 |
| `ArtifactWorkbench`  | inline plan/change/Play/review cards plus Technical details                                                    |
| `StudioConsentDock`  | compact project context and inline hash-bound decisions                                                        |
| `SourceExplorer`     | Technical details source browser and citation target                                                           |
| `CapabilityExplorer` | Technical details Roblox API and connector-health view                                                         |
| `DashboardNotice`    | bounded conversation-level connection, incomplete, and recovery event                                          |

This is a clean replacement. Do not retain the old evidence dashboard as a
parallel route or introduce old/new conversation schemas.

## Implementation sequence

1. **Durable conversation read model.** Reconstruct current request, plan,
   change, decisions, status, refresh, Play, review, and terminal events from
   the existing evidence graph without changing legality.
2. **Conversation shell and model registry.** Replace the workbench layout with
   project rail, conversation canvas, compact context rail, composer, model
   selector, and Technical details. Serve the ordered model registry and bind
   the selected model to every new AgentRun.
3. **Evidence-native cards.** Move current plan/change/mutation/verification
   presentations into inline cards; link source citations and diffs directly.
4. **Project continuity.** Group refresh successors, repair attempts, and later
   requests into one project conversation while retaining exact work episodes.
5. **Plan clarification and revision.** Add explicit immutable turn and plan
   revision contracts; only then enable free-form refinement before approval.
6. **Inspectable memory.** Add project and creator preference memory with
   provenance plus inspect/correct/pin/forget controls.
7. **Long-running continuity.** Persist activity and resumable agent work before
   implying that Forge continues while the local process is absent.
8. **Terminal output guidance.** Make Studio Save to File and source-sync output
   boundaries visible in the final conversation.

Each phase replaces its superseded surface outright. No compatibility reader,
dual UI path, or status-derived action logic is added.

## Acceptance criteria

The final creator experience is complete only when:

- a creator can return after days or weeks and understand what happened, what
  the agent remembers, and what the project currently contains;
- any platform-valid open place can enter the conversation without prior Forge
  metadata;
- the agent can inspect unfamiliar source before proposing a plan and cite what
  it consulted;
- the creator can select any available initial model, see the choice before
  sending, and recover an unsent message if that model is unavailable;
- every AgentRun and agent-authored conversation event records the exact model,
  with no silent fallback or in-flight model change;
- plan refinement is real, immutable, revision-bound, and does not mutate
  Studio;
- creator edits produce an understandable refresh event rather than stale
  overwrite or silent merge;
- every displayed state-changing action comes from the exact hash-bound
  `CreatorControlView`;
- the happy path reads as ask → plan → apply → Play → review → continue;
- complete failure and incomplete evidence remain visibly different;
- machine checks, static analysis, prior memory, and creator observations retain
  separate authority;
- recovery never implies an automatic Studio mutation;
- the full plan, source, diff, evidence, diagnostics, timings, hashes, and replay
  remain accessible without dominating the conversation;
- the creator can inspect, correct, pin, and forget remembered preferences;
- the terminal view explains the Studio `.rbxlx` Save to File boundary;
- loading, empty, unpaired, active, incomplete, recovery, terminal, and API
  error states work by keyboard, under reduced motion, at narrow widths, and
  with long content;
- the old workbench is removed rather than retained as a second route.

## Non-goals

- copying Lemonade's brand or exact interaction design;
- presenting different models as separate project agents or silently routing a
  turn to an unselected fallback;
- pretending the current immutable single-request session is already a durable
  multi-turn conversation;
- turning remembered inference into project fact;
- executing project source to understand it;
- presenting static analysis as runtime proof;
- silently merging creator edits into approved work;
- inferring Rojo authority from an opened place;
- claiming mixed Studio/filesystem mutations are atomic;
- moving creator workflow controls back into the Studio plugin;
- automatically pressing Play, Stop, Save to File, commit, cancel, or rollback;
- hiding evidence incompleteness or recovery for a smoother-looking path;
- making the Roblox API catalog the creator's primary workspace.

## Related rationale and references

- [Existing-project intelligence and refresh](research/existing-project-intelligence.md)
- [Execution isolation boundaries](research/execution-isolation-boundaries.md)
- [Mutation reconciliation](research/mutation-reconciliation.md)
- [Studio capability completeness](research/studio-capability-completeness.md)
- [Lemonade](https://lemonade.gg/)
- [Lemonade Roblox Developer Forum walkthrough](https://devforum.roblox.com/t/ai-gameday-with-lemonade-day-1-herding-cats/4083155)
