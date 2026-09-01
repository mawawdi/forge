--------------------------- MODULE CreatorMutationTransaction ---------------------------
EXTENDS Integers, Naturals, Sequences

\* A bounded transaction model. Opaque production IDs are represented by
\* `exactBindings`; reply epochs model an exact request/reply binding.

CONSTANT RevisionIds

Phases == {
    "idle", "approved", "preflighting", "preflighted", "recording_open",
    "provisional", "matched", "mismatched", "incomplete", "verifying",
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
    duplicateReplies

Terminal ==
    phase \in {"committed", "cancelled"} \/
    (phase \in {"incomplete", "mismatched"} /\ ~recording)

vars == <<
    phase, approval, exactBindings, preflight, recording, studioMutated,
    evidencePersisted, evidenceFacts, reconciliation, verification,
    commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
    replyEpoch, acceptedReplyEpoch, duplicateReplies
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

Approve ==
    /\ phase = "idle"
    /\ phase' = "approved"
    /\ approval' = TRUE
    /\ exactBindings' = TRUE
    /\ revision' \in RevisionIds
    /\ UNCHANGED <<
        preflight, recording, studioMutated, evidencePersisted, evidenceFacts,
        reconciliation, verification, commitAcknowledged, checkpoint, review,
        recoveryAuthorized, replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>

BeginPreflight ==
    /\ phase = "approved"
    /\ approval /\ exactBindings
    /\ phase' = "preflighting"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
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
        acceptedReplyEpoch, duplicateReplies
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
        recoveryAuthorized, revision, replyEpoch, duplicateReplies
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
        recoveryAuthorized, revision, replyEpoch, duplicateReplies
        >>

OpenRecording ==
    /\ phase = "preflighted"
    /\ approval /\ exactBindings /\ preflight = "passed"
    /\ evidenceFacts = "complete"
    /\ phase' = "recording_open"
    /\ recording' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
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
        revision, replyEpoch, duplicateReplies
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
        revision, replyEpoch, duplicateReplies
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

VerificationPassed ==
    /\ phase = "verifying"
    /\ phase' = "committing"
    /\ verification' = "passed"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

VerificationNotPassed ==
    /\ phase = "verifying"
    /\ phase' = "cancelling"
    /\ verification' \in {"failed", "incomplete"}
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

CommitAcknowledged ==
    /\ phase = "committing"
    /\ evidencePersisted /\ evidenceFacts = "complete"
    /\ reconciliation = "matched" /\ verification = "passed"
    /\ phase' = "committed"
    /\ recording' = FALSE
    /\ commitAcknowledged' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, checkpoint, review,
        recoveryAuthorized, revision, replyEpoch, acceptedReplyEpoch,
        duplicateReplies
        >>

BeginCancellation ==
    /\ phase \in {"mismatched", "incomplete"}
    /\ recording
    /\ phase' = "cancelling"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>

CancelAcknowledged ==
    /\ phase = "cancelling"
    /\ recording
    /\ phase' = "cancelled"
    /\ recording' = FALSE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, studioMutated, evidencePersisted,
        evidenceFacts, reconciliation, verification, commitAcknowledged,
        checkpoint, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

CreateCheckpoint ==
    /\ phase = "committed"
    /\ commitAcknowledged
    /\ phase' = phase
    /\ checkpoint' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, review, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

CreateReview ==
    /\ phase = "committed"
    /\ commitAcknowledged
    /\ phase' = phase
    /\ review' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, recoveryAuthorized, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

ConnectionLoss ==
    /\ phase \in {"preflighting", "recording_open", "provisional", "matched", "verifying", "committing", "cancelling"}
    /\ phase' = IF phase = "preflighting" THEN "incomplete" ELSE "recovery_required"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>

\* A restart only changes coordinator state. It never opens, cancels, commits,
\* or otherwise mutates Studio.
Restart ==
    /\ phase \in {"preflighting", "recording_open", "provisional", "matched", "verifying", "committing", "cancelling"}
    /\ phase' = IF phase = "preflighting" THEN "incomplete" ELSE "recovery_required"
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch, duplicateReplies
        >>

AuthorizeRecoveryCancellation ==
    /\ phase = "recovery_required"
    /\ recording
    /\ phase' = "cancelling"
    /\ recoveryAuthorized' = TRUE
    /\ UNCHANGED <<
        approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, revision, replyEpoch,
        acceptedReplyEpoch, duplicateReplies
        >>

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

Next ==
    \/ Approve
    \/ BeginPreflight
    \/ FreshReply
    \/ PreflightPassed
    \/ PreflightNotComplete
    \/ OpenRecording
    \/ ApplyProvisionally
    \/ PersistMatchedEvidence
    \/ PersistNonmatchingEvidence
    \/ BeginVerification
    \/ VerificationPassed
    \/ VerificationNotPassed
    \/ CommitAcknowledged
    \/ BeginCancellation
    \/ CancelAcknowledged
    \/ CreateCheckpoint
    \/ CreateReview
    \/ ConnectionLoss
    \/ Restart
    \/ AuthorizeRecoveryCancellation
    \/ DuplicateOrStaleReply

Spec == Init /\ [][Next]_vars

NoOpenRecordingWithoutAuthorization ==
    recording => approval /\ exactBindings /\ preflight = "passed"

VerificationAndCommitNeedMatchedEvidence ==
    phase \in {"verifying", "committing", "committed"} =>
        evidencePersisted /\ evidenceFacts = "complete" /\ reconciliation = "matched"

UnavailableOrErroneousFactsCannotMatch ==
    evidenceFacts \in BadFactResults =>
        reconciliation # "matched" /\ phase \notin {"matched", "verifying", "committing", "committed"}

BadEvidenceCannotCommit ==
    reconciliation \in {"mismatched", "incomplete"} \/ phase = "recovery_required" =>
        ~commitAcknowledged /\ phase # "committing" /\ phase # "committed"

AcceptedReplyIsFresh == acceptedReplyEpoch <= replyEpoch

CheckpointAndReviewNeedAcknowledgedCommit ==
    checkpoint \/ review => commitAcknowledged /\ phase = "committed"

BadEvidenceWithRecordingCanCancel ==
    phase \in {"incomplete", "mismatched"} /\ recording => ENABLED BeginCancellation

\* Action properties checked by TLC, in addition to the state invariants.
StaleRepliesDoNotAdvance ==
    [] [DuplicateOrStaleReply => UNCHANGED <<
        phase, approval, exactBindings, preflight, recording, studioMutated,
        evidencePersisted, evidenceFacts, reconciliation, verification,
        commitAcknowledged, checkpoint, review, recoveryAuthorized, revision,
        replyEpoch, acceptedReplyEpoch
        >>]_vars

RestartNeverMutatesStudio ==
    [] [Restart => UNCHANGED <<studioMutated, recording>>]_vars

NoUnexpectedDeadlock ==
    Terminal \/ phase = "recovery_required" \/ ENABLED Next

================================================================================
