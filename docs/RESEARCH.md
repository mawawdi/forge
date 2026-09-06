# Forge Research and Evidence

Historical record only. These observations describe the builds that produced them,
including superseded workflows. Current behavior is defined in
[Architecture](ARCHITECTURE.md); future work is in [Roadmap](ROADMAP.md), and
the consolidated visual direction is in [Visual generation](VISUALS.md). No pending
action or implementation claim below is a current instruction.

This ledger consolidates unique identifiers, hashes, and classifications from the
former root documentation. Availability of raw artifacts is not implied.

## Current conclusions

The current visual conclusion is the Blender-backed, partitioned scene-bundle
pipeline in [Visual generation](VISUALS.md). Earlier procedural composition,
Cube/CubePart, mesh review, UI, and image-input work remains useful foundation and
predecessor evidence; it is not the active world-generation strategy and does not
prove a native importer or completed game.

Other foundational findings remain in force:

- **Semantic authority must stay separated.** Creator intent, memory, observed
  project facts, platform policy, agent hypotheses, local checks, evaluator
  criteria, and creator review cannot substitute for each other.
- **Conversation state is evidence.** Immutable commits bind requests, decisions,
  plans, runs, artifacts, and outcomes. Compaction creates a bounded continuation
  handoff without granting approval or rewriting the transcript.
- **One writer needs one reconciled transaction.** Mutation safety requires exact
  approval, current observation, detached preflight, durable recording identity,
  direct readback, complete project comparison, finalization, and acknowledgement.
  A write receipt or exception alone proves none of those later facts.
- **Capabilities require closure.** A reflected API becomes authorable only after
  validation, canonicalization, writing, reading, preflight, comparison, and replay
  agree. Catalog presence is not permission.
- **Game IR must remain modular.** Ordinary source packages are the open extension
  mechanism; optional recipes lower declared structure. A generic harness must not
  prescribe rounds, reset, UI, genre, or a hidden game solution.
- **Isolation is bounded, not absolute.** Provider adapters are one-turn transports;
  Forge owns orchestration. Static Luau checks do not execute source, and Studio
  remains the authority for engine behavior. Runtime workers are resource-bounded
  processes, not general OS sandboxes.

## Recent run ledger

The following entries preserve the exact identities and classifications from the
consolidated September 5–6 records. They describe predecessor builds only. The
larger historical ledger follows unchanged below.

### Native conformance, September 5

The user-run Command Bar fixture on Studio `0.737.0.7371584` passed 137/137
before-save checks, construction for all 125 admitted classes, four complete
preflight envelopes, 11 sampled property slots, and 6/6 reopen checks. The
[raw export](research/evidence/native-conformance-2026-09-05.json) preserves exact
receipt strings.

| Identity                     | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| Capability manifest          | `19380b3b5bdcc93bb4d3810621e47e36b5c57f9a402006e2ad6ca5f6259abf33` |
| Fixture build                | `41fc37ce2ed5370606f831662bf1798ea86f7e067d7c6c4a2e2de16e3a05fc9f` |
| Before-save receipt          | `b3d8570592351a16531e93cc06bf84dd552f8c2fe9d4786a3773957a9289622d` |
| Reopen receipt               | `b83d88a03f5b0609afe2630d49f9588f416602045b3c4704b273c65286f13f15` |
| Saved place, 1,004,070 bytes | `3102b9ea292cdb3e1b25ce5fed142283cbcad576f082dab8ebbe481648f79194` |

The earlier 15:13:17 attempt failed while acquiring the old fixture's recording,
before any native case, and then produced a misleading same-session reopen error at
15:13:33. That is a fixture lifecycle failure, not property-conformance evidence.
The later September 6 fixture passed 139 before-save and seven reopen checks for
the property-specific unbounded `UISizeConstraint.MaxSize` observation. Manifest
`26090638d23c7ffe198bc80973c920d281defc0c65f111ed60f33f455a5502d7`,
fixture build `b6801080644a69e3e472392e5839ab9c7ef533e1405f4a1e5e23abe8ac26e075`,
export `49a7f4c4b439b96c79d2553edcc92aa37464696b7afc292179582ee4bcd3da84`,
and saved place `7b6ee9156466ff36cfb43120c2d0e899912ab238eb3a1b7ce7b340dfb7994320`
remain exact identities. Neither fixture proves a complete connector transaction,
recording cancellation, gameplay, or visual quality.

### Planner-schema and Last Light trials, September 5

| Trial                    | Exact identity                                                                                                                                                                             | Classification and boundary                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup failure          | `agent_run_6274f101-cc18-4f23-b27e-9799532fdb75`, session `creator_session_3d641320-dd9d-48af-be57-1ad7d881a7e3`                                                                           | `RUNTIME_FAILED` after 1,311 ms; no plan or Studio work                                                                                                                     |
| Initial planner          | `agent_run_9d2a7131-1bc8-411a-95cb-a88073d6baab`, session `creator_session_3d870e49-8a52-439a-b874-19e6548325c2`                                                                           | `incomplete / agent_failure`, `REPEATED_REJECTED_TOOL_BATCH`; 18 rejected proposals, Studio `not_run`                                                                       |
| Malformed-argument retry | `agent_run_24782e2c-f6c6-4b36-a24c-fab59545bef3`, session `creator_session_08cf6d51-caab-4bbb-8a4f-c1de52fb57cf`                                                                           | `incomplete / agent_failure`, `REPEATED_REJECTED_TOOL_BATCH`; no semantic proposal or Studio work                                                                           |
| Published-plan trial     | planner `agent_run_939ec671-83ad-41c9-8f67-c0032edaf8b3`, builder journal `agent_run_5222c082-1ba2-4052-986e-f824775bc238`, session `creator_session_70e51428-461c-488f-8e69-f8e4dca2277b` | Planner `locally_eligible`; builder interrupted at a request intent, later session `incomplete / control_process_interrupted`, provider outcome unknown; Studio `not_run`   |
| Activation trial         | planner `agent_run_50438a2c-df2a-4172-b970-9564bf77fdcc`, builder `agent_run_d3c88948-b72a-443d-a303-25a7d9257fd5`, session `creator_session_19457c77-5a2a-4164-8123-a01b3f27a571`         | Planner `locally_eligible`; builder `incomplete / agent_failure`, repeated unrepairable activation error; Studio `not_run`                                                  |
| Sealed-graph trial       | planner `agent_run_37bcc3fb-0e81-4887-ad72-822158470d24`, builder `agent_run_4a50169c-1638-4958-97f6-679df4e351f8`, session `creator_session_db6c7dc8-0278-4e81-b9d0-a35766ec1654`         | Both AgentRuns `locally_eligible`; host rejected the sealed graph with `Creator AgentRun outcome does not match its referenced phase`; session `incomplete`, no Studio work |

