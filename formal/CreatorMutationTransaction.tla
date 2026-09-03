--------------------------- MODULE CreatorMutationTransaction ---------------------------
EXTENDS Integers, Naturals, Sequences

\* A bounded transaction model. Opaque production IDs are represented by
\* `exactBindings`; reply epochs model an exact request/reply binding.

CONSTANT RevisionIds

Phases == {
    "idle", "approved", "preflighting", "preflighted", "recording_intent_persisted", "recording_open",
    "provisional", "matched", "mismatched", "incomplete", "verifying",
    "awaiting_verification_retry",
    "committing", "committed", "cancelling", "cancelled", "recovery_required"
}

BadFactResults == {"unavailable", "read_error", "missing", "duplicate"}

VARIABLES
    phase,
    approval,
    exactBindings,
    preflight,
    recording,
    studioMutated,
    evidencePersisted,
    evidenceFacts,
    reconciliation,
    verification,
    commitAcknowledged,
    checkpoint,
    review,
    recoveryAuthorized,
    revision,
    replyEpoch,
    acceptedReplyEpoch,
    duplicateReplies,
    passiveArm,
    passiveArmPersisted,
    passiveStopReceipt,
    passiveClearRequested,
    passiveClearAcknowledged,
    runtimeContext,
    passiveArmEpoch,
    acceptedPassiveArmEpoch

Terminal ==
    phase \in {"committed", "cancelled"} \/
    (phase \in {"incomplete", "mismatched"} /\ ~recording)

vars == <<
    phase, approval, exactBindings, preflight, recording, studioMutated,
    evidencePersisted, evidenceFacts, reconciliation, verification,
    commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
    replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArm,
    passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
    passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
    acceptedPassiveArmEpoch
>>

TypeOK ==
    /\ phase \in Phases
    /\ approval \in BOOLEAN
    /\ exactBindings \in BOOLEAN
    /\ preflight \in {"not_run", "passed", "failed", "incomplete"}
    /\ recording \in BOOLEAN
    /\ studioMutated \in BOOLEAN
    /\ evidencePersisted \in BOOLEAN
    /\ evidenceFacts \in {"not_observed", "complete"} \cup BadFactResults
    /\ reconciliation \in {"none", "matched", "mismatched", "incomplete"}
    /\ verification \in {"not_run", "running", "passed", "failed", "incomplete"}
    /\ commitAcknowledged \in BOOLEAN
    /\ checkpoint \in BOOLEAN
    /\ review \in BOOLEAN
    /\ recoveryAuthorized \in BOOLEAN
    /\ revision \in RevisionIds
    /\ replyEpoch \in 0..2
    /\ acceptedReplyEpoch \in -1..2
    /\ duplicateReplies \in 0..2
    /\ passiveArm \in {"not_armed", "armed", "running", "stopped", "tombstoned", "awaiting_inventory_confirmation"}
    /\ passiveArmPersisted \in BOOLEAN
    /\ passiveStopReceipt \in BOOLEAN
    /\ passiveClearRequested \in BOOLEAN
    /\ passiveClearAcknowledged \in BOOLEAN
    /\ runtimeContext \in {"edit", "play_server"}
    /\ passiveArmEpoch \in 0..2
    /\ acceptedPassiveArmEpoch \in -1..2

PassiveRuntimeUnchanged ==
    UNCHANGED <<
        passiveArm, passiveArmPersisted, passiveStopReceipt,
        passiveClearRequested, passiveClearAcknowledged, runtimeContext,
        passiveArmEpoch, acceptedPassiveArmEpoch
    >>

Init ==
    /\ phase = "idle"
    /\ approval = FALSE
    /\ exactBindings = FALSE
    /\ preflight = "not_run"
    /\ recording = FALSE
    /\ studioMutated = FALSE
    /\ evidencePersisted = FALSE
    /\ evidenceFacts = "not_observed"
    /\ reconciliation = "none"
    /\ verification = "not_run"
    /\ commitAcknowledged = FALSE
    /\ checkpoint = FALSE
    /\ review = FALSE
    /\ recoveryAuthorized = FALSE
    /\ revision = 0
    /\ replyEpoch = 0
    /\ acceptedReplyEpoch = -1
    /\ duplicateReplies = 0
    /\ passiveArm = "not_armed"
    /\ passiveArmPersisted = FALSE
    /\ passiveStopReceipt = FALSE
    /\ passiveClearRequested = FALSE
    /\ passiveClearAcknowledged = FALSE
    /\ runtimeContext = "edit"
    /\ passiveArmEpoch = 0
    /\ acceptedPassiveArmEpoch = -1

