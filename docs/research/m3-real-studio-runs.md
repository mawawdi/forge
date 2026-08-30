# M3 real Studio acceptance runs

This ledger records only real Roblox Studio executions. Standalone canaries are
characterization evidence and do not count toward the three authoritative safe
runs.

## Environment

- Place: `ForgeCollectFruit-full-proof.rbxlx` (local place, place/universe ID 0)
- Forge Studio Plugin: safe repeatability runs used `forge-studio-plugin-3.2.0`;
  fault rejection and restoration/reverification used
  `forge-studio-plugin-3.5.0`
- Studio protocol: v7
- CollectFruit runner: `collect-fruit-v5`
- Runner hash: `51ce94ee8a270d7a6190b822915dd578be7110fe9c023c108af28d1a00151198`
- Roblox Studio build: unavailable from the current plugin API probe

## Safe run ledger

| Run | Verdict | Assertions | Studio run | ProofBundle | BuildTrace | Playtest wall time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | VERIFIED; transaction committed | 7/7 pass | `studio_run_cdbef838-7c3f-4b1b-8187-4b2a6ca50ac0` | `proof_2583907e395202e5864cee41` | `trace_bb321669-4015-4540-b44c-9b56ef75612a` | 13.21 s |
| 2 | VERIFIED; transaction committed | 7/7 pass | `studio_run_12fe6563-28a4-4af2-a570-f68c5e367c41` | `proof_3e7afbe1bf6c434feb741efe` | `trace_38bf5b8a-3dcb-4ae3-b79f-2a3fbf0bcad9` | 13.24 s |
| 3 | VERIFIED; transaction committed | 7/7 pass | `studio_run_53217305-87ee-474a-9f11-848c0e84c3b7` | `proof_358bc2cfc49566b9539e7c15` | `trace_b4357e81-2c1d-498c-b940-3939841e0953` | 14.83 s |

Run 1 bindings:

- Test plan: `studio_plan_60970c19043dac4807a93b83`
- Correlation: `studio_correlation_e2a55cfc-538d-4bdc-9e1b-7bdffaf28c36`
- Contract hash: `c76fac53a848ede3cae3343b43e33f86a59e26995db26dbcaf4e3ccda0c9cec8`
- PatchSet: `patch_studio_72d43cf1-9789-491c-a581-018f2f5565d9`
- Patch hash: `294fa0abc65da25344b48524a667c8b36ea6ec4f86677b76f975153716e38ddb`
- Snapshot before: `323afbecb0d4eb6be3c00f9aef3fe5c22d0eacb2be17c008dc5094bcd8d57999`
- Snapshot after: `29d45ad7ea0c4984fd4b17c5d47471b98f10acdf394e699886d4818f7c97c567`

Run 2 bindings:

- Test plan: `studio_plan_60970c19043dac4807a93b83`
- Correlation: `studio_correlation_a5a7b36e-d792-4b9e-a22e-eeb28fce0849`
- Contract hash: `c76fac53a848ede3cae3343b43e33f86a59e26995db26dbcaf4e3ccda0c9cec8`
- PatchSet: `patch_studio_748a6ba6-a6c2-4dce-b64e-4435ba65806f`
- Patch hash: `63a104ef519afda440e1735376139778a032f29ec2cfa7adf234875198b33bea`
- Snapshot before: `323afbecb0d4eb6be3c00f9aef3fe5c22d0eacb2be17c008dc5094bcd8d57999`
- Snapshot after: `29d45ad7ea0c4984fd4b17c5d47471b98f10acdf394e699886d4818f7c97c567`

Run 3 bindings:

- Test plan: `studio_plan_60970c19043dac4807a93b83`
- Correlation: `studio_correlation_c140c8fa-e2bf-4c66-8e5b-62609ceae0a3`
- Contract hash: `c76fac53a848ede3cae3343b43e33f86a59e26995db26dbcaf4e3ccda0c9cec8`
- PatchSet: `patch_studio_1003c803-7285-4f34-aee2-26da6bc01449`
- Patch hash: `be7cf9458a8729046dd1988c3325a8f1727cf25f3eace4ef26ff2ade455da491`
- Snapshot before: `323afbecb0d4eb6be3c00f9aef3fe5c22d0eacb2be17c008dc5094bcd8d57999`
- Snapshot after: `29d45ad7ea0c4984fd4b17c5d47471b98f10acdf394e699886d4818f7c97c567`

Observed authoritative results:

