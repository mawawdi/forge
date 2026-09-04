# Durable Creator Conversation

This is a historical research record. Implementation descriptions, commands,
counts, and pending actions refer to the recorded builds, not the current product.
Use [Architecture](../ARCHITECTURE.md) for current behavior and
[Roadmap](../ROADMAP.md) for remaining work. Retained IDs and failure classifications
are evidence, not instructions to replay or resume a run.

## Dashboard quality-of-life follow-up, 2026-09-04

This follow-up adds keyboard conversation search and pins, a hideable sidebar,
draft recovery in the same browser tab, exact explicit retries across reloads,
scroll-position restoration, history-loading feedback, jump-to-latest navigation,
an expandable composer, reversible draft clearing, configurable send shortcuts,
background-tab activity titles, and copyable Markdown replies. Planner, builder,
and repair prompts request GitHub-flavored Markdown only for creator-facing prose;
tool JSON and staged source remain exact. The response deadline is still
1,200,000 ms, bounded by the existing remaining AgentRun budget.

The live Brave check caught a separate restart bug: a newly unlinked Studio place
produced provisional link controls while the read model still selected an older
conversation. The browser correctly rejected the mismatched control binding.
The coordinator now selects the provisional context without the old transcript,
preferences, or activity. The existing cross-project identity test now validates
the complete browser contract, and the repaired link screen was exercised in
Brave before successfully linking the reopened place.

Validation commands: `npm run build:all`; `npm run build`;
`node --test --test-concurrency=4 dist/test/*.test.js` (356 passing);
`dashboard/node_modules/.bin/tsc -p dashboard/tsconfig.json --noEmit`;
`npm run dashboard:test` (59 passing);
`npm --prefix dashboard run test:acceptance -- --update-snapshots`
(30 passing, 18 existing layout skips); `npm run plugin:test`;
`node scripts/check-rojo-builds.mjs`; formatting, lint, docs, runtime freshness,
and `git diff --check`. Browser checks use local synthetic data and do not call
models or Studio. The registry audit endpoint timed out, so this follow-up does
not claim a completed dependency audit.

The connector was materialized with `npm run plugin:build` through `build:all` at
`$HOME/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`; its SHA-256 remains
`001d088898b49699c917810adc236aa7504705508b4798038f368b379709429c`.
The task-owned Studio test instance was closed and reopened using
`open /Users/mawawdi/Desktop/forge/examples/orbital-freight-airlock/game.rbxlx`.
Before closing it, 20 creator-state files were copied and checksum-verified in
`$HOME/Documents/ForgeRecovery/qol-restart-2026-09-04-112030` alongside the seed
place. No creator state was purged. Native UI control remained blocked by the Mac
lock; the reopened plugin paired automatically, and Link was exercised from
Brave. No model request, Apply, or Play occurred during this QoL follow-up. The
original orbital request remains an unsent draft. Earlier generated-game defects
and their live verification remain separate unfinished work, described below.

## Live property attestation and request admission, 2026-09-04

Muse attempt `agent_run_ecc5e73d-0aeb-4804-92aa-bf3ef7ab849c` returned
HTTP 404 on its first provider request after 663 ms. It executed no tools and
produced no plan; usage was not reported. The 77-file verified archive is
`ForgeRecovery/live-model-unavailable-2026-09-04-052000`. This also exposed a
duplicate failure card: a new planner job was admitted before its episode
existed, so its later activity lacked the episode binding that hides bookkeeping
behind the terminal message. Activity now resolves the episode belonging to the
job's exact preassigned transaction. Failures that truly precede episode creation
remain visible. A 404 now explains that the selected model is unavailable.