Approve ==
    /\ phase = "idle"
    /\ phase' = "approved"
    /\ approval' = TRUE
    /\ exactBindings' = TRUE
    /\ revision' \in RevisionIds
    /\ UNCHANGED <<
        preflight, recording, studioMutated, evidencePersisted, evidenceFacts,
        reconciliation, verification, commitAcknowledged, checkpoint, review,
        recoveryAuthorized, replyEpoch, acceptedReplyEpoch, duplicateReplies,
        passiveArm, passiveArmPersisted, passiveStopReceipt,
        passiveClearRequested, passiveClearAcknowledged, runtimeContext,
        passiveArmEpoch, acceptedPassiveArmEpoch
        >>

BeginPreflight ==
    /\ phase = "approved"
    /\ approval /\ exactBindings
    /\ phase' = "preflighting"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

\* A distinct, newer reply becomes available. It does not mutate Studio.
FreshReply ==
    /\ phase \in {"preflighting", "provisional"}
    /\ replyEpoch < 2
    /\ replyEpoch' = replyEpoch + 1
    /\ UNCHANGED <<
        phase, approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        acceptedReplyEpoch, duplicateReplies, passiveArm, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

PreflightPassed ==
    /\ phase = "preflighting"
    /\ approval /\ exactBindings /\ replyEpoch > acceptedReplyEpoch
    /\ phase' = "preflighted"
    /\ preflight' = "passed"
    /\ evidenceFacts' = "complete"
    /\ acceptedReplyEpoch' = replyEpoch
    /\ UNCHANGED <<
        approval, exactBindings, recording, studioMutated, evidencePersisted,
        reconciliation, verification, commitAcknowledged, checkpoint, review,
        recoveryAuthorized, revision, replyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

PreflightNotComplete ==
    /\ phase = "preflighting"
    /\ replyEpoch > acceptedReplyEpoch
    /\ phase' = "incomplete"
    /\ preflight' \in {"failed", "incomplete"}
    /\ evidenceFacts' \in BadFactResults
    /\ acceptedReplyEpoch' = replyEpoch
    /\ UNCHANGED <<
        approval, exactBindings, recording, studioMutated, evidencePersisted,
        reconciliation, verification, commitAcknowledged, checkpoint, review,
        recoveryAuthorized, revision, replyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

\* Studio first persists a compact, exact transaction intent. This is a
\* recovery boundary, not a mutation: a failed setting write ends incomplete,
\* while a restart after success must inventory Studio instead of guessing
\* whether ChangeHistoryService opened the recording.
PersistRecordingIntent ==
    /\ phase = "preflighted"
    /\ approval /\ exactBindings /\ preflight = "passed"
    /\ evidenceFacts = "complete"
    /\ phase' = "recording_intent_persisted"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

RecordingIntentPersistenceFailed ==
    /\ phase = "preflighted"
    /\ ~recording /\ ~studioMutated
    /\ phase' = "incomplete"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

OpenRecording ==
    /\ phase = "recording_intent_persisted"
    /\ approval /\ exactBindings /\ preflight = "passed"
    /\ evidenceFacts = "complete"
    /\ phase' = "recording_open"
    /\ recording' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies, passiveArm, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

ApplyProvisionally ==
    /\ phase = "recording_open"
    /\ recording
    /\ phase' = "provisional"
    /\ studioMutated' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, evidencePersisted,
        evidenceFacts, reconciliation, verification, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

PersistMatchedEvidence ==
    /\ phase = "provisional"
    /\ recording /\ replyEpoch > acceptedReplyEpoch
    /\ phase' = "matched"
    /\ evidencePersisted' = TRUE
    /\ evidenceFacts' = "complete"
    /\ reconciliation' = "matched"
    /\ acceptedReplyEpoch' = replyEpoch
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        verification, commitAcknowledged, checkpoint, review, recoveryAuthorized,
        revision, replyEpoch, duplicateReplies, passiveArm, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

PersistNonmatchingEvidence ==
    /\ phase = "provisional"
    /\ recording /\ replyEpoch > acceptedReplyEpoch
    /\ evidencePersisted' = TRUE
    /\ acceptedReplyEpoch' = replyEpoch
    /\ \/ /\ evidenceFacts' = "complete"
          /\ phase' = "mismatched"
          /\ reconciliation' = "mismatched"
       \/ /\ evidenceFacts' \in BadFactResults
          /\ phase' = "incomplete"
          /\ reconciliation' = "incomplete"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        verification, commitAcknowledged, checkpoint, review, recoveryAuthorized,
        revision, replyEpoch, duplicateReplies, passiveArm, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

