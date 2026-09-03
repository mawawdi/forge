# Forge Roadmap

This is the canonical status and next-work record. [ARCHITECTURE.md](ARCHITECTURE.md) defines architecture, [FORGE.md](FORGE.md) defines thesis and invariants, [EVALS.md](EVALS.md) defines claims, and [RESEARCH.md](RESEARCH.md) indexes evidence.

## Current milestone: existing-project intelligence and explicit refresh

The first connector launch after the project-index clean break exposed a local
recovery deadlock before pairing: the new connector reused
`ForgePassiveRuntimeDirectV1` even though the durable arm/revision binding had
changed, so a predecessor Play receipt was interpreted as malformed current
state. The connector displayed **Passive receipt invalid**, disabled pairing,
and therefore could not report the independent creator-recording inventory.
No creator session, provider call, project index, mutation, or gameplay claim
exists for this launch. The current connector clean-replaces that key with V2
and has no V1 reader. A genuinely invalid V2 receipt remains fail-closed but
offers explicit creator-authorized discard followed by read-only recovery
pairing; valid receipts are rejected by that discard boundary.

The next clean-store launch paired and attested successfully but rejected the
first `CollectStudioProjectIndex` request before any creator session existed
with `project index projection connector or resource binding mismatch`.
Capability projection artifact
`1f0bac10d19e1f35a32cc7a91418e2a266cb071fb67e7f1f391247066fea4967`
and envelope artifact
`e1f783db2b3b4bf4ea720155edb3cb9435b44797fde37f8823587540a1fd7e1f`
are the complete local evidence for that launch; there is no AgentRun, trace,
project-index revision, provider call, recording, mutation, or gameplay claim.
The resource policy matched exactly. The host bound opaque identities to
session, project, and connector build using project-index canonical material,
while the connector omitted the project ID and hashed an ad hoc colon-joined
string. The current implementation has one shared `StudioConnectorEpoch`
canonical domain and cross-language vector; CLI collection, coordinator
collection, and plugin identity registration all use it. The dashboard also
keeps the page-level technical failure as the single raw diagnostic, bounds the
composer message, compacts empty evidence/history space, and collapses source
intelligence and API coverage into inspectable technical drawers.

The first collection after that binding repair reached the plugin but then
triggered Studio's unresponsive-plugin watchdog. The Studio hang trace ended in
`StudioProjectIndexCanonical.material` through
`StudioProjectIndexCollector.produce` and `Runtime.publishProjectIndex`. Only
the complete 183-fact capability attestation artifacts existed: no creator
session, project revision, AgentRun, trace, provider call, recording, mutation,
or gameplay claim had begun. The opened Orbital Freight Airlock place contained
only 25 serialized instances, ruling out legitimate index load. The collector's
empty-root loop emitted an empty shard without advancing its cursor, so any
declared root with no descendants repeated forever on Studio's plugin thread.
The current collector uses a one-shot empty-shard flag, exact incremental shard
byte accounting, bounded cooperative yields with deadline/detector rechecks,
and a buffered transport encoder that preserves the semantic distinction
between empty objects and empty arrays. Plugin regression checks reject the old
non-advancing loop and verify empty-root termination, exact shard sizing,
cooperative scheduling, and cross-language-safe empty-object encoding.

The following Door Control collection paired and attested all 364 manifest
property applications, then failed before session creation when an ordinary
`Part` returned `nil` for its unset inherited
`BasePart.CustomPhysicalProperties`. Generated `fromStudio` treated every
`physical_properties` value as an object and dereferenced `Density`; this was a
manifest/codec presence defect, not a malformed place. There was no plan,
provider call, recording, mutation, verification, or gameplay claim. The
current manifest requires an explicit `nullable` decision on every property
row and admits a codec-bound canonical nil only for the exact nullable row.
Generated Luau guards nil before every codec-field read, creator inputs and
replay enforce the same property binding, and an exhaustive plugin regression
exercises nil against every manifest row. The same audit added general minimum
UTF-8 bounds and closed the previously under-specified nonempty
`BasePart.CollisionGroup` domain.

The next live creator run crossed Apply successfully and then exposed a
control-plane presentation/liveness defect. Session
`creator_session_070a5596-8109-4280-aaed-6628e4e272f5`
(`443f20930877a1ce68a82226b5c5c5221e630a3c6ca4236d21140fcca45943ec`)
sealed change set `creator_change_set_107c4bf4e78531aa1ef8bc3e`, completed
preflight under evidence hash
`a814fe8d48a8e57915323f62cd250645e2bd2e0f3a1fe2d2f80cda36ca4f30be`,
and produced complete direct readback
`3243a9bc7741631880c4addf35c49d58091b2a5de60765f3c5865dc4cd1da16b`.
Pure reconciliation
`e1fd9f3a0b412ab1d409375a28b4953568e7ab99e5183aaa52e611d3434d1e0a`
was `matched` with no failure facts. A later complete read-only index
confirmation `6cb3a42aba7b1a1c9dcc8b34c96ae7f43cc6d3e55de54e8b46487d6e63d57717`
also proved the provisional revision
`7372506cdcc635f1028785849c636ca53c997d1bc10e442ebd5703fe9f0626f6`
unchanged.

After those facts were durable, dashboard rendering incorrectly recompiled
the approved pre-transaction `create` operations against the current
post-Apply index. The now-present created identity was therefore rejected as a
duplicate. The confirmation scheduler mistook that presentation exception for
failed Studio observation, wrote the false
`project_change_confirmation_incomplete` recovery classification with detail
hash `60cac9c76ec7dcf1b0d330ea8228ac56937ab77282ff1979d34685206b2d25bf`,
then repeated the same exception while presenting recovery; the unhandled
background rejection terminated the creator service and the browser reported
**Failed to fetch**. No runtime verification, finalization, checkpoint, or
creator review was recorded. A manual Play observation is creator context, not
machine evidence for this interrupted run.

The current implementation derives every change-set review from the immutable
pre-mutation capture retained by its active or settled mutation attempt, while
the current post-state remains a separate project-index display. Durable
confirmation is now an explicit error boundary: dashboard publication and
deferred acknowledgement failures are operational diagnostics and cannot
rewrite Studio evidence. Every background coordinator task, control-server
request, listener, and SSE write has terminal liveness containment. A browser
whose action response is lost performs one read-only canonical-state refresh
and never automatically repeats the mutation request.

Forge now treats the complete document open in Studio as the default project authority, regardless of whether it began as a hand-authored or Rojo-generated `.rbxlx`:

- a complete Merkle-sharded project index replaces fixed whole-project evidence ceilings; unsupported/new classes remain in the structural inventory while unsupported properties remain explicitly outside the claim domain;
- pre-existing objects need no Forge attribute to be read: connector-epoch opaque identities distinguish duplicate names, while durable identity enrollment occurs only inside an approved transaction;
- current Script Editor buffers are indexed ahead of persisted `Source`, source bodies are independently chunked, and the planner receives bounded search/read/symbol/reference/dependency tools before proposing a plan;
- source-bearing plans bind a host-derived `CreatorSourceConsultation`; `edit_source` carries UTF-8-safe byte edits, an exact before hash, and a reproducible final hash/byte count;
- dirty notifications revoke current action authority but make no revision claim; explicit Refresh either proves the revision unchanged or supersedes the old session and replans in a linked successor with no inherited approvals;
- optional `--project-authority` enables one exact Rojo source writer domain. Mixed Studio/Rojo change sets are rejected, filesystem writes are guarded and replayable, and success waits for a later complete Studio index proving sync;
- after acceptance the authoritative result is committed in Studio. The user creates the output `.rbxlx` through **File → Save to File**; Forge does not fabricate a filesystem-output claim.

## Predecessor foundation: closed Studio evidence and transactional mutation proof

The repository now implements the product-shaped vertical slice plus the closed evidence/transaction foundation:

- one canonical `StudioCapabilityManifest` and deterministic generator own the complete TypeScript/Luau writer, reader, preflight, projection, comparator, runtime dispatch, canonical encoding, and test-vector surface; generation fails when any writable row is not closed;
- `StudioEvidenceProjection`, `StudioEvidenceEnvelope`, and the explicit-status `StudioEvidenceFact` union replace the predecessor snapshot/runtime/capability-set shapes throughout current creator, experiment, runtime, semantic-map, bridge, and plugin code;
- connector build and manifest identity plus a current-security ReflectionService attestation are required at pairing, but reflection cannot add authoring capability; the plugin preserves raw owner/type/serialization/permission facts and one catalog-derived backend grader reports exact `verified`, `rejected`, or `incomplete` health;
- each mutation attempt retains that exact attestation; a failed or incomplete detached canary is an immutable incomplete attempt with no invented reconciliation verdict;
- approval displays and binds the exact mutation proof obligations; the connector independently recompiles them from the sealed change set and complete before-state evidence, then runs a scoped detached canary before ChangeHistory;
- provisional apply emits direct object readback and separate complete post-state evidence before pure reconciliation; only `matched` may enter verification, complete contrary facts are `mismatched`, and missing/invalid facts are `incomplete`;
- an evidence-derived allowed state delta covers create/update/move/delete/source/attribute operations, including moved/deleted descendants, without granting authority to unrelated facts on an affected object;
- an artifact-only in-flight transaction cursor is persisted before a recording may open; restart never retries Apply/provider work or mutates Studio automatically, and exact open-recording recovery cancellation is a creator action;
- finalization receipts survive connector/control restarts and are cleared only after an exact backend acknowledgement sent after the mutation attempt and resulting session state are persisted;
- every finalized mutation attempt is provider-free replayable through `forge creator replay-mutation` and the dashboard API; verification replay requires its linked exactly replayable matched mutation;
- the bounded TLA+ transaction model is checked offline in `npm test` using the pinned official 1.7.4 tools JAR;

