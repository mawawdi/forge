# Mutation Reconciliation: Closing the Writer/Observer Gap

This is a historical research record. Implementation descriptions, commands,
counts, and pending actions refer to the recorded builds, not the current product.
Use [Architecture](../ARCHITECTURE.md) for current behavior and
[Roadmap](../ROADMAP.md) for remaining work. Retained IDs and failure classifications
are evidence, not instructions to replay or resume a run.

Forge treats a Studio edit as a transaction whose result must be proven, not as
an RPC whose successful return is sufficient. This note records the rationale
for the current capability manifest, explicit evidence algebra, provisional
mutation sequence, and model-checked recovery rules. Normative contracts remain
in [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../FORGE.md`](../FORGE.md), and
[`../EVALS.md`](../EVALS.md).

## The failure class

A writer and an observer can each be locally correct while the system formed by
them is unsound. If the writer can set a fact that the observer cannot represent,
then a post-apply comparison has no principled answer. Treating omission as a
default invents evidence; treating it as a mismatch invents a failure. Adding the
one missing property repairs one incident but leaves the capability relation open,
so the same defect can recur for every future class, property, attribute, source
rule, numeric storage domain, or runtime observation.

The required closure property is therefore:

```text
writable => canonicalizable
          and validatable
          and preflightable
          and writable
          and readable
          and projectable
          and comparable
```

Forge generates all seven interpretations from one curated manifest and rejects
the manifest when any writable row lacks one. Roblox reflection is used only to
attest that curated rows are available under the connector's current security
context. Reflection never discovers or authorizes additional capabilities.

## Relevant systems principles

Terraform providers are required to return results consistent with their planned
values. The useful lesson for Forge is not Terraform's schema; it is that apply
and read form one contract, and an inconsistent result is a provider defect rather
than a value that the orchestrator should guess around. See HashiCorp's
[resource plan modification](https://developer.hashicorp.com/terraform/plugin/framework/resources/plan-modification)
and [resource implementation](https://developer.hashicorp.com/terraform/plugin/framework/resources/implement) guidance.

Kubernetes separates desired state from observed state and uses identity and
revision metadata to reject stale updates. Forge adopts the separation while
avoiding eventual-consistency semantics for creator mutations: the exact approved
projection is desired state, and the direct Studio readback plus complete
before/after project-index graphs are observed state. The recording stays
provisional until those bodies reconcile. See the Kubernetes
[API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md)
and [object management](https://kubernetes.io/docs/concepts/overview/working-with-objects/object-management/).

Getter/setter lens laws explain the minimum algebra a writable fact must satisfy:
reading after writing returns the canonical written value, writing back a read
does not change the object, and later writes supersede earlier writes. Forge's
detached round-trip canary tests the first two laws for only the capabilities
requested by the approved change. The manifest comparator encodes storage-domain
equality rather than JavaScript or Lua display formatting.

Protocol Buffers' explicit-presence guidance demonstrates why a missing field
cannot safely mean a default value. Forge makes presence more explicit still:
every required fact appears exactly once and is `observed`, `absent`,
`unavailable`, or `read_error`. Only the first two can be complete where the
projection permits them. See the Protocol Buffers
[field presence note](https://protobuf.dev/programming-guides/field_presence/).

PostgreSQL `RETURNING` shows the value of obtaining the stored result from the
same mutation boundary rather than issuing a semantically unrelated later read.
Forge similarly performs direct readback from the exact mutated Studio objects
before emitting the provisional result, while also requiring separate complete
before/after project-index graphs to detect unapproved drift. See PostgreSQL
[`RETURNING`](https://www.postgresql.org/docs/current/dml-returning.html).

Property-based testing, popularized by QuickCheck, is a fit for the manifest's
cross-language codecs because examples alone are weak at storage boundaries.
Forge retains named regressions such as `RequiresLineOfSight: false`, but the
general tests cover false versus missing, negative zero, float32 rounding,
non-finite rejection, RGB8, vectors, CFrames, enums, UTF-8 bounds, and tagged
length-delimited hashing. See the original
[QuickCheck paper](https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf).

Roblox exposes the two engine surfaces the protocol needs. `ReflectionService`
can report class properties visible under the plugin's current security context;
`ChangeHistoryService` can begin, inspect, commit, or cancel recordings. Neither
surface makes a network acknowledgement equivalent to durable proof. `Plugin`
settings are themselves a restricted JSON persistence boundary: Roblox documents
restricted key/value characters and the possibility of silent failure, explicitly
recommending a `GetSetting` check after frequent writes. Forge therefore uses
punctuation-free transaction keys, fresh immutable snapshots, and exact immediate
readback rather than treating a returned `SetSetting` call or a reused mutable
table as durable state. See the Roblox API references for
[`ReflectionService`](https://create.roblox.com/docs/reference/engine/classes/ReflectionService)
[`ChangeHistoryService`](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService),
and [`Plugin:SetSetting`](https://create.roblox.com/docs/reference/engine/classes/Plugin#SetSetting).

TLA+ and TLC provide a compact way to test safety across message duplication,
reordering, connection loss, and restarts—interleavings that example-based unit
tests routinely miss. Forge model-checks a bounded transaction before accepting
the implementation gate. The model's safety invariants prohibit opening a
recording without exact approval and passed preflight, prohibit verification or
commit without complete matched evidence, and prohibit any automatic mutation on
restart. See the [TLA+ tools repository](https://github.com/tlaplus/tlaplus).

## Forge's resulting transaction

1. Compile the approved change set into a canonical evidence projection bound to
   the manifest, connector build, session, approval, and exact before revision.
2. Have the connector independently recompile it and require byte/hash equality.
3. Run a detached, unparented round-trip canary before opening a recording.
4. Persist the complete preflight envelope.
5. Persist and read back an opening intent, open one recording, then persist and
   read back Studio's returned opaque recording ID before the first place
   operation. Apply provisionally and directly read every projected postcondition
   from the mutated objects.
6. Collect and persist a complete bounded post-apply project-index graph.
7. Reconcile the stored artifacts in a pure function. Complete contradictory
   evidence is `mismatched`; missing, unavailable, erroneous, misbound, duplicate,
   extra, or unordered evidence is `incomplete`.
8. Permit verification and commit only after `matched`. Commit is complete only
   after the acknowledgement and post-commit state evidence are persisted.
9. On failure, require exact cancellation acknowledgement and post-cancel state
   evidence. If recording state cannot be proven, expose an explicit, hash-bound
   recovery action and do nothing automatically.

Every transition is append-only mutation-attempt evidence. Provider-free replay
verifies the artifacts, recompiles the projection, regrades the direct readback
and allowed state delta, and reproduces the recorded status and failure-fact
hashes. A runtime playtest can add behavior evidence, but it can never substitute
for mutation proof.

## Consumed Door Control failure

The preserved Door Control attempt
`creator_session_65f2f12b-c178-46a7-bbf2-2c3943616915` was classified by the
predecessor observer as `incomplete / post_apply_mismatch` because the writer
accepted `ProximityPrompt.RequiresLineOfSight` while the snapshot collector did
not report that property. Its detail hash is
`124c67366b57a9c52d592133c851e9ce504f8eb117cffadbf931b9930762b612`.
That classification does **not** prove Studio stored the wrong value. It proves
the observer was incomplete. This distinction is the reason the current evidence
algebra reserves `mismatched` for complete authoritative evidence and represents
missing coverage as `incomplete`.

Exact consumed ledger:

- semantic session hash: `2b879d319cf00b16ef14e14c437606f970540141f5439c9e03b5a5cd12af538c`;
- preserved session-file SHA-256 before reset: `a045e4771d46dc412b68796afa92bbebcd58912dc2f72b7c69ab3c30f58053bf`;
- revisions: `a327a746de9e38275f2736ba848ca27da353ab542cd765aeb6f32ff926ef8900` → `59c24b99628542d2f8bf535a43874bb2b15c348ab048385d2df851e24961ffa0` → `a327a746de9e38275f2736ba848ca27da353ab542cd765aeb6f32ff926ef8900`;
- plan: `creator_plan_12fd84527d2ba0607734899c`, hash `12fd84527d2ba0607734899c3e572d457915997ff1000beaf7673a1faeb232e5`;
- change set: `creator_change_set_1e38c6b676df71acff9098df`, hash `1e38c6b676df71acff9098df6770ce721449ae3088fa6a0d3eae23926171182a`;
- planner: `agent_run_7ad4a7f1-276d-4778-8283-66c781f12e37`, trace `trace_7a9d7781-e2ce-4dae-b4b1-681545c01154`;
- builder: `agent_run_7c8f4812-6aed-4b15-b599-7f6441410fab`, trace `trace_46d932c6-1ac7-482b-92a2-a2d79d87e297`;
- verification, checkpoint, creator report, and gameplay claim: none.

## Subsequent accepted Door Control proof

The predecessor failure above is not the later historical result. A later run
through the closed evidence transaction completed as session
`creator_session_fa375f4e-00ad-481e-af8c-ddd502d6d0a2`, final session hash
`794b8e38d692acd44c26951afccd9bacf4a988398b2e054fe1cdc67d886e43c5`,
with status `creator_accepted`. Mutation attempt
`creator_mutation_attempt_14f0457ba6b75e3f03da1cd6_1` bound manifest hash
`99a1c4f9db8a370ebf3beb536caa5211e5a54bc2b8044333d714047e2256b80d`,
reconciled as `matched` with no failure facts, and finalized recording
`recording_4204850255683497953` as `committed`. Verification
`creator_verification_af0034c8cc325141a11ae352` passed with complete runtime
evidence and no diagnostics. Checkpoint
`creator_checkpoint_dbf22bfdacef48ffe9e60fb1` and creator report
`creator_review_report_44e97f0e8f0aadd7df9fca60` were persisted; the report says
“It works completely.” and records the creator's acceptance.

Provider-free mutation and verification replay each returned exit `0` and
`exact_match`, reproducing `matched` and `passed` respectively with no failure
facts. This validates the evidence and transaction boundaries that the earlier
observer failure motivated. Its backing store was subsequently deliberately
deleted, so it is documentary rather than live proof of the current project-index
or source-authority routes. It does not convert the free-form creator report into
a machine claim or establish capabilities beyond the exact manifest, projection,
and bounded runtime envelope used by that session.