BeginVerification ==
    /\ phase = "matched"
    /\ evidencePersisted /\ evidenceFacts = "complete" /\ reconciliation = "matched"
    /\ phase' = "verifying"
    /\ verification' = "running"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

\* Creator verification has an extra durable handoff. In production the arm
\* is a hash-bound Plugin setting; `exactBindings` represents the sealed
\* manifest, plan, projection, session, and revision binding. `passiveArmPersisted`
\* means that setting exists, whether it holds an active arm or an inert tombstone.
PersistPassiveRuntimeArm ==
    /\ phase = "verifying"
    /\ verification = "running"
    /\ approval /\ exactBindings
    /\ evidencePersisted /\ evidenceFacts = "complete" /\ reconciliation = "matched"
    /\ passiveArm = "not_armed"
    /\ passiveArmEpoch < 2
    /\ phase' = phase
    /\ passiveArm' = "armed"
    /\ passiveArmPersisted' = TRUE
    /\ passiveStopReceipt' = FALSE
    /\ passiveClearRequested' = FALSE
    /\ passiveClearAcknowledged' = FALSE
    /\ runtimeContext' = "edit"
    \* Incrementing this bounded epoch represents a new hash-bound request and
    \* nonce; the original exact creator/session/mutation binding is retained.
    /\ passiveArmEpoch' = passiveArmEpoch + 1
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, acceptedPassiveArmEpoch
        >>

\* This is the creator's normal Play action in a distinct Play Server context,
\* never a backend-triggered Studio operation.
PlayServerStartsPassiveRuntime ==
    /\ phase = "verifying"
    /\ verification = "running"
    /\ exactBindings
    /\ passiveArm = "armed" /\ passiveArmPersisted
    /\ runtimeContext = "edit"
    /\ passiveArmEpoch > acceptedPassiveArmEpoch
    /\ phase' = phase
    /\ passiveArm' = "running"
    /\ runtimeContext' = "play_server"
    /\ acceptedPassiveArmEpoch' = passiveArmEpoch
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        passiveArmEpoch
        >>

\* Stop returns to Edit and durably stores a terminal evidence receipt. It
\* deliberately does not clear the arm or produce a verdict.
StopPersistsPassiveRuntimeReceipt ==
    /\ phase = "verifying"
    /\ verification = "running"
    /\ passiveArm = "running" /\ passiveArmPersisted
    /\ runtimeContext = "play_server"
    /\ acceptedPassiveArmEpoch = passiveArmEpoch
    /\ phase' = phase
    /\ passiveArm' = "stopped"
    /\ passiveStopReceipt' = TRUE
    /\ runtimeContext' = "edit"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArmPersisted,
        passiveClearRequested, passiveClearAcknowledged, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

\* The backend must issue an exact finalization request after observing the
\* receipt; this command itself has no authority to erase the retained setting.
RequestExactPassiveRuntimeClear ==
    /\ phase = "verifying"
    /\ verification = "running"
    /\ exactBindings
    /\ passiveArm = "stopped" /\ passiveArmPersisted /\ passiveStopReceipt
    /\ runtimeContext = "edit"
    /\ acceptedPassiveArmEpoch = passiveArmEpoch
    /\ phase' = phase
    /\ passiveClearRequested' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

\* Only the Edit-side plugin can acknowledge the exact backend request by
\* replacing the active arm with an inert, replayable tombstone. The receipt
\* remains durable evidence for grading, and a restart cannot reactivate it.
EditSideTombstonesPassiveRuntimeArm ==
    /\ phase = "verifying"
    /\ verification = "running"
    /\ exactBindings
    /\ passiveArm = "stopped" /\ passiveArmPersisted /\ passiveStopReceipt
    /\ passiveClearRequested
    /\ runtimeContext = "edit"
    /\ acceptedPassiveArmEpoch = passiveArmEpoch
    /\ phase' = phase
    /\ passiveArm' = "tombstoned"
    /\ passiveClearAcknowledged' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArmPersisted, passiveStopReceipt,
        passiveClearRequested, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
        >>

VerificationPassed ==
    /\ phase = "verifying"
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearAcknowledged
    /\ phase' = "committing"
    /\ verification' = "passed"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

