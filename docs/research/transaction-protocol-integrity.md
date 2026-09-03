# Transaction protocol integrity

This note records the rationale for Forge's creator-mutation transport and the
failure evidence that forced its current contract. It is research context, not
an alternate protocol specification; current schemas and state transitions are
defined by the implementation and [Architecture](../ARCHITECTURE.md).

## Consumed failure

Creator session `creator_session_b008fa41-ed6c-42b5-a565-d965603233b0`
(`2121079b167d8c066f10333a6337b37f016cedf09d7de40782e5bc01bb8e02a3`)
ended incomplete after change approval. Mutation attempt
`creator_mutation_attempt_a73b098654ae3e216a54e939_1`
(`2d2e489493e04e0d8f477f794aa07e4671fcc0c08852ecf549145bfcd6672d38`)
retains failure fact
`ae3126ed5092b4b80c7a501a8da9c85212847438551661fe25365616d2accc40`;
the session detail hash is
`439d713ad0a1da9eabb3a1641e2966fd2da9078b126f6c77fb930b00e192c5d0`.

The pre-Apply index exactly matched revision
`2c10476c5dad6d9671770f8ce2ca2235374aabd7c54f8fb4bdc18e864924befa`,
and Studio acknowledged all three immutable source bodies. Both canonical
mutation projections used the public evidence field `revisionHash`. The plugin
then read the unrelated runtime-plan spelling `projectRevisionHash`, rejected
the otherwise valid Prepare command, and emitted a generic
`SECURITY_REJECTION`. No `CreatorChangePrepared`, detached preflight,
ChangeHistory recording, Studio mutation, direct readback, verification,
checkpoint, report, or gameplay claim exists. The attempt's historical
`preflight` label described the broad pre-recording region; it did not prove
that detached preflight ran.

This was a cross-language contract defect, not a model failure, capability
failure, project drift, or Roblox storage mismatch. The fix must therefore
remove the opportunity for TypeScript and Luau to invent different binding
field names, and must preserve phase-specific rejection evidence.

A later session exposed a separate domain-mixing defect. Session
`creator_session_c5bdf9f6-23a0-4494-be4e-3832dbcd2348` and mutation attempt
`creator_mutation_attempt_b0e07a83c489cf536129863d_1`
(`90ea294b63569f4e994f7cd71597f7aaf4899e0b75ef0ba22b0dbecb0ffc3597`)
reached Prepare with exact revision
`2142915e1e47d0a9ef8160e93ce93582317f1f5d361fe0e5fd478d77a5cfba1e`
and three accepted source bodies. The generated Luau recompiler then applied
the authorable-target validator to every node in the complete project index.
Opaque inventory necessarily included non-authorable service, camera, terrain,
and legacy joint classes, so it failed with `mutation target outside manifest`
before detached preflight or recording creation. Failure fact
`267ece69ce1804fa5279d1f5e19556a496cdb2bf4323eba8babe9450fc735ee3`
retains that boundary failure. Project-index membership proves observation and
identity only; it never grants authoring authority. Current generation keeps
opaque index validation separate and applies manifest closure only to actual
mutation targets and writable facts.

The fifth consecutive post-approval failure exposed a third, independent
projection-authority split. Session
`creator_session_c66d60b9-ec72-4faa-a0bf-f026f302ea42`
(`4289d2046e3b9590b1d4e7a07a8c43e669067c4d5225143ebfd8c2af8b36cbc5`)
ended `incomplete / creator_prepare_protocol_failed`; detail hash
`79852e231c6ad8cdf025647f82e3c28962647864eee6dbb4fad22a9211020831`.
Its 24-create change set
`creator_change_set_c47c3edfcfc62cc60db34a0d` and mutation attempt
`creator_mutation_attempt_c47c3edfcfc62cc60db34a0d_1`
(`b160d5e3e3ebefab9c30beb2a68d7b47a36a21df0838c5b29d5e086c5e32e444`)
were bound to exact pre-Apply revision
`4aa624d50df07311545770dadd95acff737bc029e2aae5e766eeadd4ac97bdd8`.
All source transfers completed, but the first generated projection check
failed with `mutation projection project-index recompilation mismatch`.
There was no prepared acknowledgement, detached preflight, recording, Studio
mutation, verification, checkpoint, report, or gameplay claim.

