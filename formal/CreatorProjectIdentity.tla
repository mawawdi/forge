------------------------- MODULE CreatorProjectIdentity -------------------------
EXTENDS Naturals

\* This model isolates Studio identity operations from ordinary creator
\* conversation work. A Link/Fork rejection is deliberately not a no-effect
\* result: only an exact, command-bound observation can release its
\* reservation, and a later retry needs fresh pairing plus Creator authority.

IdentityValues == {"absent", "alpha", "beta"}
IdentityPhases == {"idle", "opening", "open", "finalized"}
RecordingStates == {"not_open", "open", "unknown"}
CursorStates == {"none", "open", "unknown"}
Receipts == {"none", "linked", "forked", "abandoned"}
SessionStates == {"live", "expired", "unpaired"}
ContinuityStates == {"local", "required", "continued", "new"}
LinkOperations == {"link1", "link2"}
ForkOperations == {"fork1", "fork2"}
Operations == LinkOperations \cup ForkOperations
Reservations == Operations \cup {"none"}

OperationTarget(op) ==
    IF op \in LinkOperations THEN "alpha" ELSE "beta"

VARIABLES
    identity,
    identityBefore,
    identityTarget,
    identityPhase,
    reservation,
    recording,
    identityCursor,
    beforeMatches,
    receipt,
    rejectedFor,
    noEffectProofFor,
    proofIdentityMatchesBefore,
    proofCursorAbsent,
    proofReceiptAbsent,
    proofRecordingNotOpen,
    retryRequired,
    authorizedRetryFor,
    proofPairingGeneration,
    studioMutations,
    mutationAtOpening,
    sessionA,
    sessionB,
    pairing,
    pairingGeneration,
    writeA,
    writeB,
    platform,
    continuity,
    embeddedIdentity,
    heartbeats,
    restarts,
    staleSettlements

vars == <<
    identity, identityBefore, identityTarget, identityPhase, reservation,
    recording, identityCursor, beforeMatches, receipt, rejectedFor,
    noEffectProofFor, proofIdentityMatchesBefore, proofCursorAbsent,
    proofReceiptAbsent, proofRecordingNotOpen, retryRequired,
    authorizedRetryFor, proofPairingGeneration, studioMutations,
    mutationAtOpening, sessionA, sessionB, pairing, pairingGeneration,
    writeA, writeB, platform, continuity, embeddedIdentity, heartbeats,
    restarts, staleSettlements
>>

PairedWriter ==
    \/ (pairing = "A" /\ sessionA = "live" /\ writeA)
    \/ (pairing = "B" /\ sessionB = "live" /\ writeB)

CanReserve(op) ==
    /\ PairedWriter
    /\ platform = "local"
    /\ identityPhase = "idle"
    /\ reservation = "none"
    /\ (noEffectProofFor = "none" \/ authorizedRetryFor = op)

TypeOK ==
    /\ identity \in IdentityValues
    /\ identityBefore \in IdentityValues
    /\ identityTarget \in IdentityValues
    /\ identityPhase \in IdentityPhases
    /\ reservation \in Reservations
    /\ recording \in RecordingStates
    /\ identityCursor \in CursorStates
    /\ beforeMatches \in BOOLEAN
    /\ receipt \in Receipts
    /\ rejectedFor \in Reservations
    /\ noEffectProofFor \in Reservations
    /\ proofIdentityMatchesBefore \in BOOLEAN
    /\ proofCursorAbsent \in BOOLEAN
    /\ proofReceiptAbsent \in BOOLEAN
    /\ proofRecordingNotOpen \in BOOLEAN
    /\ retryRequired \in BOOLEAN
    /\ authorizedRetryFor \in Reservations
    /\ proofPairingGeneration \in 0..2
    /\ studioMutations \in 0..2
    /\ mutationAtOpening \in 0..2
    /\ sessionA \in SessionStates
    /\ sessionB \in SessionStates
    /\ pairing \in {"none", "A", "B"}
    /\ pairingGeneration \in 0..2
    /\ writeA \in BOOLEAN
    /\ writeB \in BOOLEAN
    /\ platform \in {"local", "published"}
    /\ continuity \in ContinuityStates
    /\ embeddedIdentity \in BOOLEAN
    /\ heartbeats \in 0..2
    /\ restarts \in 0..2
    /\ staleSettlements \in 0..2

