------------------------------ MODULE RojoSourceAuthority ------------------------------
EXTENDS Integers, Naturals

\* A bounded model for the filesystem-only half of an opted-in project
\* authority. Production hashes, receipts, and source maps are opaque. The
\* model checks their ordering: a source change must be guarded, it remains
\* provisional until a fresh exact Studio sync proof, and restart can only
\* demand explicit creator recovery—not retry, commit, or rollback itself.

Phases == {
    "idle", "binding", "ready", "approved", "writing", "awaiting_sync",
    "recovery_required", "reverting", "committed", "reverted", "rejected",
    "incomplete"
}

Authorities == {"none", "studio_transaction", "rojo_source", "mixed"}
SyncStatuses == {"none", "incomplete", "mismatched", "stale", "matched"}

VARIABLES
    phase,
    authority,
    manifestBound,
    sourcemapBound,
    changeSetBound,
    approval,
    writePrecondition,
    filesystemRevision,
    filesystemWritten,
    writeReceiptPersisted,
    writeEpoch,
    syncStatus,
    syncProofEpoch,
    syncObservationEpoch,
    creatorRevertAuthorized,
    revertPrecondition,
    studioMutated,
    restartCount

vars == <<
    phase, authority, manifestBound, sourcemapBound, changeSetBound,
    approval, writePrecondition, filesystemRevision, filesystemWritten,
    writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
    syncObservationEpoch,
    creatorRevertAuthorized, revertPrecondition, studioMutated, restartCount
>>

Terminal == phase \in {"committed", "reverted", "rejected", "incomplete"}

TypeOK ==
    /\ phase \in Phases
    /\ authority \in Authorities
    /\ manifestBound \in BOOLEAN
    /\ sourcemapBound \in BOOLEAN
    /\ changeSetBound \in BOOLEAN
    /\ approval \in BOOLEAN
    /\ writePrecondition \in BOOLEAN
    /\ filesystemRevision \in 0..1
    /\ filesystemWritten \in BOOLEAN
    /\ writeReceiptPersisted \in BOOLEAN
    /\ writeEpoch \in 0..1
    /\ syncStatus \in SyncStatuses
    /\ syncProofEpoch \in -1..1
    /\ syncObservationEpoch \in 0..2
    /\ creatorRevertAuthorized \in BOOLEAN
    /\ revertPrecondition \in BOOLEAN
    /\ studioMutated \in BOOLEAN
    /\ restartCount \in 0..1

Init ==
    /\ phase = "idle"
    /\ authority = "none"
    /\ manifestBound = FALSE
    /\ sourcemapBound = FALSE
    /\ changeSetBound = FALSE
    /\ approval = FALSE
    /\ writePrecondition = FALSE
    /\ filesystemRevision = 0
    /\ filesystemWritten = FALSE
    /\ writeReceiptPersisted = FALSE
    /\ writeEpoch = 0
    /\ syncStatus = "none"
    /\ syncProofEpoch = -1
    /\ syncObservationEpoch = 0
    /\ creatorRevertAuthorized = FALSE
    /\ revertPrecondition = FALSE
    /\ studioMutated = FALSE
    /\ restartCount = 0

ChooseRojoSourceAuthority ==
    /\ phase = "idle"
    /\ authority' = "rojo_source"
    /\ phase' = "binding"
    /\ UNCHANGED <<
        manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated,
        restartCount
        >>

RejectMixedAuthority ==
    /\ phase = "idle"
    /\ authority' = "mixed"
    /\ phase' = "rejected"
    /\ UNCHANGED <<
        manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated,
        restartCount
        >>

RejectStudioAuthority ==
    /\ phase = "idle"
    /\ authority' = "studio_transaction"
    /\ phase' = "rejected"
    /\ UNCHANGED <<
        manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated,
        restartCount
        >>

BindPinnedManifestAndSourcemap ==
    /\ phase = "binding"
    /\ authority = "rojo_source"
    /\ manifestBound' = TRUE
    /\ sourcemapBound' = TRUE
    /\ phase' = "ready"
    /\ UNCHANGED <<
        authority, changeSetBound, approval, writePrecondition,
        filesystemRevision, filesystemWritten, writeReceiptPersisted,
        writeEpoch, syncStatus, syncProofEpoch, syncObservationEpoch,
        creatorRevertAuthorized,
        revertPrecondition, studioMutated, restartCount
        >>