- one creator prompt entered from the local React dashboard or CLI control client;
- fresh bounded complete Studio project-index graphs, a generated engine-owned authoring-container topology, and exact connector-issued identities;
- Studio transaction authority plus an opt-in verified Rojo map, with exactly one derived writer sealed per change set and mixed-authority batches rejected before approval;
- separate read-only planner and typed builder model phases behind the bound `CreatorAgentWorker` seam;
- planner-inspected, then explicitly declared initial-snapshot `inspectionPaths` for builder placement, integration, relationship, and preservation facts;
- a content-addressed, model-visible `CreatorBuildContract` compiled from the approved plan and persisted by ID and hash in builder AgentRuns, traces, and creator-session history; Forge derives operation ID, kind, destination, parent, name, class, exact connector-issued object identity, precondition, and initialization while the model supplies only `planChangeId` plus allowlisted properties, attributes, explicit removals, and source;
- creator-visible immutable prompt, exact typed changes, generated initialization commitments, Forge-generated machine-check statements, thresholds, creator-review judgments, and artifact hash;
- plan closure before review: exact step-to-change coverage, same-operation source for newly created scripts, an exact class-aware existence check for every created or moved output, and Luau syntax coverage for every source-bearing change;
- exact source diff, complete typed canonical creative payload, operation hashes, and local gate before change approval; model-facing properties use natural JSON and are converted to the tagged Studio representation only after contract validation;
- contract-scoped current-source reading for approved existing script replacement, plus allowlisted Studio create/update/move/delete/source operations with revision and identity preconditions, atomic move-plus-property/source-plus-attribute composition, property/UTF-8 parity at Forge and Studio, and explicit `removedAttributes`;
- live budget admission before each model batch and no-progress termination for repeated identical batches within one accepted host-state epoch, while materially distinct rejected corrections remain repairable under the shared turn/call/output/time/token/cost budgets and an already seal-ready host is never downgraded;
- one open Studio ChangeHistory recording across provisional apply and verification, with the exact projection-bound revision recollected independently at prepare and apply;
- class-aware existence checks over exact safe Studio service roots, Workspace-only BasePart position checks, bounded subtree state preservation, and whole-playtest error/warning counts plus message hashes;
- cancellation on failure, at most two repairs without weakening the approved charter, and commit on pass;
- final creator acceptance/rejection and exact-revision guarded Change History rollback;
- private current-session persistence under `.forge/creator`, with bounded revision-to-observation history and one root-relative `ArtifactReference` shape for immutable canonical JSON evidence; there is no legacy reader or migration, and an explicit `.forge` deletion is a clean reset;
- a native tool-host completion contract that turns a premature normal model `end_turn` into a bounded same-session mandatory-repair instruction, and records an unsealed terminal outcome only after two such repairs fail;
- AgentRun creator phase outcomes that discriminate a sealed artifact from an unsealed attempt and bind the latter to its failure stage, code, detail hash, tool-history-derived attempt hash, model turns, and trace;
- worker results that persist phase evidence before the coordinator transitions an incomplete session, including zero-tool, plan-only, rejected-stage, partial-coverage, missing-local-gate, provider-failure, and successful-seal paths;
- bounded planner inspection, targeted builder inspection from declared paths, approved existing-source reads, structured expected-versus-received stage feedback with exact allowlists, rejected-batch evidence, and no-progress guards;
- an authenticated evidence graph across session, contract, AgentRun, trace, change set, Studio lifecycle, verification, creator report, and checkpoint artifacts;
- retrievable execution-plan and complete bounded runtime-evidence artifacts, exact state/mutation bindings, pure provider-free replay, and explicit non-replayability for incomplete connector runs;
- runtime-owned rejected/executed tool-call evidence and real monotonic-backed phase, provider-turn, and tool-call intervals, materialized as contained trace spans;
- a standalone loopback `CreatorControlServer` with one-time browser grants, host-only cookies, separate CLI bearer authentication, same-origin mutation, bounded SSE invalidations, authorized artifact retrieval, and replay;
- a canonical `CreatorControlView` consumed by the dashboard and CLI, with one primary and one secondary creator action, exact change payload presentation, content-bound terminal evidence references, and no workflow legality inferred from status text;
- a React evidence workbench with session history, five coordinator-produced stages, exact artifacts, Studio pairing and consent, required final report, explicit error/recovery states, keyboard-visible controls, reduced motion, and responsive stacking;
- a thin Studio connector with creator workflow controls and protocol messages removed while pairing, observation, typed mutation, Play Solo, diagnostics, commit/cancel, and guarded undo remain;
- approve-and-apply followed by silent arming of the next ordinary creator-driven Studio Play/Stop session, while retaining the exact approved evidence boundary;
- pre-mutation compilation of dependency-ordered runtime proof programs, persisted revision-bound execution plans, and a bounded creator-interaction observation window inside the common generated five-minute Studio ceiling;
- one non-curated default agent budget for creator planning/building/repair and unoverridden registered runs, plus one generated Studio limit policy shared by creator checks, registered evaluation, canaries, evidence collection, and direct Play Server observation;
- connector build identity over the manifest, protocol, plugin project, and all authored plugin source, so runtime-executor changes cannot pair as the old build;
- one current clean-break artifact shape throughout Forge, with tagged canonical hashes and generated manifest identity.

The automated suite covers the corrected invalid proposal, bounded planner inspection, same-run planner correction, executable initialization, approved existing-source reads, atomic move-plus-property changes, output-check and source-syntax closure, exact plan-change coverage, plan-bound builder-contract derivation, immutable artifact safety, provider-free replay, real and impossible timing, runtime-owned rejected calls, content-bound AgentRun/trace artifacts, sealed and unsealed worker evidence, control authentication, dashboard state and report requirements, plugin cutover, evaluator isolation, workspace security, and historical evidence. These tests make no provider request and perform no Studio action. They do not validate a live creator run.

## What ordinary users provide

The intended creator path needs the open Studio place and the prompt. It does not need `requirements.json`, `acceptance.json`, evaluator JSON, a prepared data plan, or a source-root manifest.

`examples/status-beacon` remains the historical accepted live-session seed. `examples/door-control` is the distinct completed closed-evidence seed. Its JSON exists only to reproducibly build a place containing `Workspace/DoorAssembly/Door`, `ControlPanel`, and `Workspace/PreservedScenery`. Those historical seeds contain deterministic `_forgeStableId` attributes, but the current index does not require them: arbitrary existing objects are observed through connector-epoch identities and are enrolled durably only by an approved transaction. Once opened, Forge consumes the current project index plus this exact prompt:

> Add a ProximityPrompt to Workspace/DoorAssembly/ControlPanel labeled “Toggle Door”. Each time a player uses it, move Workspace/DoorAssembly/Door straight up 8 studs to open or back to its starting position to close. Use server-authoritative code, keep the door anchored, and preserve Workspace/PreservedScenery.

No solution is present. No task or evaluator package exists for the fixture. `examples/orbital-freight-airlock` is the separate next seed: an interconnected physical airlock, empty networking folder, and empty HUD panel with no prompts, remotes, source, controls, evaluator, or prepared behavior. Its exact prompt and creator-run sequence live in [the fixture README](../examples/orbital-freight-airlock/README.md).

## Accepted live creator evidence

The Status Beacon vertical slice completed successfully in session `creator_session_ad50593a-e0f1-4651-95f4-c88b3b5f6242`. Plan `creator_plan_ea7f9617b3c2c33933fc2bc6` and change set `creator_change_set_9a546962a40226a512c86a76` sealed without repair. Planner AgentRun `agent_run_789d36a5-25a8-447e-9d04-fb417991fc21` and builder AgentRun `agent_run_a62cb929-4d7d-4f98-a2cb-b47356991d03` were both `locally_eligible`. Studio verification `creator_verification_f6a9c0c5f1b07e5a6b57eeb9` passed with no failure facts, checkpoint `creator_checkpoint_cb96fdbafb2f14f8aeac1e5d` committed revision `360c3e26d94c868fa2441badad2be1282b82ffa13f1729f7d88a523045c6aff3`, and creator review `creator_review_4ac1d95c5f5a797d8bc8bba9` accepted the result.

This establishes one complete prompt/plan/change/apply/check/review path in the predecessor storage and UI shape. The final snapshot bound the exact Part properties and Script source. The creator observed the visual placement and one-second green/red alternation; those remain creator-review facts rather than machine-observed color-series facts. The identifiers below are documentary: the later authorized deletion of `.forge` removed the local predecessor artifacts, and there is no current reader or replay claim for them.

## Door Control predecessor failures and accepted proof

The first Door Control run did occur and is documented as consumed failure evidence, not as a gameplay result:

- session `creator_session_65f2f12b-c178-46a7-bbf2-2c3943616915`, semantic session hash `2b879d319cf00b16ef14e14c437606f970540141f5439c9e03b5a5cd12af538c`, preserved file SHA-256 `a045e4771d46dc412b68796afa92bbebcd58912dc2f72b7c69ab3c30f58053bf`;
- predecessor classification `incomplete / post_apply_mismatch`, detail hash `124c67366b57a9c52d592133c851e9ce504f8eb117cffadbf931b9930762b612`;
- revisions `a327a746de9e38275f2736ba848ca27da353ab542cd765aeb6f32ff926ef8900` → `59c24b99628542d2f8bf535a43874bb2b15c348ab048385d2df851e24961ffa0` → `a327a746de9e38275f2736ba848ca27da353ab542cd765aeb6f32ff926ef8900`;
- plan `creator_plan_12fd84527d2ba0607734899c` (`12fd84527d2ba0607734899c3e572d457915997ff1000beaf7673a1faeb232e5`) and change set `creator_change_set_1e38c6b676df71acff9098df` (`1e38c6b676df71acff9098df6770ce721449ae3088fa6a0d3eae23926171182a`);
- planner `agent_run_7ad4a7f1-276d-4778-8283-66c781f12e37` / `trace_7a9d7781-e2ce-4dae-b4b1-681545c01154`, builder `agent_run_7c8f4812-6aed-4b15-b599-7f6441410fab` / `trace_46d932c6-1ac7-482b-92a2-a2d79d87e297`;
- no verification, checkpoint, creator report, or gameplay claim.

The predecessor writer accepted `ProximityPrompt.RequiresLineOfSight`, while its incomplete observer omitted that property and a string-based reconciler labeled the omission as a value mismatch. That classification does **not** prove Studio stored an incorrect value. It proves the writer/observer contract was open and reconciliation treated missing evidence as data. This exact failure drove the closed manifest and explicit evidence algebra.

The first closed-evidence retry also ended before mutation and is preserved as a separate harness failure:

- session `creator_session_5238ff32-4dbb-414a-bfa7-171b098d864b`, semantic session hash `acc6e39c978ce6cef34deb0aef28cee8555349e386d46c0d2fff1cbf539d9c9d`, bundle SHA-256 `391467561bd41a09330ea526a00b0a0992500657b72355c1dd28e3b2705ee452`;
- recorded classification `incomplete / project_drift`, detail hash `aa289261a799bdf6ca40e0f57a52a072d09b05427fb3934f41febee30645ba36`, with unchanged stored revision `fc941f29d11ff53c22c91726e15ec5a1901f7654bcc0b628d258bd69c4134723`;
- plan `creator_plan_82c044d062b9ee4127347888` (`82c044d062b9ee41273478882d14dd61286b5f131526a1d216325e106c1ef381`) and change set `creator_change_set_26718560532337ade2b64b4f` (`26718560532337ade2b64b4fc6e066b094ec1d77b9df0eacc0ec8fee854332ca`);
- planner `agent_run_e1f0edd5-6fd2-44a7-a6f6-a93cb4d25177` / `trace_bef17ecf-09f8-450d-bd67-a4b6eccf5b5d`, builder `agent_run_f0b8c8e7-1725-480a-b3da-579c673fc7a8` / `trace_7fd1478c-fe90-4b3c-a02f-69f1cbf3afca`;
- zero mutation attempts, verifications, checkpoints, creator reports, or gameplay claims.

That `project_drift` label was a false positive: `StudioStateRevision.stateHash` included the exact projection hash, while Apply deliberately rebound the same state requirements to the approved session, change set, approval, and dashboard view. Those incomparable revision domains had to differ even when Studio facts were identical, and the Apply-time envelope was discarded before persistence. Current revisions retain exact `projectionHash` provenance separately, derive `stateDomainHash` only from project/requirements/scope, and derive `stateHash` from manifest/domain/canonical facts. A genuine drift path now persists its complete pre-Apply projection, envelope, revision, expected/observed hashes, and failure fact before termination. This consumed run does not prove any Studio change.