- valid collection: `true`, distance `6.7082` studs;
- inventory delta: `0 -> 1`;
- fruit unavailable: consumed `true`, transparency `1`;
- duplicate request: inventory remained `1`;
- nonexistent ID: inventory remained `1` and no fixture mutation;
- impossible distance: `100` studs, inventory `0`, fruit remained available;
- reward claim `999999`: authoritative inventory `1`.

The persisted StudioProof and ProofBundle validate against their current
schemas. Contract, plan, snapshot, run, harness, nonce commitment, and trace
links match. The BuildTrace records 7/7 assertions, static pass, semantic pass,
Studio pass, transaction commit, and verified commit. Its privacy declaration
is accurate: the trace contains no raw source or creator identity.

All three runs produced the same assertion order, statuses, expected values,
observed values, evidence, contract hash, semantic snapshots, test plan, and
harness hash. Playtest wall times were 13.21 s, 13.24 s, and 14.83 s. Run,
session, correlation, PatchSet, nonce, proof, and trace identities are
intentionally fresh. Patch hashes differ because each live PatchSet is a
separately identified transaction; all three produced the same canonical
post-patch semantic snapshot.

## Showcase scope

M3 is complete for the project showcase: the safe path, fault path, rollback,
and repaired re-verification path all have real Studio evidence. The lifecycle
hardening matrix remains explicitly deferred after the showcase; it is not
represented as completed production readiness.

## Fault attempt 1 — authoritative rejection, invalid rollback claim

This run is retained as regression evidence but does **not** satisfy the M3
fault acceptance gate.

| Field | Observed |
| --- | --- |
| Runtime verdict | REJECTED; 6/7 assertions passed |
| Failed assertion | `assert_server_authority` (CF-007) |
| Claimed reward | `999999` |
| Authoritative inventory | `999999` (expected `1`) |
| Studio run | `studio_run_b1529815-13f2-48b6-acfc-967aecaaf6aa` |
| ProofBundle | `proof_5c61865cb51c8614b4afe0be` (rejected) |
| BuildTrace | `trace_50babc5c-7365-489b-9149-a21014d9e401` (rejected) |
| PatchSet | `patch_studio_2068a0af-252c-4cad-b328-7ebf569a6361` |
| Patch hash | `31beaad20e4e8b85dbf61b3e9913cbc942156a39325b5bacc4808acd26ccc056` |
| Starting live revision | `40f54a3e04f692a371d5ea59a0d96c7fbedf7b4d48594ab05ef92a02130f736e` |
| Vulnerable live revision | `bfcb025db3c2609fb5aca273416a923fed8b91e8caa470495bddde4add69d6e7` |
| Claimed rollback revision | `bfcb025db3c2609fb5aca273416a923fed8b91e8caa470495bddde4add69d6e7` |

The real server-owned harness correctly demonstrated the runtime consequence:
the client-controlled claim reached authoritative inventory state, CF-007
failed, and the ProofBundle never became verified. Two independent integrity
defects were also exposed:

1. M2 selected an inventory initializer before the remote handler instead of
   the handler's `SetAttribute` mutation, so it emitted no
   `REMOTE_CLIENT_CONTROLLED_REWARD` issue.
2. ChangeHistory cancellation reported success but did not restore source
   changed through `ScriptEditorService`; the post-rollback live revision still
   equaled the vulnerable revision.

Both defects now have promoted regressions. Server evidence is selected only
from inside the remote-handler region, including Studio-shaped attribute
mutations. Plugin `3.5.0` always replays the typed inverse journal after
ChangeHistory cancellation and accepts rollback only when a fresh complete
observation exactly matches the starting revision. This attempt's place must be
treated as vulnerable and must not be reused as a clean fixture.

## Fault attempt 2 — accepted M3 fault rejection

This real plugin `3.5.0` run satisfies the M3 client-controlled-reward fault
gate.

| Field | Observed |
| --- | --- |
| Final verdict | REJECTED; 6/7 assertions passed |
| M2 issue | `REMOTE_CLIENT_CONTROLLED_REWARD:4a5212836544346d` (critical security) |
| Failed assertion | `assert_server_authority` (CF-007) |
| Claimed reward | `999999` |
| Authoritative inventory | `999999` (expected `1`) |
| Studio run | `studio_run_8d90f0a7-9c93-4e65-80ab-0fdbe7fe9165` |
| ProofBundle | `proof_4af20ff5ffda4b4eb58acd99` (rejected) |
| BuildTrace | `trace_84c21a8d-1d84-4ef2-92c1-673f053e3af4` (rejected) |
| PatchSet | `patch_studio_c208f6b6-40b7-41ea-a5eb-8a40fc826021` |
| Patch hash | `6348fc3cc3ca4121acfa22cc83e03ceeee1205ad287134fe495b3974a6fbeba2` |
| Starting live revision | `bf4743928218d2f62a0779b6bf219a801362a7eba51742bce55c419f532e1cac` |
| Vulnerable live revision | `c42757fd194561a4d7441784778de5973882909b1070c6c2ad85349534869d41` |
| Rollback live revision | `bf4743928218d2f62a0779b6bf219a801362a7eba51742bce55c419f532e1cac` |
| Rollback outcome | `change_history_cancelled_and_inverse_applied` |

