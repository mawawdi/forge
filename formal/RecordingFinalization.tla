------------------------- MODULE RecordingFinalization -------------------------
EXTENDS Naturals

\* ChangeHistory finalization is not an atomic network operation. The plugin
\* durably records the exact action before FinishRecording, and records a
\* settled receipt only after an exact closed readback. A restart in the gap is
\* deliberately ambiguous and may only enter recovery; it never repeats the
\* Studio operation automatically.

CONSTANT Actions

VARIABLES
    coordinator,
    plugin,
    recording,
    action,
    finishCount,
    closedReadback,
    durableReceipt,
    restarts

vars == <<coordinator, plugin, recording, action, finishCount, closedReadback,
          durableReceipt, restarts>>

TypeOK ==
    /\ coordinator \in {"requesting", "recovery", "settled"}
    /\ plugin \in {"idle", "intent", "returned", "closed_readback", "finished"}
    /\ recording \in {"open", "closed", "unknown"}
    /\ action \in Actions \cup {"none"}
    /\ finishCount \in 0..1
    /\ closedReadback \in BOOLEAN
    /\ durableReceipt \in BOOLEAN
    /\ restarts \in 0..2

Init ==
    /\ coordinator = "requesting"
    /\ plugin = "idle"
    /\ recording = "open"
    /\ action = "none"
    /\ finishCount = 0
    /\ closedReadback = FALSE
    /\ durableReceipt = FALSE
    /\ restarts = 0

PersistIntent(a) ==
    /\ coordinator = "requesting"
    /\ plugin = "idle"
    /\ recording = "open"
    /\ a \in Actions
    /\ plugin' = "intent"
    /\ action' = a
    /\ UNCHANGED <<coordinator, recording, finishCount, closedReadback, durableReceipt,
                    restarts>>

CallFinishRecording ==
    /\ coordinator = "requesting"
    /\ plugin = "intent"
    /\ recording = "open"
    /\ action \in Actions
    /\ finishCount = 0
    /\ plugin' = "returned"
    /\ recording' \in {"open", "closed", "unknown"}
    /\ finishCount' = finishCount + 1
    /\ UNCHANGED <<coordinator, action, closedReadback, durableReceipt, restarts>>

ReadClosedRecording ==
    /\ coordinator = "requesting"
    /\ plugin = "returned"
    /\ recording = "closed"
    /\ finishCount = 1
    /\ plugin' = "closed_readback"
    /\ closedReadback' = TRUE
    /\ UNCHANGED <<coordinator, recording, action, finishCount, durableReceipt, restarts>>

\* A readback that is still open or unavailable leaves the durable cursor at
\* intent. Recovery may be creator-authorized, but may never issue Finish again.
ReadUnclosedOrUnknownRecording ==
    /\ coordinator = "requesting"
    /\ plugin = "returned"
    /\ recording \in {"open", "unknown"}
    /\ finishCount = 1
    /\ coordinator' = "recovery"
    /\ plugin' = "intent"
    /\ UNCHANGED <<recording, action, finishCount, closedReadback, durableReceipt, restarts>>

PersistFinishedReceipt ==
    /\ coordinator = "requesting"
    /\ plugin = "closed_readback"
    /\ recording = "closed"
    /\ finishCount = 1
    /\ closedReadback
    /\ plugin' = "finished"
    /\ durableReceipt' = TRUE
    /\ UNCHANGED <<coordinator, recording, action, finishCount, closedReadback, restarts>>

AcknowledgeFinishedReceipt ==
    /\ coordinator \in {"requesting", "recovery"}
    /\ plugin = "finished"
    /\ recording = "closed"
    /\ durableReceipt
    /\ finishCount = 1
    /\ coordinator' = "settled"
    /\ UNCHANGED <<plugin, recording, action, finishCount, closedReadback, durableReceipt,
                    restarts>>

\* A restart observes only durable plugin state. `returned` and
\* `closed_readback` were not durable, so either becomes prior intent while
\* Studio's recording state is unknown.
Restart ==
    /\ coordinator # "settled"
    /\ restarts < 2
    /\ coordinator' = "recovery"
    /\ plugin' = IF plugin \in {"returned", "closed_readback"} THEN "intent" ELSE plugin
    /\ recording' = IF plugin \in {"returned", "closed_readback"} THEN "unknown" ELSE recording
    /\ closedReadback' = IF plugin \in {"returned", "closed_readback"} THEN FALSE ELSE closedReadback
    /\ restarts' = restarts + 1
    /\ UNCHANGED <<action, finishCount, durableReceipt>>

ReplayFinishedReceipt ==
    /\ coordinator = "recovery"
    /\ plugin = "finished"
    /\ durableReceipt
    /\ UNCHANGED vars

Next ==
    \/ \E a \in Actions : PersistIntent(a)
    \/ CallFinishRecording
    \/ ReadClosedRecording
    \/ ReadUnclosedOrUnknownRecording
    \/ PersistFinishedReceipt
    \/ AcknowledgeFinishedReceipt
    \/ Restart
    \/ ReplayFinishedReceipt

Spec == Init /\ [][Next]_vars

FinishRequiresDurableIntent ==
    finishCount = 1 => action \in Actions /\ plugin # "idle"

ReceiptRequiresClosedReadback ==
    durableReceipt => finishCount = 1 /\ plugin = "finished" /\ recording = "closed" /\ closedReadback

SettlementRequiresReceipt ==
    coordinator = "settled" => durableReceipt /\ finishCount = 1 /\ closedReadback

AtMostOneFinish == finishCount <= 1

RestartNeverFinalizes ==
    [] [(Restart => UNCHANGED <<finishCount, durableReceipt>>)]_vars

RecoveryNeverAutomaticallyFinishes ==
    [] [((coordinator = "recovery" /\ coordinator' = "recovery") =>
        UNCHANGED finishCount)]_vars

NoUnexpectedDeadlock ==
    coordinator \in {"recovery", "settled"} \/ ENABLED Next

===============================================================================