The next Door Control attempt reached Studio's transaction boundary but exposed a plugin-settings durability failure before Forge received provisional evidence:

- session `creator_session_0fd7a7e0-b64f-450d-b6bd-0b4c98434373`, semantic session hash `a09540ff927565effc0977af085121234dc178e4582d73c1c7bf183b6b682a15`, current bundle SHA-256 `cc6790f62c7f2b1e4de927bd85bd9e36d0f3bef7dd7d05d7a59b12b809238d56`;
- change set `creator_change_set_8fe28fb341ad4d266f60adc8` (`8fe28fb341ad4d266f60adc8dcdacfb86b350bdd4e04122f1d3cddcfda355661`), mutation projection `creator_mutation_mutation_direct_readback_8fe28fb341ad4d266f60adc8` (`fdb86a803524cb78ae84be2851e28d072b2ec748694fb728f6c5edfc5fd49e84`), and before revision `f53382784f89ddd1ccc7534c1b3f87e027d93e08cdc9d78db02f4989b14fd875`;
- the coordinator cursor stopped at `applying / recording_may_be_open`, with zero finalized mutation attempts, verifications, checkpoints, creator reports, or gameplay claims;
- Studio's settings file retained the opening placeholder `pending_recording_creator_change_set_8fe28fb341ad4d266f60adc8` with `opening = true`, while the live plugin held Studio's different opaque recording ID. Reusing the same mutable table across `SetSetting` phase writes left the persisted cursor stale, and the later readback guard raised `provisional evidence persistence binding rejected`.

This is not a mismatch and supplies no durable claim about the resulting place state. Current connector code uses punctuation-free transaction keys, fresh deep snapshots, and immediate write/read verification at opening, real-recording, provisional, finalization, and acknowledgement boundaries. It refuses to mutate until the real recording ID is durably read back; if post-state or provisional persistence fails after mutation, the same call cancels the exact recording and must retain complete post-cancel evidence or report `recovery_required`.

After Studio and the control server were confirmed closed, that unrecoverable store was first moved to `/tmp/forge-creator-persistence-reset.id0CN3/creator`; the temporary copy was subsequently removed. A later clean reset created another current store. The creator then explicitly authorized deletion of the entire `.forge` tree, superseding those intermediate retention states. No active workspace historical or current creator store remains; cleanup was moved through the system Trash and remains recoverable until the Trash is emptied.

The corrected Door Control proof subsequently completed the then-current closed-evidence workflow:

- session `creator_session_fa375f4e-00ad-481e-af8c-ddd502d6d0a2`, final session hash `794b8e38d692acd44c26951afccd9bacf4a988398b2e054fe1cdc67d886e43c5`, status `creator_accepted`, started `2026-09-01T08:38:14.073Z`, accepted `2026-09-01T08:39:34.655Z`;
- request hash `e23896336d5b4c7da9ba9cd12a82c522de1292c91f2e6bfec421b806acbcbf1b`, plan `creator_plan_5aed53d2204146ad1e21642d` (`5aed53d2204146ad1e21642d5ffee64ef6363f8e65da110f379beb3237b8c2fc`), and change set `creator_change_set_14f0457ba6b75e3f03da1cd6` (`14f0457ba6b75e3f03da1cd6833550c8ec0c519d7ec0dcaa07d2d11f9aa19e4e`);
- planner `agent_run_4ee74b46-0a28-4fde-94e2-9a70dd34c90d` / `trace_bd611a9e-a642-4668-813e-60786437118d`, builder `agent_run_5729ecbf-1107-473b-b1ed-3faf8e8398d5` / `trace_cc345a28-60e6-44c5-8b1c-8753a34e6585`, with zero repairs;
- manifest hash `99a1c4f9db8a370ebf3beb536caa5211e5a54bc2b8044333d714047e2256b80d`; mutation attempt `creator_mutation_attempt_14f0457ba6b75e3f03da1cd6_1` (`83d2a714f68cf480782eaa366ba51e2061af74a4c149a3d27d6584943f7ddc29`) bound projection `00af936a08c0aac557318af427aecccc8bfdc083cf83dffbd1d235c0076a317a`, reconciled `matched` with no failure facts, and finalized recording `recording_4204850255683497953` as `committed`;
- before revision `f53382784f89ddd1ccc7534c1b3f87e027d93e08cdc9d78db02f4989b14fd875`, after revision `7a49e3f41313748027a9e1008127917fc0a460255f6fd42054f49477602245c7`, direct-readback hash `51e7b430d80ab245ab9f4c11d15845d2a804c14064725ec78ad2626525173fb2`, reconciliation hash `20ad1fbb52dcc2d18da0387c51d9083764b4883e30a611d29533c074f47bf6e2`, finalization hash `8700432e5c7a014a798aabc2fc6d75b812a45db55840d02b23afc48efbe72a38`, and post-commit evidence hash `9ab43442fbc5f6e0066d0081c7a545ea7d180c001ed5241ab7fbfd7c2a524c37`;
- verification `creator_verification_af0034c8cc325141a11ae352` (`af0034c8cc325141a11ae352397e766c7ed438645cd2bc9ee0bb8ac786e06863`) passed with no failure facts, using execution plan `studio_execution_plan_149ac23a2f5e4acc1a4134a2` (`149ac23a2f5e4acc1a4134a2588c968059bf0a5f526d3b9d910da07c8b8e40bd`) and complete runtime evidence hash `0a5d60462a7e530f5cd1153ec96be34722097781062b95d550ef6c264db2d5c1` with no diagnostics;
- checkpoint `creator_checkpoint_dbf22bfdacef48ffe9e60fb1` (`dbf22bfdacef48ffe9e60fb1ec13dc81a60bbc1367b739ca28ce0d84bbcff46e`) and creator review `creator_review_report_44e97f0e8f0aadd7df9fca60` (`44e97f0e8f0aadd7df9fca601ea03a28217f6b0e04b1f70d816440467cdf92c2`) were persisted; the creator accepted with report “It works completely.”;
- mutation replay returned exit `0`, `exact_match`, recorded/replayed `matched`; verification replay returned exit `0`, `exact_match`, recorded/replayed `passed`; both reproduced empty failure-fact hashes without a provider, network dependency, or Studio operation.

The machine evidence recorded at the time proved the exact approved mutation, complete projected state transition, bounded runtime observations, and diagnostic result. The creator's interaction report is separate creator-authority evidence and does not silently upgrade unsupported behavior into a machine-observed claim. At the creator's later explicit direction, the entire local `.forge` tree was removed. These identifiers remain a documentary ledger only: the underlying local artifacts are no longer present or replayable, and the next run starts from a fresh store.

## Capability completeness milestone

The offline capability-accountability milestone is implemented against the freshly pinned official source:

- official `Roblox/creator-docs` commit `d025c96bdb1c81570221997092fbe0ad94b5337c`, exact five-directory engine-reference tree hash `6df2b67ba4e5fdc4d24f245ee159a64a6575d7eea37f0819107141dfc9716d04`;
- normalized catalog hash `142406530e50b9c65fee0d7792e48aa22001e8697399820b43382dc5fdfe490e`, covering all 638 classes, 48 datatypes, 518 enums, 50 globals, 11 standard libraries, and their complete documented members/items;
- coverage hash `54e9ebcaa55030c5ab962f749316d0cf1c149a8b6edcf77cf1f01efcf231fec0`, with exactly 9,685 unique classified entries: 635 direct-authoring rows, 16 observable codec rows, 7,509 nondeprecated source-API rows, and 1,525 deprecated, hidden/NotScriptable, security-gated, or otherwise non-proof-closed restricted rows;
- current manifest hash `40638508b13ca4d0d9759c2a3ebd5a36af0f54d76c8e04290ef75899fd6560b9`, bound to evidence-contract hash `ffe622d01eba3ab1171db8587ed368a539a9bbc7bad2f1304fcf597facaf46c4`, enabling 33 coherent classes, 364 proof-closed writable property applications from 248 catalog declarations, and 13 generated engine-owned authoring containers. Selection, inheritance, and enum closure produce the 635 authorable catalog rows without duplicating manifest authority;
- class-aware catalog/member resolution, 25 canonical codec tags with cross-language TypeScript/Luau vectors, stable class-constrained Instance references with an explicit class-bound nil value, and fixed `instance.property` / `instance.property_series` runtime evidence alongside resolution and position observations;
- bounded pinned-catalog lookup available to both creator agents, plus authenticated CLI/control/dashboard exploration with official signatures, security/capability metadata, YAML provenance, source, coverage, manifest, connector, attestation, inheritance, codec, disposition, reason, and proof-route visibility;
- offline generation failure for source/catalog/coverage drift, duplicate or unclassified entries, stale output, and missing authoring proof legs.

The closure audit rejected three false-positive routes before this milestone was accepted: official `Datatype.Font` is no longer confused with the distinct `Enum.Font`; unset Instance-valued properties are canonical observed values instead of read errors; and properties typed with the deprecated `SurfaceType` enum cannot become authorable merely through policy-selected inheritance. The current connector build hash `3c626737bc156f27f209da5a1a4f938a9191269bd4d35070ab718b7bfd042e49` also binds the evidence generator and TypeScript evidence contract as well as the manifest, protocol, host transaction participants, plugin project, and authored Luau runtime, so a codec, platform-parent, project-index, runtime-lifecycle, or host-side transaction change cannot retain an old connector identity. The manifest now independently binds the generator plus TypeScript evidence and project-index contracts; changing canonical projection material therefore creates a new manifest identity instead of silently reinterpreting retained evidence.

During integration, the broader policy initially made the accepted Door Control bundle unreadable because build-contract and mutation replay validators compared stored evidence to the new global manifest. That was an evidence-lifetime defect. Live contracts remain a clean break, but immutable attempts validate their own sealed build policy and manifest artifact and recompile against that exact manifest. New authoring uses only the current generated manifest. Before the local store was deleted, the accepted Door mutation and verification again replayed exactly with exit `0`; no stored ledger byte was changed.

No current-manifest Studio attestation or mutation has been run during implementation. The documentary Door proof remains evidence for its exact then-current manifest, not live proof of the newly expanded rows; its local backing store was explicitly deleted later.

## Consumed capability-attestation rejection

The first live pairing of the expanded 183-property manifest was rejected
before session creation. Connector and manifest identities matched. Studio
returned 175 observed facts and eight `unavailable /
reflection_type_mismatch` facts for class references and one datatype alias:
`Beam.Attachment0/1`, `Trail.Attachment0/1`, `WeldConstraint.Part0/1`,
`ObjectValue.Value`, and `ImageLabel.SliceCenter`. The plugin had compared only
the internal `EngineType` spelling with a public API type and then discarded
the received type dimensions. This was collector/verifier drift, not proof of
an incompatible property. There was no creator session, provider call,
recording, mutation, verification, or gameplay claim.

The first correction removed plugin-side grading and retained the raw type
dimensions, but the backend still treated the catalog name as the expected
`ScriptType`. A second live pairing returned all 183 required facts as
`observed` with no missing, unavailable, or read-error facts, then rejected 69
numeric rows as `reflection_script_type_mismatch`: 52 catalog `float`, 15
catalog `int`, one `double`, and one `int64` all correctly had Luau
`ScriptType = number`. The consumed raw envelope is
`e3465e3a2ce81fbf33317af0a30253976ac25b800c581c5dcef79f2eaaab7c73`
under projection
`b52eef399c76c7f73e768de9fc9d402f7b7727eabc50d22462842ee1a1709d04`.
Again, no creator session, provider call, recording, mutation, verification, or
gameplay claim occurred.

