--------------------------- MODULE BridgeCommandDelivery ---------------------------
EXTENDS Naturals

\* Bounded model of Forge's loopback command transport. HTTP delivery is not
\* treated as execution. The sender retains one immutable command until the
\* receiver reports an exact terminal settlement. Both execution and rejection
\* are cached before transport, so redelivery after a lost HTTP response is
\* replay-only and a rejected head command cannot block the queue forever. A
\* rejected transport disposition makes no claim about semantic Studio effects;
\* transaction evidence and recovery model those separately.

VARIABLES
    sender,
    receiver,
    deliveries,
    handlerRuns,
    cachedSettlement,
    settlementVisible,
    conflicts,
    loopRetries

vars == <<
    sender, receiver, deliveries, handlerRuns, cachedSettlement,
    settlementVisible, conflicts, loopRetries
>>

TypeOK ==
    /\ sender \in {"idle", "queued", "executed", "rejected"}
    /\ receiver \in {"fresh", "processing", "executed", "rejected"}
    /\ deliveries \in 0..3
    /\ handlerRuns \in 0..1
    /\ cachedSettlement \in {"none", "executed", "rejected"}
    /\ settlementVisible \in BOOLEAN
    /\ conflicts \in 0..2
    /\ loopRetries \in 0..2

Init ==
    /\ sender = "idle"
    /\ receiver = "fresh"
    /\ deliveries = 0
    /\ handlerRuns = 0
    /\ cachedSettlement = "none"
    /\ settlementVisible = FALSE
    /\ conflicts = 0
    /\ loopRetries = 0

QueueExactCommand ==
    /\ sender = "idle"
    /\ sender' = "queued"
    /\ UNCHANGED <<receiver, deliveries, handlerRuns, cachedSettlement,
                    settlementVisible, conflicts, loopRetries>>

DeliverExactCommand ==
    /\ sender = "queued"
    /\ receiver = "fresh"
    /\ deliveries < 3
    /\ receiver' = "processing"
    /\ deliveries' = deliveries + 1
    /\ UNCHANGED <<sender, handlerRuns, cachedSettlement, settlementVisible,
                    conflicts, loopRetries>>

ExecuteAndPersistSettlement ==
    /\ sender = "queued"
    /\ receiver = "processing"
    /\ receiver' = "executed"
    /\ handlerRuns' = handlerRuns + 1
    /\ cachedSettlement' = "executed"
    /\ settlementVisible' = TRUE
    /\ UNCHANGED <<sender, deliveries, conflicts, loopRetries>>

RejectAndPersistSettlement ==
    /\ sender = "queued"
    /\ receiver = "processing"
    /\ receiver' = "rejected"
    /\ handlerRuns' = handlerRuns + 1
    /\ cachedSettlement' = "rejected"
    /\ settlementVisible' = TRUE
    /\ UNCHANGED <<sender, deliveries, conflicts, loopRetries>>

LoseHttpResponse ==
    /\ sender = "queued"
    /\ receiver \in {"executed", "rejected"}
    /\ settlementVisible
    /\ settlementVisible' = FALSE
    /\ UNCHANGED <<sender, receiver, deliveries, handlerRuns, cachedSettlement,
                    conflicts, loopRetries>>

RedeliverSettledCommand ==
    /\ sender = "queued"
    /\ receiver \in {"executed", "rejected"}
    /\ cachedSettlement = receiver
    \* The bounded counter saturates; the actual retained command remains
    \* redeliverable until its exact terminal settlement arrives.
    /\ deliveries' = IF deliveries < 3 THEN deliveries + 1 ELSE deliveries
    /\ settlementVisible' = TRUE
    /\ UNCHANGED <<sender, receiver, handlerRuns, cachedSettlement,
                    conflicts, loopRetries>>

SettleExactCommand ==
    /\ sender = "queued"
    /\ receiver \in {"executed", "rejected"}
    /\ cachedSettlement = receiver
    /\ settlementVisible
    /\ sender' = receiver
    /\ UNCHANGED <<receiver, deliveries, handlerRuns, cachedSettlement,
                    settlementVisible, conflicts, loopRetries>>

RejectConflictingFingerprint ==
    /\ sender = "queued"
    /\ conflicts < 2
    /\ conflicts' = conflicts + 1
    /\ UNCHANGED <<sender, receiver, deliveries, handlerRuns, cachedSettlement,
                    settlementVisible, loopRetries>>

RetryTransportLoop ==
    /\ sender = "queued"
    /\ receiver \in {"executed", "rejected"}
    /\ cachedSettlement = receiver
    /\ loopRetries < 2
    /\ loopRetries' = loopRetries + 1
    /\ settlementVisible' = FALSE
    /\ UNCHANGED <<sender, receiver, deliveries, handlerRuns,
                    cachedSettlement, conflicts>>

Next ==
    \/ QueueExactCommand
    \/ DeliverExactCommand
    \/ ExecuteAndPersistSettlement
    \/ RejectAndPersistSettlement
    \/ LoseHttpResponse
    \/ RedeliverSettledCommand
    \/ SettleExactCommand
    \/ RejectConflictingFingerprint
    \/ RetryTransportLoop

Spec == Init /\ [][Next]_vars

TerminalSettlementRequiresOneHandlerRun ==
    /\ (sender = "executed" =>
        receiver = "executed" /\ cachedSettlement = "executed" /\ handlerRuns = 1)
    /\ (sender = "rejected" =>
        receiver = "rejected" /\ cachedSettlement = "rejected" /\ handlerRuns = 1)

TerminalReceiverHasCachedSettlement ==
    receiver \in {"executed", "rejected"} => cachedSettlement = receiver

NoSettlementBeforeTerminalOutcome ==
    cachedSettlement = "none" => receiver \notin {"executed", "rejected"}

ConflictNeverExecutes ==
    [] [(RejectConflictingFingerprint =>
        UNCHANGED <<sender, receiver, deliveries, handlerRuns, cachedSettlement,
                    settlementVisible, loopRetries>>)]_vars

TransportRetryNeverRunsHandler ==
    [] [(RetryTransportLoop => UNCHANGED <<handlerRuns, cachedSettlement>>)]_vars

RedeliveryNeverRerunsHandler ==
    [] [(RedeliverSettledCommand => UNCHANGED <<handlerRuns, cachedSettlement>>)]_vars

NoUnexpectedDeadlock == sender \in {"executed", "rejected"} \/ ENABLED Next

================================================================================
