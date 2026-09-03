-------------------------- MODULE ExistingProjectIntelligence --------------------------
EXTENDS Naturals

\* This bounded model covers the authority edges added for existing Studio
\* documents. Index data and hashes are opaque; the model checks when they may
\* confer revision, approval, mutation, refresh, and filesystem authority.

CONSTANT Roots

Phases == {
    "indexing", "planning", "approved", "refresh_required", "refreshing",
    "superseded", "applying", "awaiting_source_sync", "committed",
    "recovery_required", "reverted", "incomplete"
}

Authorities == {"studio_document", "rojo_source", "mixed"}

VARIABLES
    phase,
    indexComplete,
    indexRoot,
    dirty,
    connectorEpochCurrent,
    approval,
    successor,
    recording,
    authority,
    filesystemWritten,
    syncProof,
    revertAuthorized,
    studioMutated,
    workerCandidate,
    restartCount

vars == <<
    phase, indexComplete, indexRoot, dirty, connectorEpochCurrent, approval,
    successor, recording, authority, filesystemWritten, syncProof,
    revertAuthorized, studioMutated, workerCandidate, restartCount
>>

TypeOK ==
    /\ phase \in Phases
    /\ indexComplete \in BOOLEAN
    /\ indexRoot \in Roots
    /\ dirty \in BOOLEAN
    /\ connectorEpochCurrent \in BOOLEAN
    /\ approval \in BOOLEAN
    /\ successor \in BOOLEAN
    /\ recording \in BOOLEAN
    /\ authority \in Authorities
    /\ filesystemWritten \in BOOLEAN
    /\ syncProof \in BOOLEAN
    /\ revertAuthorized \in BOOLEAN
    /\ studioMutated \in BOOLEAN
    /\ workerCandidate \in BOOLEAN
    /\ restartCount \in 0..2

Init ==
    /\ phase = "indexing"
    /\ indexComplete = FALSE
    /\ indexRoot = 0
    /\ dirty = FALSE
    /\ connectorEpochCurrent = TRUE
    /\ approval = FALSE
    /\ successor = FALSE
    /\ recording = FALSE
    /\ authority = "studio_document"
    /\ filesystemWritten = FALSE
    /\ syncProof = FALSE
    /\ revertAuthorized = FALSE
    /\ studioMutated = FALSE
    /\ workerCandidate = FALSE
    /\ restartCount = 0

CompleteIndex ==
    /\ phase = "indexing"
    /\ indexRoot' \in Roots
    /\ indexComplete' = TRUE
    /\ phase' = "planning"
    /\ UNCHANGED <<dirty, connectorEpochCurrent, approval, successor,
        recording, authority, filesystemWritten, syncProof, revertAuthorized,
        studioMutated, workerCandidate, restartCount>>

ChooseAuthority ==
    /\ phase = "planning"
    /\ authority' \in Authorities
    /\ UNCHANGED <<phase, indexComplete, indexRoot, dirty,
        connectorEpochCurrent, approval, successor, recording,
        filesystemWritten, syncProof, revertAuthorized, studioMutated,
        workerCandidate, restartCount>>

PublishWorkerCandidate ==
    /\ phase = "planning"
    /\ indexComplete /\ ~dirty /\ connectorEpochCurrent
    /\ workerCandidate' = TRUE
    /\ UNCHANGED <<phase, indexComplete, indexRoot, dirty,
        connectorEpochCurrent, approval, successor, recording, authority,
        filesystemWritten, syncProof, revertAuthorized, studioMutated,
        restartCount>>

Approve ==
    /\ phase = "planning"
    /\ indexComplete /\ ~dirty /\ connectorEpochCurrent
    /\ authority # "mixed" /\ workerCandidate
    /\ approval' = TRUE
    /\ phase' = "approved"
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        successor, recording, authority, filesystemWritten, syncProof,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

DetectDirty ==
    /\ phase \in {"planning", "approved"}
    /\ dirty' = TRUE
    /\ workerCandidate' = FALSE
    /\ phase' = "refresh_required"
    /\ UNCHANGED <<indexComplete, indexRoot, connectorEpochCurrent, approval,
        successor, recording, authority, filesystemWritten, syncProof,
        revertAuthorized, studioMutated, restartCount>>

InvalidateConnectorEpoch ==
    /\ phase \in {"planning", "approved"}
    /\ connectorEpochCurrent' = FALSE
    /\ dirty' = TRUE
    /\ workerCandidate' = FALSE
    /\ phase' = "refresh_required"
    /\ UNCHANGED <<indexComplete, indexRoot, approval, successor, recording,
        authority, filesystemWritten, syncProof, revertAuthorized,
        studioMutated, restartCount>>

BeginRefresh ==
    /\ phase = "refresh_required"
    /\ ~recording
    /\ phase' = "refreshing"
    /\ indexComplete' = FALSE
    /\ UNCHANGED <<indexRoot, dirty, connectorEpochCurrent, approval,
        successor, recording, authority, filesystemWritten, syncProof,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

StaleWorkerCompletion ==
    /\ phase \in {"refresh_required", "refreshing", "superseded"}
    /\ ~workerCandidate
    /\ UNCHANGED vars