Init ==
    /\ identity = "absent"
    /\ identityBefore = "absent"
    /\ identityTarget = "absent"
    /\ identityPhase = "idle"
    /\ reservation = "none"
    /\ recording = "not_open"
    /\ identityCursor = "none"
    /\ beforeMatches = TRUE
    /\ receipt = "none"
    /\ rejectedFor = "none"
    /\ noEffectProofFor = "none"
    /\ proofIdentityMatchesBefore = FALSE
    /\ proofCursorAbsent = FALSE
    /\ proofReceiptAbsent = FALSE
    /\ proofRecordingNotOpen = FALSE
    /\ retryRequired = FALSE
    /\ authorizedRetryFor = "none"
    /\ proofPairingGeneration = 0
    /\ studioMutations = 0
    /\ mutationAtOpening = 0
    /\ sessionA = "live"
    /\ sessionB = "unpaired"
    /\ pairing = "A"
    /\ pairingGeneration = 0
    /\ writeA = TRUE
    /\ writeB = FALSE
    /\ platform = "local"
    /\ continuity = "local"
    /\ embeddedIdentity = FALSE
    /\ heartbeats = 0
    /\ restarts = 0
    /\ staleSettlements = 0

BeginLink(op) ==
    /\ op \in LinkOperations
    /\ CanReserve(op)
    /\ identity = "absent"
    /\ identityBefore' = identity
    /\ identityTarget' = OperationTarget(op)
    /\ identityPhase' = "opening"
    /\ reservation' = op
    /\ recording' = "unknown"
    /\ identityCursor' = "unknown"
    /\ beforeMatches' = TRUE
    /\ receipt' = "none"
    /\ rejectedFor' = "none"
    /\ noEffectProofFor' = "none"
    /\ proofIdentityMatchesBefore' = FALSE
    /\ proofCursorAbsent' = FALSE
    /\ proofReceiptAbsent' = FALSE
    /\ proofRecordingNotOpen' = FALSE
    /\ retryRequired' = FALSE
    /\ authorizedRetryFor' = "none"
    /\ mutationAtOpening' = studioMutations
    /\ UNCHANGED <<identity, proofPairingGeneration, studioMutations,
        sessionA, sessionB, pairing, pairingGeneration, writeA, writeB,
        platform, continuity, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

BeginFork(op) ==
    /\ op \in ForkOperations
    /\ CanReserve(op)
    /\ identity = "alpha"
    /\ identityBefore' = identity
    /\ identityTarget' = OperationTarget(op)
    /\ identityPhase' = "opening"
    /\ reservation' = op
    /\ recording' = "unknown"
    /\ identityCursor' = "unknown"
    /\ beforeMatches' = TRUE
    /\ receipt' = "none"
    /\ rejectedFor' = "none"
    /\ noEffectProofFor' = "none"
    /\ proofIdentityMatchesBefore' = FALSE
    /\ proofCursorAbsent' = FALSE
    /\ proofReceiptAbsent' = FALSE
    /\ proofRecordingNotOpen' = FALSE
    /\ retryRequired' = FALSE
    /\ authorizedRetryFor' = "none"
    /\ mutationAtOpening' = studioMutations
    /\ UNCHANGED <<identity, proofPairingGeneration, studioMutations,
        sessionA, sessionB, pairing, pairingGeneration, writeA, writeB,
        platform, continuity, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