The current clean-break manifest gives every row separate generated catalog,
engine/storage, and Luau script identities, plus enum or Instance constraints
when applicable. Every expected dimension is required: omission is incomplete,
and a contradictory present value is rejected. Numeric catalog subtypes retain
their exact engine spelling while mapping to Luau `number`; class, enum, and
datatype aliases remain explicit rather than heuristic. Rebinding the exact 183
raw facts from the second attempt in memory to this corrected manifest produced
`verified` with zero mismatches. That provider-free diagnostic did not rewrite
or promote the consumed artifact into current Studio evidence.

## Consumed creator-Stop rollback defect

The later creator-authored door-hinge run exposed a lifecycle defect rather than a build defect. Session `creator_session_2e5ac9c7-b9ff-4fc3-bd8d-a50720204f20` used plan `creator_plan_cc1ff023d8e48e431d0d00b2` and change set `creator_change_set_a0bb94897412608d6144cbc5`. Mutation attempt `creator_mutation_attempt_a0bb94897412608d6144cbc5_1` (`6f98e6624ae6bd3471209fd4c54467946de176c2ed4bb8e4b96060d641e5a2d8`) reconciled `matched` with no failure facts under reconciliation hash `54a82fabf7907912297412b9952426438b0d8bc4f3133785b6c415ebf0534c2f`; the provisional revision was `cc72ae82fb6bef67d1209484a91eae48b96ec0363eca663b59b696ac54b1cde5` from initial revision `eafa1e0929ed7990a0ef706e30311f87cceeaf10c6c50a3b02419644b0b0a778`.

The creator then used the hinge successfully in Studio and pressed the ordinary Stop control. The old creator path had started a programmatic `StudioTestService:ExecutePlayModeAsync` run and required the injected runner to call `EndTest` after its full observation window. Manual Stop returned `nil`, so verification draft `creator_verification_af96ac15dddfef82a3f13219` (`af96ac15dddfef82a3f13219e4fb70f1f3a65f9472577bb1996dd5286da347a5`) correctly remained `incomplete` but the coordinator incorrectly routed that infrastructure absence through its generic verification-failure cancellation branch. Finalization `creator_mutation_finalization_d4c6b8162ae8e345a407dcab` (`24299315629eac1d51d82eaf79b847d14e6abfb6741c2e2980b79fc254e48618`) cancelled recording `recording_12353536219018302493` and restored the initial revision. There was no committed checkpoint, final report, accepted/rejected creator result, replayable verification verdict, or machine gameplay claim.

The current clean-break creator path removes that contract. Apply persists and reads back an exact passive-runtime arm for the next ordinary Studio Play. The distinct Play Server connector validates that arm, executes generated manifest dispatch directly against the Play Server objects, samples concurrent series in memory, persists a terminal receipt on normal Stop, and transports the exact bound evidence. No runtime Script, source string, print prefix, or LogService result parser exists. The backend then requests an exact Edit-side transition to an inert finalization tombstone and waits for acknowledgement before grading. Stop-sealed technical incompleteness leaves the matched recording provisional in `awaiting_verification_retry`; only a hash-bound creator Retry or Cancel action may progress it. Terminal tombstones remain replayable until the mutation-finalization evidence graph is acknowledged. Creator verification never calls `ExecutePlayModeAsync`, never times out while waiting for the human to press Play, never silently re-arms, and never treats ambiguous runtime state as a verdict. Registered programmatic experiments use the same direct observer under their separate `StudioTestService` lifecycle.

## Consumed passive-Play lifecycle defect

Session `creator_session_772dca14-a0de-44f9-8cba-1cc8b6e989e9` (`1cb09369776bb82af173f19fdc54b0e5420be02aaa264cf0774df7a21c141ded`) used prompt hash `9a0068a2245da442904f7baf9887d9fc1a7bf3a43e2f9c5249b4f55b753631e8`, plan `creator_plan_b8cf02e59b446f09bee82035` (`b8cf02e59b446f09bee820355679033686af669f28912609698b2511bfdcdedc`), and change set `creator_change_set_f465161d825b4d2cd9fee691` (`f465161d825b4d2cd9fee69135856f5224593ebeb6039fa9a8225adea5b863ee`). Provisional attempt `creator_mutation_attempt_f465161d825b4d2cd9fee691_1` reconciled `matched` under hash `3701837eee400278954e2c850aa1557bad68afe6d7ea7e7d1f2d982505191669`, retaining recording `recording_380893068892191361` across revisions `959cc7a528565fa502087b1a181bee5ede7a7b1ae8566eee179509f3198314ec → 2862272f1e7b8b7fa5fbece8137f814ed6a3f564638aa4ed9977020452113111`.

The connector accepted execution plan `studio_execution_plan_5449b4bfaca53aae9d610c36` (`5449b4bfaca53aae9d610c36b0bf67356edd6efb06ef90dacdd2c64693cacfa4`) but emitted no `RuntimeEvalStarted`, runtime envelope, or `RuntimeEvalStopped` when the creator used ordinary Play/Stop. Verification draft `creator_verification_427983b2909e554bf2e4f924` timed out waiting for runtime start because the generic six-minute transport timeout incorrectly covered human Play latency. The automatic re-arm then produced draft `creator_verification_8294fa07db8e643232e4c29b`, rejected because the plugin still held the first exact plan. The creator reported that the hinge interaction looked correct, but this is creator observation only: there is no runtime proof, finalized mutation attempt, commit, checkpoint, review report, accepted/rejected verdict, or machine gameplay claim.

The first attempted correction—adding `EditModeActive`, `RunState`, Heartbeat, and bridge-loop polling—was rejected before release because it still assumed one in-memory plugin executor crossed Studio data models. The root cause is broader: `Main.server.luau` deliberately returned in running data models, while the armed executor and its signal connections lived in Edit, whose `RunState` did not represent the Play Server lifecycle. The durable correction persists the exact arm before Play, resumes it only in the Play Server connector instance, writes the terminal receipt before transport, and transitions it to an inert acknowledgement tombstone only after an exact backend finalization command in Edit. Creator authority has an unbounded pre-Play wait within the control-process lifetime; the sealed machine deadline begins only at the bound start. The dashboard reports `Observing Studio Play` from that exact request-bound start. Stop seals the actual sample prefix; visible series clauses state their sample count as a maximum rather than claiming every possible sample occurred.

## Consumed passive-runtime collection defect

Session `creator_session_74960890-f231-4b64-a0a8-6dba6b3be30f` proves that the cross-data-model lifecycle fix worked while its evidence transport did not. The matched provisional mutation is `creator_mutation_attempt_e44bc1e0fa8cb5a5c2d47d3f_1`; recording `recording_6704729960395439030` remains open at revision `a44aff6f541b1d0b98dfa74301e62d3ad1bff052d44e65513af6f3223cf54043`. Execution plan `studio_execution_plan_26a2a3546c22cfb97d0ba329` (`26a2a3546c22cfb97d0ba329302229aeee892d5e9ab5a332bcd67a6046bb81c9`) completed the full protocol sequence through `PassiveRuntimeEvalFinalized` for Play interval `2026-09-01T14:28:04.000Z → 2026-09-01T14:28:17.000Z`.

Runtime artifact `71bbe8c4560e8e4e533877f5c97524b646d3114439fdfa2c916d2e48aba4cd09` has envelope content hash `2fa70f34c81a0ca8b2214c0fc22360c50bea82d091938156336501f9345f4c59` and verification evidence hash `77b8756341bda5bed92a2c015e77dd291d960cfa19f49b08e1936086e90a78c8`. It is `incomplete`: all six requirements are `read_error / missing_runtime_result`, diagnostics are empty, and the Studio log contains no Forge checkpoint prefix. The injected runtime Script → `print` → `LogService.MessageOut` channel therefore produced no evidence even though Play/Stop and finalization succeeded. The coordinator then emitted a second `RuntimeEvalPlanAccepted` automatically and returned the dashboard to Waiting, falsely suggesting the first Play had not been detected. There is no finalized mutation, verification verdict, checkpoint, review report, or machine gameplay claim. The creator's statement that the hinge worked remains creator-authority observation only.

Passive Play v2 consumes that defect without rewriting its evidence. `DirectRuntimeObserver` now reads the sealed plan inside the Play Server plugin using generated manifest result dispatch, resolves all targets synchronously, captures one-shot facts and immediate series samples, samples all series through Heartbeat, and seals the actual prefix on Stop. LogService remains diagnostics-only. Exact projections define completeness by authoritative coverage (`observed` or `absent`), while pure graders own expectation matching. Technical gaps land visibly in `awaiting_verification_retry` with immutable interval/count/issue evidence and exact Retry/Cancel controls; the automatic re-arm set and every runner/checkpoint parser path are deleted.

## Consumed stale-finalization pairing defect

After the creator store and evidence contract were clean-reset, the rebuilt connector successfully paired and submitted its current capability attestation, but Studio still held an already-settled cancellation receipt under the removed `ForgeCreatorFinalizationReceiptV3` plugin setting. The connector replayed that historical body as `CreatorChangeFinalized`; the current protocol rejected its old manifest-bound projection with `400 Invalid CreatorChangeFinalized payload`. Setup aborted before `CreatorRecordingRecovery { recordingState: "none" }`, so Start Request correctly refused to call a provider and reported that the paired connector had not supplied durable transaction inventory. This was a pairing-order/contract-lifetime defect, not a new request failure, open recording, Studio mutation, or place-state claim.

The clean-break repair replaces the numbered transaction keys outright, so the removed settings are neither read nor migrated. Settled receipt and rollback metadata with a noncurrent manifest may be discarded locally because they cannot represent an open recording and clearing them performs no Studio operation. A possibly open cursor is instead retained and fails pairing closed: Forge neither drops it nor substitutes a fresh projection from a different manifest. The exact manifest-bound connector must recover it before upgrade. All current recovery, finalization, and acknowledgement messages require the current manifest, and the connector persists both recovery projection and evidence hashes before a proved-closed acknowledgement can clear the cursor.

## Consumed planner parent-topology defect

Orbital Freight Airlock session `creator_session_c7e9722e-1fb9-434f-8293-6f37d030e00c` (`113318f5daed2eb313663be15fe7f07ac81f470bd407a6fe6a7083aa7c02549b`) ended `incomplete / PLAN_NOT_PUBLISHED` before approval or Studio mutation. Planner AgentRun `agent_run_2e3dfabe-e785-4c78-aee5-e1ca884d6b3a` is stored as artifact `4bfec765e58043db3945908a63ed83d31fa7c54effa16e6ca5dce5fa0733cf1a`; trace `trace_f1d1bd0d-c40c-40b8-8575-26afc51196e1` is artifact `8000300eb12556ad32eb308fe36e6236fda78009e3c9658304ad54c6ad62450f`. The run used six of 32 turns, 26 of 256 tool calls, 54.144 seconds of 30 minutes, 96,569 of one million input tokens, 5,136 of 128,000 output tokens, and USD 0.01302488 of USD 10; no budget was exhausted.