ApproveExactRojoChangeSet ==
    /\ phase = "ready"
    /\ authority = "rojo_source"
    /\ manifestBound /\ sourcemapBound
    /\ phase' = "approved"
    /\ changeSetBound' = TRUE
    /\ approval' = TRUE
    /\ writePrecondition' = TRUE
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, filesystemRevision,
        filesystemWritten, writeReceiptPersisted, writeEpoch, syncStatus,
        syncProofEpoch, syncObservationEpoch, creatorRevertAuthorized, revertPrecondition,
        studioMutated, restartCount
        >>

BeginGuardedWrite ==
    /\ phase = "approved"
    /\ authority = "rojo_source"
    /\ manifestBound /\ sourcemapBound /\ changeSetBound /\ approval
    /\ writePrecondition
    /\ phase' = "writing"
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated,
        restartCount
        >>

PersistGuardedWriteReceipt ==
    /\ phase = "writing"
    /\ authority = "rojo_source"
    /\ manifestBound /\ sourcemapBound /\ changeSetBound /\ approval
    /\ writePrecondition /\ ~filesystemWritten /\ writeEpoch = 0
    /\ phase' = "awaiting_sync"
    /\ filesystemRevision' = 1
    /\ filesystemWritten' = TRUE
    /\ writeReceiptPersisted' = TRUE
    /\ writeEpoch' = 1
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, syncStatus, syncProofEpoch, syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated,
        restartCount
        >>

ReceiveIncompleteSyncProof ==
    /\ phase = "awaiting_sync"
    /\ filesystemWritten /\ writeReceiptPersisted
    /\ syncObservationEpoch < 2
    /\ syncStatus' = "incomplete"
    /\ syncProofEpoch' = writeEpoch
    /\ syncObservationEpoch' = syncObservationEpoch + 1
    /\ UNCHANGED <<
        phase, authority, manifestBound, sourcemapBound, changeSetBound,
        approval, writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, creatorRevertAuthorized,
        revertPrecondition, studioMutated, restartCount
        >>

ReceiveMismatchedSyncProof ==
    /\ phase = "awaiting_sync"
    /\ filesystemWritten /\ writeReceiptPersisted
    /\ syncObservationEpoch < 2
    /\ syncStatus' = "mismatched"
    /\ syncProofEpoch' = writeEpoch
    /\ syncObservationEpoch' = syncObservationEpoch + 1
    /\ UNCHANGED <<
        phase, authority, manifestBound, sourcemapBound, changeSetBound,
        approval, writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, creatorRevertAuthorized,
        revertPrecondition, studioMutated, restartCount
        >>

ReceiveStaleSyncProof ==
    /\ phase = "awaiting_sync"
    /\ filesystemWritten /\ writeReceiptPersisted /\ writeEpoch = 1
    /\ syncObservationEpoch < 2
    /\ syncStatus' = "stale"
    /\ syncProofEpoch' = 0
    /\ syncObservationEpoch' = syncObservationEpoch + 1
    /\ UNCHANGED <<
        phase, authority, manifestBound, sourcemapBound, changeSetBound,
        approval, writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, creatorRevertAuthorized,
        revertPrecondition, studioMutated, restartCount
        >>

AcceptFreshExactSyncProof ==
    /\ phase = "awaiting_sync"
    /\ filesystemWritten /\ writeReceiptPersisted
    /\ syncStatus # "mismatched"
    /\ syncObservationEpoch < 2
    /\ phase' = "committed"
    /\ syncStatus' = "matched"
    /\ syncProofEpoch' = writeEpoch
    /\ syncObservationEpoch' = syncObservationEpoch + 1
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, creatorRevertAuthorized,
        revertPrecondition, studioMutated, restartCount
        >>

AuthorizeExplicitRevert ==
    /\ phase \in {"awaiting_sync", "recovery_required"}
    /\ authority = "rojo_source"
    /\ filesystemWritten /\ writeReceiptPersisted
    /\ syncStatus # "matched"
    /\ phase' = "reverting"
    /\ creatorRevertAuthorized' = TRUE
    /\ revertPrecondition' = TRUE
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        studioMutated, restartCount
        >>