\* A command-level rejection is an outcome, not evidence that Studio had no
\* effect. It leaves this exact operation reserved.
RejectIdentitySettlement(op) ==
    /\ op \in Operations
    /\ reservation = op
    /\ identityPhase = "opening"
    /\ rejectedFor' = op
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        noEffectProofFor, proofIdentityMatchesBefore, proofCursorAbsent,
        proofReceiptAbsent, proofRecordingNotOpen, retryRequired,
        authorizedRetryFor, proofPairingGeneration, studioMutations,
        mutationAtOpening, sessionA, sessionB, pairing, pairingGeneration,
        writeA, writeB, platform, continuity, embeddedIdentity, heartbeats,
        restarts, staleSettlements>>

\* The post-rejection inventory is fetched while the same paired authority
\* still owns the reservation. It records the only safe no-effect observation.
ObserveExactNoEffectInventory(op) ==
    /\ op \in Operations
    /\ PairedWriter
    /\ reservation = op
    /\ rejectedFor = op
    /\ identityPhase = "opening"
    /\ recording = "unknown"
    /\ identityCursor = "unknown"
    /\ recording' = "not_open"
    /\ identityCursor' = "none"
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, beforeMatches, receipt, rejectedFor, noEffectProofFor,
        proofIdentityMatchesBefore, proofCursorAbsent, proofReceiptAbsent,
        proofRecordingNotOpen, retryRequired, authorizedRetryFor,
        proofPairingGeneration, studioMutations, mutationAtOpening, sessionA,
        sessionB, pairing, pairingGeneration, writeA, writeB, platform,
        continuity, embeddedIdentity, heartbeats, restarts, staleSettlements>>

\* An uncertain opening may have made a Studio-side recording. It can never be
\* released by the rejection path after that fact becomes known.
OpenRecording(op) ==
    /\ op \in Operations
    /\ reservation = op
    /\ identityPhase = "opening"
    /\ recording = "unknown"
    /\ identityCursor = "unknown"
    /\ identityPhase' = "open"
    /\ recording' = "open"
    /\ identityCursor' = "open"
    /\ UNCHANGED <<identity, identityBefore, identityTarget, reservation,
        beforeMatches, receipt, rejectedFor, noEffectProofFor,
        proofIdentityMatchesBefore, proofCursorAbsent, proofReceiptAbsent,
        proofRecordingNotOpen, retryRequired, authorizedRetryFor,
        proofPairingGeneration, studioMutations, mutationAtOpening, sessionA,
        sessionB, pairing, pairingGeneration, writeA, writeB, platform,
        continuity, embeddedIdentity, heartbeats, restarts, staleSettlements>>

\* This is the narrow release condition: the proof is bound to the current
\* reservation and includes the approved-before identity, absent cursor and
\* receipt, and a confirmed non-open recording.
ProveExactNoEffectRejection(op) ==
    /\ op \in Operations
    /\ PairedWriter
    /\ reservation = op
    /\ rejectedFor = op
    /\ identityPhase = "opening"
    /\ identity = identityBefore
    /\ beforeMatches
    /\ recording = "not_open"
    /\ identityCursor = "none"
    /\ receipt = "none"
    /\ studioMutations = mutationAtOpening
    /\ identityPhase' = "finalized"
    /\ reservation' = "none"
    /\ receipt' = "abandoned"
    /\ noEffectProofFor' = op
    /\ proofIdentityMatchesBefore' = TRUE
    /\ proofCursorAbsent' = TRUE
    /\ proofReceiptAbsent' = TRUE
    /\ proofRecordingNotOpen' = TRUE
    /\ retryRequired' = TRUE
    /\ authorizedRetryFor' = "none"
    /\ proofPairingGeneration' = pairingGeneration
    /\ UNCHANGED <<identity, identityBefore, identityTarget, recording,
        identityCursor, beforeMatches, rejectedFor, studioMutations,
        mutationAtOpening, sessionA, sessionB, pairing, pairingGeneration,
        writeA, writeB, platform, continuity, embeddedIdentity, heartbeats,
        restarts, staleSettlements>>

