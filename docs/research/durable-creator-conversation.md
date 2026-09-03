# Durable Creator Conversation

## Dashboard refresh and outcome publication, 2026-09-04

The user's subsequent DeepSeek run completed planning successfully, but the
dashboard remained on a stale running view. The exact identities are conversation
`creator_conversation_2d202b8f51000c9bd7311cc2`, job
`creator_job_089393d5-39f6-4594-a1cd-f67c97b2f23b`, session
`creator_session_c331e03d-656a-442c-b1af-2cfaaf38b275`, AgentRun
`agent_run_e559d3ed-41a0-4cb1-acd0-4fdd34aded76`, and trace
`trace_bec5f0f0-f5e4-41be-b764-df250260baf6`. The run used
`deepseek/deepseek-v4-flash-0731`, took 161,761 ms from
2026-09-03T22:41:14.688Z to 22:43:56.449Z, and made 10 model turns and 25 tool
calls. It recorded 369,132 input tokens, 35,355 output tokens, and $0.013685175168.
It is `locally_eligible`, classification `none`, with a sealed planner outcome;
no writes, verifier calls, or Studio evaluation occurred.

One proposal was rejected with `PLAN_INSPECTION_NOT_OBSERVED`; the agent inspected
the missing objects and successfully proposed its plan. This was a recoverable
tool error. The full 977-byte error was incorrectly placed into an activity
field limited to 240 UTF-8 bytes. The authenticated state endpoint returned HTTP
200, but `assertCreatorDashboardState` rejected it with **Invalid agent step
detail**. Every later update included the same step, freezing the browser's last
accepted state. The previous query-loop correction introduced this mismatch.

Three boundary corrections now cover the incident:

- Activity text uses one shared 240-byte limit and truncates only at Unicode
  character boundaries. Structured tool errors show their explanation instead
  of the full object/path payload. Raw evidence remains unchanged.
- Global settings and navigation action authorities no longer force internal
  running events into the transcript. The current context-preparation message
  is also plain language. Real conversation actions such as Resume remain
  attached to their exact authorizing event.
- Successful outcome publication now uses the artifact store's canonical
  serialization, including its trailing newline. The original validator
  hashed JSON without that newline, producing **Creator agent outcome artifact
  binding mismatch**. The next publication boundary also invented an outcome
  attachment ID from its file hash; it now uses the outcome's actual ID and
  semantic hash. The conversation store continues enforcing both identities.

All 139 original artifact files matched their content hashes and all 80 journal
entries loaded. The terminal journal entry hash is
`a2eaad23ba6956318e45d83ecdd4fdae84846d2eedb2f0fc5785938784d4bd69`.
The outcome ID is `creator_agent_outcome_03f65e12b3bb158ac96a63b5`, semantic hash
`03f65e12b3bb158ac96a63b53e237df096e97671c0a0eefefd4b8b32a9c49255`, and artifact
hash `4b2d73c7e86720e18f5b7a8e69546d4ae742f225b79964510b8c05cb791c5b42`.
The saved plan, `creator_plan_e7d4f6e656fad6ef093891a2`, contains six steps and
20 proposed creates. It has not been built or applied.

The exact evidence was replayed in an isolated copy at
`/var/folders/76/2lc82tt94msdt45f439zns8h0000gn/T/forge-dashboard-incident-uK3oBz/creator`.
The reconstructed session passed `loadCreatorBundle`, and the normal conversation
publisher appended an agent turn and plan revision, reaching
`awaiting_plan_decision`. The repaired activity projection also passed the full
browser contract against the captured production response. No original head,
job, session, artifact, or journal was rewritten; the running service was not
interrupted. This verifies the publication fix without a provider retry or
Studio operation. The original failed conversation still needs an explicitly
coordinated recovery or a fresh user request after service restart; offline
publication is not a claim that the live conversation was repaired.

Validation from `/Users/mawawdi/Desktop/forge`:

- `npm run build`, `npm run runtime-build:check`, `npm run dashboard:build`,
  and `npx tsc --noEmit -p tsconfig.json` from `dashboard`: passed.
- `node --test dist/test/*.test.js`: **342 passed**, zero failures or skips.
  Regression tests exercise real artifact serialization, actual conversation
  attachment validation, and the complete dashboard contract for structured
  errors and multibyte activity text.
- `npm run dashboard:test`: **48 passed** across nine files, including settings
  and navigation actions attached to an internal running event.