The following clean Luna run published plan `creator_plan_b5e811c0e67433953da13182`
from planner `agent_run_26c82ce4-05aa-46c3-91ef-1b8639b27f1e` (14 responses,
30 tools; 371,385 input and 36,179 output tokens, USD 0.06025706). Builder
`agent_run_347eb2c4-023a-4990-becf-3c54e91471d1` produced 24 changes and an
eligible local gate in about 75 seconds (10 responses; 364,122 input and 7,710
output tokens, USD 0.02664696). A particle-value batch was rejected atomically
and then corrected. This is a successful local Build, not a correct-game claim:
source review found missing alive-character validation for remote requests,
request-ID replay protection reset with the rate window, stale async completion
after equalization, and insufficient indicator states. No Apply or Play occurred.
Its 370 verified files, separate rollback copy, extracted scripts, and review
notes are preserved under `ForgeRecovery/live-draft-review-2026-09-04-051400`.

Review exposed additional product friction. Build review now hides empty change
categories, uses plain language, and offers Request changes before Apply. This
reuses the refinement boundary, supersedes the old candidate before planning,
and never transfers approvals or applies a correction automatically. Application
and open-mutation states cannot be refined. A host coordinator edit changes the
connector build hash, so the installed plugin must be rebuilt and Studio fully
reopened even when the Luau implementation itself has not changed.

Final offline verification: `npm run build:all`; 356 Node tests with
`node --test --test-concurrency=4 dist/test/*.test.js`; 53 dashboard tests with
`npm run dashboard:test`; 21 browser checks with `npm run dashboard:acceptance`
(18 existing layout skips); `npm run plugin:test`, including native UI analysis,
module checks, 66 codec round trips, and project-identity vectors; and
`node scripts/check-rojo-builds.mjs` for the plugin and all three examples.
Formatting, lint, documentation, runtime-build freshness, and `git diff --check`
also pass. These offline tests make no model or Studio calls. Live calls are
recorded separately above. No candidate from this follow-up has been applied or
tested in Play. The next task is to correct the archived draft using its saved
`review-feedback.txt`, then establish Apply and ordinary Studio Play behavior
once native computer use can access the Mac.

The next DeepSeek planner, `agent_run_d626bd9a-5562-46c0-811a-1f34e2499e18`,
successfully published one visible plan after nine responses and 20 tools.
Its recorded usage was 300,369 input tokens and 35,227 output tokens, with
reported cost USD 0.013120141. The approved Build started
`agent_run_72266aaf-87ca-47c7-9b28-a0a6cbedf813` and staged eight of its
declared changes before response 17 failed at the provider boundary. The old
adapter collapsed both an error envelope and an invalid success envelope into
`http_200`, discarding the distinction; the exact upstream cause cannot be
recovered from that journal. The 16 completed assistant responses record
776,661 input tokens, 46,581 output tokens, and USD 0.024710233. The failed
response's usage is unknown. No Apply or Play occurred. Its 311 checksum-verified
files, original seed, prompt, metrics, and independent rollback copy are in
`/Users/mawawdi/Documents/ForgeRecovery/live-provider-response-2026-09-04-045100`.

That build also exposed ten malformed staging payloads and one inspection of a
path outside its approved contract. Planner instructions now clearly reserve
source and property writing for Build, require every output check, and explain
explicit citation selection. Builder instructions name the exact staging envelope
and approved inspection paths, discourage redundant API lookups, and request a
review against the creator's requirements before verification. Missing output
checks are reported together, and repeated IDs in a read-only inspection return
each object once. Unknown IDs and mutation constraints still fail closed.
HTTP-success error envelopes and unreadable response schemas now have distinct
provider classifications, without exposing arbitrary provider payloads. Terminal
conversation messages use the saved run's failure reason. Activity names reflect
planning, building, and actual tool operations. These changes do not alter the
20-minute response timeout, output allowance, or approval boundaries.

The next Luna attempt, `agent_run_906c2bba-a69c-47e4-b175-f75a0c079637`,
exposed a separate truncation defect. Response six consumed its full 32,768
output-token allowance and returned unfinished tool JSON with a long whitespace
tail. The transport prioritized the presence of tool calls over the provider's
`length` finish reason, and the runtime checked truncation only for responses
without tool calls. Consequently it treated a cut-off response as ordinary tool
validation feedback and continued repeated malformed-plan retries. The operator
stopped that attempt; the final pending response is unknown and no plan, Build,
or Apply resulted. Its 157 verified files are preserved in
`live-truncated-plan-2026-09-04-041610`. Truncation and refusal now take precedence
over tool presence, and the native runtime executes no tools from either type
of response. `MODEL_RESPONSE_TRUNCATED` gives the creator a plain-language reason
to retry or choose another model. This change does not reduce the 20-minute
response timeout or the model output allowance.