CommitIdentity(op) ==
    /\ op \in Operations
    /\ reservation = op
    /\ rejectedFor = "none"
    /\ identityPhase = "open"
    /\ recording = "open"
    /\ identityCursor = "open"
    /\ studioMutations < 2
    /\ identity' = identityTarget
    /\ identityPhase' = "finalized"
    /\ reservation' = "none"
    /\ recording' = "not_open"
    /\ identityCursor' = "none"
    /\ receipt' = IF op \in LinkOperations THEN "linked" ELSE "forked"
    /\ studioMutations' = studioMutations + 1
    /\ embeddedIdentity' = TRUE
    /\ UNCHANGED <<identityBefore, identityTarget, beforeMatches, rejectedFor,
        noEffectProofFor, proofIdentityMatchesBefore, proofCursorAbsent,
        proofReceiptAbsent, proofRecordingNotOpen, retryRequired,
        authorizedRetryFor, proofPairingGeneration, mutationAtOpening,
        sessionA, sessionB, pairing, pairingGeneration, writeA, writeB,
        platform, continuity, heartbeats, restarts, staleSettlements>>

AcknowledgeIdentity ==
    /\ identityPhase = "finalized"
    /\ identityPhase' = "idle"
    /\ UNCHANGED <<identity, identityBefore, identityTarget, reservation,
        recording, identityCursor, beforeMatches, receipt, rejectedFor,
        noEffectProofFor, proofIdentityMatchesBefore, proofCursorAbsent,
        proofReceiptAbsent, proofRecordingNotOpen, retryRequired,
        authorizedRetryFor, proofPairingGeneration, studioMutations,
        mutationAtOpening, sessionA, sessionB, pairing, pairingGeneration,
        writeA, writeB, platform, continuity, embeddedIdentity, heartbeats,
        restarts, staleSettlements>>

\* The retry has a different operation identity/hash. It is not started here;
\* this action models the distinct creator authorization after a fresh re-pair.
CreatorAuthorizeFreshRetry(old, new) ==
    /\ old \in Operations
    /\ new \in Operations
    /\ old # new
    /\ OperationTarget(old) = OperationTarget(new)
    /\ identityPhase = "idle"
    /\ reservation = "none"
    /\ retryRequired
    /\ rejectedFor = old
    /\ noEffectProofFor = old
    /\ pairingGeneration > proofPairingGeneration
    /\ PairedWriter
    /\ retryRequired' = FALSE
    /\ authorizedRetryFor' = new
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        proofPairingGeneration, studioMutations, mutationAtOpening, sessionA,
        sessionB, pairing, pairingGeneration, writeA, writeB, platform,
        continuity, embeddedIdentity, heartbeats, restarts, staleSettlements>>

\* Late or duplicate delivery can be observed but cannot affect another
\* operation's reservation or Studio state.
IgnoreStaleSettlement(op) ==
    /\ op \in Operations
    /\ op # reservation
    /\ staleSettlements < 2
    /\ staleSettlements' = staleSettlements + 1
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, sessionB, pairing,
        pairingGeneration, writeA, writeB, platform, continuity,
        embeddedIdentity, heartbeats, restarts>>

ExternalIdentityChange ==
    /\ identityPhase = "opening"
    /\ beforeMatches
    /\ studioMutations < 2
    /\ beforeMatches' = FALSE
    /\ studioMutations' = studioMutations + 1
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, receipt, rejectedFor,
        noEffectProofFor, proofIdentityMatchesBefore, proofCursorAbsent,
        proofReceiptAbsent, proofRecordingNotOpen, retryRequired,
        authorizedRetryFor, proofPairingGeneration, mutationAtOpening,
        sessionA, sessionB, pairing, pairingGeneration, writeA, writeB,
        platform, continuity, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

\* A normal heartbeat is liveness-only. In particular, it cannot transfer an
\* unlinked write capability or release an identity reservation.
UnchangedHeartbeat ==
    /\ PairedWriter
    /\ heartbeats < 2
    /\ heartbeats' = heartbeats + 1
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, sessionB, pairing,
        pairingGeneration, writeA, writeB, platform, continuity,
        embeddedIdentity, restarts, staleSettlements>>

