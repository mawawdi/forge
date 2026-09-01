# Forge Roadmap

This is the canonical status and next-work record. [ARCHITECTURE.md](ARCHITECTURE.md) defines architecture, [FORGE.md](FORGE.md) defines thesis and invariants, [EVALS.md](EVALS.md) defines claims, and [RESEARCH.md](RESEARCH.md) indexes evidence.

## Current milestone: closed Studio evidence and transactional mutation proof

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
- fresh bounded manifest-projected Studio state, explicit service-root parent facts, and stable identities;
- Studio-only write authority, with optional explicit Rojo roots treated as read-only exclusion zones;
- separate read-only planner and typed builder model phases behind the bound `CreatorAgentWorker` seam;
- planner-inspected, then explicitly declared initial-snapshot `inspectionPaths` for builder placement, integration, relationship, and preservation facts;
- a content-addressed, model-visible `CreatorBuildContract` compiled from the approved plan and persisted by ID and hash in builder AgentRuns, traces, and creator-session history; Forge derives operation ID, kind, destination, parent, name, class, stable identity, precondition, and initialization while the model supplies only `planChangeId` plus allowlisted properties, attributes, explicit removals, and source;
- creator-visible immutable prompt, exact typed changes, generated initialization commitments, Forge-generated machine-check statements, thresholds, creator-review judgments, and artifact hash;
- plan closure before review: exact step-to-change coverage, same-operation source for newly created scripts, an exact class-aware existence check for every created or moved output, and Luau syntax coverage for every source-bearing change;
- exact source diff, complete typed canonical creative payload, operation hashes, and local gate before change approval; model-facing properties use natural JSON and are converted to the tagged Studio representation only after contract validation;
- contract-scoped current-source reading for approved existing script replacement, plus allowlisted Studio create/update/move/delete/source operations with revision and identity preconditions, atomic move-plus-property/source-plus-attribute composition, property/UTF-8 parity at Forge and Studio, and explicit `removedAttributes`;
- live budget admission before each model batch and no-progress termination for repeated identical or varied consecutive all-failed batches, preserving incomplete evidence instead of exhausting turns on guesses;
- one open Studio ChangeHistory recording across provisional apply and verification, with the exact projection-bound revision recollected independently at prepare and apply;
- class-aware existence checks over exact safe Studio service roots, Workspace-only BasePart position checks, bounded subtree state preservation, and whole-playtest error/warning counts plus message hashes;
- cancellation on failure, at most two repairs without weakening the approved charter, and commit on pass;
- final creator acceptance/rejection and exact-revision guarded Change History rollback;
- private current-session persistence under `.forge/creator`, with bounded revision-to-observation history and one root-relative `ArtifactReference` shape for immutable canonical JSON evidence; there is no legacy reader or migration, and an explicit `.forge` deletion is a clean reset;
- a native tool-host completion contract that rejects a normal model `end_turn` unless the current planner or builder is seal-ready;
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
- approve-and-apply and one-click creator-authorized Play Solo initiation, while retaining the distinct consent boundaries;
- pre-mutation compilation of dependency-ordered runtime proof programs, persisted revision-bound execution plans, and a 15-second creator-interaction observation window inside the 20-second Studio budget;
- connector build identity over the manifest, protocol, plugin project, and all authored plugin source, so runtime-executor changes cannot pair as the old build;
- one current clean-break artifact shape throughout Forge, with tagged canonical hashes and generated manifest identity.

The automated suite covers the corrected invalid proposal, bounded planner inspection, same-run planner correction, executable initialization, approved existing-source reads, atomic move-plus-property changes, output-check and source-syntax closure, exact plan-change coverage, plan-bound builder-contract derivation, immutable artifact safety, provider-free replay, real and impossible timing, runtime-owned rejected calls, content-bound AgentRun/trace artifacts, sealed and unsealed worker evidence, control authentication, dashboard state and report requirements, plugin cutover, evaluator isolation, workspace security, and historical evidence. These tests make no provider request and perform no Studio action. They do not validate a live creator run.

## What ordinary users provide

The intended creator path needs the open Studio place and the prompt. It does not need `requirements.json`, `acceptance.json`, evaluator JSON, a prepared data plan, or a source-root manifest.

`examples/status-beacon` remains the historical accepted live-session seed. `examples/door-control` is the distinct current seed. Its JSON exists only to reproducibly build a place containing `Workspace/DoorAssembly/Door`, `ControlPanel`, and `Workspace/PreservedScenery`; both Rojo seeds carry deterministic `_forgeStableId` attributes so complete state evidence never mutates a place merely to establish identity. Once opened, Forge consumes the Studio evidence envelope plus this exact prompt:

> Add a ProximityPrompt to Workspace/DoorAssembly/ControlPanel labeled “Toggle Door”. Each time a player uses it, move Workspace/DoorAssembly/Door straight up 8 studs to open or back to its starting position to close. Use server-authoritative code, keep the door anchored, and preserve Workspace/PreservedScenery.

No solution is present. No task or evaluator package exists for the fixture.

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

The corrected Door Control proof subsequently completed the entire current workflow:

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

- official `Roblox/creator-docs` commit `529a24ff2aa9896dad50fc12268717210ba3127d`, exact engine-reference tree hash `b62066ef0fa92c4be5f8a6e0681cd899b4a88a30571a410900a75de98a987315`;
- normalized catalog hash `e4d89b5a42f7587f0740d9ee5833e5ecfbb06ef2b212eba1aa4ee037e595af5b`, covering 638 classes, 48 datatypes, 518 enums, and their complete documented members/items;
- coverage hash `a9e2363ed8578edbf42ae81f811fc83add294e9d3ec640ae9b2228ab6b926a1d`, with exactly 9,449 unique classified entries: 1,204 types and 8,245 member occurrences;
- current manifest hash `b27c84c59df3ca520dc0247360d2e0d00282ed76bc4378e97fb11e0ceb54fc2f`, enabling 33 coherent classes and 183 distinct proof-closed writable properties. Inheritance expands those properties to 209 authorable catalog rows without duplicating the manifest authority;
- class-aware catalog/member resolution, 25 canonical codec tags with cross-language TypeScript/Luau vectors, stable class-constrained Instance references with an explicit class-bound nil value, and fixed `instance.property` / `instance.property_series` runtime evidence alongside resolution and position observations;
- authenticated CLI/control/dashboard catalog exploration with source, coverage, manifest, connector, attestation, inheritance, codec, disposition, reason, and proof-route visibility;
- offline generation failure for source/catalog/coverage drift, duplicate or unclassified entries, stale output, and missing authoring proof legs.

The closure audit rejected two false-positive routes before this milestone was accepted: official `Datatype.Font` is no longer confused with the distinct `Enum.Font`, and unset Instance-valued properties are now canonical observed values instead of read errors. The current connector build hash `a84be536e51194fcaadb1036dcdd585f6f1b8d70f8db3de1f75fd5600fab91f5` also binds the evidence generator and TypeScript evidence contract as well as the manifest, protocol, plugin project, and authored Luau runtime, so a codec-semantics change cannot retain an old connector identity.

During integration, the broader current policy initially made the accepted Door Control bundle unreadable because build-contract and mutation replay validators compared stored evidence to the new global manifest. That was an evidence-lifetime defect. Current live contracts are still a clean break, but immutable attempts now validate their own sealed build policy and manifest artifact and recompile against that exact manifest. New authoring uses only the current generated manifest. After this correction, the accepted Door mutation and verification again replay exactly with exit `0`; no stored ledger byte was changed.

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

## Next live evidence task

Install the rebuilt connector, open the solution-free Door Control seed, and
pair it with a fresh `creator serve` process. Before submitting any prompt, the
dashboard must report the current connector and manifest identities, 183
required/observed attestation facts, zero missing/unavailable/read-error/
mismatched facts, and a `verified` result. Inspect the raw attestation artifact
and confirm class-reference, enum, datatype-alias, and numeric rows retain their
distinct engine/storage and Luau script dimensions. This pairing check makes no
provider call and no Studio mutation.

After that evidence and explicit model-call authorization, repeat the Door
Control prompt through the complete fresh-store transaction:

> Add a ProximityPrompt to Workspace/DoorAssembly/ControlPanel labeled “Toggle Door”. Each time a player uses it, move Workspace/DoorAssembly/Door straight up 8 studs to open or back to its starting position to close. Use server-authoritative code, keep the door anchored, and preserve Workspace/PreservedScenery.

The visible plan must bind exact prompt/script existence, source syntax,
preservation, direct mutation readback, complete state delta, bounded
diagnostics, and creator review. During the approved Play Solo window, the
creator triggers the prompt twice and records the observed open/close behavior
in the required report. The run is new evidence under the corrected manifest;
the documentary predecessor ledger is not reused or migrated.

After that evidence, choose the next increment from the observed boundary:

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
- cloud identity, deployment, and multi-user dashboard collaboration;
- microVM builder/evaluator workers after the local worker boundary is demonstrated; real Roblox Studio remains a separate proof worker.