The model's final `creator.propose_plan` covered the requested interconnected change, but Forge rejected two otherwise authorized outputs: `ServerScriptService/AirlockServer` because `ServerScriptService` was absent from mutable project evidence, and `StarterPlayer/StarterPlayerScripts/AirlockClient` because `StarterPlayer/StarterPlayerScripts` was absent. The policy already allowed those roots and Studio authoring could resolve them. The contradiction came from treating engine-owned topology as though it had to be a Forge-owned mutable instance. The tool returned only the generic `PLAN_INVALID` message, and the following empty `end_turn` made the recoverable rejection terminal. No plan, approval, change set, recording, mutation, verification, report, gameplay claim, or Studio operation exists for this session.

The current manifest now contains one generated, catalog-validated `authoringContainers` topology for every allowed service root plus `StarterPlayerScripts` and `StarterCharacterScripts`. These containers authorize parenting only; they are not mutable project-index facts and do not become Forge-owned instances. TypeScript plan/change validation and generated Luau preflight share that table, while the plugin re-resolves the exact path and class immediately before recording and again at apply. Every other parent requires exact identity/path/class membership in the complete Studio-document-owned initial index; parent classes need not be authorable and acquire no mutation authority. Parent rejection now returns the operation ID, kind, target, parent, and observed authority facts. Independently, the native runtime issues up to two bounded mandatory completion repairs when any tool host reports an unsealed phase, so a recoverable tool rejection is not silently converted into a terminal `end_turn`.

## Consumed builder verification-topology defect

Orbital Freight Airlock session `creator_session_1c9a435d-bde2-4121-8f20-fc7101c576fb` (`495bbeaf15c7d0e6e50eb93337499154d6cd015b8f99bb0e6132c5ad75e2d45d`) ended `incomplete / BUILDER_LOCAL_GATE_NOT_ELIGIBLE`; failure detail hash `ab87dc2410427c50f309ad8d22393558e7505c7bf95b16a67806908bd5c37634`. Plan `creator_plan_067dfb1c571eedb14eeff490` and approval `creator_approval_af1068a39473324eac0c659c` sealed. Planner AgentRun `agent_run_1879c78a-c147-40aa-bf10-374f7df0b459` / trace `trace_fc0be05c-61fe-481e-8f61-31798476b1c0` were locally eligible. Builder AgentRun `agent_run_b031d14b-6592-4b73-b72a-87771c4f120d` is artifact `f0c1305165c4c7b326267d5e669877ca304d0b3f40850059026f8b17548e6ad9`; trace `trace_c58c8b2b-1b85-4595-83de-bc9edf5e273c` is artifact `ff0d446a7af27d4dbca8462e0c9721870e6e61254cb22945c8cd679f7dc2df20`. It staged all 25 approved operations and used 14 of 32 turns, 58 of 256 tool calls, 137.623 seconds of 30 minutes, 550,603 of one million input tokens, 13,911 of 128,000 output tokens, and USD 0.03906424 of USD 10. No budget was exhausted. No change set, Studio recording, mutation, verification, checkpoint, report, or gameplay claim exists.

All three local verifier calls falsely rejected the same two valid module imports. The creator verifier wrote each staged source under an operation-ID filename and asked its generic synthetic Rojo fallback to infer topology. That fallback flattened `ReplicatedStorage/AirlockSystem/Protocol` to an unrelated `ReplicatedStorage` child, so Roblox-aware Luau analysis reported `Unknown require: game/ReplicatedStorage/AirlockSystem/Protocol` in both the server and client sources. The model received only `LUAU_TYPE_ERROR` plus a random temporary filesystem path—not the message, range, logical Studio path, or plan-change binding. Its corrected `c09` and `c10` source proposals were then rejected by the virtual staging layer's write-once `PLAN_CHANGE_DUPLICATE` rule. Repeated verification hashed the random temporary directory into each issue, so identical diagnostics also acquired different identities. The two mandatory completion repairs could not overcome those host contradictions.

The current verifier builds one exact post-change DataModel topology from generated engine-owned containers, the bound initial observation, and every staged create/move/delete/update/source operation, then mounts each staged Script, LocalScript, and ModuleScript at its approved logical Studio path before Roblox-aware analysis. Model-visible diagnostics contain stable logical paths, exact ranges, bounded messages, and plan-change/operation bindings; temporary host paths are removed before hashing. A valid `studio.stage` call for an already staged `planChangeId` atomically replaces that virtual proposal, resets the local gate, and leaves the previous proposal intact if validation fails. `studio.diff` exposes the current plan-change and source hashes. Replaying the exact 25 stored operations under this implementation is `eligible`; only the two pre-existing unused-symbol warnings remain, and repeated verifier calls produce identical issue hashes. This is a local diagnostic replay, not new provider, Studio, or gameplay evidence. The consumed session remains unchanged and must not be resumed.

## Consumed builder progress-epoch defect

Orbital Freight Airlock session `creator_session_fcd59d97-b225-4790-899e-45a8d1e32540` (`29f3140eb733774eee6464bcfa40738bf98a4e8e7d3d652c5d6aabfa510ff18d`) ended `incomplete / REPEATED_NO_PROGRESS_TOOL_BATCH`; failure detail hash `7b4fba48f31b5aa49052186e44289e7954d95520c705d947fab6b06c81c8b6d8`. Plan `creator_plan_5122e0c431c93531b0b6f47a`, approval `creator_approval_88f6a300f7733408d5958378`, and build contract `creator_build_contract_a736e8c4324945ae665e04a9` sealed. Builder AgentRun `agent_run_5c6f742f-4271-445c-b250-109076bad938` is artifact `71da36e2f784551aa38448dfc30a2ea72a71c12c67bb2f31e36d1ec1e51ad243`; trace `trace_5d0f5cee-04a5-4b9c-ad71-cb76a06dce6a` is artifact `5c188d46920bd54d7d15154e44d431eead4e54efcda5b3868ea0671af0ed75e8`. The 12-turn run executed 73 tool calls, staged all 24 approved operations, repaired its source after the first eligible gate reported warnings, and reached a second exact `forge.verify` result of `eligible` with no issues. No change set, Studio recording, mutation, verification, checkpoint, report, or gameplay claim exists in the consumed session.

The terminal classification was a runtime bookkeeping defect. `studio.diff` appeared once before the final accepted stage-and-verification transitions and once after them. The no-progress counter fingerprinted only the tool batch, so those identical reads collided even though the builder host's accepted staged-state/local-gate token had changed and the host was already seal-ready. No-progress identity now includes that exact progress token, and every accepted state transition clears the prior chronological epoch even if content later cycles to an earlier hash. Repeated calls inside one genuinely unchanged, unready epoch still terminate. On the first no-progress batch, an exact tool-host completion check is authoritative: a ready host seals without another model turn, while an unready host remains subject to the repetition bound. Deterministic local re-execution of the recorded 73 calls under the corrected runtime completed and sealed 24 operations as `creator_change_set_97252149b3502ad6a5486f80` (`97252149b3502ad6a5486f80c9e27cbd3a1f83016764889708f85d676ace4322`) with an eligible empty-issue gate. That replay proves runtime/tool-host behavior only; it is not added to the consumed session and is not Studio or gameplay evidence.

## Consumed planner varied-failure-streak defect

Orbital Freight Airlock session `creator_session_e1889118-4956-47d0-b7dd-faa40c7f86e0` (`4c493e12fefb9eee9025669821e467bd089afb538f9e6b24feec038d243db7f2`) ended `incomplete / CONSECUTIVE_ALL_FAILED_TOOL_BATCHES`; failure detail hash `6009bfc0886f3503ba0c6cf43fdd8c3193ed4677e470bd99740d2f5f6eb1db81`. Planner AgentRun `agent_run_6501bc40-4da6-4819-a972-c17b09fb618c` is artifact `694bfb598e335c8fd34aed6fd7809fa3564339a85df6db816f957a2c44cd4350`; trace `trace_40893ec6-ece7-4bd0-91f7-21ae554cc259` is artifact `3236675a2ebb931e437906a54432014c83e92eeb2143f575f113730478b56fea`. The six-turn run made 22 tool calls over 96.648 seconds and used 86,636 input tokens, 11,428 output tokens, and USD 0.01986648. No plan, approval, change set, recording, mutation, verification, checkpoint, creator report, or gameplay claim exists.

The three terminal proposal calls were not repetitions. The first tried to create the already-seeded `ReplicatedStorage/AirlockSystem`; the second bound an existence check to the wrong planned prompt path `Workspace/OrbitalFreightAirlock/CargoScanner/CoolantPrompt`; the third corrected those facts but supplied position-series capacity below the declared 90-second creator observation window. Each call produced different exact validation feedback and the planner was still changing its proposal. The runtime nevertheless treated any three consecutive failed tool batches as equivalent to no progress and stopped before the next correction. That classification was unsupported: distinct failure evidence is not an infinite loop. The fixed runtime removes the varied-failure streak entirely. Exact repeated rejected batches bind the current chronological host epoch and canonical feedback-result hashes; exact repeated executed batches bind their canonical result hashes and unchanged epoch. Accepted state changes clear both histories, including A → B → A cycles. Otherwise the shared 32-turn, 256-call, 30-minute, token, output, and cost budgets are the sole logical bound on repair. The generated planner prompt and proposal-tool description now state the exact cross-field position-series formula before proposal rather than revealing its 90-second capacity only after rejection. The consumed session remains unchanged and cannot be resumed.

## Consumed finalization-inventory race

Orbital Freight Airlock review session `creator_session_f661face-4c53-4bd7-ae9d-4ba3ff45756b` reached `preflighting` and Studio rejected `PrepareCreatorChangeSet` before preflight, recording creation, or place mutation with `SECURITY_REJECTION: creator prepare requires acknowledgement of the prior finalization receipt`. The receipt belonged to already-settled cancellation session `creator_session_8c0c5e3e-0725-4bab-94ce-16b5583c6089`, change set `creator_change_set_65a0acaafb29425405e5d887`, and recording `recording_12791897696750865225`. It was a notification obligation, not an open recording and not evidence about the new change set.

The connector correctly replayed `CreatorChangeFinalized`, but then independently emitted `CreatorRecordingRecovery { recordingState: "none" }`. The coordinator ignored the replay because its historical bundle had been removed, accepted the later `none` as globally clear, and allowed a new request. This collapsed two independent durable phases—possibly active recording cursor and unacknowledged settled finalization receipt—into one lossy readiness bit. The plugin's Prepare guard caught the contradiction, so no Studio mutation occurred, but the coordinator left the new session misleadingly live and surfaced the rejection as a control-plane error.

The current clean-break protocol treats transaction inventory as both dimensions. Pairing reports a retained receipt first and suppresses an unrelated recording scan. Forge stores every receipt even when its original bundle is absent, blocks Start and Apply, and sends the exact acknowledgement. Only the plugin's fresh inventory report correlated to that acknowledgement can release the receipt gate; stale or uncorrelated `none` remains blocked. Per-Studio-session inbound processing is serialized across async artifact writes, so overlapping or duplicate deliveries cannot recreate the same ordering bug in memory. Apply checks the aggregate gate before approval consumption and again immediately before mutation. A command failure while still in preflight now closes the session as `incomplete / creator_preflight_protocol_failed` rather than stranding it in `preflighting`. This repair acknowledges settled notification state only; it does not repeat commit/cancel, infer place state, or operate Studio.