- `npm run dashboard:acceptance`: **18 passed**, 18 existing layout skips.
  The first run had ten failures because screenshot baselines were absent.
  After inspecting generated desktop, settings, working, and mobile images,
  the normal acceptance command passed with the generated baselines.
- `npm run plugin:test`: parse, analyzer, native UI analysis, module tests,
  and Studio identity authority vectors passed.
- `node scripts/check-rojo-builds.mjs`: pinned Rojo 7.7.0 built the plugin and
  all three examples into temporary output.
- Targeted ESLint and Prettier checks, `git diff --check`, and
  `npm run docs:check`: passed. Docs checked 21 Markdown files and three diagrams.
- `npm run plugin:build` materialized
  `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, 742,151 bytes,
  SHA-256 `a3e0789ecd70a89447e5e80ef766fa33e115737859be87af746c735ad8c07a78`.
  The connector bytes are unchanged by this host-side correction.

No real model calls or Studio operations were made during this correction.
The current service still has the old Node modules loaded. From its configured
terminal, stop it with Ctrl+C and run:

```sh
cd /Users/mawawdi/Desktop/forge
node bin/forge.js creator serve --default-model deepseek/deepseek-v4-flash-0731
```

Reload the browser to load the corrected activity and transcript rendering.
Restarting does not republish the old failed job's saved plan. Its isolated
publication proof above remains distinct from live recovery. For a new live
planning check, use the exact place and click sequence in the prior incident
section; a plan should appear for review before any build or Apply action.

## Planner query loop, 2026-09-04

The user-run GPT-5.6 Luna incident belongs to conversation
`creator_conversation_f6fb505e35474543ef25b062`, job
`creator_job_a7213775-4d6a-4c0f-a4fc-e4eba7b68101`, session
`creator_session_dfe9b2e3-a807-4100-835a-5f20d2f0382c`, AgentRun
`agent_run_c0baa2a7-13a3-46fc-944e-8bf131be744c`, and trace
`trace_4b7402c7-36a6-4834-9c2b-0f5b013c4346`. It ran from
2026-09-03T21:24:36.413Z to 21:25:31.411Z (54,998 ms), with 15 provider
responses and 39 tool calls. Attribution is `openai/gpt-5.6-luna` served by
OpenAI. Recorded usage is 171,056 input tokens, 1,971 output tokens, and
$0.00902086. No budget was exhausted; no write, verifier, or Studio run occurred.

Every project search fabricated a nonempty cursor, and every children query
supplied both `parentObjectId` and `rootPath`. Those 34 queries failed with
`PROJECT_CURSOR_STALE` or `PROJECT_PARENT_INVALID`; the remaining five API
lookups combined multiple member names into a single literal phrase and returned
no entries. The runtime correctly stopped an identical repeated batch with
`REPEATED_NO_PROGRESS_TOOL_BATCH`. The AgentRun remains `incomplete`, classified
`agent_failure`, with unsealed `creator_outcome`, detail hash
`ac6e9ea440581393d851902ad576fe4c09afc993ff55e1488380caa52ad97630`, and attempt
hash `c02cfcb94883a238708e5040789f8a2184bd595cdc902ace5a40e57ecd4b97e3`.
The journal has 124 entries. Its terminal entry hash is
`0f337a29f73b1eb25b68f85566c0887f68355c0657822ba6348d942e647971a2` and
terminal result hash is
`70dc68034595a5b7535455b23fa8f0bf4a662bbeb1b04e51f39376ecffc813da`.
All 187 saved artifacts were checked against their SHA-256 filenames, with
zero mismatches. Original failed evidence is preserved unchanged.

The saved native schemas correctly marked these fields optional, but did not
represent absence with null. The installed `@openrouter/ai-sdk-provider` 3.0.0
does not forward the AI SDK per-tool `strict` flag. The exact downstream request
and schema transformation inside OpenRouter are not in the trace, so strict
normalization is a contributing-cause inference, not an observed provider fact.
[OpenAI's function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
states that Responses may normalize schemas when strict is omitted and that
explicit `strict: false` preserves optional fields. The transport now sends that
setting explicitly using the adapter's call-level passthrough, without changing
the native argument format or silently repairing invalid model arguments.
Tool descriptions and rejection feedback explain omitted first-page cursors,
exactly one parent selector, and one literal API search phrase per call.

The conversation publisher previously masked this cause as
`agent_outcome_missing`; it now retains the runtime failure code and bounded
reason on every planner completion/recovery path. Journal-derived activity
shows failed-tool details even for this original failed run. Terminal events
are titled **Work result**, since a failed planner result is not a Studio result.
These fixes do not change the read-only planner or the subsequent approval flow.
Zero edits alone is normal during planning; the failure here is rejected
inspection followed by termination before a plan, answer, or clarification.

Validation from `/Users/mawawdi/Desktop/forge`:

- `npm run build`, `npm run runtime-build:check`, `npm run dashboard:build`,
  and `npx tsc --noEmit -p tsconfig.json` from `dashboard`: passed.
- `node --test dist/test/*.test.js`: **340 passed**, zero failures or skips.
  The new provider fixture inspects the actual SDK-produced HTTP body, then
  executes omitted-field first pages and returned cursors through the real
  planner tools. Invented cursors and conflicting parents remain rejected.
- `npm run dashboard:test -- --run`: **47 passed** across nine files.
- `npm run dashboard:acceptance`: **18 passed**, 18 existing layout skips.
- `npm run plugin:test`: parse, analyzer, native UI analysis, module tests,
  and Studio identity authority vectors passed.
- `node scripts/check-rojo-builds.mjs`: pinned Rojo 7.7.0 built the plugin and
  all three examples into temporary output.
- Targeted ESLint, `git diff --check`, and `npm run docs:check`: passed.
- The new activity reader was also run read-only against the original store:
  all 124 journal entries loaded, all seven conversation events verified,
  and the resulting activity exposed 34 failed steps and the exact last error.
- `npm run plugin:build` materialized
  `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, 742,151 bytes,
  SHA-256 `a3e0789ecd70a89447e5e80ef766fa33e115737859be87af746c735ad8c07a78`.
  The connector bytes are unchanged by this host-side query fix.

The running service must be restarted to load the rebuilt host. From the same
configured terminal, stop the old service with Ctrl+C, then run:

```sh
cd /Users/mawawdi/Desktop/forge
node bin/forge.js creator serve --default-model openai/gpt-5.6-luna
```

For an isolated creator-run check, the generated place is
`/var/folders/76/2lc82tt94msdt45f439zns8h0000gn/T/forge-planner-query-review-2kqhpcss/OrbitalFreightAirlock.rbxlx`
(16,115 bytes). It was produced with:

```sh
.forge/tooling/source-analysis/lock-49699a17a8536fc0/darwin-arm64/bin/rojo build examples/orbital-freight-airlock/default.project.json --output /var/folders/76/2lc82tt94msdt45f439zns8h0000gn/T/forge-planner-query-review-2kqhpcss/OrbitalFreightAirlock.rbxlx
```

The user opens the place in Studio, opens **Plugins → Forge**, and clicks
**Connect** if it is not already connected. In the browser, open
`http://127.0.0.1:8788`, link the fresh project if requested, and choose
**New conversation**. Send: “Inspect Workspace/OrbitalFreightAirlock and propose
a plan to make the airlock server-authoritative. Do not build yet.” Successful
inspection followed by a plan is the next smallest live proof; no build or
Apply action is needed for that check. The existing place may be used instead
if retaining the original conversation context is preferred.

No real model calls or Studio operations were made during this correction.
Downstream provider behavior and a successful live planning result after the
fix remain unverified until the user performs that check.

## Review corrections, 2026-09-04

An unconfirmed browser message now retains its original request independently
of later turn contracts. **Retry message** resends the same body and idempotency
key, including while the current conversation has no send contract. A normal
send of that unchanged draft also resolves to the retained request. Edited
drafts remain separate, and confirmation only clears a draft that still matches
the original message. Server rejection explanations use the current `message`
field.

Project activity now follows exact `resumesJob` references. Replaced jobs remain
immutable history, while the unreplaced end of each recovery chain determines
whether it still occupies the project. A queued, running, externally waiting,
or unknown replacement continues to block sibling conversations; a successful
replacement releases them. Tests cover both single and repeated recovery.

Validation run from `/Users/mawawdi/Desktop/forge`:

- `npm run build` and `npm run runtime-build:check`: passed.
- `node --test dist/test/*.test.js`: 338 passed, zero failures or skips.
- `npm run dashboard:build` and the dashboard TypeScript check: passed.
- `npm run dashboard:test`: 46 passed across nine files.
- `npm run dashboard:acceptance`: 18 passed; 18 existing layout skips.
- `npm run plugin:test`: source parse, analyzer gates, native UI analysis,
  module tests, and identity authority vectors passed.
- `node scripts/check-rojo-builds.mjs`: plugin and all three example places
  passed using pinned Rojo 7.7.0 and temporary output.
- Targeted Prettier/ESLint, `git diff --check`, and `npm run docs:check`: passed.
- `npm run plugin:build`: installed the connector at
  `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`. Its bytes
  and SHA-256 match the native connector review record below.

These corrections have no new provider or Studio result. The next live check is
to restart the rebuilt service and connector and confirm a conversation can be
continued after recovery. The native connector review steps below provide the
installed artifact and clean place paths; Studio remains creator-operated.

## Planner publication failure, 2026-09-03

This is predecessor runtime evidence consumed by the focused workspace correction.
The immutable original artifacts remain in the local creator store; they were
not rewritten or converted into a successful result.

- Conversation: `creator_conversation_5c2b0edb74a220c4fce2df16`.
- Job: `creator_job_9948a0e0-eb7e-4ad5-9237-815282089190`.
- Session: `creator_session_5c701995-dc6f-4378-abe4-00de11373a8a`.
- AgentRun: `agent_run_b857c1a5-10d5-4eff-af3e-b3e3c745d8be`.
- Trace: `trace_2a967fa2-11a6-4db8-8050-f78a9df4b40f`.
- Terminal provider response: `gen-1788464230-0ShvNtRGfD5OGW10Pshg`.
- Model: `deepseek/deepseek-v4-flash-0731`; serving provider: Baidu.
- Runtime interval: 36,086 ms; six responses; 18 tools; 101,386 input tokens;
  5,677 output tokens; recorded cost USD 0.003971030784; zero source writes.
- Response 6 stopped at `max_tokens` with exactly 4,096 output tokens.
- AgentRun status: `incomplete`; classification: `budget_exhausted`;
  unsealed failure: `RUNTIME_BUDGET_EXHAUSTED`; intended output: `creator_outcome`.
- Failure detail hash: `524d21d9f3d9c534cba41225175041cb92152cfd1cbc4ca38b96b5d116fe3bdf`.

The durable execution journal recorded the real failure. The session-bundle
validator retained an obsolete planner-kind check against `plan`; it rejected
the current `creator_outcome` before the normal incomplete episode could be
published. The dashboard therefore showed the validator exception and zero
episodes, concealing the response limit.

The correction accepts exactly the current planner outcome algebra, binds sealed
planner references to their exact outcome, and retains unsealed failures. It
raises the per-response ceiling to 32,768 while preserving the remaining total
runtime budget and explicit retry boundary. Offline regressions cover unsealed
failures, sealed answers/questions, mismatched phase and outcome rejection,
separate chat creation, and shared project preference authority. No new provider
or Studio run was made for this repair. This evidence establishes neither a
completed plan nor gameplay correctness.

### Native connector redesign review

The plugin follows the dashboard's charcoal and lavender direction. It shows
the current place, connection, actual Studio command activity, and three recent
steps. Connection controls and copyable diagnostics sit inside a dismissible
settings popup. A toolbar toggle hides the panel without disconnecting it;
narrow layouts scroll. The optional reduced-motion setting and system
preference control animation. These changes keep test and mutation authority
in the existing runtime. Recovery warnings now survive connect/disconnect
status updates instead of being replaced by a generic connected state.

The pure presentation module has regressions for connection actions, reserved
sessions, explicit invalid-data disposal, command activity, and result copy
that does not equate collected evidence with passing a test. A Rojo source map
also enables static type analysis of the native view itself.

Verification from `/Users/mawawdi/Desktop/forge`:

- `npm run build`: passed TypeScript and runtime-manifest generation.
- `node --test dist/test/*.test.js`: 337 passed, zero failed or skipped.
- `npm run plugin:test`: all plugin source parsed; analyzer gates, native UI
  analysis, module tests, and project identity authority vectors passed.
- `node scripts/check-rojo-builds.mjs`: pinned Rojo 7.7.0 built the plugin and
  all three example places into temporary output.
- `git diff --check`: passed. Targeted Prettier and ESLint passed for the new
  analysis script; `npm run docs:check` passed for 21 files and three diagrams.
- `npm run plugin:build`: installed the final connector, 742,151 bytes, SHA-256
  `a3e0789ecd70a89447e5e80ef766fa33e115737859be87af746c735ad8c07a78`.
- The exact clean-place build below passed and produced a 16,115-byte `.rbxlx`.

The static design approximation is
`/tmp/forge-plugin-review.4Vtepn/preview.png`; it is not a Studio screenshot.
No model calls or Studio operations were made. Native font metrics, docking,
keyboard focus, and animation still require the creator's review.

The exact final installation and clean-place generation commands are:

```sh
cd /Users/mawawdi/Desktop/forge
npm run plugin:build
.forge/tooling/source-analysis/lock-49699a17a8536fc0/darwin-arm64/bin/rojo build examples/orbital-freight-airlock/default.project.json --output /tmp/forge-plugin-review.4Vtepn/OrbitalFreightAirlock.rbxlx
```

The installed connector is
`/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`.
Start this checkout's service with `node bin/forge.js creator serve` after any
existing service has finished its work and been stopped in its own terminal.
Open the dashboard URL printed by that command.

The next smallest evidence-producing task requires no model request:

1. Restart Studio and use **File → Open from File** to open
   `/tmp/forge-plugin-review.4Vtepn/OrbitalFreightAirlock.rbxlx`.
2. Click **Plugins → Forge**. Check the place name, connected state, and clear
   current-activity card.
3. Open **Settings → Connection**, then **Details**. Verify copyable diagnostics,
   **Close**, and **Escape**. Switch **Motion: system** to **Motion: reduced**.
4. Dock the panel narrowly and check scrolling. Hide and reopen it with the
   toolbar, confirming that the connection is retained.
5. Return screenshots of the main view and settings at narrow width. An
   approved Play workflow is a separate live evidence task.

### Workspace verification and next live check

The 2026-09-03 workspace redesign replaces the persistent context rail with
project settings, groups independent conversations under their project, removes
the turn-kind selector, and shows actual journal steps. Shared preferences are
separate from each conversation's messages, decisions, and evidence.

Commands actually run from `/Users/mawawdi/Desktop/forge`:

| Command                                                                                                      | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `git diff --check`                                                                                           | Passed.                                                                                     |
| `npm run build`                                                                                              | TypeScript and runtime manifest passed.                                                     |
| `node --test dist/test/*.test.js`                                                                            | 337 passed; zero failed or skipped.                                                         |
| `npm run dashboard:test`                                                                                     | 43 passed across nine files.                                                                |
| `npm exec --prefix dashboard tsc -- --noEmit -p dashboard/tsconfig.json`                                     | Passed.                                                                                     |
| `npm run dashboard:build`                                                                                    | Passed.                                                                                     |
| `npm --prefix dashboard run test:acceptance -- --update-snapshots`                                           | Updated reviewed layout baselines.                                                          |
| `npm --prefix dashboard run test:acceptance -- --project=desktop --grep 'reduced-motion' --update-snapshots` | Fixed the elapsed-time clock in the zoom baseline.                                          |
| `npm --prefix dashboard run test:acceptance`                                                                 | 18 passed, zero failed; 18 redundant layout cases explicitly skipped.                       |
| `npm run plugin:test`                                                                                        | Luau parse/analyze, module tests, and project identity authority vectors passed.            |
| `node scripts/check-rojo-builds.mjs`                                                                         | Pinned Rojo 7.7.0 built plugin and all three places into temporary output.                  |
| `npm run plugin:build`                                                                                       | Installed `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, 716,680 bytes. |
| `npm run docs:check`                                                                                         | Passed.                                                                                     |

Targeted ESLint passed for the changed application, contract, and regression
files; the repository's ESLint configuration excludes the two browser test
files. Browser tests run locally with intercepted APIs. Accessibility scans
cover the conversation, settings, and live activity at desktop, tablet, and
mobile widths. Settings and drawer focus, keyboard navigation, draft retention,
independent conversation admission, reduced motion, and effective 200% zoom
are covered. The review found and fixed a missing settings action-group role
and a screenshot clock that was not fixed in the zoom test.

No model requests or Studio operations were made. The preceding failure's
artifacts remain unchanged; it has not become a successful run. Increased
output allowance is not proof that a fresh model will complete this request.

The service observed on port 8788 was running from
`/Users/mawawdi/.codex/worktrees/a98a/forge`, not this checkout. To review this
version, stop that service in its terminal when its work is finished, then run:

```sh
cd /Users/mawawdi/Desktop/forge
node bin/forge.js creator serve --default-model deepseek/deepseek-v4-flash-0731
```

The same pinned Rojo executable also generated a clean review place with:

```sh
.forge/tooling/source-analysis/lock-49699a17a8536fc0/darwin-arm64/bin/rojo build examples/orbital-freight-airlock/default.project.json --output /tmp/forge-ui-review.imKQoP/OrbitalFreightAirlock.rbxlx
```

The next smallest evidence-producing task belongs to the creator:

1. Restart Studio to load the installed connector, then use **File → Open from
   File** to open `/tmp/forge-ui-review.imKQoP/OrbitalFreightAirlock.rbxlx`.
2. Open the Forge plugin in Studio, allow its required local permissions,
   connect, and open the new one-time dashboard URL printed by the service.
   Click **Link project** if offered.
3. Click **Settings**, save a project preference, and close it. Click **New
   conversation** and confirm a separate empty chat under the same project;
   the preference remains available in Settings.
4. Send `Explain how this airlock works. Do not change anything.` Watch the
   activity steps and open **Details** to inspect the resulting trace and
   artifacts. Confirm that the answer or real model failure is published
   without the old phase-mismatch exception.
5. To reproduce the original planning attempt, send the original request in a
   separate conversation. Return the new run/trace IDs and visible result
   before making a claim about plan completion, Apply, Play, or gameplay.

Reviewed screenshots are in
[`dashboard/e2e/conversation.spec.ts-snapshots`](../../dashboard/e2e/conversation.spec.ts-snapshots/forge-workspace-desktop-desktop-darwin.png).

Status: current architectural rationale and presentation-milestone boundary.
Normative workflow and claim semantics remain in
[ARCHITECTURE.md](../ARCHITECTURE.md), [FORGE.md](../FORGE.md), and
[EVALS.md](../EVALS.md). Demonstrated run status is in
[ROADMAP.md](../ROADMAP.md).

## Why a conversation is an evidence structure

A creator conversation cannot be a browser-local rendering of the latest
session status. A restart, stale action, provider interruption, or old project
revision would otherwise let the UI imply a message, decision, or permission
that Forge never durably established.

`CreatorConversationStore` therefore persists one append-only chain per
conversation. An append writes the immutable conversation snapshot, event, and
any associated episode, turn, citation, plan revision, memory revision, or job
before it writes the commit that links them. Only then does it atomically
replace the private head. The head names the exact latest commit and snapshot;
every later commit names its exact predecessor artifact/hash. Loading walks
from head to sequence one and validates canonical bytes, content identities,
strict sequence, snapshot progression, and every record-to-event binding. A
publication failure can leave unreachable immutable artifacts, but it cannot
create visible history. A corrupt head is surfaced as corruption rather than
partially replayed.

This is a clean break. There is no old transcript reader, session-history UI
fallback, or migration path. An old store may be reset; it must never be
silently interpreted as current conversation authority.

## Host authority over context and citations

The model receives a host-authored `CreatorConversationContext`, not an
unbounded transcript or provider-owned chat session. The current context
contains project identity, current project-revision hash when present, selected
model, all active creator-memory summaries, at most 20 prior turns, at most 20
creator decisions, and the exact current turn. Its canonical JSON is stored as
an artifact and must fit a 128 KiB UTF-8 bound. Its prompt instruction
distinguishes quoted creator history from evaluator authority.

Planner tools issue citation handles when they return a bounded source result or
project fact. The model may choose only those issued handles in its terminal
outcome. The host resolves each selected handle into a sealed conversation
citation carrying source byte range/source hash/index hash/project revision or
project-fact hash. Citation contract variants also model prior evidence and
memory targets, but none gives a provider a way to fabricate a target. A
citation identifies what Forge supplied; it does not prove code execution,
Studio mutation, or gameplay.

## Foreground work is durable but never auto-resumed

A `CreatorWorkJob` reserves its immutable `AgentExecutionSlot` before a
provider-capable phase can start. A slot names exactly one planner, builder, or
repair AgentRun and derives its journal identity from that AgentRun ID. It
cannot be reassigned to another job, phase, or restart. The corresponding
append-only `AgentExecutionJournal` records the provider-neutral boundaries
`request_intent`, `response_received`, `batch_validated`, `tool_completed`,
and `terminal`; every entry has a predecessor hash and an exact host-state
binding. Durable admission therefore describes an exact attempted execution,
not a provider-owned chat session or a claim that work finished.

The coordinator schedules jobs only while the local `creator serve` process is
running. Closing the browser does not stop that foreground executor; stopping
the service does. Startup verifies the journal and exposes only a hash-bound
creator recovery action:

- no journal head is `never_dispatched`; **Resume work** creates a fresh job,
  AgentRun, and journal slot;
- `request_intent` without `response_received`, or a
  `tool_execution_intent` without matching `tool_completed`, is
  `outcome_unknown`; **Retry work** creates a fresh job, AgentRun, and journal
  slot rather than resending or automatically retrying the ambiguous work;
- a fully persisted response with all completed tool records and no pending
  execution intent may be consumed only by explicit **Resume work** in the
  same reserved AgentRun and journal. It does not re-dispatch the persisted
  response or reconstruct opaque provider continuation;
- a terminal journal may publish only deterministic, already-persisted local
  output. It can never cause another provider dispatch.

No recovery action retries a provider request, Apply, commit, cancellation,
rollback, or passive Play arm automatically. The same rule applies to planner,
builder, and repair phases. Background daemon or login-service work is
deferred; this local product makes no claim that it continues after
`creator serve` exits.

## Exact model registry

The registry has exactly four ordered model IDs:

- `meta/muse-spark-1.3-contributor` — Muse Spark 1.3
- `z-ai/glm-5.3-flash` — GLM 5.3 Flash
- `deepseek/deepseek-v4-flash-0731` — DeepSeek V4 Flash
- `openai/gpt-5.6-luna` — GPT-5.6 Luna (default)

All require `tools`. The model-client descriptor disables model and provider
fallback and retries. Catalog evidence may call an entry available,
unavailable, or unconfirmed; the dashboard presents the latter as unknown and
does not offer it for sending. A submitted unavailable ID is rejected, never
substituted. A durable agent turn is published only when the provider response
attributes the requested model and an exact serving provider.

## Project continuity is separate from authoring

The reserved DataModel attribute `_forgeProjectId` is only a local project
conversation identity. It is written by a dedicated Studio identity protocol,
not by the generated capability manifest or ordinary authoring transaction.

- A local place with an absent attribute may **Link** to a fresh Forge project
  ID.
- A local place with an observed ID may **Fork** to a different fresh Forge
  project ID.

Both commands bind the exact initial identity and connector epoch, use their
own ChangeHistory recording, persist/re-read a cursor, direct-read the final
DataModel attribute, persist a finalization receipt, and wait for an exact host
acknowledgement. An uncertain/open/finalizing cursor requires recovery; it
never justifies replaying Link or Fork. Identity mutation also requires that
the ordinary creator recording inventory is clear.

Save As duplicates a local place's observed attribute, so it deliberately
continues the local conversation until a creator explicitly selects Fork.
Publication switches authority to the exact universe/place pair. An embedded
local ID remains visible for an explicit continuity decision but is never used
to silently bind that published project to the local conversation. The current
control view exposes **Link project**, **Fork project**, and explicit
**Continue this conversation** / **Start new project conversation** choices at
the local-to-published boundary. None is inferred from a filename or pairing
heartbeat.

### Link rejection incident: 2026-09-03

The first `game.rbxlx` conversation-shell canary paired as
`studio_9df118b2-8676-4017-b67c-d82b8d4fbade` at 18:58:56 UTC. Its identity
observation was `970536638f6054490813fa1dc84371f1b2a39c2c9ebf9119684b84c64406b195`:
unpublished, reserved attribute absent, identity-transaction inventory clear.
The first heartbeat at 18:58:58 exposed a duplicated authority calculation:
pairing salted the local-unlinked identity with the exact Studio session, but
the connector's later adoption path omitted the salt. The host retained
project ID `studio_project_386d33ca55e9c808989e39c1` / connector epoch
`27ae667038a4a2dc82d04fc7102b5d18e54983d979d8ba2b8d26bca4058aec24`, while
the connector recomputed `studio_project_b38fdd88e1172781aa08c945` / epoch
`b41bfc0183a24d771a5d8548d2120806c2053664e0ac67334849960854b88582`.

Link job `creator_identity_job_bea28003-07f0-481e-96f3-e41d090a08a0`
dispatched at 18:59:08.978. Its exact bridge settlement rejected command
`msg_b227fd2c-2e24-4214-953c-2220c53e8cb3` at 18:59:10.754 with
`STUDIO_FAILURE: project identity operation connector epoch mismatch`.
The retained error hash
`b65995c21c277268a21a41d6133f8bb007db436079912c8f789fff2db58b3ddc`
matches the full bridge error including its plugin source location. This guard
precedes the identity cursor, recording, and attribute write.

Two explicit Resume attempts,
`creator_identity_job_1cad739b-8a5b-49bb-9f0c-2d233dd2393e` and
`creator_identity_job_3d8a9f99-a25f-42c4-b837-ad6344cc2f4b`, failed locally
without dispatching another Studio command. The rejected first operation still
held the bridge's identity reservation. Both errors hashed to
`6524cb71ef67f973890074216bd32bb347616cc7013065628ca9aac5f44afd53`:
“The prior project identity transaction outcome is not yet finalized for this
Studio session.” The UI exposed neither error, only generic recovery guidance
derived from older clear inventory. All 15 artifact files verified against
their content-addressed filenames. There is no conversation, project index,
AgentRun, mutation receipt, or gameplay claim for this incident.

The correction removes the duplicated recipe. A generated authority helper
and shared TypeScript/Luau vectors cover unlinked pairing, repeated adoption,
distinct same-name windows, linked Save As, and publication. Unlinked controls
also bind the current connector epoch. A rejected Link/Fork now includes a
command-bound, read-only identity/transaction/recording observation. Only exact
before-identity + no cursor/receipt + proven `not_open` can release that exact
reservation; rejection text alone never proves no effect. Open, unknown,
unavailable, or changed identity keeps recovery blocked. Historical pairing
inventory cannot authorize same-session retry after an ambiguous outcome.

Readable bounded errors and the exact command/settlement are immutable job
evidence. The UI always shows the failure, even with no legal actions, and
offers **Retry linking** only from coordinator-issued no-effect authority.
These are offline regression and formal-model claims; the corrected plugin
still requires a user-run Link → Save → reopen continuity canary. Previous
hash-only failure snapshots are not a current schema and are isolated, not
migrated or reinterpreted.

After the creator stopped the service, the exact incompatible `.forge/creator`
root was reset. Its 18 files were first copied byte-for-byte to
`/Users/mawawdi/Desktop/forge-creator-rollback.JnZlRB/creator`; the sorted
path/byte-count/SHA-256 inventory hashes to
`f0f4fe25a49d9e8680452d7e43bd5f2466f5e100b8767ec0dac21ee4fa84d532`.
No Studio operation or plugin-setting reset accompanied that filesystem reset.
The next launch must obtain fresh paired transaction inventory before linking.

Roblox's [ChangeHistoryService API](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService)
documents both recording creation and the optional-identifier
`IsRecordingInProgress` query. The latter is used read-only to prove that even
an unnamed recording is absent; an unavailable query cannot be treated as
`false`.

## Memory authority

`CreatorMemoryRevision` is immutable creator authority, with a category,
active/forgotten state, optional pin, and predecessor link. It may orient a
later host-authored context. It is not a current project fact, machine
observation, evaluator criterion, Studio command, or source of mutation
authority. Newer complete Studio evidence wins over memory, and rejected
proposal content cannot become project truth by being remembered. The current
control view exposes creator-authorized **Remember**, **Correct**, **Pin**,
**Unpin**, and **Forget** actions. Each action appends a revision; forgetting
excludes the item from later host-authored contexts without rewriting the
immutable event history that originally contained it.

## Presentation evidence versus Studio evidence

The current Night Blueprint UI has a project rail, chronological timeline,
authority-colored evidence seam, anchored composer and model selector, Project
Context rail, and focus-managed lazy Technical Details sheet. Technical Details
displays event authority/bindings, host-issued citation targets, and raw JSON
only for coordinator-attached sealed artifacts. It does not invent an
unattached diff, replay, source body, API proof, or Studio fact.

Automated Node, dashboard, plugin-module, and formal tests establish the
contract/store/rendering behavior using synthetic data. They make no provider
call and no Studio action. The next required evidence is a user-run Studio
canary that records pairing, conversation continuity, a permitted action, and
the normal transaction/Play boundary in this clean-break shell. Until then the
milestone is presentation-ready and locally tested, not Studio-verified or a
new accepted creator run.

## Existing accepted baseline

The accepted Orbital Freight Airlock run remains the predecessor baseline in
[ROADMAP.md](../ROADMAP.md#accepted-orbital-freight-airlock-baseline-ledger):
session `creator_session_de3157de-700e-4c95-871d-2ad94e111102`, mutation
attempt `creator_mutation_attempt_ce9de277302ca309fa688836_1`, verification
`creator_verification_624d0d509a58ab3d1443efcc`, checkpoint
`creator_checkpoint_f27e16929b8f4813954b6104`, and creator review
`creator_review_report_949a503899d96b717f85ec04`. It records one accepted
predecessor transaction with the scope stated there. It does not demonstrate
the later durable conversation store, foreground-job handling, local-identity
surface, fixed registry UI, or Night Blueprint shell.