VerificationFailed ==
    /\ phase = "verifying"
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearAcknowledged
    /\ phase' = "cancelling"
    /\ verification' = "failed"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

VerificationIncomplete ==
    /\ phase = "verifying"
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearAcknowledged
    /\ phase' = "awaiting_verification_retry"
    /\ verification' = "incomplete"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

\* Only a fresh, hash-bound creator action may replace the inert receipt with
\* one new observer arm. This is not a reply-driven or automatic transition.
AuthorizeVerificationRetry ==
    /\ phase = "awaiting_verification_retry"
    /\ verification = "incomplete"
    /\ recording /\ exactBindings /\ reconciliation = "matched"
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
    /\ runtimeContext = "edit"
    /\ passiveArmEpoch < 2
    /\ phase' = "verifying"
    /\ verification' = "running"
    /\ passiveArm' = "armed"
    /\ passiveStopReceipt' = FALSE
    /\ passiveClearRequested' = FALSE
    /\ passiveClearAcknowledged' = FALSE
    /\ passiveArmEpoch' = passiveArmEpoch + 1
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies, passiveArmPersisted,
        runtimeContext, acceptedPassiveArmEpoch
        >>

CommitAcknowledged ==
    /\ phase = "committing"
    /\ evidencePersisted /\ evidenceFacts = "complete"
    /\ reconciliation = "matched" /\ verification = "passed"
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearAcknowledged
    /\ phase' = "committed"
    /\ recording' = FALSE
    /\ commitAcknowledged' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, checkpoint, review,
        recoveryAuthorized, revision, replyEpoch, acceptedReplyEpoch,
        duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

BeginCancellation ==
    /\ phase \in {"mismatched", "incomplete", "awaiting_verification_retry"}
    /\ recording
    /\ phase' = "cancelling"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

CancelAcknowledged ==
    /\ phase = "cancelling"
    /\ recording
    /\ runtimeContext = "edit"
    /\ passiveArm \in {"not_armed", "tombstoned"}
    /\ (verification \in {"failed", "incomplete"} =>
        passiveArm = "tombstoned" /\ passiveArmPersisted /\
        passiveStopReceipt /\ passiveClearAcknowledged)
    /\ phase' = "cancelled"
    /\ recording' = FALSE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

CreateCheckpoint ==
    /\ phase = "committed"
    /\ commitAcknowledged
    /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
    /\ phase' = phase
    /\ checkpoint' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

CreateReview ==
    /\ phase = "committed"
    /\ commitAcknowledged
    /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
    /\ phase' = phase
    /\ review' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

\* A tombstone is transport-replay only: it retains the original exact
\* binding and receipt and cannot arm or re-enter the Play Server context.
ReplayInertPassiveRuntimeTombstone ==
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
    /\ runtimeContext = "edit"
    /\ exactBindings
    /\ UNCHANGED vars

\* This models AcknowledgeCreatorChangeFinalization. It is issued only after
\* the backend has persisted the commit/cancel/recovery finalization. Consuming
\* the exact acknowledgement removes the plugin receipt but does not yet make
\* coordinator inventory clear: a fresh correlated scan must still arrive.
GarbageCollectPassiveRuntimeTombstone ==
    /\ phase \in {"committed", "cancelled"}
    /\ ~recording
    /\ passiveArm = "tombstoned" /\ passiveArmPersisted
    /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
    /\ phase' = phase
    /\ passiveArm' = "awaiting_inventory_confirmation"
    /\ passiveArmPersisted' = FALSE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveStopReceipt,
        passiveClearRequested, passiveClearAcknowledged, runtimeContext,
        passiveArmEpoch, acceptedPassiveArmEpoch
        >>

\* An unrelated or stale `none` report has no transition. Only the inventory
\* emitted after the exact acknowledgement releases a later transaction.
ConfirmFinalizationInventory ==
    /\ phase \in {"committed", "cancelled"}
    /\ ~recording
    /\ passiveArm = "awaiting_inventory_confirmation"
    /\ ~passiveArmPersisted
    /\ exactBindings
    /\ phase' = phase
    /\ passiveArm' = "not_armed"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>

ConnectionLoss ==
    /\ phase \in {"preflighting", "preflighted", "recording_intent_persisted", "recording_open", "provisional", "matched", "verifying", "awaiting_verification_retry", "committing", "cancelling"}
    /\ phase' = IF phase \in {"preflighting", "preflighted"} THEN "incomplete" ELSE "recovery_required"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