## Consumed chronological rollback/finalization-tail defect

Orbital Freight Airlock session `creator_session_3b4e5065-924d-4127-ac25-186bf1f1bc25` provisionally reached revision `fcf1ff85e0b0681cad81f19397fea8deceab8ff7ec0972b867e7979c372ad11e`. Complete Play envelope artifact `74d3275b28a1a79f03d51df0895f10b6ec3b9a8a2790632a0e0a7da2ad6f44ef` covers `2026-09-01T18:09:07Z` through `18:10:16Z` with 28 facts and no diagnostics; both projected door position series remained static, so the declared movement checks failed on complete evidence. Studio then cancelled recording `recording_11683387525020547070` and proved the exact initial/final revision `857705cdd8e60a316a0d2c8740cf1b7c889f5c93514c4e2cf23eb7a0111fe036`. Settled mutation attempt `creator_mutation_attempt_3cff7185340aec8554aa4a1c_1` (`212d23a3e58cc80cbd42c0550b128ba35446d3018cc7306614adb3f43ad23714`) and cancellation finalization `creator_mutation_finalization_33eaae3fac8ae1a7f31db2dd` (`ddf6703b98d702a2597887c9b73604e6b6f22178993cb43311a28c0f26ee99a8`) were persisted. There is no commit, checkpoint, creator report, accepted result, or machine claim that the airlock interaction succeeded.

The coordinator incorrectly treated observation history as a uniqueness set. Because the rollback observation was byte-for-byte equal to the initial entry, it suppressed the legitimate third A → B → A boundary; bundle validation then saw the provisional B entry as the tail, rejected persistence, and stopped before acknowledging receipt artifact `558a6799270b281bd4b7f044cf6e71093c127f6610b82b74b23390dbfa357032`. The dashboard remained in `repairing` while the durable bundle remained `cancelling`, and Studio correctly blocked a later transaction on the unacknowledged settled receipt.

The current implementation keeps chronological history, suppressing only a consecutive duplicate. Startup provider-free replays any already-settled attempt whose session tail was interrupted, appends its exact final state, and ends the cancelled workflow incomplete without retrying Studio or a provider. Finalization routing snapshots exact waiter ownership when a receipt arrives; a request ID whose waiter has expired is not mistaken for a live owner and is recovered/acknowledged centrally. The existing accepted artifacts were copied to a temporary store and exercised through startup recovery, producing the exact history `857705cd… → fcf1ff85… → 857705cd…` and terminal `incomplete` state without a Studio operation.

## Consumed source-write acceptance defect

Orbital Freight Airlock session `creator_session_2d742e6d-8338-4da0-8702-ca147cfa2839` (`c17020a43a4f6a3f8d6e8bdc2e9d1b46ed51ef50b15c71d762475cb0655762c`) ended `incomplete / creator_preflight_protocol_failed`; detail hash `ac4a560ea213339194c8e4c7b9d4500c56399a885a2bc3d8181f0cfd2eb48451`. Plan `creator_plan_9f313ce688ffc6f8006a9ebe`, change approval `creator_approval_e35bc0955cc115912b493e0f`, and 18-operation change set `creator_change_set_9d59b1d172076ec2f452ca7a` sealed. Its three source manifests were retained under hashes `9985c4a8…25a09`, `c3ae0be0…6c543`, and `f0063249…2c67`. The pre-Apply index exactly matched revision `ec258aa0…bf12`; Studio then rejected the source-write completion handshake with `source-write blob is absent or incomplete before Prepare`. There is no `CreatorChangePrepared`, verification, recording, checkpoint, review, or gameplay evidence. Forge therefore makes no claim that Studio changed.

The durability repair was exercised by a fresh retry. Session `creator_session_ba53e6bb-f80d-4271-bba2-6ab22341991c` (`c020434d7723eba7194d660661eb5ce296c37a759083e8b7536eba13bab8a7f5`) ended with the same classification and detail hash against exact revision `75e92d2c50797b7eb9e60b0ed12c42daf07c0f443b12352bbe1e976f03c3675e`. Plan `creator_plan_6848a0eb9f171aca8bf3616e`, approvals `58f86cef…82cf` and `89d57a28…ed71`, and change set `creator_change_set_83aa168caf3342f623f80242` (`83aa168caf3342f623f80242872e826484382695eee0588af10e188128eee984`) sealed. All three source bodies were retained under manifests `5f1888b8…7d787`, `707e41c9…f070d`, and `b845ca77…14a88`. This time Forge durably recorded mutation attempt `creator_mutation_attempt_83aa168caf3342f623f80242_1` (`4e36a368157a5afb2ee2e0169efcc10ad24d6b88ab0a9cb1e40cf83d36db8006`) as incomplete during preflight, with failure-fact hash `6fd7fb4c…a8663`. There is still no preflight envelope, recording, place mutation, verification, checkpoint, creator report, or gameplay claim.

The underlying defect was a reversed state transition in the connector, not bad generated Luau. `completeSourceWrite` passed the fully assembled capture to `resolvedSourceWrite`, whose authority guard accepts only an already-complete capture, and set `complete = true` only after that call returned. Every valid transfer therefore rejected itself before it could emit `CreatorSourceWriteBlobAccepted`; the phrase “before Prepare” described the guard boundary, not proof that the Prepare command ran. Audit of the newly reachable success path exposed a second contract violation: the acknowledgement body omitted its required `requestId`, so the bridge would have rejected it before the host could authorize Prepare. The current connector has an explicit request-bound `receiving → accepted` state machine: it verifies fragment bounds/count, complete piece coverage, chunk order, hashes, byte coverage, UTF-8 body length, and final source hash while still receiving, crosses the acceptance boundary exactly once, and emits an acknowledgement carrying the exact request and immutable source binding. Prepare may resolve only accepted bodies from that same request. A new request may discard abandoned mutation-free prepared/source state, but no source graph can cross request IDs and no recording state is cleared. The executable plugin regression calls the production transition, proves verification precedes acceptance, validates the acknowledgement binding, and rejects a duplicate completion.

Build identity closes over all transaction participants: protocol, evidence contract, Studio runtime, bridge, creator coordinator, source transport, plugin project, and authored plugin modules. A rebuilt connector cannot pair with a stale host transaction implementation. `forge` also refuses to launch from stale `dist` using a content hash of its compile inputs. Source transfers require one exact request-bound acknowledgement per immutable blob before Prepare, and unrelated `PluginError` messages cannot fail the transaction. Any exception after the exact pre-Apply projection exists persists an incomplete mutation attempt with its manifest, attestation, change set, projections, before-index capture, and failure facts before the session becomes terminal.

The trace also exposed an independent stream-correlation hazard before it produced a false verdict: Prepare, preflight, and Apply each published a complete index under the same request ID, while the host router accepts one stream per request. The connector now performs those three revision guards locally and publishes only receipt-bound post-apply/finalization captures. Thus an earlier unchanged capture cannot be consumed as post-mutation evidence. This consumed session remains terminal and is not rewritten or resumed; retry requires a fresh request with the rebuilt service and connector.

## Consumed creator projection-binding defect

Orbital Freight Airlock session `creator_session_b008fa41-ed6c-42b5-a565-d965603233b0` (`2121079b167d8c066f10333a6337b37f016cedf09d7de40782e5bc01bb8e02a3`) ended incomplete after exact change approval, with detail hash `439d713ad0a1da9eabb3a1641e2966fd2da9078b126f6c77fb930b00e192c5d0`. Plan `creator_plan_75c7d7f337d81dcdaa5ce781`, change set `creator_change_set_a73b098654ae3e216a54e939`, and mutation attempt `creator_mutation_attempt_a73b098654ae3e216a54e939_1` (`2d2e489493e04e0d8f477f794aa07e4671fcc0c08852ecf549145bfcd6672d38`) are retained. The pre-Apply index exactly matched revision `2c10476c5dad6d9671770f8ce2ca2235374aabd7c54f8fb4bdc18e864924befa`, and Studio acknowledged all three immutable source bodies. The plugin then rejected Prepare because the sealed projections correctly carried `binding.revisionHash` while handwritten Luau checked the unrelated runtime-plan name `binding.projectRevisionHash`. Failure fact `ae3126ed5092b4b80c7a501a8da9c85212847438551661fe25365616d2accc40` records that self-rejection.

No `CreatorChangePrepared`, detached preflight, ChangeHistory recording, Studio mutation, direct readback, verification, checkpoint, report, or gameplay evidence exists. The old attempt phase called this broad region `preflight`, but detached preflight did not execute. The current clean-break repair generates and validates one exact mutation-binding field set in both TypeScript and Luau, distinguishes source transfer, Prepare, and detached-preflight failures, retains commands until hash-bound plugin acknowledgement, and revokes stale asynchronous transaction continuations when Studio reports external activity. The consumed terminal session is evidence for the predecessor defect and is never resumed or rewritten.

## Consumed opaque-index authoring-boundary defect

Orbital Freight Airlock session `creator_session_c5bdf9f6-23a0-4494-be4e-3832dbcd2348` (`dc758f6d1952985f675ff570e9e4d6efb97cfed129c3000ac06acf2bc05ceef6`) ended `incomplete / creator_prepare_protocol_failed` after exact change approval. Plan `creator_plan_5bb5ff2737b2daae02da5447`, change set `creator_change_set_b0e07a83c489cf536129863d`, and mutation attempt `creator_mutation_attempt_b0e07a83c489cf536129863d_1` (`90ea294b63569f4e994f7cd71597f7aaf4899e0b75ef0ba22b0dbecb0ffc3597`) are retained. Its pre-Apply project revision was `2142915e1e47d0a9ef8160e93ce93582317f1f5d361fe0e5fd478d77a5cfba1e`; all three source bodies were accepted. Prepare then failed with failure fact `267ece69ce1804fa5279d1f5e19556a496cdb2bf4323eba8babe9450fc735ee3`: `mutation target outside manifest`.

The approved mutation targets were inside the authoring manifest. The generated Luau recompiler instead passed every node in the complete existing-project index through the authorable-mutation-target validator. A complete index intentionally includes non-authorable but observable classes—including service roots, `Workspace/Camera`, `Workspace/Terrain`, and existing `Snap` objects—so the first such node rejected the whole otherwise-valid Prepare. This crossed two distinct domains: opaque project inventory and typed authoring authority.

No `CreatorChangePrepared`, detached preflight, ChangeHistory recording, Studio mutation, project change, verification, checkpoint, creator report, or gameplay claim exists. The repaired generator validates every indexed node as an opaque identity/path/class record, and applies manifest class/property closure only when a node becomes an actual mutation target or projected writable fact. Cross-language regressions compile a valid mutation against an index containing unsupported classes and separately prove that an unsupported mutation target is still rejected. The terminal attempt is not resumed or rewritten.

## Consumed duplicate projection-authority defect