The following GPT-5.6 Luna attempt,
`agent_run_cef4d826-2f5e-497c-9680-8dcc7ce72526`, produced plan
`creator_plan_72414732b1b7b2844a6cf7ec` after 13 responses and 30 tools
(340,402 input tokens, 16,454 output tokens, reported cost USD 0.03536633).
Six tool failures included mistyped opaque IDs and malformed plan fields. The
plan itself was valid, but automatic inclusion of every browsed project/source
citation created 35 citations and violated the outcome's 32-citation bound.
Publication failed with `Invalid CreatorAgentOutcome`. Plans now retain only
explicitly selected host-issued citation handles, matching answers and the
documented citation contract; full project/source provenance remains in the
immutable plan and consultation. All sealed outcomes validate before tool success.
Replaying the 24 successful saved calls offline produced the identical plan hash
`72414732b1b7b2844a6cf7ecab2444b055ae653737863d9d3ec2f0c573c7e289`
and a valid outcome with the model-selected zero citations. This replay made no
model or Studio calls and did not modify the original evidence. The 170-file
verified archive is `live-plan-citation-overflow-2026-09-04-040536` under the
same recovery root. Validation feedback now expands union failures to specific
field paths and explains how to recover an absent object ID or use an engine
container parent. No Build or Apply occurred in that failed attempt.

After the creator unlocked the Mac and authorized Brave/Studio operation,
the requested place was opened directly with `open`, the installed connector
was refreshed by fully closing and reopening Studio, and the dashboard was
operated in Brave. Studio 0.737.0.7371584 reported all 630 manifest properties.
The first attestation exposed 11 ContentId engine-type mismatches and seven
modern Content properties whose live `Serialized` value is false. Explicit
catalog-derived ContentId typing and property serialization policy correct
those differences. The following live attestation passed all 630 checks.
This establishes reflection agreement, not full authoring behavior for every
property or a successful game build.

Two independent live admission defects were corrected. A completed project link
left the dashboard selected on its provisional identity and disabled its
composer; the coordinator now resolves that identity through the completed
link job. The exact saved prompt includes a trailing newline, which the lower
transaction action parser rejected before making any model call. Creator request
boundaries now consistently admit nonblank UTF-8 text up to 64 KiB and trim its
outer whitespace at the canonical transaction boundary. Agent output bounds
are unchanged. A subsequent live submission reached the model normally.

The DeepSeek attempt `agent_run_8089f305-7e77-4d71-b32e-01e3df63eb48`, in
`creator_session_21fc65a1-7d19-43c3-b7ef-1c31e47c2cb5`, completed four provider
responses and 15 successful read-only tools. Its fifth request, recorded at
`2026-09-04T00:40:04.901Z`, was pending when the operator stopped the bridge.
No provider failure or timeout was observed; its eventual response is unknown.
No plan was published and no Build or Apply occurred. Inspection found that
`project.children` silently returned an empty list for a nested path supplied
as a service root. The tool now restricts roots to declared services and rejects
unknown parent IDs, while retaining valid empty-folder results. Per-response
timeouts are explicitly 20 minutes, bounded by the remaining run budget, as
requested by the creator. No three-minute response cap is retained.

The bridge restart also exposed stale live status in the dashboard: disconnected
SSE left Studio marked ready and the activity indicator animated. The browser
now retains the conversation and draft, marks the connection as reconnecting,
pauses live activity animation, and fetches fresh state on reconnect. Startup
failures remain visible even when they precede episode creation.