\* A restart only changes coordinator state. It never opens, cancels, commits,
\* or otherwise mutates Studio.
Restart ==
    /\ phase \in {"preflighting", "preflighted", "recording_intent_persisted", "recording_open", "provisional", "matched", "verifying", "awaiting_verification_retry", "committing", "cancelling"}
    /\ phase' = IF phase \in {"preflighting", "preflighted"} THEN "incomplete" ELSE "recovery_required"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

AuthorizeRecoveryCancellation ==
    /\ phase = "recovery_required"
    /\ recording
    \* Recovery authority never races a live or merely stopped Play observer.
    \* The exact passive arm must first be absent or durably tombstoned in Edit.
    /\ runtimeContext = "edit"
    /\ passiveArm \in {"not_armed", "tombstoned"}
    /\ phase' = "cancelling"
    /\ recoveryAuthorized' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>
    /\ PassiveRuntimeUnchanged

\* A duplicate or stale reply is recorded for model coverage but cannot advance
\* any coordinator, Studio, or accepted-reply state.
DuplicateOrStaleReply ==
    /\ duplicateReplies < 2
    /\ duplicateReplies' = duplicateReplies + 1
    /\ UNCHANGED <<
        phase, approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch
        >>
    /\ PassiveRuntimeUnchanged

Next ==
    \/ Approve
    \/ BeginPreflight
    \/ FreshReply
    \/ PreflightPassed
    \/ PreflightNotComplete
    \/ PersistRecordingIntent
    \/ RecordingIntentPersistenceFailed
    \/ OpenRecording
    \/ ApplyProvisionally
    \/ PersistMatchedEvidence
    \/ PersistNonmatchingEvidence
    \/ BeginVerification
    \/ PersistPassiveRuntimeArm
    \/ PlayServerStartsPassiveRuntime
    \/ StopPersistsPassiveRuntimeReceipt
    \/ RequestExactPassiveRuntimeClear
    \/ EditSideTombstonesPassiveRuntimeArm
    \/ VerificationPassed
    \/ VerificationFailed
    \/ VerificationIncomplete
    \/ AuthorizeVerificationRetry
    \/ CommitAcknowledged
    \/ BeginCancellation
    \/ CancelAcknowledged
    \/ CreateCheckpoint
    \/ CreateReview
    \/ ReplayInertPassiveRuntimeTombstone
    \/ GarbageCollectPassiveRuntimeTombstone
    \/ ConfirmFinalizationInventory
    \/ ConnectionLoss
    \/ Restart
    \/ AuthorizeRecoveryCancellation
    \/ DuplicateOrStaleReply

Spec == Init /\ [][Next]_vars

NoOpenRecordingWithoutAuthorization ==
    recording => approval /\ exactBindings /\ preflight = "passed"

VerificationAndCommitNeedMatchedEvidence ==
    phase \in {"verifying", "awaiting_verification_retry", "committing", "committed"} =>
        evidencePersisted /\ evidenceFacts = "complete" /\ reconciliation = "matched"

UnavailableOrErroneousFactsCannotMatch ==
    evidenceFacts \in BadFactResults =>
        reconciliation # "matched" /\ phase \notin {"matched", "verifying", "committing", "committed"}

BadEvidenceCannotCommit ==
    reconciliation \in {"mismatched", "incomplete"} \/ phase = "recovery_required" =>
        ~commitAcknowledged /\ phase # "committing" /\ phase # "committed"

IncompleteVerificationPreservesTombstonedRecording ==
    verification = "incomplete" /\ reconciliation = "matched" =>
        /\ ~commitAcknowledged
        /\ passiveStopReceipt /\ passiveClearRequested /\ passiveClearAcknowledged
        /\ \/ /\ phase \in {"awaiting_verification_retry", "recovery_required"}
              /\ recording /\ passiveArm = "tombstoned" /\ passiveArmPersisted
           \/ /\ phase = "cancelling"
              /\ recording /\ passiveArm = "tombstoned" /\ passiveArmPersisted
           \/ /\ phase = "cancelled"
              /\ ~recording /\ passiveArm \in {"tombstoned", "awaiting_inventory_confirmation", "not_armed"}

AcceptedReplyIsFresh == acceptedReplyEpoch <= replyEpoch