Orbital Freight Airlock session
`creator_session_c66d60b9-ec72-4faa-a0bf-f026f302ea42`
(`4289d2046e3b9590b1d4e7a07a8c43e669067c4d5225143ebfd8c2af8b36cbc5`)
ended `incomplete / creator_prepare_protocol_failed` after exact change
approval; detail hash
`79852e231c6ad8cdf025647f82e3c28962647864eee6dbb4fad22a9211020831`.
Plan `creator_plan_71ac8ef8c4fb4f248ba737b2`, 24-create change set
`creator_change_set_c47c3edfcfc62cc60db34a0d`, and attempt
`creator_mutation_attempt_c47c3edfcfc62cc60db34a0d_1`
(`b160d5e3e3ebefab9c30beb2a68d7b47a36a21df0838c5b29d5e086c5e32e444`)
were retained. The complete pre-Apply index exactly bound revision
`4aa624d50df07311545770dadd95acff737bc029e2aae5e766eeadd4ac97bdd8`,
and all three source bodies transferred successfully. Prepare then stopped at
the production generated recompiler with `mutation projection project-index
recompilation mismatch`.

The host correctly omitted an optional `allowedProjectDelta`; the plugin
recompiler always synthesized a nonempty one for this create batch and then
compared the two projection hashes. The field duplicated authority already
derived from the approved operations during reconciliation, so no producer
could make this path generally reliable. The clean replacement removes it
from both languages and makes mutation requirements the only projection
material. It also derives delete consequences through exact parent identities,
including structural absence of opaque descendants without granting them
write authority. Current offline evidence includes a TypeScript-to-production-
Luau conformance gate across both projection purposes and a semantic replay of
this exact 24-operation payload. Neither is a Studio mutation claim.

There was no `CreatorChangePrepared`, detached preflight, ChangeHistory
recording, Studio mutation, after-index capture, verification, checkpoint,
creator report, or gameplay claim. This terminal session remains unchanged;
only a fresh request with the rebuilt connector can produce live evidence.

## Consumed structural-parent authorability defect

Orbital Freight Airlock session
`creator_session_2e5812aa-60f8-497c-8827-20048aca349c`
(`0db9e3df16e4b6987adbae63a3ac7bf2a6221bf5f948120c91bf6d98481719f0`)
ended `incomplete / creator_prepare_protocol_failed` after exact approval;
detail hash
`cc45fde98416bb47edf8c5149d514ca804d2e5507f955f2ff5f3ecd14ffa148f`.
Change set `creator_change_set_bfe11e69a6cc2f4ba6904342` and mutation
attempt `creator_mutation_attempt_bfe11e69a6cc2f4ba6904342_1` retained the
19 approved create operations and the exact complete before-index. Prepare
failed on operation `creator_operation_cde6a941ba5b618548d0f699`, a valid
`LocalScript` create beneath the existing exact
`StarterPlayer/StarterPlayerScripts` identity, with failure fact
`eeb9451a54b8c197b876d2d0664d223ce29e340344495e3ff9d8857ea6476079`:
`mutation target outside manifest`.

Every actual mutation target was authorable. The production Luau recompiler
incorrectly converted the existing `StarterPlayerScripts` parent into a
mutation target, even though that class is deliberately only a structural
container. This was the remaining dual of the earlier opaque-index defect:
index membership and exact identity authorize a containment edge, while
manifest closure authorizes changing the target. The current generator has
separate structural-anchor and authorable-target paths. Its cross-language
matrix covers create and move under an indexed non-authorable parent, missing
parents, an unmanifest mutation root, and an authorable delete whose opaque
descendants remain structural absence evidence. `StudioOwnershipMap` no longer
stores the misleading redundant `writable` boolean; it records only the exact
persistent writer, leaving manifest authorability as a separate proof.

There was no `CreatorChangePrepared`, detached preflight, ChangeHistory
recording, Studio mutation, verification, checkpoint, creator report, or
gameplay claim. The exact retained payload reproduced the production failure
before the repair. This terminal attempt is not resumed or rewritten.

An independent parity review then found one further canonical-order split
before live release: TypeScript permitted an update or move of an existing
object to reference a newly created object before that create operation, while
the generated Luau transaction graph correctly required the create first.
TypeScript now carries the same non-create-to-create reference edge. References
among created objects remain edge-free because StudioAuthoring allocates the
entire detached create graph before opening a recording, preserving self,
forward, and mutual references. The production TypeScript-to-Luau Prepare gate
now covers both cases, so either implementation changing this rule alone makes
the repository test fail.

## Consumed live project-index coverage and transaction-notice defect

The rebuilt connector then crossed the entire boundary that had failed in the
five preceding post-approval runs. Live Studio session
`creator_session_68189112-eb83-4b13-b762-6f40ec7bda48`
(`6ce12135fd6073281b7690e04347c65e2d242f73b3fb4ea2f343fc83e73ef010`)
sealed plan `creator_plan_2dbb7d47c429f7cb38126df6`, change set
`creator_change_set_94ef8a48055a1fad1e839044`, and exact approval
`creator_approval_7840a0ec8638c65908f2c374`. Studio accepted all three source
bodies, emitted `CreatorChangePrepared`, passed detached preflight, opened
recording `recording_7501576164658514536`, applied the 18 operations
provisionally, produced complete direct readback, and emitted
`CreatorMutationProvisional`. This is the first live evidence that the repaired
Prepare role algebra works in Studio; it is not an accepted-product or gameplay
claim.

That run exposed a later observer defect. Direct-readback artifact
`7bdf8123ba5651b0c183ba8eb5a064277fae949f4df0cbaf2e8ece2883e136d2`
was complete with 87 authoritative observed facts under evidence hash
`db5a15164d6db57b8fc47d0db27e7a7ebf7296fe3fbb51f9c285ce224d4fb35c`.
The separate project-index collector, however, iterated a name-keyed generated
property map as a sequence. Every manifested node consequently advertised an
empty property coverage set. Pure reconciliation artifact
`c218686ae9ab5030f86545295beb1a6cfe5ceadd3c48079e2c495dd4b5f0476b`
therefore produced the false `mismatched` result
`0e7020b4d53c34378453bacb321be1018639169c9bfe6cdacd8c8969cad19d6a`
with 66 `approved_property_not_reflected` facts. Those facts prove that the
observer omitted its declared coverage; they do **not** prove that Studio
stored any wrong property.

Forge requested exact cancellation. Studio durably records that
`FinishRecording` returned for the cancellation, but post-cancel index evidence
and the host acknowledgement were not completed. A delayed property/attribute
notification arrived while that index was being collected. The host then
rejected the otherwise valid notice because two packages carried different
closed reason vocabularies, and it had already revoked authority before
semantic validation. The session ended `recovery_required /
studio_transaction_interrupted` with detail hash
`f5927086a8d3432dfb829177e66114e201101a1ecd5535db99b22bada01b182a`.
No mutation attempt was settled, no verification ran, and there is no commit,
checkpoint, creator report, gameplay claim, or durable proof yet that the
initial place revision was restored.

The repair is architectural rather than a delay or event-name exception:
generated project-property metadata is an ordered first-class contract;
project-index validation requires every applicable manifested property exactly
once and class-validates every value; mutation replay rejects missing coverage;
Studio signals are matched only to exact object/field/source and recording
identities; and an external-change notification remains an advisory dirty hint
until a complete read-only project index confirms whether transaction state
actually changed. The exact opaque recording identifier is the third argument
of `ChangeHistoryService.OnRecordingFinished`; the human-readable recording
name is never used as authority. An unchanged confirmation is stored as
immutable evidence and permits the already-authorized transaction to continue;
changed or incomplete confirmation fails closed. Neither outcome retries,
commits, or cancels Studio automatically.

## Consumed size-dependent project-index publication race

Two adjacent live requests isolated the remaining post-approval failure. Door
Control session `creator_session_ef58d226-2043-4115-a14c-99ef8d8b1098`
completed as `creator_accepted`. Its change set
`creator_change_set_7a5a8eb5e81645de50480f4a`, mutation attempt
`creator_mutation_attempt_7a5a8eb5e81645de50480f4a_1`
(`c71c7ce20b8fc8ad94b835c8b2eb87177260d0f217dc1dc90f2a7b66d58dbcaf`),
reconciliation
`780c15e6347fd2ed2daf91fef94258312c9a0d1c863742964cb1ab5a12725224`,
passed verification `creator_verification_1a1458830ce1bac6932f8b37`, commit
finalization
`a4c5cdf3eec325c246bb3e6a8c6dae0af6295139f2b37b80b5283ab4cb10d094`,
checkpoint `creator_checkpoint_c03a51f1aa8a71ef20d04727`, and creator
report `creator_review_report_faf173968aa32a3875b26466` are current accepted
evidence. A delayed property notice at detector epoch 28 was confirmed by a
fresh complete capture as unchanged at revision
`5b13df7c59369b8a8dd1cfaf6428787b582a0364b5057537f0b1f9fe8297f05d`.
The creator report “It works” remains creator authority rather than a machine
gameplay claim.

Orbital Freight Airlock session
`creator_session_af4eba03-9780-401b-9c28-c0ea770c1849` used change set
`creator_change_set_fe7d7528f3c19b60fe2da48f` and completed detached
preflight under evidence hash
`6dbc8a754362954c36604c8d6950aaec9f82b75e06609bf30edc21b35a63c7ed`.
It then stopped before a provisional receipt with active attempt
`creator_mutation_attempt_fe7d7528f3c19b60fe2da48f_1` at
`recording_may_be_open`. The retained bridge diagnostic is
`creator provisional-evidence cancellation project changed after the current
project index`. A property notice at detector epoch 42 was incorrectly allowed
to invalidate a complete post-Apply capture while its larger shard stream was
still in flight. The host then incorrectly graded that hint against the
pre-Apply capture because no post-Apply baseline had been persisted, producing
an invented incomplete confirmation before ending `recovery_required /
studio_transaction_interrupted` with detail hash
`927ee0e1baf2f3369bcb0a739b2132dd479e888afceb207c8f59d31c6a3f81ea`.
No mutation attempt, verification, finalization, checkpoint, creator report,
or gameplay verdict was durably recorded. The surviving recording state must
still be recovered by the creator; these facts do not prove whether the place
was changed or restored.

The root cause was a category error between observation and delivery, exposed
by place size rather than by any Airlock-specific class or operation. Current
code retries a whole capture when the epoch changes during reading, treats the
completed capture as immutable during bounded transport, and grants current
command authority only if the epoch is still unchanged after transport.
Otherwise the exact dirty notice is retained and a fresh complete index is
compared with the legitimate post-state or recovery baseline. A notice that
arrives before that baseline remains a barrier with no verdict. If an evidence
failure cannot pass the exact safe-cancellation gate, the connector emits a
bound `CreatorMutationFailed` with cancellation unproven and performs no
automatic finalization. `formal/ProjectIndexPublication.tla` model-checks these
boundaries independently of project size, property, class, or timing.

## Current registered-experiment path

Current clean-break benchmark tooling binds the seed, source roots, implementation snapshot, model transport, budgets, semantic views, evaluator configuration, expected harness identities, and connector manifest/projection identity before provider execution.

The empty-root regression recomputes and verifies the orientation content hash, ordered tool-description hash, and harness configuration identity. These derived current values are intentionally not duplicated in documentation.