The initial 13-minute planner spent almost all measured time in provider turns and
discovered constraints through repeated full-plan errors. Later trials established
schema sharing, saved component declarations, aggregate diagnostics, malformed-JSON
fingerprints, activation admission, source-repair replay, and sealed-graph recovery.
They did not establish a two-minute workflow or a playable game.

### Visual Brief trials, September 6

The common 3,839-byte brief hash was
`296f4a16a503b6139493698b4950a18aa86ebc3c10c53df4ef82184271e81727`;
the clean seed hash was
`82751b6aa16fc6ebd79c19baca6687612c1884dfe38b5e3ac70bd8beb78ae5fa`.
The work predates the Blender decision and is retained as procedural generation,
latency, recovery, and native-failure evidence.

| Trial                    | Exact identity                                                                                                                                                                                                                                                                                      | Classification and boundary                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                 | conversation `creator_conversation_12a0bdce41130a734a9e92ea`, project `forge_project_6a5100e158564bcdac4c08f68181dabb`, planner `agent_run_33946629-904b-48dc-8fda-00b5e1f7d7ed`                                                                                                                    | Operator-interrupted after 14 responses plus one pending intent and no plan; pending response unknown, no Studio mutation                                                                     |
| Schema/context treatment | job `creator_job_7b406ad5-fc0c-4d0f-aed7-169d4cf5d5c9`, planner `agent_run_f7c90415-621b-4fee-830b-9c9c5a2fd2ce`                                                                                                                                                                                    | `failed / model`, `REPEATED_REJECTED_TOOL_BATCH`; 13 malformed inputs, no plan or Studio work                                                                                                 |
| Wire-evidence trial      | job `creator_job_4900593f-d002-4ffa-a635-2c683e3beead`, planner `agent_run_550d1ef3-81cf-43f6-88b5-92efd878451c`, builder `agent_run_6f9ea75c-10f7-400f-abd6-be8d75967716`                                                                                                                          | Plan published; builder `incomplete` after provider HTTP 400 request 12; no mutation or verification                                                                                          |
| Retry boundary           | job `creator_job_b6686724-9e72-4146-b7e7-e037e68376fc`, reserved builder `agent_run_7a3fe71f-912a-48fd-ae39-2fbb4abb6b4b`                                                                                                                                                                           | Changed authority required refresh; provider `never_dispatched`                                                                                                                               |
| Interrupted refresh      | job `creator_job_8f5e627a-68a4-42b3-bbea-df86c91316f4`, session `creator_session_839b1567-65e2-45d4-a012-4daf15968098`, planner `agent_run_4229d744-ce5b-47a8-84a0-df6691029d70`                                                                                                                    | Additive native facts rejected strict equivalence; request two was interrupted and remains outcome unknown                                                                                    |
| Offline additive refresh | session `creator_session_a6d068ff-b68d-4c2f-b234-2ebd79bf4cd2`                                                                                                                                                                                                                                      | 263 operations and four exact source files recompiled in a copied store with zero model/Studio calls; fixture only, no approval                                                               |
| Live retained refresh    | job `creator_job_699fafca-dc32-48cb-a440-e18b769e428d`, reserved planner `agent_run_b08db549-59cf-4018-b6d7-5fd4264871da`, session `creator_session_036e34ee-85d1-4a4c-b9c2-b8a2f9ecb187`                                                                                                           | Succeeded with provider `never_dispatched`; new approval still required                                                                                                                       |
| Retained builder         | `agent_run_b0c412d1-67bf-4b14-976b-7301444259b0`                                                                                                                                                                                                                                                    | `locally_eligible`; native Apply failed on non-finite before-state and ended `recovery_required`, zero verified checkpoints                                                                   |
| Fresh full trial         | conversation `creator_conversation_db6fc922d199446fea54cb5d`, session `creator_session_db42f924-4611-4421-9973-598d96a1a50b`, project `studio_project_c3ddf4fe91a27970df9cce50`, planner `agent_run_1bb5e1f4-5266-48b6-908d-bb42d755ea36`, builder `agent_run_8abf3dba-0ebe-4852-8a55-f5609f7f9990` | Planner/builder completed locally, but first native partition mismatched three approved attributes; `recovery_required`, recording `recording_3909101944013802940`, zero verified checkpoints |

The fresh trial took 47 model requests and did not meet its speed gates. Its sealed
graph `f016bd1c4d84631524e2b5f13cdfc2083e0e3ceea29530a8a61f09d60257b0bf`
partitioned as 128, 128, 128, 24, and 2 operations. Reconciliation artifact
`87733462a9f5e35f2ab721c09bd7f8f56dd7af89e3e2b1cb58014c113890402d`
records the three `approved_attribute_not_reflected` facts. This is a completed
failed-run measurement, not a completed game or rollback claim.

### Compact-planning and conversation incidents, September 3–4

