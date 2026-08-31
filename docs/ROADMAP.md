# Forge Roadmap

This is the canonical status and next-work record. [ARCHITECTURE.md](ARCHITECTURE.md) defines architecture, [FORGE.md](FORGE.md) defines thesis and invariants, [EVALS.md](EVALS.md) defines claims, and [RESEARCH.md](RESEARCH.md) indexes evidence.

## Current milestone: failure-complete creator phase evidence

The repository now implements the first product-shaped vertical slice:

- one creator prompt entered from the Studio plugin or CLI control client;
- fresh bounded Studio snapshot, explicit service-root parent facts, and stable identity enrollment;
- Studio-only write authority, with optional explicit Rojo roots treated as read-only exclusion zones;
- separate read-only planner and typed builder model phases behind the bound `CreatorAgentWorker` seam;
- planner-inspected, then explicitly declared initial-snapshot `inspectionPaths` for builder placement, integration, relationship, and preservation facts;
- a content-addressed, model-visible `CreatorBuildContract` compiled from the approved plan and persisted by ID and hash in builder AgentRuns, traces, and creator-session history; Forge derives operation ID, kind, destination, parent, name, class, stable identity, precondition, and initialization while the model supplies only `planChangeId` plus allowlisted properties, attributes, explicit removals, and source;
- creator-visible immutable prompt, exact typed changes, generated initialization commitments, Forge-generated machine-check statements, thresholds, creator-review judgments, and artifact hash;
- plan closure before review: exact step-to-change coverage, same-operation source for newly created scripts, an exact class-aware existence check for every created or moved output, and Luau syntax coverage for every source-bearing change;
- exact source diff, complete typed canonical creative payload, operation hashes, and local gate before change approval; model-facing properties use natural JSON and are converted to the tagged Studio representation only after contract validation;
- contract-scoped current-source reading for approved existing script replacement, plus allowlisted Studio create/update/move/delete/source operations with revision and identity preconditions, atomic move-plus-property/source-plus-attribute composition, property/UTF-8 parity at Forge and Studio, and explicit `removedAttributes`;
- live budget admission before each model batch and no-progress termination for repeated identical or varied consecutive all-failed batches, preserving incomplete evidence instead of exhausting turns on guesses;
- one open Studio ChangeHistory recording across apply and verification, with a fresh whole-snapshot revision recollected independently at prepare and apply;
- class-aware existence checks over exact safe Studio service roots, Workspace-only BasePart position checks, bounded subtree snapshot preservation, and whole-playtest error/warning counts plus message hashes;
- cancellation on failure, at most two repairs without weakening the approved charter, and commit on pass;
- final creator acceptance/rejection and exact-revision guarded Change History rollback;
- private prompt/session persistence with bounded revision-to-observation history, reproducible plan/contract/change-set materialization, content-bound AgentRun/BuildTrace locators, and per-attempt verification-record linkage;
- a native tool-host completion contract that rejects a normal model `end_turn` unless the current planner or builder is seal-ready;
- AgentRun creator phase outcomes that discriminate a sealed artifact from an unsealed attempt and bind the latter to its failure stage, code, detail hash, tool-history-derived attempt hash, model turns, and trace;
- worker results that persist phase evidence before the coordinator transitions an incomplete session, including zero-tool, plan-only, rejected-stage, partial-coverage, missing-local-gate, provider-failure, and successful-seal paths;
- bounded planner inspection, targeted builder inspection from declared paths, approved existing-source reads, structured expected-versus-received stage feedback with exact allowlists, rejected-batch evidence, and no-progress guards;
- an authenticated evidence graph across session, contract, AgentRun, trace, change set, Studio lifecycle, verification, and checkpoint artifacts;
- a canonical `CreatorControlView` consumed by both CLI and plugin, with one primary and one secondary creator action, exact change payload presentation, content-bound terminal evidence references, and **Submit New Request** at terminal UI states;
- approve-and-apply and one-click creator-authorized Play Solo initiation, while retaining the distinct consent boundaries;
- one current clean-break artifact shape throughout Forge, with exact content hashes and capability-set identity.