## Documentary historical evidence

Following the explicitly authorized `.forge` purge, this section preserves
only the written identifiers, classifications, and claim boundaries. It does
not assert that any referenced local artifact is still present or replayable.

The historical capability canary remains `studio_capability_canary_beef4ad696113cbf8b69de7e`, bound to `studio_execution_plan_7e138ef9465e5a60ab1aae3d`. It established only the predecessor transport and observation substrate.

The sole consumed MovingPlatform trial remains `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286` under `harness_configuration_bca40ea4ef667a18a61089e9`. It crossed `trialStarted` and ended `incomplete / agent_failure` with no writes, candidate, or Studio run. Its missing-root defect is fixed by the current regression; the historical result is not retried or rewritten.

The historical Vertical Shuttle treatment remains registration `experiment_registration_60857fefe801607baa1f6b7d`, AgentRun `agent_run_ba3716f8-4ecc-4bf8-9689-45f41700f179`, candidate `workspace_candidate_79937cb8767b18d553850b63`, runtime run `runtime_evaluation_run_35b4ef7f3f9c482d82d498bc`, runtime plan `runtime_eval_plan_5d7c1c5236342ae56fe30ecf`, and proof `runtime_proof_84e4e26fda34ee4dd937597e`. Its exact predecessor treatment was `runtime_verified`; this is not evidence for current authoring or general model quality.

The first rejected Status Beacon session is preserved unchanged as successful failure evidence: session `creator_session_9e8d9646-6460-432b-a1f5-9ef0a72182f3`, plan `creator_plan_1d26e6203c428915825673e7` (`1d26e6203c428915825673e7f0759510a125e58f18b015656d2ccbcaf37027c8`), approval `creator_approval_aea4665ee662da5f87d2dc6d`, AgentRun `agent_run_26f87d81-fd13-44c0-a50a-e7fd0e2628fb`, and trace `trace_b94e2b50-c19c-4c48-8b48-68c0196bbf90`. It exposed class-blind existence checks, an impossible planned-parent nesting, vague alternative-path prose, diagnostic attribution overclaiming, and workflow button overload. No builder, mutation, verification, or checkpoint occurred. The session is not rewritten or retried.

The second consumed Status Beacon session is also preserved unchanged: session `creator_session_e9ac955e-1f3b-4735-bcfd-fdfec308d058`; corrected plan `creator_plan_641a87b5293de093607599d4` (`641a87b5293de093607599d4f1cbbc0683bf6d59c3aec5a1620434e97ccb066c`); plan approval `creator_approval_f4ccd167ba311da97ed23b66` (`f4ccd167ba311da97ed23b66319b522023565ba1fd426ece64b54858ecb5f98f`); planner AgentRun `agent_run_9647b86e-41f7-4c3e-8c09-87a7a1206bdc`; and planner trace `trace_13a68af6-9205-474f-bed2-e03812b707dc`. The planner corrected two invalid proposals in the same AgentRun and reached exact approval. The builder then ended with zero accepted operations, and sealing threw `Creator change set requires 1-32 uniquely identified operations`. Because persistence occurred only after sealing, no builder AgentRun or builder trace was written. No Studio mutation, verification, or checkpoint occurred. This is the exact evidence-loss defect fixed by the current implementation; the consumed session is not rewritten, resumed, or retried.

The third rejected Status Beacon session remains unchanged: session `creator_session_241d11a1-252c-4094-b6a9-6017662f0d38`; plan `creator_plan_85681d35e151a2fb7ab60669` (`85681d35e151a2fb7ab606696331179f9fc87d0a792f3dbc85b29ed1bd3224bf`); rejection approval `creator_approval_650a75ab0c3802dc22843255` (`650a75ab0c3802dc228432551f07cb68dae8a9b81f779c8979e738ae686e1254`); planner AgentRun `agent_run_b687611f-d8a7-4565-b49b-be3d414128c0`; and trace `trace_f7ab8597-96c6-49bd-abd7-d71004309736`. Luna's first tool call correctly planned a new Script with source plus Script existence and Luau syntax checks. Forge rejected that executable proposal because planning could not express source on create, then rejected the safe `ServerScriptService` existence check because observation was incorrectly bounded to `Workspace`. The planner adapted to those tool errors and Forge ultimately sealed a weaker structure-only plan that deferred the requested runtime behavior. The creator rejected it before any builder, Studio mutation, verification, or checkpoint. This is harness-contract failure evidence, not a model-quality failure; the session is not rewritten, resumed, or retried.

The fourth consumed Status Beacon session is preserved unchanged: session `creator_session_ee098877-0434-4adc-ac25-971f56d65d75`; approved plan `creator_plan_f917b66a7c6c344f505814e3` (`f917b66a7c6c344f505814e3a7c48c2035be673262b8848f7cc13c831aeaa9d6`); builder AgentRun `agent_run_20b5f04f-8f3e-4602-931c-6679998b41e8`; and trace `trace_a2382f5f-18c8-4832-8029-de4a90c8d94c`. It ended `incomplete / RUNTIME_BUDGET_EXHAUSTED` after 12 turns, seven recorded tool calls, and `$0.00893117`. No operation was accepted, `forge.verify` did not run, and no Studio mutation occurred. The builder was not shown the approved plan/build contract, had to guess change IDs, path, and class, did not receive the exact property allowlist, and received vague mismatch feedback. This is harness/model-interface failure evidence, not a model-quality failure; it is not rewritten, resumed, or retried.

The fifth consumed Status Beacon session is preserved unchanged: session `creator_session_908dcc05-e702-40fc-91c1-5bb998d95aea`; approved plan `creator_plan_a06dd8d1e3198a19ed46b911` (`a06dd8d1e3198a19ed46b911a97f08e08a8d901b858f0c77d8578e2c2f8af43c`); planner AgentRun `agent_run_fbb75cf3-6843-41a5-aee3-7d45e3ec1676` and trace `trace_dd303aab-42f6-420b-b5e7-4e79e3f9eff5`; builder AgentRun `agent_run_e9f54f0f-de53-46b7-92e0-8a16cf03b1ff` and trace `trace_56a2d795-4072-47d6-9c6b-98c17a5b1c37`. Planning sealed successfully. The builder first supplied semantically correct natural JSON for the Part properties, but Forge exposed its internal tagged `StudioValue` representation as the model tool contract. Three progressively adapted encodings all failed with pathless schema errors, triggering the consecutive-all-failed guard after four turns, four tool calls, and `$0.00324777`. No operation was accepted, `forge.verify` did not run, and Studio was not mutated. This is preserved harness-interface failure evidence; the current clean-break model-facing property contract uses natural JSON and performs the tagged conversion behind the trust boundary. The session is not rewritten, resumed, or retried.

The sixth consumed Status Beacon session is preserved unchanged: session `creator_session_2fc9d4ac-d27f-4ac1-87df-60701bcb9468`; approved plan `creator_plan_0927f211476722b7e3c3d431` (`0927f211476722b7e3c3d431527e51e9e9fa9ee80c246cf6be14758c1a9e5dc2`); sealed change set `creator_change_set_12f86290d366d7a2e6501b5f` (`12f86290d366d7a2e6501b5f014905737b3aeda26904ad732f9f8ecd24a9c87c`); planner AgentRun `agent_run_102524ec-7a5c-4229-a7dd-ff496053278b` and trace `trace_d55a23ae-a0a1-46f4-9f15-cba33da4bd80`; builder AgentRun `agent_run_23fd5567-5894-47cd-9e84-60fb7a31c093` and trace `trace_559e93a3-d7a2-49fb-9b0d-5de1c92fa8ae`. Planning and building both sealed, all natural property inputs staged on their first attempt, and the local gate was `eligible`. After exact change approval, Studio created the Part and Script inside an open recording. Post-apply observation showed Roblox had stored the requested red channel `0.1` as the 8-bit value `0.09803921729326248`; Forge compared it to the unrepresentable input decimal and falsely classified the Color as mismatched. The recording was automatically cancelled, a fresh rollback observation exactly restored the initial revision, and all three initial/transient/recovered observations are preserved. No playtest or final review occurred. This is storage-semantics boundary failure evidence, not builder failure. Current Forge canonicalizes natural numeric/color inputs to Studio's storage domain before review and the connector accepts deterministic canonical color bytes. The session is not rewritten, resumed, or retried.

## Accepted Orbital Freight Airlock proof and next milestone

The full interconnected Orbital Freight Airlock flow has now completed as
accepted evidence. Session
`creator_session_de3157de-700e-4c95-871d-2ad94e111102`
(`392cf6a88bb15b3052b7776aada4d742061ff8ec5f8a3ced1a62c2455a4456cb`)
ran with `openai/gpt-5.6-luna` and advanced from complete project revision
`81037f10906fa15edca614274bbf28b670d4d383771af13c26eb4dc651f100dc`
to
`ac4833d82ee38abf47c1967956c54c1f6efd2f3f3a2fa62737cfd7dada4810e0`.
Plan `creator_plan_5735a1ff0f10d801a4066646` and change set
`creator_change_set_ce9de277302ca309fa688836` were explicitly approved.

Mutation attempt
`creator_mutation_attempt_ce9de277302ca309fa688836_1`
(`d8deb998572e75d2d47e6be8a2dab100f8dee66ff63f742579469c2158bd3aff`)
settled with reconciliation hash
`789b213b0175d2bfa4e45739e2d5c430270b875949f5dad7259b8f3ab144e88f`
and commit-finalization hash
`2b5a334e9efdcc5cdf77afbe36d3bb645281bb6ee722d73fb4dcbd85c68d1baf`.
Verification `creator_verification_624d0d509a58ab3d1443efcc`
(`624d0d509a58ab3d1443efccf6cf247b968dfd81306b1c8df560bf7b9c2b80a9`)
passed with no failure facts. Checkpoint
`creator_checkpoint_f27e16929b8f4813954b6104` committed the exact revision
transition. Creator review
`creator_review_report_949a503899d96b717f85ec04`
(`949a503899d96b717f85ec04e9540ec05ea42e03ec6685533414c2b22bf8f605`)
accepted the result with the creator-authority report “It looks good!”. The
report remains creator observation; it does not upgrade unsupported visual,
client, or causal behavior into machine evidence.

This proof closes the repeated Prepare, preflight, project-index publication,
provisional Apply, ordinary Play/Stop, commit, and final-review blockers for the
demonstrated transaction. The next milestone is the clean-break creator
conversation specified in [CREATOR-EXPERIENCE.md](CREATOR-EXPERIENCE.md): a
durable project conversation, genuine clarification and plan revision,
conversation-native source citations, explicit memory, per-turn model
selection, asynchronous foreground jobs, and the Night Blueprint product
shell. The current session-oriented evidence workbench is no longer the target
experience.

## Deferred goal-only work

- automatic Rojo ownership discovery without introducing a second writer;
- broader typed Studio and source tools;
- asset search/import and qualitative asset evaluation;
- durable multi-checkpoint sessions;
- calibrated qualitative evaluators;
- reviewed failure mining and regression promotion;
- cloud identity, deployment, and multi-user dashboard collaboration;
- microVM builder/evaluator workers after the local worker boundary is demonstrated; real Roblox Studio remains a separate proof worker.