All resets preserved checksum-verified snapshots under
`/Users/mawawdi/Documents/ForgeRecovery`: `live-content-attestation-2026-09-04-032810`
(18 metadata mismatches), `live-link-transition-2026-09-04-033027`
(passing attestation and link transition), `live-pasted-request-2026-09-04-033807`
(zero-model admission failure), and `live-response-interrupted-2026-09-04-035304`
(105 files from the interrupted model attempt). Each contains the original
`forge`, an independent `rollback`, checksums, seed place, and request text.
Plan publication and a locally eligible Build are now demonstrated by the runs
above. Apply, gameplay correctness, and evaluation remain pending. Native Studio control again reports
a locked Mac despite the configured automatic unlock; Brave and the bridge remain
usable, but Play and visual inspection require native access.

## Property coverage audit and clean rebuild, 2026-09-04

The creator explicitly requested automated Studio operation for this task,
overriding the repository's normal user-run-only workflow. Live execution could
not begin: computer use reported a locked Mac twice, and the creator was asked
to unlock it while offline work continued. No Studio restart, project link,
model prompt, Apply, or Play has been performed in this audit.

The audit covered all 9,685 pinned catalog entries. The previous Font omission
had a second instance: ContentId lacked a mapping despite an implemented content
codec. It affected ImageLabel.Image, Beam.Texture, ParticleEmitter.Texture,
Sound.SoundId, and Trail.Texture. Modern Content values also require a native
Content conversion rather than assignment of a plain string. Empty content
must remain valid so default objects and asset clearing can be captured.
The implementation now uses URI/none conversion for modern Content and strings
for ContentId, preserving the distinct engine and script type expectations.
Object-backed and opaque assets remain rejected, consistent with the documented
[Roblox Content domains](https://create.roblox.com/docs/reference/engine/datatypes/Content).

Generation fails if an implemented codec loses its API mapping or if an enabled
class gains an eligible property with no codec and no explicit exclusion. Tests
remove Font and ContentId mappings in isolated generator fixtures and require
failure before any model or Studio run. Every codec has a shared canonical
vector. A new plugin gate performs 66 conversion round trips using Lune's Roblox
datatypes, including all content-property applications and empty/URI cases.

The selected UI groups now include CanvasGroup, ImageButton, ScrollingFrame,
SurfaceGui, TextBox, UIAspectRatioConstraint, UICorner, UIGradient, UIGridLayout,
UIListLayout, UIPadding, UIScale, UIStroke, and UITextSizeConstraint. The manifest
contains 47 classes and 630 property applications from 370 distinct declarations.
No enabled class has an unclassified missing-codec property. SecurityCapabilities
is explicitly engine-owned. This is not a claim that every Roblox API is directly
editable: other APIs remain searchable as script context or restricted metadata.

A broader default-object diagnostic exposed limitations in Lune's serialized
instance implementation, including absent defaults and nil-reference setters.
Those are not asserted as native Studio defects. It also identified infinite
default values for BillboardGui.MaxDistance and UISizeConstraint.MaxSize, which
the finite numeric evidence domain cannot represent. Those two additional classes
were not enabled; extending their numeric domain remains explicit future work.
The accepted offline gate tests the actual codec conversion functions, not a
substitute engine's incomplete default-property table.

Dashboard polish removes persistent sidebar instructions and duplicated running
instructions, keeps Send aligned when its keyboard hint is hidden, and uses plain
language for API support, failed delivery, and history loading. Request admission
and exact retry checks remain unchanged. Screenshot updates were inspected at
desktop and mobile sizes.

With both local service ports stopped, `.forge` was copied, checksum-verified,
and moved to `/Users/mawawdi/Documents/ForgeRecovery/property-audit-2026-09-04-031012/forge`.
The adjacent `rollback` contains the verified seven-file snapshot; `checksums.json`
records hashes. `game-before.rbxlx` preserves the requested existing seed and
`request.txt` preserves the original Turn Workspace request. The earlier full
run evidence remains in `/Users/mawawdi/Documents/ForgeRecovery/2026-09-04-024045`.
`npm run build:all` succeeded after this reset, including the dashboard, installed
plugin, pinned TLA+ setup, and verified source-analysis toolchain setup.

The installed connector is
`/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, 849,314 bytes,
SHA-256 `3ef3f36ded7f4af1770356d472c99f904d1f42f3e1c700a0f18914f251e2c46b`.
The requested place is
`/Users/mawawdi/Desktop/forge/examples/orbital-freight-airlock/game.rbxlx`.
Its source has not been changed. Temporary-output Rojo checks passed for the
plugin and all three examples. Node tests passed 348/348; plugin parse, analysis,
module tests, 66 codec round trips, and identity vectors passed.
`npm run dashboard:test` passed 51/51 tests in nine files;
`npm run dashboard:acceptance` passed 18 checks with 18 existing layout skips.
The normal browser command passed after screenshot updates and visual review.
`npm run lint`, `npm run format:check`, `npm run docs:check`,
`npx tsc --noEmit -p dashboard/tsconfig.json`, `npm run studio-evidence:check`,
`npm run runtime-build:check`, and `git diff --check` passed. The dashboard was
rebuilt after its final copy and layout corrections. Diagnostic logs are saved
under `diagnostics/` in the audit archive above.

The bridge was started with:

```sh
node bin/forge.js creator serve --default-model deepseek/deepseek-v4-flash-0731
```

`node bin/forge.js creator state` confirmed a fresh unpaired dashboard with zero
conversations. The service performs a model-catalog probe, but no model completion
was requested. Pending sequence after unlocking: close and reopen Studio, open
the exact game path above, Plugins → Forge → Connect, open the service's dashboard
link, Link project, submit archived request.txt, inspect the single plan, Build,
then review the resulting evidence before the subsequent Studio action. Archive
each failed run before another `.forge` reset and `build:all`; restart Studio after
every plugin rebuild. No live success or clean end-to-end result is claimed yet.

## Conversation polish, Font authoring, and refresh, 2026-09-04

This incident is conversation `creator_conversation_4066f9982584ac0cdc85f807`,
session `creator_session_eece991e-0c16-4243-9ab4-4c3a9279e6bb`, and project
`studio_project_c312b015b29db73a661c8be3`. All 409 artifact files match their
SHA-256 filenames. The complete journals contain 84 planner entries and 103
builder entries; both end at a terminal checkpoint.

| Run                                              | Result                                          | Time       | Model turns | Input tokens, cumulative | Output tokens | Recorded cost   |
| ------------------------------------------------ | ----------------------------------------------- | ---------- | ----------- | ------------------------ | ------------- | --------------- |
| `agent_run_6f6e2c26-7a9d-4c24-ad34-cbd8fd0b6fcd` | `locally_eligible`, classification `none`       | 241,140 ms | 12          | 497,979                  | 49,838        | $0.018814741568 |
| `agent_run_c6a4174f-9138-48a0-8070-00faaade7143` | `incomplete`, classification `budget_exhausted` | 190,152 ms | 13          | 1,061,362                | 42,881        | $0.02828644224  |

The traces are `trace_e945622b-cd0a-48a2-bd20-531d83ba0f3b` and
`trace_ce63e6b1-15e6-408d-bdbf-c8148efbbf85`. Terminal journal entry hashes are
`4a9cc58f1fb8b4455664bf31d3230b7865fdf745cb46c1f61200cf4b6d368a2b` and
`9476c46301094496e6df0f104f73b2a3df0c74a8ca52dcb967755c57a59467c8`.
The planner ran from 23:08:09.298Z to 23:12:10.438Z on September 3 UTC; the
builder ran from 23:13:25.234Z to 23:16:35.386Z. The selected model was
`deepseek/deepseek-v4-flash-0731`. These are recorded user-run costs, not model
calls made during diagnosis.

The planner produced `creator_plan_e24f5df274eb14a9936022aa`, hash
`e24f5df274eb14a9936022aaf806671d0e31458bdde9e9aba5867612be49202e`,
with six steps, 22 proposed creates, and 33 check/review clauses. Its three
recoverable tool failures were `PROJECT_INSPECTION_ABSENT`,
`PLAN_INSPECTION_NOT_OBSERVED`, and `PLAN_INVALID`. The builder made 34 tool
calls, with eight `PROPERTY_NOT_ALLOWED` failures for Font, four malformed
stage calls, and one invalid inspection-path call. It reached
`RUNTIME_BUDGET_EXHAUSTED`. The recorded 28 writes are virtual staging attempts;
there is no published change set, mutation attempt, or Studio verification.

The defects and corrections are:

- The publisher used the original creator prompt as both the agent answer and
  plan summary. The transcript now displays a single plan with actual steps
  and separate expandable checks/review. Summaries must fit the 16,384-byte
  publication boundary before a plan is sealed. Long messages expand in place.
- Internal decision receipts and activity records were rendered as dialogue.
  They remain in Details, while current actions preserve their exact original
  event bindings. One header Details button opens an event selector, replacing
  redundant per-message, citation, activity, and settings shortcuts. Local-day
  timestamps show only time today and only the date for other days.
- Activity events between dirty notifications defeated consecutive-event
  deduplication. Repeated notices now coalesce in publication and rendering.
  More seriously, every notice replaced `priorStatus` with the current status,
  so later notices remembered `refresh_required` as the state to restore.
  The saved refresh found an identical revision
  `fda22b6e796b155b55fe119da855fe96a57b39a721993c164c244f4e6d6dc17f`,
  yet restored `refresh_required`. The first pre-invalidation status is now
  retained across a burst. An unchanged refresh publishes an up-to-date notice.
- The monitor watched all property changes, including values the project index
  never captures. It now watches indexed properties and structural/source/tag
  fields. Camera motion and computed UI geometry no longer invalidate work.
  Original notices recorded only `property`, so the precise fields responsible
  for this incident cannot be reconstructed; viewport movement is a reproduced
  false-invalidation path, not an asserted observation of the user's actions.
  Value objects use their specialized value signal plus separate name/parent
  signals, so filtering does not conceal changes to their contents or identity.
- The Font codec existed but was absent from the policy's API-type mapping.
  Current `FontFace` properties are now enabled on text widgets. Deprecated
  `Font` remains excluded, with specific guidance to use the modern property.
- Builder system context duplicated property policies in every change and
  included unrelated classes. The applicable policies now appear once and
  changes reference them by index, preserving every exact rule. On the saved
  build, this produces 66,368 bytes of system context versus 159,114 bytes for
  the old plan and contract alone, roughly 58% smaller. This is an offline byte
  comparison, not a measured live token or latency improvement. Each old Font
  rejection also returned 13.9–15.5 KB, including duplicate contract data and
  the creative payload. Errors now return correction guidance and compact
  metadata while original inputs remain in the execution journal.

FontFace changes the attested capability manifest. Per the repository's clean
break policy, no old-manifest reader or migration was added. With port 8788
confirmed stopped, all 419 store files were copied and verified by checksum
before moving the original store out of the active path. The archive is
`/Users/mawawdi/Documents/ForgeRecovery/2026-09-04-024045`: `creator/` contains
the original store, `rollback/` is the verified snapshot, `checksums.json`
records every file hash, and `saved-plan.md` preserves a readable proposal.
`request.txt` contains the original request for a fresh conversation. The active
`.forge/creator` is empty. The `.rbxlx` place was not edited.

Validation from `/Users/mawawdi/Desktop/forge`:

- `npm run build`, `npm run runtime-build:check`, `npm run dashboard:build`,
  and `npx tsc --noEmit -p dashboard/tsconfig.json`: passed.
- `node --test dist/test/*.test.js`: **345 passed**, no failures or skips.
  Coverage includes FontFace on both text widget classes, bounded correction
  errors, lossless contract-policy expansion, complete plan publication, and
  repeated notifications followed by an unchanged refresh.
- `npm run dashboard:test`: **51 passed** across nine files. Coverage includes
  one visible plan, hidden bookkeeping with preserved actions/history access,
  full-message expansion, and local-day timestamps.
- `npm run dashboard:acceptance`: **18 passed**, 18 existing layout skips.
  Seven screenshot baselines were updated for the intended layout, desktop
  and mobile output was inspected, and the normal acceptance command passed.
- `npm run plugin:test`: parsing, analyzer, native UI type analysis, module
  tests, and Studio identity authority vectors passed. Mock signal tests
  exercise ignored camera/computed-layout events and retained font, value,
  rename, and parent changes without operating Studio.
- `node scripts/check-rojo-builds.mjs`: pinned Rojo 7.7.0 built the plugin and
  all three examples into temporary output.
- `npm run lint`, `npm run format:check`, `npm run docs:check`, and
  `git diff --check`: passed.
- `npm run plugin:build` installed the final connector directly at
  `/Users/mawawdi/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`, 744,034 bytes,
  SHA-256 `35772f357b72020e5a79c7e827e1f8a57095faaf0c386de82fb8c980a9b95f7f`.

No model calls or Studio operations were made during this correction. Live
token/latency improvements, native property notifications, and actual Studio
application remain unverified. Planning remains non-mutating: a suggested
plan requires an explicit Build decision before candidate generation; Studio
application retains its separate review boundary.

The next smallest user-run check is to restart Studio to load the installed
connector, then start Forge in the terminal that has the provider configured:

```sh
cd /Users/mawawdi/Desktop/forge
node bin/forge.js creator serve --default-model deepseek/deepseek-v4-flash-0731
```

Open the existing place, click **Plugins → Forge**, and click **Connect** if it
does not connect automatically. Open the dashboard link printed by the service,
click **New conversation**, and submit `request.txt` from the archive above.
Expect one plan with expandable checks and no internal decision receipts.
Move the Studio viewport without editing the place; it should not request a
refresh. Click **Build** on the plan to exercise FontFace staging; do not claim
success or an applied change until the corresponding evidence is returned.
Return the new run's result or error for comparison with the archived trace.

A clean seed place was also generated, without opening Studio, at
`/Users/mawawdi/Documents/ForgeRecovery/2026-09-04-024045/OrbitalFreightAirlock.rbxlx`.
Its exact generation command was:

```sh
.forge/tooling/source-analysis/lock-49699a17a8536fc0/darwin-arm64/bin/rojo build examples/orbital-freight-airlock/default.project.json -o /Users/mawawdi/Documents/ForgeRecovery/2026-09-04-024045/OrbitalFreightAirlock.rbxlx
```

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

The reviewed screenshot baselines were intentionally replaced during the later
dashboard redesign; this record does not retain a stale image link.
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

The reserved Workspace attribute `_forgeProjectId` is only a local project
conversation identity. It is written by a dedicated Studio identity protocol,
not by the generated capability manifest or ordinary authoring transaction.

The predecessor connector stored this attribute on DataModel. The V11
Save/Open incident demonstrated that Roblox does not serialize attributes on
that root: the saved applied game reopened without its ID. Current storage is
Workspace only. Binary and XML place round-trip regressions cover persistence;
there is no old-location compatibility reader.

- A local place with an absent attribute may **Link** to a fresh Forge project
  ID.
- A local place with an observed ID may **Fork** to a different fresh Forge
  project ID.

Both commands bind the exact initial identity and connector epoch, use their
own ChangeHistory recording, persist/re-read a cursor, direct-read the final
Workspace attribute, persist a finalization receipt, and wait for an exact host
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
[ROADMAP.md](validation-evidence.md):
session `creator_session_de3157de-700e-4c95-871d-2ad94e111102`, mutation
attempt `creator_mutation_attempt_ce9de277302ca309fa688836_1`, verification
`creator_verification_624d0d509a58ab3d1443efcc`, checkpoint
`creator_checkpoint_f27e16929b8f4813954b6104`, and creator review
`creator_review_report_949a503899d96b717f85ec04`. It records one accepted
predecessor transaction with the scope stated there. It does not demonstrate
the later durable conversation store, foreground-job handling, local-identity
surface, fixed registry UI, or Night Blueprint shell.