PassiveArmPersistenceAndOrdering ==
    /\ passiveArm \in {"armed", "running", "stopped"} => passiveArmPersisted
    /\ passiveArm = "tombstoned" =>
        /\ passiveArmPersisted
        /\ passiveStopReceipt
        /\ passiveClearRequested
        /\ passiveClearAcknowledged
    /\ passiveArm = "not_armed" /\ passiveStopReceipt =>
        /\ ~passiveArmPersisted
        /\ phase \in {"committed", "cancelled"}
    /\ passiveArm = "awaiting_inventory_confirmation" =>
        /\ ~passiveArmPersisted
        /\ phase \in {"committed", "cancelled"}
    /\ passiveStopReceipt => acceptedPassiveArmEpoch = passiveArmEpoch /\ passiveArmEpoch > 0
    /\ acceptedPassiveArmEpoch <= passiveArmEpoch

PassiveRuntimeContextIsDistinct ==
    (runtimeContext = "play_server") <=> passiveArm = "running"

VerificationVerdictAndCommitNeedTombstoneReceipt ==
    verification \in {"passed", "failed", "incomplete"} \/
    phase \in {"committing", "committed"} =>
        /\ passiveStopReceipt
        /\ passiveClearRequested
        /\ passiveClearAcknowledged

TombstoneCannotReactivate ==
    passiveArm = "tombstoned" =>
        /\ runtimeContext = "edit"
        /\ passiveArmPersisted
        /\ exactBindings

TombstoneReplacementIsCreatorAuthorized ==
    [] [AuthorizeVerificationRetry =>
        /\ exactBindings /\ exactBindings'
        /\ recording /\ recording'
        /\ passiveArm' = "armed" /\ passiveArmPersisted'
        /\ passiveArmEpoch' = passiveArmEpoch + 1
    ]_vars

RecoveryCancellationNeedsRetiredPassiveRuntime ==
    recoveryAuthorized /\ phase = "cancelling" =>
        /\ runtimeContext = "edit"
        /\ passiveArm \in {"not_armed", "tombstoned"}

CheckpointAndReviewNeedTerminalTombstoneAck ==
    checkpoint \/ review =>
        /\ passiveStopReceipt
        /\ passiveClearRequested
        /\ passiveClearAcknowledged

CheckpointAndReviewNeedAcknowledgedCommit ==
    checkpoint \/ review => commitAcknowledged /\ phase = "committed"

BadEvidenceWithRecordingCanCancel ==
    phase \in {"incomplete", "mismatched"} /\ recording => ENABLED BeginCancellation

RetryStateHasOnlyExplicitProgress ==
    phase = "awaiting_verification_retry" =>
        /\ ENABLED BeginCancellation
        /\ (passiveArmEpoch < 2 => ENABLED AuthorizeVerificationRetry)

\* Action properties checked by TLC, in addition to the state invariants.
StaleRepliesDoNotAdvance ==
    [] [DuplicateOrStaleReply => UNCHANGED <<
        phase, approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, passiveArm, passiveArmPersisted,
        passiveStopReceipt, passiveClearRequested, passiveClearAcknowledged,
        runtimeContext, passiveArmEpoch, acceptedPassiveArmEpoch
        >>]_vars

RestartNeverMutatesStudio ==
    [] [Restart => UNCHANGED <<studioMutated, recording>>]_vars

RecordingIntentFailureNeverMutatesStudio ==
    [] [RecordingIntentPersistenceFailed =>
        /\ phase' = "incomplete"
        /\ ~recording /\ ~recording'
        /\ ~studioMutated /\ ~studioMutated'
    ]_vars

PersistedIntentRestartRequiresRecovery ==
    [] [Restart /\ phase = "recording_intent_persisted" =>
        /\ phase' = "recovery_required"
        /\ UNCHANGED <<studioMutated, recording>>
    ]_vars

InterruptionNeverFinalizesPassiveRuntime ==
    [] [ConnectionLoss \/ Restart => UNCHANGED <<
        studioMutated, recording, commitAcknowledged, passiveArm,
        passiveArmPersisted, passiveStopReceipt, passiveClearRequested,
        passiveClearAcknowledged, runtimeContext, passiveArmEpoch,
        acceptedPassiveArmEpoch
    >>]_vars

RestartNeverReactivatesTombstone ==
    [] [Restart => UNCHANGED <<
        passiveArm, passiveArmPersisted, passiveStopReceipt,
        passiveClearRequested, passiveClearAcknowledged, runtimeContext,
        passiveArmEpoch, acceptedPassiveArmEpoch
    >>]_vars

NoUnexpectedDeadlock ==
    Terminal \/ phase = "recovery_required" \/ ENABLED Next

================================================================================