The automated suite covers the corrected invalid proposal, bounded planner inspection, same-run planner correction, executable initialization, approved existing-source reads, atomic move-plus-property changes, output-check and source-syntax closure, exact plan-change coverage, plan-bound builder-contract derivation, observation-history reproduction, content-bound AgentRun/trace locators, structured rejection and no-progress evidence, sealed and unsealed worker evidence, class-aware service-root resolution, view-bound action rejection, plugin UI mapping, evaluator isolation, workspace security, and historical evidence. These tests make no provider request and perform no Studio action. They do not validate a live creator run.

## What ordinary users provide

The intended creator path needs the open Studio place and the prompt. It does not need `requirements.json`, `acceptance.json`, evaluator JSON, a prepared data plan, or a source-root manifest.

`examples/status-beacon` is the first live-session seed. Its JSON exists only to reproducibly build a place for the milestone. Once opened, Forge consumes the Studio snapshot plus this suggested prompt:

> Add a status beacon above Generator that alternates green and red every second while the game is running. Preserve PreservedTree.

No solution is present. No task or evaluator package exists for the fixture.

## Accepted live creator evidence

The Status Beacon vertical slice completed successfully in session `creator_session_ad50593a-e0f1-4651-95f4-c88b3b5f6242`. Plan `creator_plan_ea7f9617b3c2c33933fc2bc6` and change set `creator_change_set_9a546962a40226a512c86a76` sealed without repair. Planner AgentRun `agent_run_789d36a5-25a8-447e-9d04-fb417991fc21` and builder AgentRun `agent_run_a62cb929-4d7d-4f98-a2cb-b47356991d03` were both `locally_eligible`. Studio verification `creator_verification_f6a9c0c5f1b07e5a6b57eeb9` passed with no failure facts, checkpoint `creator_checkpoint_cb96fdbafb2f14f8aeac1e5d` committed revision `360c3e26d94c868fa2441badad2be1282b82ffa13f1729f7d88a523045c6aff3`, and creator review `creator_review_4ac1d95c5f5a797d8bc8bba9` accepted the result.

This establishes one complete prompt/plan/change/apply/check/review path. The final snapshot binds the exact Part properties and Script source. The creator observed the visual placement and one-second green/red alternation; those remain creator-review facts rather than machine-observed color-series facts.

## Next evidence-producing task

First make the successful evidence independently auditable:

1. persist the complete bounded Studio runtime observation and diagnostics material, not only their hashes;
2. bind retrievable artifact locators into the creator verification record and session graph;
3. support provider-free replay of grading from the persisted charter, execution plan, observation, and diagnostics;
4. record real planner, builder, provider-turn, and tool-call timing rather than zero-duration spans;
5. add regressions for missing verification evidence and impossible trace timing.

Then run one genuinely different prompt-only creator scenario. Do not rerun Status Beacon merely to accumulate a second success.

## Current registered-experiment path

Current clean-break benchmark tooling binds the seed, source roots, implementation snapshot, model transport, budgets, semantic views, evaluator configuration, expected harness identities, and connector capability set before provider execution.

The empty-root regression recomputes and verifies the orientation content hash, ordered tool-description hash, and harness configuration identity. These derived current values are intentionally not duplicated in documentation.

## Preserved historical evidence

The historical capability canary remains `studio_capability_canary_beef4ad696113cbf8b69de7e`, bound to `studio_execution_plan_7e138ef9465e5a60ab1aae3d`. It established only the predecessor transport and observation substrate.

The sole consumed MovingPlatform trial remains `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286` under `harness_configuration_bca40ea4ef667a18a61089e9`. It crossed `trialStarted` and ended `incomplete / agent_failure` with no writes, candidate, or Studio run. Its missing-root defect is fixed by the current regression; the historical result is not retried or rewritten.

The historical Vertical Shuttle treatment remains registration `experiment_registration_60857fefe801607baa1f6b7d`, AgentRun `agent_run_ba3716f8-4ecc-4bf8-9689-45f41700f179`, candidate `workspace_candidate_79937cb8767b18d553850b63`, runtime run `runtime_evaluation_run_35b4ef7f3f9c482d82d498bc`, runtime plan `runtime_eval_plan_5d7c1c5236342ae56fe30ecf`, and proof `runtime_proof_84e4e26fda34ee4dd937597e`. Its exact predecessor treatment was `runtime_verified`; this is not evidence for current authoring or general model quality.

