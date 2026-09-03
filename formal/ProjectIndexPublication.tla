-------------------------- MODULE ProjectIndexPublication --------------------------
EXTENDS Naturals

\* A complete project-index capture is immutable historical evidence. Detector
\* callbacks fence the connector's current command authority, but a callback
\* arriving while already-captured bytes are transported cannot erase or
\* retroactively invalidate those bytes. A later stable capture decides whether
\* the advisory dirty barrier was harmless or represented real drift.

CONSTANT Revisions

Phases == {
    "idle", "reading", "captured", "transporting", "transported",
    "confirming", "confirmed", "recovery_required", "finalized"
}

VARIABLES
    phase,
    detectorEpoch,
    readEpoch,
    confirmationEpoch,
    captureComplete,
    captureRevision,
    transportComplete,
    baselineAvailable,
    dirtyBarrier,
    currentAuthority,
    currentAuthorityEpoch,
    currentRevision,
    comparison,
    studioFinalized

vars == <<
    phase, detectorEpoch, readEpoch, confirmationEpoch, captureComplete,
    captureRevision, transportComplete, baselineAvailable, dirtyBarrier,
    currentAuthority, currentAuthorityEpoch, currentRevision, comparison,
    studioFinalized
>>

TypeOK ==
    /\ phase \in Phases
    /\ detectorEpoch \in 0..2
    /\ readEpoch \in 0..2
    /\ confirmationEpoch \in 0..2
    /\ captureComplete \in BOOLEAN
    /\ captureRevision \in Revisions
    /\ transportComplete \in BOOLEAN
    /\ baselineAvailable \in BOOLEAN
    /\ dirtyBarrier \in BOOLEAN
    /\ currentAuthority \in BOOLEAN
    /\ currentAuthorityEpoch \in 0..2
    /\ currentRevision \in Revisions
    /\ comparison \in {"none", "unchanged", "drift"}
    /\ studioFinalized \in BOOLEAN

Init ==
    /\ phase = "idle"
    /\ detectorEpoch = 0
    /\ readEpoch = 0
    /\ confirmationEpoch = 0
    /\ captureComplete = FALSE
    /\ captureRevision = 0
    /\ transportComplete = FALSE
    /\ baselineAvailable = FALSE
    /\ dirtyBarrier = FALSE
    /\ currentAuthority = TRUE
    /\ currentAuthorityEpoch = 0
    /\ currentRevision = 0
    /\ comparison = "none"
    /\ studioFinalized = FALSE

BeginRead ==
    /\ phase = "idle"
    /\ phase' = "reading"
    /\ readEpoch' = detectorEpoch
    /\ captureComplete' = FALSE
    /\ transportComplete' = FALSE
    /\ baselineAvailable' = FALSE
    /\ comparison' = "none"
    /\ UNCHANGED <<detectorEpoch, confirmationEpoch, captureRevision,
        dirtyBarrier, currentAuthority, currentAuthorityEpoch,
        currentRevision, studioFinalized>>

CallbackDuringRead ==
    /\ phase = "reading"
    /\ detectorEpoch < 2
    /\ detectorEpoch' = detectorEpoch + 1
    /\ dirtyBarrier' = TRUE
    /\ currentAuthority' = FALSE
    /\ UNCHANGED <<phase, readEpoch, confirmationEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

RetryWholeRead ==
    /\ phase = "reading"
    /\ readEpoch # detectorEpoch
    /\ readEpoch' = detectorEpoch
    /\ UNCHANGED <<phase, detectorEpoch, confirmationEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable, dirtyBarrier,
        currentAuthority, currentAuthorityEpoch, currentRevision, comparison,
        studioFinalized>>

CompleteStableRead ==
    /\ phase = "reading"
    /\ readEpoch = detectorEpoch
    /\ phase' = "captured"
    /\ captureComplete' = TRUE
    /\ captureRevision' \in Revisions
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        transportComplete, baselineAvailable, dirtyBarrier, currentAuthority,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

BeginTransport ==
    /\ phase = "captured"
    /\ captureComplete
    /\ phase' = "transporting"
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, transportComplete, baselineAvailable,
        dirtyBarrier, currentAuthority, currentAuthorityEpoch, currentRevision,
        comparison, studioFinalized>>

CallbackDuringTransport ==
    /\ phase = "transporting"
    /\ detectorEpoch < 2
    /\ detectorEpoch' = detectorEpoch + 1
    /\ dirtyBarrier' = TRUE
    /\ currentAuthority' = FALSE
    /\ UNCHANGED <<phase, readEpoch, confirmationEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

CompleteTransport ==
    /\ phase = "transporting"
    /\ captureComplete
    /\ phase' = "transported"
    /\ transportComplete' = TRUE
    /\ baselineAvailable' = TRUE
    /\ currentAuthority' = (readEpoch = detectorEpoch)
    /\ currentAuthorityEpoch' = IF readEpoch = detectorEpoch THEN readEpoch
                                 ELSE currentAuthorityEpoch
    /\ currentRevision' = IF readEpoch = detectorEpoch THEN captureRevision
                           ELSE currentRevision
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, dirtyBarrier, comparison,
        studioFinalized>>