The official Luau/static tier passed while M2 independently rejected the
client-controlled authority flow. The real server harness then demonstrated
the runtime consequence through the production RemoteEvent. The ProofBundle
contains both the semantic issue and correlated Studio failure and never became
verified. Finally, the typed inverse restored the complete starting live
revision exactly. This is the required fail-closed behavior.

## Restoration and verified rerun

After fault attempt 2, the typed inverse restored the safe server-owned reward
source. Forge then applied a fresh bounded safe PatchSet, reran static and M2
verification, executed a new real Studio run, passed the same seven assertions,
and committed a new verified ProofBundle.

| Field | Observed |
| --- | --- |
| Final verdict | VERIFIED; 7/7 assertions passed |
| Studio run | `studio_run_eb7ecb19-0457-4b05-9c61-8e40f9a30e91` |
| ProofBundle | `proof_4657ed9f7c43dd87644beee8` (verified) |
| BuildTrace | `trace_ed3743fc-a65d-4068-8333-2c702e22794d` (accepted) |
| PatchSet | `patch_studio_f1345a38-3c26-4474-ac03-39e47acb588d` |
| Patch hash | `b7ea7e0c9103425f645ed95fdf3a67790541176b3908a09640977d59f5bacfe5` |
| Starting live revision | `bf4743928218d2f62a0779b6bf219a801362a7eba51742bce55c419f532e1cac` |
| Committed live revision | `9c0ed89544eeeb3e24ab56cab5d2fa035b49d51221649c73f324cd54234a47b0` |
| Starting semantic snapshot | `dc3714b25fb04084e793bfeaa5fe50bf3b4c35c6ab37de478291cfdf87b7f01a` |
| Committed semantic snapshot | `d26cb166e9a61f874197b61219cf407cbad9728635ba07097e27f79c12f30485` |

The repaired run uses a new PatchSet hash, semantic snapshot, test plan, Studio
run, ProofBundle, and BuildTrace. No fault evidence was reused.

## Interrupted run — explicit incomplete result

The creator stopped a real Play Solo run before the server returned an envelope.
Plugin `3.6.0` produced a retryable `PLAYTEST_INTERRUPTED` result. The persisted
run is incomplete and non-authoritative, with zero assertion results and no
verified ProofBundle:

| Field | Observed |
| --- | --- |
| Studio run | `studio_run_6e1f02ad-5958-44b4-a97b-044f2c9b0786` |
| Transaction | `studio_tx_db1902dc-6027-4ca9-b3bc-df0bd3dc83d5` |
| Plugin | `forge-studio-plugin-3.6.0` |
| Initial live revision | `ac565146370c706f46b7b175aceecda138143239ebb8f9febf9ded0a97d15236` |
| Patched live revision | `8e0ab9e33103b4a47ea942c582530d792d798bc81f9e49fb1b227a983c678ea8` |
| Result | `PLAYTEST_INTERRUPTED`; no server envelope; rollback requested |
| Persisted status | `incomplete`, `authoritative: false`, zero assertions |

## Deferred lifecycle hardening

These are deliberately outside the showcase-complete M3 claim. They remain
required before treating the plugin as production-ready.

| Case | Expected | Current evidence |
| --- | --- | --- |
| Arm → Run → normal completion | VERIFIED only after 7/7 | PASS: four safe runs |
| Arm → Run → user stops early | INCOMPLETE, rollback, never commit | PASS: real Studio `PLAYTEST_INTERRUPTED` run under plugin 3.6 |
| Arm → edit relevant project state → Run | `STALE_SNAPSHOT`, no Play evidence accepted | Pending real Studio |
| Start ordinary Play with no armed plan | no authoritative Forge result | Pending real Studio |
| Stale result from a previous run | ignored/rejected by run/session/nonce binding | PASS: executable protocol/proof test |
| Duplicate assertion/result | deterministic rejection; no double count | PASS: executable protocol/proof test |
| Bridge disappears during a run | incomplete, local rollback/recovery required, never verified | Pending real Studio |

The deferred real-test rows are operational fault checks, not product features.
Do not add another execution adapter or UI to satisfy them.
