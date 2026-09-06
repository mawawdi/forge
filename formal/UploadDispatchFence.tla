------------------------- MODULE UploadDispatchFence -------------------------
EXTENDS Naturals

\* One immutable upload intent may result in at most one POST. Polling and
\* restart can recover a retained operation, but uncertainty never authorizes
\* a second dispatch.

VARIABLES state, postCount, pollCount, restarts
vars == <<state, postCount, pollCount, restarts>>

TypeOK ==
    /\ state \in {"absent", "intent", "dispatched", "unknown", "pending", "eligible", "rejected"}
    /\ postCount \in 0..1
    /\ pollCount \in 0..3
    /\ restarts \in 0..2

Init == /\ state = "absent" /\ postCount = 0 /\ pollCount = 0 /\ restarts = 0
PersistIntent == /\ state = "absent" /\ state' = "intent" /\ UNCHANGED <<postCount, pollCount, restarts>>
Post == /\ state = "intent" /\ postCount = 0 /\ state' \in {"dispatched", "unknown"} /\ postCount' = 1 /\ UNCHANGED <<pollCount, restarts>>
ObserveOperation == /\ state = "dispatched" /\ state' \in {"pending", "eligible", "rejected"} /\ UNCHANGED <<postCount, pollCount, restarts>>
Poll == /\ state = "pending" /\ pollCount < 3 /\ state' \in {"pending", "eligible", "rejected", "unknown"} /\ pollCount' = pollCount + 1 /\ UNCHANGED <<postCount, restarts>>
ExhaustPolling ==
    /\ state = "pending"
    /\ pollCount = 3
    /\ state' = "unknown"
    /\ UNCHANGED <<postCount, pollCount, restarts>>
Restart ==
    /\ state \notin {"absent", "eligible", "rejected"}
    /\ restarts < 2
    /\ restarts' = restarts + 1
    /\ state' = (IF state = "dispatched" THEN "unknown" ELSE state)
    /\ UNCHANGED <<postCount, pollCount>>
ReadTerminal == /\ state \in {"eligible", "rejected", "unknown"} /\ UNCHANGED vars

Next == PersistIntent \/ Post \/ ObserveOperation \/ Poll \/ ExhaustPolling \/ Restart \/ ReadTerminal
Spec == Init /\ [][Next]_vars

AtMostOnePost == postCount <= 1
PostRequiresIntent == postCount = 1 => state # "absent" /\ state # "intent"
UnknownNeverResubmits == [] [((state = "unknown") => postCount' = postCount)]_vars
RestartNeverPosts == [] [(Restart => UNCHANGED postCount)]_vars
NoUnexpectedDeadlock == ENABLED Next

===============================================================================
