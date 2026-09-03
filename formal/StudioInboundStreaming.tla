--------------------------- MODULE StudioInboundStreaming ---------------------------
EXTENDS Naturals, Integers

\* Bounded model of both large semantic evidence and project-index delivery.
\* The plugin sends exactly one start/chunk/complete frame at a time and does
\* not advance until the host accepts that exact frame. A lost HTTP response
\* replays the same fingerprint; reordered or oversized frames change neither
\* side's cursor. The logical message becomes visible at most once, only after
\* every exact fragment and completion boundary has been accepted.

CONSTANT FrameCount

VARIABLES senderNext, hostNext, acceptedFrame, ackVisible, logicalDeliveries, failures

vars == <<senderNext, hostNext, acceptedFrame, ackVisible, logicalDeliveries, failures>>

TypeOK ==
    /\ FrameCount = 4
    /\ senderNext \in 0..FrameCount
    /\ hostNext \in 0..FrameCount
    /\ acceptedFrame \in -1..(FrameCount - 1)
    /\ ackVisible \in BOOLEAN
    /\ logicalDeliveries \in 0..1
    /\ failures \in 0..2

Init ==
    /\ senderNext = 0
    /\ hostNext = 0
    /\ acceptedFrame = -1
    /\ ackVisible = FALSE
    /\ logicalDeliveries = 0
    /\ failures = 0

AcceptExpectedFrame ==
    /\ senderNext < FrameCount
    /\ hostNext = senderNext
    /\ acceptedFrame # senderNext
    /\ hostNext' = hostNext + 1
    /\ acceptedFrame' = senderNext
    /\ ackVisible' = TRUE
    /\ logicalDeliveries' =
        IF senderNext = FrameCount - 1 THEN logicalDeliveries + 1
        ELSE logicalDeliveries
    /\ UNCHANGED <<senderNext, failures>>

LoseResponse ==
    /\ senderNext < FrameCount
    /\ hostNext = senderNext + 1
    /\ acceptedFrame = senderNext
    /\ ackVisible
    /\ ackVisible' = FALSE
    /\ UNCHANGED <<senderNext, hostNext, acceptedFrame, logicalDeliveries, failures>>

ReplayAcceptedFrame ==
    /\ senderNext < FrameCount
    /\ hostNext = senderNext + 1
    /\ acceptedFrame = senderNext
    /\ ~ackVisible
    /\ ackVisible' = TRUE
    /\ UNCHANGED <<senderNext, hostNext, acceptedFrame, logicalDeliveries, failures>>

AdvanceAfterAcknowledgement ==
    /\ senderNext < FrameCount
    /\ hostNext = senderNext + 1
    /\ acceptedFrame = senderNext
    /\ ackVisible
    /\ senderNext' = senderNext + 1
    /\ ackVisible' = FALSE
    /\ UNCHANGED <<hostNext, acceptedFrame, logicalDeliveries, failures>>

RejectReorderedOrOversized ==
    /\ senderNext < FrameCount
    /\ failures < 2
    /\ failures' = failures + 1
    /\ UNCHANGED <<senderNext, hostNext, acceptedFrame, ackVisible, logicalDeliveries>>

Next ==
    \/ AcceptExpectedFrame
    \/ LoseResponse
    \/ ReplayAcceptedFrame
    \/ AdvanceAfterAcknowledgement
    \/ RejectReorderedOrOversized

Spec == Init /\ [][Next]_vars

HostAtMostOneAcceptedFrameAhead == hostNext = senderNext \/ hostNext = senderNext + 1
LogicalDeliveryRequiresEveryFrame == logicalDeliveries = 1 => hostNext = FrameCount
SenderCompletionRequiresLogicalDelivery == senderNext = FrameCount => logicalDeliveries = 1
NoDuplicateLogicalDelivery == logicalDeliveries <= 1

RejectedFrameNeverAdvances ==
    [] [(RejectReorderedOrOversized =>
        UNCHANGED <<senderNext, hostNext, acceptedFrame, ackVisible, logicalDeliveries>>)]_vars

LostResponseNeverAdvances ==
    [] [(LoseResponse => UNCHANGED <<senderNext, hostNext, logicalDeliveries>>)]_vars

ReplayNeverRedeliversLogicalMessage ==
    [] [(ReplayAcceptedFrame => UNCHANGED <<hostNext, logicalDeliveries>>)]_vars

NoUnexpectedDeadlock == senderNext = FrameCount \/ ENABLED Next

================================================================================