CallbackAfterTransport ==
    /\ phase = "transported"
    /\ detectorEpoch < 2
    /\ detectorEpoch' = detectorEpoch + 1
    /\ dirtyBarrier' = TRUE
    /\ currentAuthority' = FALSE
    /\ UNCHANGED <<phase, readEpoch, confirmationEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

AcceptStillCurrent ==
    /\ phase = "transported"
    /\ baselineAvailable /\ transportComplete /\ currentAuthority
    /\ ~dirtyBarrier
    /\ phase' = "confirmed"
    /\ comparison' = "unchanged"
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, transportComplete, baselineAvailable,
        dirtyBarrier, currentAuthority, currentAuthorityEpoch, currentRevision,
        studioFinalized>>

BeginConfirmation ==
    /\ phase = "transported"
    /\ baselineAvailable /\ dirtyBarrier
    /\ phase' = "confirming"
    /\ confirmationEpoch' = detectorEpoch
    /\ UNCHANGED <<detectorEpoch, readEpoch, captureComplete, captureRevision,
        transportComplete, baselineAvailable, dirtyBarrier, currentAuthority,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

CallbackDuringConfirmation ==
    /\ phase = "confirming"
    /\ detectorEpoch < 2
    /\ detectorEpoch' = detectorEpoch + 1
    /\ dirtyBarrier' = TRUE
    /\ currentAuthority' = FALSE
    /\ UNCHANGED <<phase, readEpoch, confirmationEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable,
        currentAuthorityEpoch, currentRevision, comparison, studioFinalized>>

RetryWholeConfirmation ==
    /\ phase = "confirming"
    /\ confirmationEpoch # detectorEpoch
    /\ confirmationEpoch' = detectorEpoch
    /\ UNCHANGED <<phase, detectorEpoch, readEpoch, captureComplete,
        captureRevision, transportComplete, baselineAvailable, dirtyBarrier,
        currentAuthority, currentAuthorityEpoch, currentRevision, comparison,
        studioFinalized>>

ConfirmUnchanged ==
    /\ phase = "confirming"
    /\ confirmationEpoch = detectorEpoch
    /\ phase' = "confirmed"
    /\ dirtyBarrier' = FALSE
    /\ currentAuthority' = TRUE
    /\ currentAuthorityEpoch' = detectorEpoch
    /\ currentRevision' = captureRevision
    /\ comparison' = "unchanged"
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, transportComplete, baselineAvailable,
        studioFinalized>>

ConfirmDrift ==
    /\ phase = "confirming"
    /\ confirmationEpoch = detectorEpoch
    /\ \E observed \in Revisions:
        /\ observed # captureRevision
        /\ phase' = "recovery_required"
        /\ currentAuthority' = TRUE
        /\ currentAuthorityEpoch' = detectorEpoch
        /\ currentRevision' = observed
        /\ comparison' = "drift"
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, transportComplete, baselineAvailable,
        dirtyBarrier, studioFinalized>>

Finalize ==
    /\ phase = "confirmed"
    /\ baselineAvailable /\ transportComplete /\ currentAuthority
    /\ currentAuthorityEpoch = detectorEpoch
    /\ ~dirtyBarrier /\ comparison = "unchanged"
    /\ phase' = "finalized"
    /\ studioFinalized' = TRUE
    /\ UNCHANGED <<detectorEpoch, readEpoch, confirmationEpoch,
        captureComplete, captureRevision, transportComplete, baselineAvailable,
        dirtyBarrier, currentAuthority, currentAuthorityEpoch, currentRevision,
        comparison>>

Next ==
    \/ BeginRead
    \/ CallbackDuringRead
    \/ RetryWholeRead
    \/ CompleteStableRead
    \/ BeginTransport
    \/ CallbackDuringTransport
    \/ CompleteTransport
    \/ CallbackAfterTransport
    \/ AcceptStillCurrent
    \/ BeginConfirmation
    \/ CallbackDuringConfirmation
    \/ RetryWholeConfirmation
    \/ ConfirmUnchanged
    \/ ConfirmDrift
    \/ Finalize

Spec == Init /\ [][Next]_vars

HistoricalCaptureSurvivesTransport ==
    phase \in {"transporting", "transported", "confirming", "confirmed",
               "recovery_required", "finalized"} => captureComplete

TransportNeedsCompleteCapture == transportComplete => captureComplete
ComparisonNeedsBaseline == comparison # "none" => baselineAvailable /\ transportComplete
CurrentAuthorityHasStableEpoch == currentAuthority => currentAuthorityEpoch = detectorEpoch
FinalizationNeedsConfirmedCurrentState ==
    studioFinalized => phase = "finalized" /\ comparison = "unchanged" /\
        baselineAvailable /\ transportComplete /\ currentAuthority /\ ~dirtyBarrier
DirtyBarrierNeverFinalizes == dirtyBarrier => ~studioFinalized
DriftNeverFinalizes == comparison = "drift" => ~studioFinalized

=============================================================================