RefreshUnchanged ==
    /\ phase = "refreshing"
    /\ indexRoot' = indexRoot
    /\ indexComplete' = TRUE
    /\ dirty' = FALSE
    /\ connectorEpochCurrent' = TRUE
    /\ approval' = FALSE
    /\ workerCandidate' = FALSE
    /\ phase' = "planning"
    /\ UNCHANGED <<successor, recording, authority, filesystemWritten,
        syncProof, revertAuthorized, studioMutated, restartCount>>

RefreshChanged ==
    /\ phase = "refreshing"
    /\ indexRoot' \in Roots
    /\ indexRoot' # indexRoot
    /\ indexComplete' = TRUE
    /\ dirty' = FALSE
    /\ connectorEpochCurrent' = TRUE
    /\ approval' = FALSE
    /\ workerCandidate' = FALSE
    /\ successor' = TRUE
    /\ phase' = "superseded"
    /\ UNCHANGED <<recording, authority, filesystemWritten, syncProof,
        revertAuthorized, studioMutated, restartCount>>

ApplyStudio ==
    /\ phase = "approved"
    /\ approval /\ indexComplete /\ ~dirty /\ connectorEpochCurrent
    /\ authority = "studio_document"
    /\ phase' = "applying"
    /\ recording' = TRUE
    /\ studioMutated' = TRUE
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        approval, successor, authority, filesystemWritten, syncProof,
        revertAuthorized, workerCandidate, restartCount>>

CommitStudio ==
    /\ phase = "applying"
    /\ recording /\ ~dirty /\ indexComplete
    /\ phase' = "committed"
    /\ recording' = FALSE
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        approval, successor, authority, filesystemWritten, syncProof,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

WriteRojo ==
    /\ phase = "approved"
    /\ approval /\ indexComplete /\ ~dirty /\ connectorEpochCurrent
    /\ authority = "rojo_source"
    /\ phase' = "awaiting_source_sync"
    /\ filesystemWritten' = TRUE
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        approval, successor, recording, authority, syncProof,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

ProveRojoSync ==
    /\ phase = "awaiting_source_sync"
    /\ filesystemWritten /\ indexComplete /\ ~dirty
    /\ syncProof' = TRUE
    /\ phase' = "committed"
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        approval, successor, recording, authority, filesystemWritten,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

AuthorizeRevert ==
    /\ phase = "awaiting_source_sync"
    /\ filesystemWritten
    /\ revertAuthorized' = TRUE
    /\ UNCHANGED <<phase, indexComplete, indexRoot, dirty,
        connectorEpochCurrent, approval, successor, recording, authority,
        filesystemWritten, syncProof, studioMutated, workerCandidate,
        restartCount>>

RevertRojo ==
    /\ phase = "awaiting_source_sync"
    /\ filesystemWritten /\ revertAuthorized
    /\ filesystemWritten' = FALSE
    /\ phase' = "reverted"
    /\ UNCHANGED <<indexComplete, indexRoot, dirty, connectorEpochCurrent,
        approval, successor, recording, authority, syncProof,
        revertAuthorized, studioMutated, workerCandidate, restartCount>>

Restart ==
    /\ restartCount < 2
    /\ restartCount' = restartCount + 1
    /\ phase' = IF recording THEN "recovery_required"
                 ELSE IF phase \in {"planning", "approved"} THEN "refresh_required"
                 ELSE phase
    /\ dirty' = IF recording \/ phase \in {"planning", "approved"} THEN TRUE ELSE dirty
    /\ connectorEpochCurrent' = IF recording \/ phase \in {"planning", "approved"} THEN FALSE ELSE connectorEpochCurrent
    /\ approval' = IF recording \/ phase \in {"planning", "approved"} THEN FALSE ELSE approval
    /\ workerCandidate' = IF recording \/ phase \in {"planning", "approved"} THEN FALSE ELSE workerCandidate
    /\ UNCHANGED <<indexComplete, indexRoot,
        successor, recording, authority, filesystemWritten,
        syncProof, revertAuthorized, studioMutated>>

Next ==
    \/ CompleteIndex
    \/ ChooseAuthority
    \/ PublishWorkerCandidate
    \/ Approve
    \/ DetectDirty
    \/ InvalidateConnectorEpoch
    \/ StaleWorkerCompletion
    \/ BeginRefresh
    \/ RefreshUnchanged
    \/ RefreshChanged
    \/ ApplyStudio
    \/ CommitStudio
    \/ WriteRojo
    \/ ProveRojoSync
    \/ AuthorizeRevert
    \/ RevertRojo
    \/ Restart

Spec == Init /\ [][Next]_vars

NoMutationFromDirty == dirty => phase # "applying"
NoRevisionFromIncompleteIndex == ~indexComplete => phase # "approved"
NoMixedAuthorityMutation == authority = "mixed" => ~studioMutated /\ ~filesystemWritten
SuccessorInheritsNoApproval == successor => ~approval
RojoCommitNeedsSyncProof == phase = "committed" /\ authority = "rojo_source" => syncProof
StudioCommitNeedsClosedRecording == phase = "committed" /\ authority = "studio_document" => ~recording
FilesystemRevertNeedsCreatorAuthority == phase = "reverted" => revertAuthorized
RestartNeverFinalizesRecording == phase = "recovery_required" => recording
DirtyRejectsStaleWorker == dirty => ~workerCandidate

=============================================================================