The first rejected Status Beacon session is preserved unchanged as successful failure evidence: session `creator_session_9e8d9646-6460-432b-a1f5-9ef0a72182f3`, plan `creator_plan_1d26e6203c428915825673e7` (`1d26e6203c428915825673e7f0759510a125e58f18b015656d2ccbcaf37027c8`), approval `creator_approval_aea4665ee662da5f87d2dc6d`, AgentRun `agent_run_26f87d81-fd13-44c0-a50a-e7fd0e2628fb`, and trace `trace_b94e2b50-c19c-4c48-8b48-68c0196bbf90`. It exposed class-blind existence checks, an impossible planned-parent nesting, vague alternative-path prose, diagnostic attribution overclaiming, and workflow button overload. No builder, mutation, verification, or checkpoint occurred. The session is not rewritten or retried.

The second consumed Status Beacon session is also preserved unchanged: session `creator_session_e9ac955e-1f3b-4735-bcfd-fdfec308d058`; corrected plan `creator_plan_641a87b5293de093607599d4` (`641a87b5293de093607599d4f1cbbc0683bf6d59c3aec5a1620434e97ccb066c`); plan approval `creator_approval_f4ccd167ba311da97ed23b66` (`f4ccd167ba311da97ed23b66319b522023565ba1fd426ece64b54858ecb5f98f`); planner AgentRun `agent_run_9647b86e-41f7-4c3e-8c09-87a7a1206bdc`; and planner trace `trace_13a68af6-9205-474f-bed2-e03812b707dc`. The planner corrected two invalid proposals in the same AgentRun and reached exact approval. The builder then ended with zero accepted operations, and sealing threw `Creator change set requires 1-32 uniquely identified operations`. Because persistence occurred only after sealing, no builder AgentRun or builder trace was written. No Studio mutation, verification, or checkpoint occurred. This is the exact evidence-loss defect fixed by the current implementation; the consumed session is not rewritten, resumed, or retried.

The third rejected Status Beacon session remains unchanged: session `creator_session_241d11a1-252c-4094-b6a9-6017662f0d38`; plan `creator_plan_85681d35e151a2fb7ab60669` (`85681d35e151a2fb7ab606696331179f9fc87d0a792f3dbc85b29ed1bd3224bf`); rejection approval `creator_approval_650a75ab0c3802dc22843255` (`650a75ab0c3802dc228432551f07cb68dae8a9b81f779c8979e738ae686e1254`); planner AgentRun `agent_run_b687611f-d8a7-4565-b49b-be3d414128c0`; and trace `trace_f7ab8597-96c6-49bd-abd7-d71004309736`. Luna's first tool call correctly planned a new Script with source plus Script existence and Luau syntax checks. Forge rejected that executable proposal because planning could not express source on create, then rejected the safe `ServerScriptService` existence check because observation was incorrectly bounded to `Workspace`. The planner adapted to those tool errors and Forge ultimately sealed a weaker structure-only plan that deferred the requested runtime behavior. The creator rejected it before any builder, Studio mutation, verification, or checkpoint. This is harness-contract failure evidence, not a model-quality failure; the session is not rewritten, resumed, or retried.

The fourth consumed Status Beacon session is preserved unchanged: session `creator_session_ee098877-0434-4adc-ac25-971f56d65d75`; approved plan `creator_plan_f917b66a7c6c344f505814e3` (`f917b66a7c6c344f505814e3a7c48c2035be673262b8848f7cc13c831aeaa9d6`); builder AgentRun `agent_run_20b5f04f-8f3e-4602-931c-6679998b41e8`; and trace `trace_a2382f5f-18c8-4832-8029-de4a90c8d94c`. It ended `incomplete / RUNTIME_BUDGET_EXHAUSTED` after 12 turns, seven recorded tool calls, and `$0.00893117`. No operation was accepted, `forge.verify` did not run, and no Studio mutation occurred. The builder was not shown the approved plan/build contract, had to guess change IDs, path, and class, did not receive the exact property allowlist, and received vague mismatch feedback. This is harness/model-interface failure evidence, not a model-quality failure; it is not rewritten, resumed, or retried.