The host projection contained the exact mutation proof requirements. The
plugin independently added a second `allowedProjectDelta` field during
recompilation even though the host had not declared it. Every nonempty create
batch therefore produced different canonical projection material. This was
not project drift or a Roblox result; it was an internally contradictory
contract. The clean replacement deletes that field from the public shape,
TypeScript material, validator, and generated Luau. Project-index delta
authority is derived once from the approved operations during pure
reconciliation. The new manifest identity also binds the generator and the
TypeScript evidence/project-index algebra; predecessor projection bytes are
therefore explicitly incompatible rather than reinterpreted under the same
manifest hash. A portable test now compiles direct and preflight projections
in TypeScript and submits those exact serialized values to the production Luau
recompiler across the full operation algebra, including source-backed creates,
source editing, identity enrollment, `color_sequence`, `number_range`, and a
128-descendant delete with duplicate display paths and an opaque class. A local
semantic replay of the exact 24-operation payload passes the current
recompiler; that is offline contract evidence, not a live Studio success
claim.

The next retained run proved that separating opaque inventory from authorable
targets was necessary but not yet sufficient. Session
`creator_session_2e5812aa-60f8-497c-8827-20048aca349c`
(`0db9e3df16e4b6987adbae63a3ac7bf2a6221bf5f948120c91bf6d98481719f0`)
and attempt `creator_mutation_attempt_bfe11e69a6cc2f4ba6904342_1` reached the
production Prepare recompiler with an exact indexed
`StarterPlayerScripts` parent and an authorable `LocalScript` child. The
recompiler passed that parent through the authorable-target constructor and
failed with `mutation target outside manifest`; detail hash
`cc45fde98416bb47edf8c5149d514ca804d2e5507f955f2ff5f3ecd14ffa148f`
and failure-fact hash
`eeb9451a54b8c197b876d2d0664d223ce29e340344495e3ff9d8857ea6476079`
retain the exact boundary. No detached preflight or recording began.

This establishes three independent roles that implementations must not
collapse: a project-index node is observable identity, a structural anchor is
exact containment authority, and an authorable target is a manifest-closed
mutation surface. A structural anchor may be an engine-owned or otherwise
unsupported class; it is valid only when its identity/path/class is exact in
the complete bound index, and it grants no right to mutate itself. Only the
operation target enters the writer/readback/preflight/comparator closure. The
production TypeScript-to-Luau conformance fixture now exercises that role
matrix for create, move, delete descendants, missing anchors, and unsupported
mutation roots. The host ownership graph also dropped its redundant
`writable` bit so persistent writer selection cannot masquerade as class
authorability.

Canonical operation order is part of the same cross-language contract. A
non-create operation that writes an `instance_ref` to a newly created object
must follow that create; create-to-create references deliberately add no edge
because all approved creates are allocated as one detached graph before live
mutation. TypeScript and generated Luau now enforce this identical rule, and
the production transfer fixture contains both an existing-object update to a
new object and mutual references between new objects. This distinction was
found by an independent edge-by-edge parity review rather than by the consumed
Studio failure, and was closed before another live attempt.

The first live rehearsal after that repair crossed Prepare, detached preflight,
recording creation, provisional Apply, direct readback, and post-apply capture.
Session `creator_session_68189112-eb83-4b13-b762-6f40ec7bda48`
(`6ce12135fd6073281b7690e04347c65e2d242f73b3fb4ea2f343fc83e73ef010`)
produced 87 complete observed direct-readback facts under evidence hash
`db5a15164d6db57b8fc47d0db27e7a7ebf7296fe3fbb51f9c285ce224d4fb35c`.
The project-index collector nevertheless emitted no covered properties because
it iterated generated name-keyed property metadata with `ipairs`. Reconciliation
then emitted 66 `approved_property_not_reflected` facts. That is observer
incompleteness mislabeled as Studio mismatch: the direct reader had observed
the values, while the independent whole-project reader failed to declare its
manifest coverage.