PublishHeartbeat ==
    /\ PairedWriter
    /\ pairing = "A"
    /\ platform = "local"
    /\ embeddedIdentity
    /\ identityPhase = "idle"
    /\ reservation = "none"
    /\ platform' = "published"
    /\ continuity' = "required"
    /\ writeA' = FALSE
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, sessionB, pairing,
        pairingGeneration, writeB, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

ChoosePublishedContinuity ==
    /\ platform = "published"
    /\ continuity = "required"
    /\ sessionA = "live"
    /\ pairing = "A"
    /\ continuity' \in {"continued", "new"}
    /\ writeA' = TRUE
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, sessionB, pairing,
        pairingGeneration, writeB, platform, embeddedIdentity, heartbeats,
        restarts, staleSettlements>>

ExpireConnectorA ==
    /\ sessionA = "live"
    /\ pairing = "A"
    /\ sessionA' = "expired"
    /\ pairing' = "none"
    /\ writeA' = FALSE
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionB, pairingGeneration,
        writeB, platform, continuity, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

UnloadConnectorA ==
    /\ sessionA = "live"
    /\ pairing = "A"
    /\ sessionA' = "unpaired"
    /\ pairing' = "none"
    /\ writeA' = FALSE
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionB, pairingGeneration,
        writeB, platform, continuity, embeddedIdentity, heartbeats, restarts,
        staleSettlements>>

RePairConnectorA ==
    /\ sessionA \in {"expired", "unpaired"}
    /\ sessionB # "live"
    /\ pairing = "none"
    /\ pairingGeneration < 2
    /\ sessionA' = "live"
    /\ pairing' = "A"
    /\ pairingGeneration' = pairingGeneration + 1
    /\ writeA' = (continuity # "required")
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionB, writeB, platform,
        continuity, embeddedIdentity, heartbeats, restarts, staleSettlements>>

PairConnectorB ==
    /\ sessionA # "live"
    /\ sessionB # "live"
    /\ pairing = "none"
    /\ pairingGeneration < 2
    /\ sessionB' = "live"
    /\ pairing' = "B"
    /\ pairingGeneration' = pairingGeneration + 1
    /\ writeB' = (continuity # "required")
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, writeA, platform,
        continuity, embeddedIdentity, heartbeats, restarts, staleSettlements>>

RestartControl ==
    /\ restarts < 2
    /\ restarts' = restarts + 1
    /\ UNCHANGED <<identity, identityBefore, identityTarget, identityPhase,
        reservation, recording, identityCursor, beforeMatches, receipt,
        rejectedFor, noEffectProofFor, proofIdentityMatchesBefore,
        proofCursorAbsent, proofReceiptAbsent, proofRecordingNotOpen,
        retryRequired, authorizedRetryFor, proofPairingGeneration,
        studioMutations, mutationAtOpening, sessionA, sessionB, pairing,
        pairingGeneration, writeA, writeB, platform, continuity,
        embeddedIdentity, heartbeats, staleSettlements>>

Next ==
    \/ (\E op \in LinkOperations : BeginLink(op))
    \/ (\E op \in ForkOperations : BeginFork(op))
    \/ (\E op \in Operations : RejectIdentitySettlement(op))
    \/ (\E op \in Operations : ObserveExactNoEffectInventory(op))
    \/ (\E op \in Operations : OpenRecording(op))
    \/ (\E op \in Operations : ProveExactNoEffectRejection(op))
    \/ (\E op \in Operations : CommitIdentity(op))
    \/ AcknowledgeIdentity
    \/ (\E old \in Operations, new \in Operations :
        CreatorAuthorizeFreshRetry(old, new))
    \/ (\E op \in Operations : IgnoreStaleSettlement(op))
    \/ ExternalIdentityChange
    \/ UnchangedHeartbeat
    \/ PublishHeartbeat
    \/ ChoosePublishedContinuity
    \/ ExpireConnectorA
    \/ UnloadConnectorA
    \/ RePairConnectorA
    \/ PairConnectorB
    \/ RestartControl
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