The fifth consumed Status Beacon session is preserved unchanged: session `creator_session_908dcc05-e702-40fc-91c1-5bb998d95aea`; approved plan `creator_plan_a06dd8d1e3198a19ed46b911` (`a06dd8d1e3198a19ed46b911a97f08e08a8d901b858f0c77d8578e2c2f8af43c`); planner AgentRun `agent_run_fbb75cf3-6843-41a5-aee3-7d45e3ec1676` and trace `trace_dd303aab-42f6-420b-b5e7-4e79e3f9eff5`; builder AgentRun `agent_run_e9f54f0f-de53-46b7-92e0-8a16cf03b1ff` and trace `trace_56a2d795-4072-47d6-9c6b-98c17a5b1c37`. Planning sealed successfully. The builder first supplied semantically correct natural JSON for the Part properties, but Forge exposed its internal tagged `StudioValue` representation as the model tool contract. Three progressively adapted encodings all failed with pathless schema errors, triggering the consecutive-all-failed guard after four turns, four tool calls, and `$0.00324777`. No operation was accepted, `forge.verify` did not run, and Studio was not mutated. This is preserved harness-interface failure evidence; the current clean-break model-facing property contract uses natural JSON and performs the tagged conversion behind the trust boundary. The session is not rewritten, resumed, or retried.

The sixth consumed Status Beacon session is preserved unchanged: session `creator_session_2fc9d4ac-d27f-4ac1-87df-60701bcb9468`; approved plan `creator_plan_0927f211476722b7e3c3d431` (`0927f211476722b7e3c3d431527e51e9e9fa9ee80c246cf6be14758c1a9e5dc2`); sealed change set `creator_change_set_12f86290d366d7a2e6501b5f` (`12f86290d366d7a2e6501b5f014905737b3aeda26904ad732f9f8ecd24a9c87c`); planner AgentRun `agent_run_102524ec-7a5c-4229-a7dd-ff496053278b` and trace `trace_d55a23ae-a0a1-46f4-9f15-cba33da4bd80`; builder AgentRun `agent_run_23fd5567-5894-47cd-9e84-60fb7a31c093` and trace `trace_559e93a3-d7a2-49fb-9b0d-5de1c92fa8ae`. Planning and building both sealed, all natural property inputs staged on their first attempt, and the local gate was `eligible`. After exact change approval, Studio created the Part and Script inside an open recording. Post-apply observation showed Roblox had stored the requested red channel `0.1` as the 8-bit value `0.09803921729326248`; Forge compared it to the unrepresentable input decimal and falsely classified the Color as mismatched. The recording was automatically cancelled, a fresh rollback observation exactly restored the initial revision, and all three initial/transient/recovered observations are preserved. No playtest or final review occurred. This is storage-semantics boundary failure evidence, not builder failure. Current Forge canonicalizes natural numeric/color inputs to Studio's storage domain before review and the connector accepts deterministic canonical color bytes. The session is not rewritten, resumed, or retried.

## After the next session

Only use the preserved result to choose the smallest next capability:

- if planning or review is unclear, improve presentation and approval evidence;
- if typed authoring is insufficient, add the narrowest required class/property operation;
- if verification is insufficient, add one creator-visible factual capability;
- if recovery is unsafe, strengthen checkpoint or revision handling;
- if the flow succeeds, repeat on a genuinely different prompt before broadening assets or long-horizon work.

## Deferred goal-only work

- automatic Rojo ownership discovery without introducing a second writer;
- broader typed Studio and source tools;
- asset search/import and qualitative asset evaluation;
- durable multi-checkpoint sessions;
- calibrated qualitative evaluators;
- reviewed failure mining and regression promotion;
- a web dashboard over `CreatorControlView` and the control API, replacing creator workflow UI in the plugin;
- microVM builder/evaluator workers after the local worker boundary is demonstrated; real Roblox Studio remains a separate proof worker.