| Exact identity                                                                                                                                                                      | Classification or observed boundary                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creator_session_5c701995-dc6f-4378-abe4-00de11373a8a`, `agent_run_b857c1a5-10d5-4eff-af3e-b3e3c745d8be`                                                                            | `incomplete / budget_exhausted`, response stopped at `max_tokens`; publication validator then hid the retained failure                                |
| `creator_session_dfe9b2e3-a807-4100-835a-5f20d2f0382c`, `agent_run_c0baa2a7-13a3-46fc-944e-8bf131be744c`                                                                            | `incomplete / agent_failure`, `REPEATED_NO_PROGRESS_TOOL_BATCH`; invalid cursors/parents and no writes                                                |
| `creator_session_c331e03d-656a-442c-b1af-2cfaaf38b275`, `agent_run_e559d3ed-41a0-4cb1-acd0-4fdd34aded76`                                                                            | Planner `locally_eligible`; an oversized activity field froze dashboard projection; no writes                                                         |
| `creator_session_eece991e-0c16-4243-9ab4-4c3a9279e6bb`, planner `agent_run_6f6e2c26-7a9d-4c24-ad34-cbd8fd0b6fcd`, builder `agent_run_c6a4174f-9138-48a0-8070-00faaade7143`          | Planner `locally_eligible`; builder `incomplete / budget_exhausted`, no change set or Studio work                                                     |
| `creator_session_21fc65a1-7d19-43c3-b7ef-1c31e47c2cb5`, `agent_run_8089f305-7e77-4d71-b32e-01e3df63eb48`                                                                            | Operator stopped during request five; provider outcome unknown, no plan or Studio work                                                                |
| `creator_session_ef0bfb71-8970-4721-86ca-17849e1cc4e6`, planner `agent_run_b0d7600f-1786-4d35-ba16-9ac389ce8319`, reserved builder `agent_run_fb3ff554-fa88-4858-a24c-5c1ab6c48417` | Builder contract preparation failed before dispatch because the host read the wrong target class field                                                |
| `creator_session_1bf78655-94a1-492a-bc34-de9624fcb946`, builder `agent_run_4ca71c0e-064a-4b14-814e-e505c49a0262`                                                                    | Locally eligible draft rejected in human source review; never applied                                                                                 |
| `creator_session_f0a2f620-e00b-431d-99ff-3d4e89206cf5`, planner `agent_run_632c7632-387f-4cce-9c1c-40c5088adec5`, builder `agent_run_05b5a456-d4cf-489c-9610-0463068eb5ba`          | Mutation matched and bounded verification passed; later conversation status ordering failed; full gameplay unproved                                   |
| `creator_session_ed181c25-11bc-4bdf-acd2-6769dcd2f349`, planner `agent_run_8e0d2b8b-ba74-4c04-a6b2-e34552cc5f10`, builder `agent_run_06704992-1421-42ae-92c8-c2050af53540`          | Mutation and bounded verification passed; source review still found authority/resource defects                                                        |
| `creator_session_ac5f8fde-6a9a-40ab-a0de-756ee0126232`, planner `agent_run_c4c53d54-dab8-484d-a368-b6964267b5ca`, builder `agent_run_fcc7d97d-5bbe-4405-b0da-70cdcc01f70e`          | Completed single-accept flow; did not meet speed target and gameplay remained unproved                                                                |
| `creator_session_8457b6d2-1c84-4878-a1f2-188a302df2a0`, planner `agent_run_96154b0b-7eb5-43c3-9e8e-8d16f660d4e6`, builder `agent_run_df9d6b76-fb43-4094-aac4-0e78724108cf`          | Small title edit completed automatic Apply at `creator_checkpoint_9a1e15e025b5a391e3328b89`; not an equivalent speed comparison                       |
| `creator_session_0f472b8d-e965-459e-a1b8-fd51d91cecb7`, planner `agent_run_e1b67fb9-097f-4b17-a2c2-1e581b15c911`, builder `agent_run_600d9461-bda7-4bfd-b7d6-bc102f9bb3dd`          | Eight-change plan applied at `creator_checkpoint_5272f13739699622982642c0`; build remained slow and HUD title was clipped                             |
| `creator_session_949be163-5aa7-4391-a43c-818e112228e0`                                                                                                                              | Same terminal result was published twice after cleanup-only hash change; outcome identity defect                                                      |
| `creator_session_fc93e2bc-356d-4a72-97cc-ca4ec7a91780`                                                                                                                              | Preparation failed before provider dispatch on source-indexing limits; no fabricated AgentRun                                                         |
| `creator_session_58311026-35ae-4b75-b317-4eb0ed770395`, planner `agent_run_230297d1-10bf-4c28-81bf-075394c20a82`                                                                    | Planning completed; invalid active-job topology then made the conversation head unreadable                                                            |
| `creator_session_596a2e09-54fb-41cb-a2fc-58fe6571c776`, builder `agent_run_08e5f038-d88b-479b-a3d7-29d8d586f5e9`                                                                    | Mutation matched; delayed notification interrupted finalization, later observation proved unchanged provisional revision, recording required recovery |

## ROADMAP records

### Predecessor milestone: existing-project intelligence and explicit refresh

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

### Accepted live creator evidence

The Status Beacon vertical slice completed successfully in session `creator_session_ad50593a-e0f1-4651-95f4-c88b3b5f6242`. Plan `creator_plan_ea7f9617b3c2c33933fc2bc6` and change set `creator_change_set_9a546962a40226a512c86a76` sealed without repair. Planner AgentRun `agent_run_789d36a5-25a8-447e-9d04-fb417991fc21` and builder AgentRun `agent_run_a62cb929-4d7d-4f98-a2cb-b47356991d03` were both `locally_eligible`. Studio verification `creator_verification_f6a9c0c5f1b07e5a6b57eeb9` passed with no failure facts, checkpoint `creator_checkpoint_cb96fdbafb2f14f8aeac1e5d` committed revision `360c3e26d94c868fa2441badad2be1282b82ffa13f1729f7d88a523045c6aff3`, and creator review `creator_review_4ac1d95c5f5a797d8bc8bba9` accepted the result.

### Door Control predecessor failures and accepted proof

- session `creator_session_5238ff32-4dbb-414a-bfa7-171b098d864b`, semantic session hash `acc6e39c978ce6cef34deb0aef28cee8555349e386d46c0d2fff1cbf539d9c9d`, bundle SHA-256 `391467561bd41a09330ea526a00b0a0992500657b72355c1dd28e3b2705ee452`;
- recorded classification `incomplete / project_drift`, detail hash `aa289261a799bdf6ca40e0f57a52a072d09b05427fb3934f41febee30645ba36`, with unchanged stored revision `fc941f29d11ff53c22c91726e15ec5a1901f7654bcc0b628d258bd69c4134723`;
- plan `creator_plan_82c044d062b9ee4127347888` (`82c044d062b9ee41273478882d14dd61286b5f131526a1d216325e106c1ef381`) and change set `creator_change_set_26718560532337ade2b64b4f` (`26718560532337ade2b64b4fc6e066b094ec1d77b9df0eacc0ec8fee854332ca`);
- planner `agent_run_e1f0edd5-6fd2-44a7-a6f6-a93cb4d25177` / `trace_bef17ecf-09f8-450d-bd67-a4b6eccf5b5d`, builder `agent_run_f0b8c8e7-1725-480a-b3da-579c673fc7a8` / `trace_7fd1478c-fe90-4b3c-a02f-69f1cbf3afca`;
- zero mutation attempts, verifications, checkpoints, creator reports, or gameplay claims.

- session `creator_session_0fd7a7e0-b64f-450d-b6bd-0b4c98434373`, semantic session hash `a09540ff927565effc0977af085121234dc178e4582d73c1c7bf183b6b682a15`, current bundle SHA-256 `cc6790f62c7f2b1e4de927bd85bd9e36d0f3bef7dd7d05d7a59b12b809238d56`;
- change set `creator_change_set_8fe28fb341ad4d266f60adc8` (`8fe28fb341ad4d266f60adc8dcdacfb86b350bdd4e04122f1d3cddcfda355661`), mutation projection `creator_mutation_mutation_direct_readback_8fe28fb341ad4d266f60adc8` (`fdb86a803524cb78ae84be2851e28d072b2ec748694fb728f6c5edfc5fd49e84`), and before revision `f53382784f89ddd1ccc7534c1b3f87e027d93e08cdc9d78db02f4989b14fd875`;
- the coordinator cursor stopped at `applying / recording_may_be_open`, with zero finalized mutation attempts, verifications, checkpoints, creator reports, or gameplay claims;
- Studio's settings file retained the opening placeholder `pending_recording_creator_change_set_8fe28fb341ad4d266f60adc8` with `opening = true`, while the live plugin held Studio's different opaque recording ID. Reusing the same mutable table across `SetSetting` phase writes left the persisted cursor stale, and the later readback guard raised `provisional evidence persistence binding rejected`.

- session `creator_session_fa375f4e-00ad-481e-af8c-ddd502d6d0a2`, final session hash `794b8e38d692acd44c26951afccd9bacf4a988398b2e054fe1cdc67d886e43c5`, status `creator_accepted`, started `2026-09-01T08:38:14.073Z`, accepted `2026-09-01T08:39:34.655Z`;
- request hash `e23896336d5b4c7da9ba9cd12a82c522de1292c91f2e6bfec421b806acbcbf1b`, plan `creator_plan_5aed53d2204146ad1e21642d` (`5aed53d2204146ad1e21642d5ffee64ef6363f8e65da110f379beb3237b8c2fc`), and change set `creator_change_set_14f0457ba6b75e3f03da1cd6` (`14f0457ba6b75e3f03da1cd6833550c8ec0c519d7ec0dcaa07d2d11f9aa19e4e`);
- planner `agent_run_4ee74b46-0a28-4fde-94e2-9a70dd34c90d` / `trace_bd611a9e-a642-4668-813e-60786437118d`, builder `agent_run_5729ecbf-1107-473b-b1ed-3faf8e8398d5` / `trace_cc345a28-60e6-44c5-8b1c-8753a34e6585`, with zero repairs;
- manifest hash `99a1c4f9db8a370ebf3beb536caa5211e5a54bc2b8044333d714047e2256b80d`; mutation attempt `creator_mutation_attempt_14f0457ba6b75e3f03da1cd6_1` (`83d2a714f68cf480782eaa366ba51e2061af74a4c149a3d27d6584943f7ddc29`) bound projection `00af936a08c0aac557318af427aecccc8bfdc083cf83dffbd1d235c0076a317a`, reconciled `matched` with no failure facts, and finalized recording `recording_4204850255683497953` as `committed`;
- before revision `f53382784f89ddd1ccc7534c1b3f87e027d93e08cdc9d78db02f4989b14fd875`, after revision `7a49e3f41313748027a9e1008127917fc0a460255f6fd42054f49477602245c7`, direct-readback hash `51e7b430d80ab245ab9f4c11d15845d2a804c14064725ec78ad2626525173fb2`, reconciliation hash `20ad1fbb52dcc2d18da0387c51d9083764b4883e30a611d29533c074f47bf6e2`, finalization hash `8700432e5c7a014a798aabc2fc6d75b812a45db55840d02b23afc48efbe72a38`, and post-commit evidence hash `9ab43442fbc5f6e0066d0081c7a545ea7d180c001ed5241ab7fbfd7c2a524c37`;
- verification `creator_verification_af0034c8cc325141a11ae352` (`af0034c8cc325141a11ae352397e766c7ed438645cd2bc9ee0bb8ac786e06863`) passed with no failure facts, using execution plan `studio_execution_plan_149ac23a2f5e4acc1a4134a2` (`149ac23a2f5e4acc1a4134a2588c968059bf0a5f526d3b9d910da07c8b8e40bd`) and complete runtime evidence hash `0a5d60462a7e530f5cd1153ec96be34722097781062b95d550ef6c264db2d5c1` with no diagnostics;
- checkpoint `creator_checkpoint_dbf22bfdacef48ffe9e60fb1` (`dbf22bfdacef48ffe9e60fb1ec13dc81a60bbc1367b739ca28ce0d84bbcff46e`) and creator review `creator_review_report_44e97f0e8f0aadd7df9fca60` (`44e97f0e8f0aadd7df9fca601ea03a28217f6b0e04b1f70d816440467cdf92c2`) were persisted; the creator accepted with report “It works completely.”;
- mutation replay returned exit `0`, `exact_match`, recorded/replayed `matched`; verification replay returned exit `0`, `exact_match`, recorded/replayed `passed`; both reproduced empty failure-fact hashes without a provider, network dependency, or Studio operation.

### Capability completeness milestone

The closure audit rejected three false-positive routes before this milestone was accepted: official `Datatype.Font` is no longer confused with the distinct `Enum.Font`; unset Instance-valued properties are canonical observed values instead of read errors; and properties typed with the deprecated `SurfaceType` enum cannot become authorable merely through policy-selected inheritance. The current connector build hash `3c626737bc156f27f209da5a1a4f938a9191269bd4d35070ab718b7bfd042e49` also binds the evidence generator and TypeScript evidence contract as well as the manifest, protocol, host transaction participants, plugin project, and authored Luau runtime, so a codec, platform-parent, project-index, runtime-lifecycle, or host-side transaction change cannot retain an old connector identity. The manifest now independently binds the generator plus TypeScript evidence and project-index contracts; changing canonical projection material therefore creates a new manifest identity instead of silently reinterpreting retained evidence.

### Consumed creator-Stop rollback defect

The later creator-authored door-hinge run exposed a lifecycle defect rather than a build defect. Session `creator_session_2e5ac9c7-b9ff-4fc3-bd8d-a50720204f20` used plan `creator_plan_cc1ff023d8e48e431d0d00b2` and change set `creator_change_set_a0bb94897412608d6144cbc5`. Mutation attempt `creator_mutation_attempt_a0bb94897412608d6144cbc5_1` (`6f98e6624ae6bd3471209fd4c54467946de176c2ed4bb8e4b96060d641e5a2d8`) reconciled `matched` with no failure facts under reconciliation hash `54a82fabf7907912297412b9952426438b0d8bc4f3133785b6c415ebf0534c2f`; the provisional revision was `cc72ae82fb6bef67d1209484a91eae48b96ec0363eca663b59b696ac54b1cde5` from initial revision `eafa1e0929ed7990a0ef706e30311f87cceeaf10c6c50a3b02419644b0b0a778`.

The creator then used the hinge successfully in Studio and pressed the ordinary Stop control. The old creator path had started a programmatic `StudioTestService:ExecutePlayModeAsync` run and required the injected runner to call `EndTest` after its full observation window. Manual Stop returned `nil`, so verification draft `creator_verification_af96ac15dddfef82a3f13219` (`af96ac15dddfef82a3f13219e4fb70f1f3a65f9472577bb1996dd5286da347a5`) correctly remained `incomplete` but the coordinator incorrectly routed that infrastructure absence through its generic verification-failure cancellation branch. Finalization `creator_mutation_finalization_d4c6b8162ae8e345a407dcab` (`24299315629eac1d51d82eaf79b847d14e6abfb6741c2e2980b79fc254e48618`) cancelled recording `recording_12353536219018302493` and restored the initial revision. There was no committed checkpoint, final report, accepted/rejected creator result, replayable verification verdict, or machine gameplay claim.

### Consumed passive-Play lifecycle defect

Session `creator_session_772dca14-a0de-44f9-8cba-1cc8b6e989e9` (`1cb09369776bb82af173f19fdc54b0e5420be02aaa264cf0774df7a21c141ded`) used prompt hash `9a0068a2245da442904f7baf9887d9fc1a7bf3a43e2f9c5249b4f55b753631e8`, plan `creator_plan_b8cf02e59b446f09bee82035` (`b8cf02e59b446f09bee820355679033686af669f28912609698b2511bfdcdedc`), and change set `creator_change_set_f465161d825b4d2cd9fee691` (`f465161d825b4d2cd9fee69135856f5224593ebeb6039fa9a8225adea5b863ee`). Provisional attempt `creator_mutation_attempt_f465161d825b4d2cd9fee691_1` reconciled `matched` under hash `3701837eee400278954e2c850aa1557bad68afe6d7ea7e7d1f2d982505191669`, retaining recording `recording_380893068892191361` across revisions `959cc7a528565fa502087b1a181bee5ede7a7b1ae8566eee179509f3198314ec → 2862272f1e7b8b7fa5fbece8137f814ed6a3f564638aa4ed9977020452113111`.

The connector accepted execution plan `studio_execution_plan_5449b4bfaca53aae9d610c36` (`5449b4bfaca53aae9d610c36b0bf67356edd6efb06ef90dacdd2c64693cacfa4`) but emitted no `RuntimeEvalStarted`, runtime envelope, or `RuntimeEvalStopped` when the creator used ordinary Play/Stop. Verification draft `creator_verification_427983b2909e554bf2e4f924` timed out waiting for runtime start because the generic six-minute transport timeout incorrectly covered human Play latency. The automatic re-arm then produced draft `creator_verification_8294fa07db8e643232e4c29b`, rejected because the plugin still held the first exact plan. The creator reported that the hinge interaction looked correct, but this is creator observation only: there is no runtime proof, finalized mutation attempt, commit, checkpoint, review report, accepted/rejected verdict, or machine gameplay claim.

### Consumed passive-runtime collection defect

Session `creator_session_74960890-f231-4b64-a0a8-6dba6b3be30f` proves that the cross-data-model lifecycle fix worked while its evidence transport did not. The matched provisional mutation is `creator_mutation_attempt_e44bc1e0fa8cb5a5c2d47d3f_1`; recording `recording_6704729960395439030` remains open at revision `a44aff6f541b1d0b98dfa74301e62d3ad1bff052d44e65513af6f3223cf54043`. Execution plan `studio_execution_plan_26a2a3546c22cfb97d0ba329` (`26a2a3546c22cfb97d0ba329302229aeee892d5e9ab5a332bcd67a6046bb81c9`) completed the full protocol sequence through `PassiveRuntimeEvalFinalized` for Play interval `2026-09-01T14:28:04.000Z → 2026-09-01T14:28:17.000Z`.

Runtime artifact `71bbe8c4560e8e4e533877f5c97524b646d3114439fdfa2c916d2e48aba4cd09` has envelope content hash `2fa70f34c81a0ca8b2214c0fc22360c50bea82d091938156336501f9345f4c59` and verification evidence hash `77b8756341bda5bed92a2c015e77dd291d960cfa19f49b08e1936086e90a78c8`. It is `incomplete`: all six requirements are `read_error / missing_runtime_result`, diagnostics are empty, and the Studio log contains no Forge checkpoint prefix. The injected runtime Script → `print` → `LogService.MessageOut` channel therefore produced no evidence even though Play/Stop and finalization succeeded. The coordinator then emitted a second `RuntimeEvalPlanAccepted` automatically and returned the dashboard to Waiting, falsely suggesting the first Play had not been detected. There is no finalized mutation, verification verdict, checkpoint, review report, or machine gameplay claim. The creator's statement that the hinge worked remains creator-authority observation only.

### Consumed planner parent-topology defect

Orbital Freight Airlock session `creator_session_c7e9722e-1fb9-434f-8293-6f37d030e00c` (`113318f5daed2eb313663be15fe7f07ac81f470bd407a6fe6a7083aa7c02549b`) ended `incomplete / PLAN_NOT_PUBLISHED` before approval or Studio mutation. Planner AgentRun `agent_run_2e3dfabe-e785-4c78-aee5-e1ca884d6b3a` is stored as artifact `4bfec765e58043db3945908a63ed83d31fa7c54effa16e6ca5dce5fa0733cf1a`; trace `trace_f1d1bd0d-c40c-40b8-8575-26afc51196e1` is artifact `8000300eb12556ad32eb308fe36e6236fda78009e3c9658304ad54c6ad62450f`. The run used six of 32 turns, 26 of 256 tool calls, 54.144 seconds of 30 minutes, 96,569 of one million input tokens, 5,136 of 128,000 output tokens, and USD 0.01302488 of USD 10; no budget was exhausted.

### Consumed builder verification-topology defect

Orbital Freight Airlock session `creator_session_1c9a435d-bde2-4121-8f20-fc7101c576fb` (`495bbeaf15c7d0e6e50eb93337499154d6cd015b8f99bb0e6132c5ad75e2d45d`) ended `incomplete / BUILDER_LOCAL_GATE_NOT_ELIGIBLE`; failure detail hash `ab87dc2410427c50f309ad8d22393558e7505c7bf95b16a67806908bd5c37634`. Plan `creator_plan_067dfb1c571eedb14eeff490` and approval `creator_approval_af1068a39473324eac0c659c` sealed. Planner AgentRun `agent_run_1879c78a-c147-40aa-bf10-374f7df0b459` / trace `trace_fc0be05c-61fe-481e-8f61-31798476b1c0` were locally eligible. Builder AgentRun `agent_run_b031d14b-6592-4b73-b72a-87771c4f120d` is artifact `f0c1305165c4c7b326267d5e669877ca304d0b3f40850059026f8b17548e6ad9`; trace `trace_c58c8b2b-1b85-4595-83de-bc9edf5e273c` is artifact `ff0d446a7af27d4dbca8462e0c9721870e6e61254cb22945c8cd679f7dc2df20`. It staged all 25 approved operations and used 14 of 32 turns, 58 of 256 tool calls, 137.623 seconds of 30 minutes, 550,603 of one million input tokens, 13,911 of 128,000 output tokens, and USD 0.03906424 of USD 10. No budget was exhausted. No change set, Studio recording, mutation, verification, checkpoint, report, or gameplay claim exists.

### Consumed builder progress-epoch defect

Orbital Freight Airlock session `creator_session_fcd59d97-b225-4790-899e-45a8d1e32540` (`29f3140eb733774eee6464bcfa40738bf98a4e8e7d3d652c5d6aabfa510ff18d`) ended `incomplete / REPEATED_NO_PROGRESS_TOOL_BATCH`; failure detail hash `7b4fba48f31b5aa49052186e44289e7954d95520c705d947fab6b06c81c8b6d8`. Plan `creator_plan_5122e0c431c93531b0b6f47a`, approval `creator_approval_88f6a300f7733408d5958378`, and build contract `creator_build_contract_a736e8c4324945ae665e04a9` sealed. Builder AgentRun `agent_run_5c6f742f-4271-445c-b250-109076bad938` is artifact `71da36e2f784551aa38448dfc30a2ea72a71c12c67bb2f31e36d1ec1e51ad243`; trace `trace_5d0f5cee-04a5-4b9c-ad71-cb76a06dce6a` is artifact `5c188d46920bd54d7d15154e44d431eead4e54efcda5b3868ea0671af0ed75e8`. The 12-turn run executed 73 tool calls, staged all 24 approved operations, repaired its source after the first eligible gate reported warnings, and reached a second exact `forge.verify` result of `eligible` with no issues. No change set, Studio recording, mutation, verification, checkpoint, report, or gameplay claim exists in the consumed session.

The terminal classification was a runtime bookkeeping defect. `studio.diff` appeared once before the final accepted stage-and-verification transitions and once after them. The no-progress counter fingerprinted only the tool batch, so those identical reads collided even though the builder host's accepted staged-state/local-gate token had changed and the host was already seal-ready. No-progress identity now includes that exact progress token, and every accepted state transition clears the prior chronological epoch even if content later cycles to an earlier hash. Repeated calls inside one genuinely unchanged, unready epoch still terminate. On the first no-progress batch, an exact tool-host completion check is authoritative: a ready host seals without another model turn, while an unready host remains subject to the repetition bound. Deterministic local re-execution of the recorded 73 calls under the corrected runtime completed and sealed 24 operations as `creator_change_set_97252149b3502ad6a5486f80` (`97252149b3502ad6a5486f80c9e27cbd3a1f83016764889708f85d676ace4322`) with an eligible empty-issue gate. That replay proves runtime/tool-host behavior only; it is not added to the consumed session and is not Studio or gameplay evidence.

### Consumed planner varied-failure-streak defect

Orbital Freight Airlock session `creator_session_e1889118-4956-47d0-b7dd-faa40c7f86e0` (`4c493e12fefb9eee9025669821e467bd089afb538f9e6b24feec038d243db7f2`) ended `incomplete / CONSECUTIVE_ALL_FAILED_TOOL_BATCHES`; failure detail hash `6009bfc0886f3503ba0c6cf43fdd8c3193ed4677e470bd99740d2f5f6eb1db81`. Planner AgentRun `agent_run_6501bc40-4da6-4819-a972-c17b09fb618c` is artifact `694bfb598e335c8fd34aed6fd7809fa3564339a85df6db816f957a2c44cd4350`; trace `trace_40893ec6-ece7-4bd0-91f7-21ae554cc259` is artifact `3236675a2ebb931e437906a54432014c83e92eeb2143f575f113730478b56fea`. The six-turn run made 22 tool calls over 96.648 seconds and used 86,636 input tokens, 11,428 output tokens, and USD 0.01986648. No plan, approval, change set, recording, mutation, verification, checkpoint, creator report, or gameplay claim exists.

### Consumed finalization-inventory race

Orbital Freight Airlock review session `creator_session_f661face-4c53-4bd7-ae9d-4ba3ff45756b` reached `preflighting` and Studio rejected `PrepareCreatorChangeSet` before preflight, recording creation, or place mutation with `SECURITY_REJECTION: creator prepare requires acknowledgement of the prior finalization receipt`. The receipt belonged to already-settled cancellation session `creator_session_8c0c5e3e-0725-4bab-94ce-16b5583c6089`, change set `creator_change_set_65a0acaafb29425405e5d887`, and recording `recording_12791897696750865225`. It was a notification obligation, not an open recording and not evidence about the new change set.

### Consumed chronological rollback/finalization-tail defect

Orbital Freight Airlock session `creator_session_3b4e5065-924d-4127-ac25-186bf1f1bc25` provisionally reached revision `fcf1ff85e0b0681cad81f19397fea8deceab8ff7ec0972b867e7979c372ad11e`. Complete Play envelope artifact `74d3275b28a1a79f03d51df0895f10b6ec3b9a8a2790632a0e0a7da2ad6f44ef` covers `2026-09-01T18:09:07Z` through `18:10:16Z` with 28 facts and no diagnostics; both projected door position series remained static, so the declared movement checks failed on complete evidence. Studio then cancelled recording `recording_11683387525020547070` and proved the exact initial/final revision `857705cdd8e60a316a0d2c8740cf1b7c889f5c93514c4e2cf23eb7a0111fe036`. Settled mutation attempt `creator_mutation_attempt_3cff7185340aec8554aa4a1c_1` (`212d23a3e58cc80cbd42c0550b128ba35446d3018cc7306614adb3f43ad23714`) and cancellation finalization `creator_mutation_finalization_33eaae3fac8ae1a7f31db2dd` (`ddf6703b98d702a2597887c9b73604e6b6f22178993cb43311a28c0f26ee99a8`) were persisted. There is no commit, checkpoint, creator report, accepted result, or machine claim that the airlock interaction succeeded.

The coordinator incorrectly treated observation history as a uniqueness set. Because the rollback observation was byte-for-byte equal to the initial entry, it suppressed the legitimate third A → B → A boundary; bundle validation then saw the provisional B entry as the tail, rejected persistence, and stopped before acknowledging receipt artifact `558a6799270b281bd4b7f044cf6e71093c127f6610b82b74b23390dbfa357032`. The dashboard remained in `repairing` while the durable bundle remained `cancelling`, and Studio correctly blocked a later transaction on the unacknowledged settled receipt.

### Consumed source-write acceptance defect

Orbital Freight Airlock session `creator_session_2d742e6d-8338-4da0-8702-ca147cfa2839` (`c17020a43a4f6a3f8d6e8bdc2e9d1b46ed51ef50b15c71d762475cb0655762c`) ended `incomplete / creator_preflight_protocol_failed`; detail hash `ac4a560ea213339194c8e4c7b9d4500c56399a885a2bc3d8181f0cfd2eb48451`. Plan `creator_plan_9f313ce688ffc6f8006a9ebe`, change approval `creator_approval_e35bc0955cc115912b493e0f`, and 18-operation change set `creator_change_set_9d59b1d172076ec2f452ca7a` sealed. Its three source manifests were retained under hashes `9985c4a8…25a09`, `c3ae0be0…6c543`, and `f0063249…2c67`. The pre-Apply index exactly matched revision `ec258aa0…bf12`; Studio then rejected the source-write completion handshake with `source-write blob is absent or incomplete before Prepare`. There is no `CreatorChangePrepared`, verification, recording, checkpoint, review, or gameplay evidence. Forge therefore makes no claim that Studio changed.

The durability repair was exercised by a fresh retry. Session `creator_session_ba53e6bb-f80d-4271-bba2-6ab22341991c` (`c020434d7723eba7194d660661eb5ce296c37a759083e8b7536eba13bab8a7f5`) ended with the same classification and detail hash against exact revision `75e92d2c50797b7eb9e60b0ed12c42daf07c0f443b12352bbe1e976f03c3675e`. Plan `creator_plan_6848a0eb9f171aca8bf3616e`, approvals `58f86cef…82cf` and `89d57a28…ed71`, and change set `creator_change_set_83aa168caf3342f623f80242` (`83aa168caf3342f623f80242872e826484382695eee0588af10e188128eee984`) sealed. All three source bodies were retained under manifests `5f1888b8…7d787`, `707e41c9…f070d`, and `b845ca77…14a88`. This time Forge durably recorded mutation attempt `creator_mutation_attempt_83aa168caf3342f623f80242_1` (`4e36a368157a5afb2ee2e0169efcc10ad24d6b88ab0a9cb1e40cf83d36db8006`) as incomplete during preflight, with failure-fact hash `6fd7fb4c…a8663`. There is still no preflight envelope, recording, place mutation, verification, checkpoint, creator report, or gameplay claim.

### Consumed creator projection-binding defect

Orbital Freight Airlock session `creator_session_b008fa41-ed6c-42b5-a565-d965603233b0` (`2121079b167d8c066f10333a6337b37f016cedf09d7de40782e5bc01bb8e02a3`) ended incomplete after exact change approval, with detail hash `439d713ad0a1da9eabb3a1641e2966fd2da9078b126f6c77fb930b00e192c5d0`. Plan `creator_plan_75c7d7f337d81dcdaa5ce781`, change set `creator_change_set_a73b098654ae3e216a54e939`, and mutation attempt `creator_mutation_attempt_a73b098654ae3e216a54e939_1` (`2d2e489493e04e0d8f477f794aa07e4671fcc0c08852ecf549145bfcd6672d38`) are retained. The pre-Apply index exactly matched revision `2c10476c5dad6d9671770f8ce2ca2235374aabd7c54f8fb4bdc18e864924befa`, and Studio acknowledged all three immutable source bodies. The plugin then rejected Prepare because the sealed projections correctly carried `binding.revisionHash` while handwritten Luau checked the unrelated runtime-plan name `binding.projectRevisionHash`. Failure fact `ae3126ed5092b4b80c7a501a8da9c85212847438551661fe25365616d2accc40` records that self-rejection.

### Consumed opaque-index authoring-boundary defect

Orbital Freight Airlock session `creator_session_c5bdf9f6-23a0-4494-be4e-3832dbcd2348` (`dc758f6d1952985f675ff570e9e4d6efb97cfed129c3000ac06acf2bc05ceef6`) ended `incomplete / creator_prepare_protocol_failed` after exact change approval. Plan `creator_plan_5bb5ff2737b2daae02da5447`, change set `creator_change_set_b0e07a83c489cf536129863d`, and mutation attempt `creator_mutation_attempt_b0e07a83c489cf536129863d_1` (`90ea294b63569f4e994f7cd71597f7aaf4899e0b75ef0ba22b0dbecb0ffc3597`) are retained. Its pre-Apply project revision was `2142915e1e47d0a9ef8160e93ce93582317f1f5d361fe0e5fd478d77a5cfba1e`; all three source bodies were accepted. Prepare then failed with failure fact `267ece69ce1804fa5279d1f5e19556a496cdb2bf4323eba8babe9450fc735ee3`: `mutation target outside manifest`.

### Consumed duplicate projection-authority defect

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

### Consumed structural-parent authorability defect

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

### Consumed live project-index coverage and transaction-notice defect

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

### Consumed size-dependent project-index publication race

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

### Documentary historical evidence

The historical capability canary remains `studio_capability_canary_beef4ad696113cbf8b69de7e`, bound to `studio_execution_plan_7e138ef9465e5a60ab1aae3d`. It established only the predecessor transport and observation substrate.

The sole consumed MovingPlatform trial remains `agent_run_e7b303bf-5712-4cc5-9f0a-f15c17d22286` under `harness_configuration_bca40ea4ef667a18a61089e9`. It crossed `trialStarted` and ended `incomplete / agent_failure` with no writes, candidate, or Studio run. Its missing-root defect is fixed by the current regression; the historical result is not retried or rewritten.

The historical Vertical Shuttle treatment remains registration `experiment_registration_60857fefe801607baa1f6b7d`, AgentRun `agent_run_ba3716f8-4ecc-4bf8-9689-45f41700f179`, candidate `workspace_candidate_79937cb8767b18d553850b63`, runtime run `runtime_evaluation_run_35b4ef7f3f9c482d82d498bc`, runtime plan `runtime_eval_plan_5d7c1c5236342ae56fe30ecf`, and proof `runtime_proof_84e4e26fda34ee4dd937597e`. Its exact predecessor treatment was `runtime_verified`; this is not evidence for current authoring or general model quality.

The first rejected Status Beacon session is preserved unchanged as successful failure evidence: session `creator_session_9e8d9646-6460-432b-a1f5-9ef0a72182f3`, plan `creator_plan_1d26e6203c428915825673e7` (`1d26e6203c428915825673e7f0759510a125e58f18b015656d2ccbcaf37027c8`), approval `creator_approval_aea4665ee662da5f87d2dc6d`, AgentRun `agent_run_26f87d81-fd13-44c0-a50a-e7fd0e2628fb`, and trace `trace_b94e2b50-c19c-4c48-8b48-68c0196bbf90`. It exposed class-blind existence checks, an impossible planned-parent nesting, vague alternative-path prose, diagnostic attribution overclaiming, and workflow button overload. No builder, mutation, verification, or checkpoint occurred. The session is not rewritten or retried.

The second consumed Status Beacon session is also preserved unchanged: session `creator_session_e9ac955e-1f3b-4735-bcfd-fdfec308d058`; corrected plan `creator_plan_641a87b5293de093607599d4` (`641a87b5293de093607599d4f1cbbc0683bf6d59c3aec5a1620434e97ccb066c`); plan approval `creator_approval_f4ccd167ba311da97ed23b66` (`f4ccd167ba311da97ed23b66319b522023565ba1fd426ece64b54858ecb5f98f`); planner AgentRun `agent_run_9647b86e-41f7-4c3e-8c09-87a7a1206bdc`; and planner trace `trace_13a68af6-9205-474f-bed2-e03812b707dc`. The planner corrected two invalid proposals in the same AgentRun and reached exact approval. The builder then ended with zero accepted operations, and sealing threw `Creator change set requires 1-32 uniquely identified operations`. Because persistence occurred only after sealing, no builder AgentRun or builder trace was written. No Studio mutation, verification, or checkpoint occurred. This is the exact evidence-loss defect fixed by the current implementation; the consumed session is not rewritten, resumed, or retried.

The third rejected Status Beacon session remains unchanged: session `creator_session_241d11a1-252c-4094-b6a9-6017662f0d38`; plan `creator_plan_85681d35e151a2fb7ab60669` (`85681d35e151a2fb7ab606696331179f9fc87d0a792f3dbc85b29ed1bd3224bf`); rejection approval `creator_approval_650a75ab0c3802dc22843255` (`650a75ab0c3802dc228432551f07cb68dae8a9b81f779c8979e738ae686e1254`); planner AgentRun `agent_run_b687611f-d8a7-4565-b49b-be3d414128c0`; and trace `trace_f7ab8597-96c6-49bd-abd7-d71004309736`. Luna's first tool call correctly planned a new Script with source plus Script existence and Luau syntax checks. Forge rejected that executable proposal because planning could not express source on create, then rejected the safe `ServerScriptService` existence check because observation was incorrectly bounded to `Workspace`. The planner adapted to those tool errors and Forge ultimately sealed a weaker structure-only plan that deferred the requested runtime behavior. The creator rejected it before any builder, Studio mutation, verification, or checkpoint. This is harness-contract failure evidence, not a model-quality failure; the session is not rewritten, resumed, or retried.

The fourth consumed Status Beacon session is preserved unchanged: session `creator_session_ee098877-0434-4adc-ac25-971f56d65d75`; approved plan `creator_plan_f917b66a7c6c344f505814e3` (`f917b66a7c6c344f505814e3a7c48c2035be673262b8848f7cc13c831aeaa9d6`); builder AgentRun `agent_run_20b5f04f-8f3e-4602-931c-6679998b41e8`; and trace `trace_a2382f5f-18c8-4832-8029-de4a90c8d94c`. It ended `incomplete / RUNTIME_BUDGET_EXHAUSTED` after 12 turns, seven recorded tool calls, and `$0.00893117`. No operation was accepted, `forge.verify` did not run, and no Studio mutation occurred. The builder was not shown the approved plan/build contract, had to guess change IDs, path, and class, did not receive the exact property allowlist, and received vague mismatch feedback. This is harness/model-interface failure evidence, not a model-quality failure; it is not rewritten, resumed, or retried.

The fifth consumed Status Beacon session is preserved unchanged: session `creator_session_908dcc05-e702-40fc-91c1-5bb998d95aea`; approved plan `creator_plan_a06dd8d1e3198a19ed46b911` (`a06dd8d1e3198a19ed46b911a97f08e08a8d901b858f0c77d8578e2c2f8af43c`); planner AgentRun `agent_run_fbb75cf3-6843-41a5-aee3-7d45e3ec1676` and trace `trace_dd303aab-42f6-420b-b5e7-4e79e3f9eff5`; builder AgentRun `agent_run_e9f54f0f-de53-46b7-92e0-8a16cf03b1ff` and trace `trace_56a2d795-4072-47d6-9c6b-98c17a5b1c37`. Planning sealed successfully. The builder first supplied semantically correct natural JSON for the Part properties, but Forge exposed its internal tagged `StudioValue` representation as the model tool contract. Three progressively adapted encodings all failed with pathless schema errors, triggering the consecutive-all-failed guard after four turns, four tool calls, and `$0.00324777`. No operation was accepted, `forge.verify` did not run, and Studio was not mutated. This is preserved harness-interface failure evidence; the current clean-break model-facing property contract uses natural JSON and performs the tagged conversion behind the trust boundary. The session is not rewritten, resumed, or retried.

The sixth consumed Status Beacon session is preserved unchanged: session `creator_session_2fc9d4ac-d27f-4ac1-87df-60701bcb9468`; approved plan `creator_plan_0927f211476722b7e3c3d431` (`0927f211476722b7e3c3d431527e51e9e9fa9ee80c246cf6be14758c1a9e5dc2`); sealed change set `creator_change_set_12f86290d366d7a2e6501b5f` (`12f86290d366d7a2e6501b5f014905737b3aeda26904ad732f9f8ecd24a9c87c`); planner AgentRun `agent_run_102524ec-7a5c-4229-a7dd-ff496053278b` and trace `trace_d55a23ae-a0a1-46f4-9f15-cba33da4bd80`; builder AgentRun `agent_run_23fd5567-5894-47cd-9e84-60fb7a31c093` and trace `trace_559e93a3-d7a2-49fb-9b0d-5de1c92fa8ae`. Planning and building both sealed, all natural property inputs staged on their first attempt, and the local gate was `eligible`. After exact change approval, Studio created the Part and Script inside an open recording. Post-apply observation showed Roblox had stored the requested red channel `0.1` as the 8-bit value `0.09803921729326248`; Forge compared it to the unrepresentable input decimal and falsely classified the Color as mismatched. The recording was automatically cancelled, a fresh rollback observation exactly restored the initial revision, and all three initial/transient/recovered observations are preserved. No playtest or final review occurred. This is storage-semantics boundary failure evidence, not builder failure. Current Forge canonicalizes natural numeric/color inputs to Studio's storage domain before review and the connector accepts deterministic canonical color bytes. The session is not rewritten, resumed, or retried.

### Accepted Orbital Freight Airlock baseline ledger

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

## FORGE records

### Model and tool ownership

`studio.build` records one complete virtual implementation only. Forge derives every approved operation's ID and structural fields from `CreatorBuildContract`; the builder may supply only the contract's allowlisted properties, primitive attributes, explicit removals, complete source for a new script, or sorted non-overlapping UTF-8-safe byte edits for an existing script. The full plan batch is atomic and immediately receives local Luau review. A rejected draft may be corrected in one atomic `studio.repair` batch; eligible build or repair results finish without another model request. Forge materializes final source host-side, checks the final hash and byte count, and Studio uses `ScriptEditorService:UpdateSourceAsync` only if the current editor-source hash still matches. The builder may read any source in the exact approved consultation closure; reading outside that closure fails with `source_context_outside_approved_closure` and requires a new plan. Model-facing properties remain natural JSON and are canonicalized through the sealed property policy before Studio. Local Luau verification analyzes the exact projected hierarchy and approved dependency closure without executing project source. Diagnostics use stable logical Studio locations; temporary host paths never define identity.

## studio-capability-evidence records

### Predecessor characterization

| Run  | Result                                             | Evidence and interpretation                                                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | Completed transport; invalid observation substrate | `studio_capability_canary_6cc7b6a13534442a8a991cd4`, execution plan `studio_execution_plan_203a57180b4299bdd66058be`. Correlated execution returned `(0,0,0)` for both endpoints despite nonzero serialized locations, so it was never valid grading evidence.                                                        |
| P0.1 | Incomplete infrastructure result                   | `studio_capability_canary_b4a90f7cd7cbf4e623272366`, execution plan `studio_execution_plan_c3b2b9d70bf3caf7923a8103`. The plan armed and Play Solo started, but no correlated runtime envelope returned; the run remained a timeout/connector failure, not candidate behavior.                                        |
| P0.2 | Successful earlier capability characterization     | `studio_capability_canary_7e4602dae1fc51b6023c987a`, execution plan `studio_execution_plan_7be78fcad2a0c9eab607f347`. EndpointA was observed at `(-12,4,0)`, EndpointB at `(12,4,0)`, and the stationary seed platform returned four bounded samples at `(-12,4,0)` over 1499 ms through correlated direct `EndTest`. |

P0.2 artifact SHA-256 is `36716e671a64ba15393ec7647e6ac0b750ab2a50d2b8026a2ddb03fd63293ee8`. Its preserved record and place are in the external canonicalization snapshot under `p0.2-canary/`.