PersistGuardedRevertReceipt ==
    /\ phase = "reverting"
    /\ authority = "rojo_source"
    /\ creatorRevertAuthorized /\ revertPrecondition
    /\ filesystemWritten /\ writeReceiptPersisted /\ filesystemRevision = 1
    /\ phase' = "reverted"
    /\ filesystemRevision' = 0
    /\ filesystemWritten' = FALSE
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, writeReceiptPersisted, writeEpoch, syncStatus,
        syncProofEpoch, syncObservationEpoch, creatorRevertAuthorized, revertPrecondition,
        studioMutated, restartCount
        >>

RejectStaleRevertPrecondition ==
    /\ phase = "reverting"
    /\ creatorRevertAuthorized
    /\ phase' = "incomplete"
    /\ revertPrecondition' = FALSE
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, studioMutated, restartCount
        >>

Restart ==
    /\ restartCount = 0
    /\ phase \in {"writing", "awaiting_sync", "reverting"}
    /\ phase' = "recovery_required"
    /\ restartCount' = 1
    /\ UNCHANGED <<
        authority, manifestBound, sourcemapBound, changeSetBound, approval,
        writePrecondition, filesystemRevision, filesystemWritten,
        writeReceiptPersisted, writeEpoch, syncStatus, syncProofEpoch,
        syncObservationEpoch,
        creatorRevertAuthorized, revertPrecondition, studioMutated
        >>

Next ==
    \/ ChooseRojoSourceAuthority
    \/ RejectMixedAuthority
    \/ RejectStudioAuthority
    \/ BindPinnedManifestAndSourcemap
    \/ ApproveExactRojoChangeSet
    \/ BeginGuardedWrite
    \/ PersistGuardedWriteReceipt
    \/ ReceiveIncompleteSyncProof
    \/ ReceiveMismatchedSyncProof
    \/ ReceiveStaleSyncProof
    \/ AcceptFreshExactSyncProof
    \/ AuthorizeExplicitRevert
    \/ PersistGuardedRevertReceipt
    \/ RejectStaleRevertPrecondition
    \/ Restart

Spec == Init /\ [][Next]_vars

NoStudioMutation == ~studioMutated

MixedAuthorityCannotWrite ==
    authority = "mixed" => /\ phase = "rejected" /\ ~filesystemWritten

FilesystemWriteNeedsExactGuards ==
    filesystemWritten =>
        /\ authority = "rojo_source"
        /\ manifestBound /\ sourcemapBound /\ changeSetBound /\ approval
        /\ writePrecondition /\ writeReceiptPersisted /\ writeEpoch = 1

AwaitingSyncRetainsProvisionalReceipt ==
    phase \in {"awaiting_sync", "recovery_required", "reverting"} /\ filesystemWritten =>
        writeReceiptPersisted /\ filesystemRevision = 1

CommitNeedsFreshExactSyncProof ==
    phase = "committed" =>
        /\ filesystemWritten /\ writeReceiptPersisted
        /\ syncStatus = "matched" /\ syncProofEpoch = writeEpoch

StaleProofCannotCommit == syncStatus = "stale" => phase # "committed"

RevertNeedsExplicitCreatorAuthority ==
    phase = "reverted" =>
        /\ creatorRevertAuthorized /\ revertPrecondition
        /\ ~filesystemWritten /\ filesystemRevision = 0

RecoveryCannotFinalize ==
    phase = "recovery_required" => syncStatus # "matched"

NoUnexpectedDeadlock == Terminal \/ phase = "recovery_required" \/ ENABLED Next

\* Action properties checked separately from the state invariants.
RestartNeverWrites ==
    [] [Restart => UNCHANGED <<
        filesystemRevision, filesystemWritten, writeReceiptPersisted,
        writeEpoch, syncStatus, syncProofEpoch, syncObservationEpoch,
        studioMutated
    >>]_vars

RestartRequiresRecovery ==
    [] [Restart => phase' = "recovery_required"]_vars

StaleSyncProofDoesNotAdvance ==
    [] [ReceiveStaleSyncProof => UNCHANGED <<
        phase, filesystemRevision, filesystemWritten, writeReceiptPersisted,
        approval, changeSetBound, studioMutated
    >>]_vars

RevertWriteRequiresCreatorAuthority ==
    [] [PersistGuardedRevertReceipt => creatorRevertAuthorized /\ revertPrecondition]_vars

MixedAuthorityIsRejected ==
    [] [RejectMixedAuthority => phase' = "rejected" /\ ~filesystemWritten']_vars

========================================================================================