The resulting exact cancellation returned in Studio, but a delayed project
notification interrupted post-cancel collection and an independently duplicated
host reason enum rejected the valid notification. The connector retained the
finished cancellation cursor for recording `recording_7501576164658514536`,
but no finalization receipt or post-cancel revision was established. The live
run therefore remains recovery-required, not cancelled, committed, or verified
evidence. This failure adds three general protocol requirements: generated
property metadata needs one explicit ordered observation representation;
advisory callbacks cannot be treated as revisions; and Forge must classify a
possible transaction change by a serialized read-only index comparison before
revoking or preserving transaction authority.

## Primary-source constraints

HTTP does not provide exactly-once execution. RFC 9110 permits automatic retry
only when a method is idempotent or the client can know that the original
request was not applied. Forge consequently treats localhost polling as an
at-least-once delivery substrate and gives each effect an immutable identity
and payload fingerprint. An identical redelivery can replay its prior receipt;
reuse with different bytes is a conflict. See [RFC 9110, section
9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).

Roblox requires plugins to bracket their document mutations with
`ChangeHistoryService:TryBeginRecording()` and `FinishRecording()`. A plugin can
have only one active recording, and `IsRecordingInProgress()` answers only for
an identified recording. Therefore Forge must persist an opening intent before
asking Studio to begin, persist and read back the returned opaque recording ID
before the first mutation, and never infer that a restart committed or
cancelled anything. `OnRecordingFinished` reports the human-readable name first
and the optional opaque identifier third, so exact suppression and recovery bind
the third argument. See [ChangeHistoryService](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService)
and [Studio plugin recording guidance](https://create.roblox.com/docs/studio/plugins).

The current contents of an open script editor are distinct from a stale direct
`Source` read. Roblox directs plugins to use `ScriptEditorService` for open
documents, including `GetEditorSource()` and `UpdateSourceAsync()`. Transaction
bindings must therefore cover the editor-source hash that was actually read
and approved. See [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService)
and [Script.Source](https://create.roblox.com/docs/reference/engine/classes/Script/Source).

Plugin HTTP access is user-granted and localhost integrations extend Studio's
trust boundary. Loopback does not make payloads trusted: every message remains
bounded, authenticated, strictly shaped, hash-bound, and incapable of carrying
arbitrary executable code. See [Roblox HTTP service guidance](https://create.roblox.com/docs/cloud-services/http-service)
and [Roblox security tactics](https://create.roblox.com/docs/scripting/security/security-tactics).

## Derived protocol rules

1. One generated closed field set defines each evidence binding. Mutation
   bindings require exact keys; unknown keys and runtime-only aliases are
   rejected in both TypeScript and Luau.
2. Every command and outcome is correlated to one request and one canonical
   transaction binding. Source transfer, Prepare, detached preflight, recording
   open, provisional evidence, and finalization are distinct phases.
3. Delivery and execution are separate. The bridge retains a bounded command
   until the plugin acknowledges the exact command hash. The plugin remembers
   handled commands long enough to replay an acknowledgement without repeating
   an effect.
4. The bridge rejects reuse of a message ID with a different canonical body.
   Inbound processing is not marked complete before handlers succeed, and a
   client advances its event cursor only after successful dispatch.
5. A project-change callback is an advisory dirty signal, not revision evidence.
   Outside a possible transaction it revokes stale work immediately. During a
   possible recording, Forge serializes a read-only index confirmation against
   the last authoritative transaction revision; only a changed or incomplete
   result revokes authority. An identical result is retained as immutable
   no-change evidence. No continuation after an `await` may publish state using
   an older confirmed authority epoch.
6. Prepare and detached preflight cannot own a recording. Their failures are
   terminal pre-recording evidence, not recording recovery. Only the durable
   opening-intent boundary can enter `recovery_required`.
7. A finalization action, kind, optional displaced-action provenance, exact
   current project-index binding, and detector epoch are persisted before
   `FinishRecording`. The sole closure primitive rechecks that durable gate
   immediately before one call and requires exact
   `IsRecordingInProgress(recordingId) == false` readback before recording a
   finished cursor. Its settled receipt is retained until the host durably
   acknowledges it. Recovery observes and reports state and never repeats the
   original `FinishRecording` action automatically.
8. Formal and executable tests inject duplicate, stale, reordered, lost, and
   conflicting messages at every boundary. A success-path test must use the
   same backend-produced serialized binding consumed by the Luau validator.
9. A complete project index is an open inventory of platform-valid classes;
   the authoring manifest is a closed mutation algebra. Reconciliation derives
   its one allowed delta from approved operations. Consequential deletion of
   opaque descendants may project structural absence, but never grants their
   classes a writable property surface.
10. The host-produced direct/preflight projection bytes are exercised against
    the production generated Luau recompiler in offline CI. A plugin-only toy
    compiler test is not sufficient evidence of a cross-language contract.
11. Parent validation consumes structural-anchor authority only: a nonplatform
    parent must match one exact index identity, path, class, connector epoch,
    and Studio writer domain. Manifest class closure is applied to the child or
    moved target, never to the unchanged parent. Missing anchors fail closed;
    unsupported anchors do not become writable by serving as parents.
12. Presentation uses the transaction's immutable pre-state. Recompiling a
    reviewed `create` against post-Apply state changes the meaning of its
    precondition and can turn success into a fabricated duplicate-target
    failure.
13. Persistence precedes presentation, and the boundary is one-way. After a
    semantic result is durable, a dashboard render, SSE write, disconnected
    socket, or deferred acknowledgement failure is operational state; it cannot
    enter a Studio evidence catch path or create a replacement verdict.
14. A failed HTTP response is not proof that a state-changing request was not
    executed. The browser may perform one read-only state observation, but it
    must not replay the action without fresh creator authority.

These rules generalize the observed typo into a durable boundary: naming drift,
lost responses, stale asynchronous continuations, and ambiguous recording tails
all fail before unreviewed authority can advance.

## Accepted interconnected transaction evidence

The later Orbital Freight Airlock session
`creator_session_de3157de-700e-4c95-871d-2ad94e111102`
(`392cf6a88bb15b3052b7776aada4d742061ff8ec5f8a3ced1a62c2455a4456cb`)
exercised the repaired path end to end. It bound plan
`creator_plan_5735a1ff0f10d801a4066646`, change set
`creator_change_set_ce9de277302ca309fa688836`, and settled mutation attempt
`creator_mutation_attempt_ce9de277302ca309fa688836_1`
(`d8deb998572e75d2d47e6be8a2dab100f8dee66ff63f742579469c2158bd3aff`).
The attempt reconciled under hash
`789b213b0175d2bfa4e45739e2d5c430270b875949f5dad7259b8f3ab144e88f`
and committed under finalization hash
`2b5a334e9efdcc5cdf77afbe36d3bb645281bb6ee722d73fb4dcbd85c68d1baf`.

Provider-free verification record
`creator_verification_624d0d509a58ab3d1443efcc`
(`624d0d509a58ab3d1443efccf6cf247b968dfd81306b1c8df560bf7b9c2b80a9`)
passed with no failure facts. Checkpoint
`creator_checkpoint_f27e16929b8f4813954b6104` committed revision
`81037f10906fa15edca614274bbf28b670d4d383771af13c26eb4dc651f100dc`
to
`ac4833d82ee38abf47c1967956c54c1f6efd2f3f3a2fa62737cfd7dada4810e0`.
Creator report `creator_review_report_949a503899d96b717f85ec04` accepted with
“It looks good!”. That report is creator-authority evidence only. This ledger
establishes the demonstrated transaction and evidence lifecycle; it is not a
claim that every future project, capability, visual result, or interaction is
correct.