NoDuplicateWriteCapability == ~(writeA /\ writeB)

OpeningIntentDoesNotChangeIdentity ==
    identityPhase = "opening" => identity = identityBefore

AbandonmentRequiresExactNoEffectProof ==
    receipt = "abandoned" =>
        /\ noEffectProofFor = rejectedFor
        /\ proofIdentityMatchesBefore
        /\ proofCursorAbsent
        /\ proofReceiptAbsent
        /\ proofRecordingNotOpen
        /\ recording = "not_open"
        /\ identityCursor = "none"
        /\ studioMutations = mutationAtOpening

PublishedContinuityIsExplicit ==
    (platform = "published" /\ continuity = "required") => ~(writeA \/ writeB)

ClosedReceiptHasNoOpenRecording ==
    receipt # "none" => recording # "open"

\* While there is no identity yet, the only authority is the currently paired
\* connector. UnchangedHeartbeat preserves every term in this implication.
UnlinkedAuthorityRemainsPairingScoped ==
    identity = "absent" /\ identityPhase = "idle" /\ reservation = "none" =>
        /\ (writeA <=> (pairing = "A" /\ sessionA = "live"))
        /\ (writeB <=> (pairing = "B" /\ sessionB = "live"))

ReservationMatchesActiveOperation ==
    reservation # "none" =>
        /\ identityPhase \in {"opening", "open"}
        /\ identityTarget = OperationTarget(reservation)

RejectedSettlementRetainsReservation ==
    rejectedFor # "none" /\ noEffectProofFor = "none" =>
        reservation = rejectedFor

ExactNoEffectProofIsRequired ==
    noEffectProofFor # "none" =>
        /\ noEffectProofFor = rejectedFor
        /\ receipt = "abandoned"
        /\ proofIdentityMatchesBefore
        /\ proofCursorAbsent
        /\ proofReceiptAbsent
        /\ proofRecordingNotOpen
        /\ identity = identityBefore
        /\ recording = "not_open"
        /\ identityCursor = "none"
        /\ studioMutations = mutationAtOpening

AuthorizedRetryHasExactProof ==
    authorizedRetryFor # "none" =>
        /\ noEffectProofFor # "none"
        /\ noEffectProofFor = rejectedFor
        /\ authorizedRetryFor # noEffectProofFor
        /\ OperationTarget(authorizedRetryFor) = OperationTarget(noEffectProofFor)
        /\ ~retryRequired
        /\ pairingGeneration > proofPairingGeneration

\* A later hash-bound Link/Fork may use a former no-effect reservation only
\* when the separate creator-authorization action was already recorded.
FreshRetryBeginsOnlyAfterCreatorAuthorization ==
    [] [((\E op \in LinkOperations : BeginLink(op)) \/
        (\E op \in ForkOperations : BeginFork(op)) =>
        noEffectProofFor = "none" \/
        (authorizedRetryFor # "none" /\
            authorizedRetryFor # noEffectProofFor /\
            OperationTarget(authorizedRetryFor) =
                OperationTarget(noEffectProofFor)))]_vars

\* A late settlement is observational only; it cannot release a reservation
\* held by another Link/Fork or mutate Studio identity state.
StaleSettlementCannotReleaseAnotherReservation ==
    [] [((\E op \in Operations : IgnoreStaleSettlement(op)) =>
        UNCHANGED <<identity, identityPhase, reservation, recording,
            identityCursor, receipt, studioMutations>>)]_vars

TransportLossNeverMutatesStudio ==
    [][(((sessionA = "live" /\ sessionA' \in {"expired", "unpaired"}) \/
        restarts' > restarts) =>
        UNCHANGED <<identity, identityPhase, reservation, recording,
            identityCursor, receipt, studioMutations>>)]_vars

HeartbeatNeverMutatesStudio ==
    [][((UnchangedHeartbeat \/ PublishHeartbeat) =>
        UNCHANGED <<identity, identityPhase, reservation, recording,
            identityCursor, receipt, studioMutations>>)]_vars

=============================================================================
