---------------------------- MODULE CreatorConversation ----------------------------
EXTENDS Naturals, FiniteSets

\* A bounded model of the durable Creator Conversation layer. The transaction
\* and identity models cover Studio effects below this layer. This model covers
\* immutable conversation publication, hash-bound turns/actions, and every
\* provider-bearing foreground phase: planner, builder, and optional repair.
\*
\* A CreatorWorkJob pre-allocates an immutable agent-execution slot. Its journal
\* is the authority for restart classification. In particular, a journal intent
\* without a response is ambiguous. An explicit creator action may consume a
\* durable response/tool-completion boundary in its exact existing slot, but it
\* never redispatches the received response. Intent and unconfirmed-tool
\* boundaries remain fresh-run only; an opaque continuation likewise prevents
\* any later provider turn in the retained slot.

CONSTANT Models

Versions == 0..1
RequestIds == 0..1
SlotIds == 0..1
Purposes == {"planner", "builder", "repair"}
PublicationStates == {
    "idle", "snapshot_persisted", "event_persisted", "commit_persisted",
    "isolated"
}
JobStates == {
    "idle", "queued", "running", "awaiting_external", "outcome_unknown",
    "completed", "failed"
}
JournalStates == {
    "unallocated", "allocated", "intent_persisted", "response_persisted",
    "tool_boundary_persisted", "tool_outcome_unknown", "terminal_persisted",
    "failure_persisted"
}
ProviderOutcomes == {
    "not_applicable", "never_dispatched", "intent_persisted",
    "response_persisted", "failure_persisted", "outcome_unknown"
}
AgentResults == {"none", "answer", "clarification", "plan", "built", "repaired"}

VARIABLES
    publication,
    storeHealthy,
    chronology,
    controls,
    workflow,
    job,
    journal,
    service,
    audit

vars == <<publication, storeHealthy, chronology, controls, workflow, job,
          journal, service, audit>>

ChronologyType == [
    head: Versions,
    pending: Versions,
    snapshot: Versions,
    event: Versions,
    commit: Versions,
    commitParent: Versions,
    headParent: Versions
]
ControlsType == [turnContract: Versions, turnLive: BOOLEAN, view: Versions]
WorkflowType == [
    plan: Versions,
    approved: Versions,
    refining: BOOLEAN,
    builderComplete: BOOLEAN,
    applyAuthorized: BOOLEAN
]
JobType == [
    state: JobStates,
    purpose: (Purposes \cup {"none"}),
    slot: 0..2,
    model: (Models \cup {"none"}),
    responseModel: (Models \cup {"none"}),
    opaqueContinuation: BOOLEAN,
    outcome: ProviderOutcomes,
    result: AgentResults
]
AuditType == [
    usedTurns: SUBSET RequestIds,
    usedActions: SUBSET RequestIds,
    staleTurnRejected: BOOLEAN,
    staleActionRejected: BOOLEAN,
    nextSlot: 0..2,
    providerDispatches: 0..2,
    studioEffects: 0..1,
    restarts: 0..1
]

EmptyJob == [
    state |-> "idle", purpose |-> "none", slot |-> 2, model |-> "none",
    responseModel |-> "none", opaqueContinuation |-> FALSE,
    outcome |-> "not_applicable", result |-> "none"
]

TypeOK ==
    /\ publication \in PublicationStates
    /\ storeHealthy \in BOOLEAN
    /\ chronology \in ChronologyType
    /\ controls \in ControlsType
    /\ workflow \in WorkflowType
    /\ job \in JobType
    /\ journal \in [SlotIds -> JournalStates]
    /\ service \in {"running", "stopped"}
    /\ audit \in AuditType

Init ==
    /\ publication = "idle"
    /\ storeHealthy = TRUE
    /\ chronology = [
        head |-> 0, pending |-> 0, snapshot |-> 0, event |-> 0, commit |-> 0,
        commitParent |-> 0, headParent |-> 0
        ]
    /\ controls = [turnContract |-> 0, turnLive |-> FALSE, view |-> 0]
    /\ workflow = [
        plan |-> 0, approved |-> 0, refining |-> FALSE, builderComplete |-> FALSE,
        applyAuthorized |-> FALSE
        ]
    /\ job = EmptyJob
    /\ journal = [slot \in SlotIds |-> "unallocated"]
    /\ service = "running"
    /\ audit = [
        usedTurns |-> {}, usedActions |-> {}, staleTurnRejected |-> FALSE,
        staleActionRejected |-> FALSE, nextSlot |-> 0, providerDispatches |-> 0,
        studioEffects |-> 0, restarts |-> 0
        ]

\* Conversation append has four durable boundaries. An interruption can leave
\* immutable orphans but can never advance the mutable head.
PersistEpisodeSnapshot ==
    /\ publication = "idle"
    /\ storeHealthy
    /\ chronology.head < 1
    /\ chronology' = [chronology EXCEPT
        !.pending = chronology.head + 1,
        !.snapshot = chronology.head + 1
        ]
    /\ publication' = "snapshot_persisted"
    /\ UNCHANGED <<storeHealthy, controls, workflow, job, journal, service, audit>>

PersistTypedEvent ==
    /\ publication = "snapshot_persisted"
    /\ chronology' = [chronology EXCEPT !.event = chronology.pending]
    /\ publication' = "event_persisted"
    /\ UNCHANGED <<storeHealthy, controls, workflow, job, journal, service, audit>>

PersistHashChainedCommit ==
    /\ publication = "event_persisted"
    /\ chronology' = [chronology EXCEPT
        !.commit = chronology.pending,
        !.commitParent = chronology.head
        ]
    /\ publication' = "commit_persisted"
    /\ UNCHANGED <<storeHealthy, controls, workflow, job, journal, service, audit>>

PublishConversationHead ==
    /\ publication = "commit_persisted"
    /\ chronology.commit = chronology.pending
    /\ chronology.event = chronology.pending
    /\ chronology.snapshot = chronology.pending
    /\ chronology' = [chronology EXCEPT
        !.head = chronology.pending,
        !.headParent = chronology.commitParent
        ]
    /\ publication' = "idle"
    /\ workflow' = [workflow EXCEPT !.applyAuthorized = FALSE]
    /\ UNCHANGED <<storeHealthy, controls, job, journal, service, audit>>

IsolateCorruptConversation ==
    /\ publication \in {"idle", "snapshot_persisted", "event_persisted", "commit_persisted"}
    /\ publication' = "isolated"
    /\ storeHealthy' = FALSE
    /\ workflow' = [workflow EXCEPT !.applyAuthorized = FALSE]
    /\ UNCHANGED <<chronology, controls, job, journal, service, audit>>

IssueTurnContract ==
    /\ service = "running"
    /\ storeHealthy
    /\ publication = "idle"
    /\ ~controls.turnLive
    /\ job.state \in {"idle", "completed", "failed"}
    /\ controls' = [controls EXCEPT
        !.turnContract = chronology.head,
        !.turnLive = TRUE
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, workflow, job, journal, service, audit>>

\* Admission reserves a new exact slot before the foreground executor sees it.
\* A duplicate turn cannot reserve another planner slot.
AdmitPlannerTurn(t, m) ==
    /\ t \in RequestIds
    /\ m \in Models
    /\ service = "running"
    /\ storeHealthy
    /\ controls.turnLive
    /\ controls.turnContract = chronology.head
    /\ t \notin audit.usedTurns
    /\ job.state \in {"idle", "completed", "failed"}
    /\ audit.nextSlot < 2
    /\ controls' = [controls EXCEPT !.turnLive = FALSE]
    /\ job' = [
        state |-> "queued", purpose |-> "planner", slot |-> audit.nextSlot,
        model |-> m, responseModel |-> "none", opaqueContinuation |-> FALSE,
        outcome |-> "not_applicable",
        result |-> "none"
        ]
    /\ journal' = [journal EXCEPT ![audit.nextSlot] = "allocated"]
    /\ audit' = [audit EXCEPT
        !.usedTurns = @ \cup {t},
        !.nextSlot = @ + 1
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, workflow, service>>

RejectStaleOrDuplicateTurn(t) ==
    /\ t \in RequestIds
    /\ ~(
        service = "running" /\ storeHealthy /\ controls.turnLive /\
        controls.turnContract = chronology.head /\ t \notin audit.usedTurns /\
        job.state \in {"idle", "completed", "failed"} /\ audit.nextSlot < 2
        )
    /\ audit' = [audit EXCEPT !.staleTurnRejected = TRUE]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, job, journal, service>>

IssueControlView ==
    /\ service = "running"
    /\ storeHealthy
    /\ publication = "idle"
    /\ controls' = [controls EXCEPT !.view = chronology.head]
    /\ UNCHANGED <<publication, storeHealthy, chronology, workflow, job, journal, service, audit>>

ApproveExactPlan(a) ==
    /\ a \in RequestIds
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ workflow.plan # 0
    /\ ~workflow.refining
    /\ workflow' = [workflow EXCEPT !.approved = workflow.plan]
    /\ audit' = [audit EXCEPT !.usedActions = @ \cup {a}]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, job, journal, service>>

\* Refinement is a planner call, not a prose-only status transition. It clears
\* old approval and build output before allocating a distinct journal slot.
AdmitPlanRefinement(a, m) ==
    /\ a \in RequestIds
    /\ m \in Models
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ workflow.plan # 0
    /\ job.state \in {"idle", "completed", "failed"}
    /\ audit.nextSlot < 2
    /\ workflow' = [workflow EXCEPT
        !.approved = 0,
        !.refining = TRUE,
        !.builderComplete = FALSE,
        !.applyAuthorized = FALSE
        ]
    /\ job' = [
        state |-> "queued", purpose |-> "planner", slot |-> audit.nextSlot,
        model |-> m, responseModel |-> "none", opaqueContinuation |-> FALSE,
        outcome |-> "not_applicable",
        result |-> "none"
        ]
    /\ journal' = [journal EXCEPT ![audit.nextSlot] = "allocated"]
    /\ audit' = [audit EXCEPT
        !.usedActions = @ \cup {a},
        !.nextSlot = @ + 1
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, service>>

AdmitBuilder(a, m) ==
    /\ a \in RequestIds
    /\ m \in Models
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ workflow.plan # 0
    /\ workflow.approved = workflow.plan
    /\ ~workflow.refining
    /\ ~workflow.builderComplete
    /\ job.state \in {"idle", "completed", "failed"}
    /\ audit.nextSlot < 2
    /\ job' = [
        state |-> "queued", purpose |-> "builder", slot |-> audit.nextSlot,
        model |-> m, responseModel |-> "none", opaqueContinuation |-> FALSE,
        outcome |-> "not_applicable",
        result |-> "none"
        ]
    /\ journal' = [journal EXCEPT ![audit.nextSlot] = "allocated"]
    /\ audit' = [audit EXCEPT
        !.usedActions = @ \cup {a},
        !.nextSlot = @ + 1
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service>>

\* Repair is optional and can be admitted only after a prior transaction effect.
\* It is still a provider-bearing phase and therefore gets the same journal.
AdmitRepair(a, m) ==
    /\ a \in RequestIds
    /\ m \in Models
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ audit.studioEffects > 0
    /\ job.state \in {"idle", "completed", "failed"}
    /\ audit.nextSlot < 2
    /\ job' = [
        state |-> "queued", purpose |-> "repair", slot |-> audit.nextSlot,
        model |-> m, responseModel |-> "none", opaqueContinuation |-> FALSE,
        outcome |-> "not_applicable",
        result |-> "none"
        ]
    /\ journal' = [journal EXCEPT ![audit.nextSlot] = "allocated"]
    /\ audit' = [audit EXCEPT
        !.usedActions = @ \cup {a},
        !.nextSlot = @ + 1
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service>>

RejectStaleOrDuplicateAction(a) ==
    /\ a \in RequestIds
    /\ ~(
        service = "running" /\ storeHealthy /\ controls.view = chronology.head /\
        a \notin audit.usedActions
        )
    /\ audit' = [audit EXCEPT !.staleActionRejected = TRUE]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, job, journal, service>>

RunQueuedJob ==
    /\ service = "running"
    /\ job.state = "queued"
    /\ journal[job.slot] = "allocated"
    /\ job' = [job EXCEPT !.state = "running"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, journal, service, audit>>

\* Intent is persisted before the single provider dispatch. This is the first
\* point at which a restart can produce provider-outcome ambiguity.
PersistIntentAndDispatch ==
    /\ service = "running"
    /\ job.state = "running"
    /\ job.purpose \in Purposes
    /\ job.slot \in SlotIds
    /\ journal[job.slot] = "allocated"
    /\ audit.providerDispatches < 2
    /\ journal' = [journal EXCEPT ![job.slot] = "intent_persisted"]
    /\ job' = [job EXCEPT
        !.state = "awaiting_external",
        !.outcome = "intent_persisted"
        ]
    /\ audit' = [audit EXCEPT !.providerDispatches = @ + 1]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service>>

\* The exact response attribution is sealed before further tool work. A model
\* or provider substitution has no transition in this specification.
PersistExactProviderResponse(opaque) ==
    /\ opaque \in BOOLEAN
    /\ service = "running"
    /\ job.state = "awaiting_external"
    /\ job.slot \in SlotIds
    /\ job.model \in Models
    /\ journal[job.slot] = "intent_persisted"
    /\ journal' = [journal EXCEPT ![job.slot] = "response_persisted"]
    /\ job' = [job EXCEPT
        !.state = "running",
        !.responseModel = job.model,
        !.opaqueContinuation = opaque,
        !.outcome = "response_persisted"
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service, audit>>

PersistToolBoundary ==
    /\ service = "running"
    /\ job.state = "running"
    /\ job.slot \in SlotIds
    /\ journal[job.slot] = "response_persisted"
    /\ journal' = [journal EXCEPT ![job.slot] = "tool_boundary_persisted"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, job, service, audit>>

\* The tool host began an effect but did not durably record its result. This
\* is never replayable in the existing journal, even with creator authority.
PersistUnconfirmedToolIntent ==
    /\ service = "running"
    /\ job.state = "running"
    /\ job.slot \in SlotIds
    /\ journal[job.slot] = "response_persisted"
    /\ journal' = [journal EXCEPT ![job.slot] = "tool_outcome_unknown"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, job, service, audit>>

PersistTerminalJournal ==
    /\ service = "running"
    /\ job.state = "running"
    /\ job.slot \in SlotIds
    /\ journal[job.slot] \in {"response_persisted", "tool_boundary_persisted"}
    /\ journal' = [journal EXCEPT ![job.slot] = "terminal_persisted"]
    /\ job' = [job EXCEPT !.state = "completed"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service, audit>>

PersistProviderFailure ==
    /\ service = "running"
    /\ job.state \in {"running", "awaiting_external"}
    /\ job.slot \in SlotIds
    /\ journal[job.slot] \in {"allocated", "intent_persisted", "response_persisted", "tool_boundary_persisted"}
    /\ journal' = [journal EXCEPT ![job.slot] = "failure_persisted"]
    /\ job' = [job EXCEPT
        !.state = "failed",
        !.outcome = "failure_persisted"
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service, audit>>

PublishAnswer ==
    /\ service = "running"
    /\ job.state = "completed"
    /\ job.purpose = "planner"
    /\ journal[job.slot] = "terminal_persisted"
    /\ job' = [job EXCEPT !.result = "answer"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, journal, service, audit>>

PublishClarification ==
    /\ service = "running"
    /\ job.state = "completed"
    /\ job.purpose = "planner"
    /\ journal[job.slot] = "terminal_persisted"
    /\ job' = [job EXCEPT !.result = "clarification"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, journal, service, audit>>

PublishPlan ==
    /\ service = "running"
    /\ job.state = "completed"
    /\ job.purpose = "planner"
    /\ journal[job.slot] = "terminal_persisted"
    /\ workflow.plan < 1
    /\ workflow' = [workflow EXCEPT
        !.plan = @ + 1,
        !.approved = 0,
        !.refining = FALSE,
        !.builderComplete = FALSE,
        !.applyAuthorized = FALSE
        ]
    /\ job' = [job EXCEPT !.result = "plan"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, journal, service, audit>>

PublishBuiltChangeSet ==
    /\ service = "running"
    /\ job.state = "completed"
    /\ job.purpose = "builder"
    /\ journal[job.slot] = "terminal_persisted"
    /\ workflow.approved = workflow.plan
    /\ workflow' = [workflow EXCEPT !.builderComplete = TRUE]
    /\ job' = [job EXCEPT !.result = "built"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, journal, service, audit>>

PublishRepair ==
    /\ service = "running"
    /\ job.state = "completed"
    /\ job.purpose = "repair"
    /\ journal[job.slot] = "terminal_persisted"
    /\ job' = [job EXCEPT !.result = "repaired"]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, journal, service, audit>>

AuthorizeExactApply(a) ==
    /\ a \in RequestIds
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ workflow.plan # 0
    /\ workflow.approved = workflow.plan
    /\ workflow.builderComplete
    /\ ~workflow.refining
    /\ workflow' = [workflow EXCEPT !.applyAuthorized = TRUE]
    /\ audit' = [audit EXCEPT !.usedActions = @ \cup {a}]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, job, journal, service>>

PerformAuthorizedStudioEffect ==
    /\ service = "running"
    /\ workflow.applyAuthorized
    /\ workflow.approved = workflow.plan
    /\ workflow.builderComplete
    /\ ~workflow.refining
    /\ audit.studioEffects < 1
    /\ workflow' = [workflow EXCEPT !.applyAuthorized = FALSE]
    /\ audit' = [audit EXCEPT !.studioEffects = @ + 1]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, job, journal, service>>

\* Restart only classifies a durable journal. It never turns an existing slot
\* back into `allocated`, sends a provider request, performs Studio work, or
\* turns persisted response/tool work into a completed agent result. An absent
\* intent is a failed `never_dispatched` job; intent without a response is
\* `outcome_unknown`; response, completed-tool, and tool-outcome boundaries
\* are recorded as failed until an exact creator action classifies them.
RestartService ==
    /\ service = "running"
    /\ audit.restarts < 1
    /\ service' = "stopped"
    /\ job' = IF job.state \in {"queued", "running", "awaiting_external"} /\
                  job.slot \in SlotIds /\ journal[job.slot] = "allocated"
              THEN [job EXCEPT
                  !.state = "failed",
                  !.outcome = "never_dispatched"
                  ]
              ELSE IF job.state \in {"queued", "running", "awaiting_external"} /\
                      job.slot \in SlotIds /\
                      journal[job.slot] \in {
                          "intent_persisted", "response_persisted", "tool_boundary_persisted",
                          "tool_outcome_unknown"
                      }
                   THEN [job EXCEPT
                       !.state = IF journal[job.slot] = "intent_persisted"
                                    THEN "outcome_unknown" ELSE "failed",
                       !.outcome = IF journal[job.slot] = "intent_persisted"
                                    THEN "outcome_unknown" ELSE "response_persisted"
                       ]
                   ELSE job
    /\ workflow' = [workflow EXCEPT !.applyAuthorized = FALSE]
    /\ audit' = [audit EXCEPT !.restarts = @ + 1]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, journal>>

StartForegroundService ==
    /\ service = "stopped"
    /\ service' = "running"
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, job, journal, audit>>

\* Creator authority can consume a response already received in an exact
\* same slot only when every tool outcome is durable and no opaque provider
\* continuation would be needed. It does not send a provider request.
CreatorConsumesPersistedResponse(a) ==
    /\ a \in RequestIds
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ job.state = "failed"
    /\ job.outcome = "response_persisted"
    /\ job.slot \in SlotIds
    /\ journal[job.slot] \in {"response_persisted", "tool_boundary_persisted"}
    /\ ~job.opaqueContinuation
    /\ job' = [job EXCEPT !.state = "running"]
    /\ audit' = [audit EXCEPT !.usedActions = @ \cup {a}]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, journal, service>>

\* Intent/tool-outcome ambiguity, and opaque response continuations, can
\* only be retried in a fresh AgentRun/journal slot after creator authority.
CreatorStartsFreshRecoveryRun(a, m) ==
    /\ a \in RequestIds
    /\ m \in Models
    /\ service = "running"
    /\ storeHealthy
    /\ controls.view = chronology.head
    /\ a \notin audit.usedActions
    /\ job.state \in {"outcome_unknown", "failed"}
    /\ job.outcome \in {"never_dispatched", "outcome_unknown", "failure_persisted"}
       \/ (job.outcome = "response_persisted" /\
           (job.opaqueContinuation \/ journal[job.slot] = "tool_outcome_unknown"))
    /\ audit.nextSlot < 2
    /\ job' = [
        state |-> "queued", purpose |-> job.purpose, slot |-> audit.nextSlot,
        model |-> m, responseModel |-> "none", opaqueContinuation |-> FALSE,
        outcome |-> "not_applicable",
        result |-> "none"
        ]
    /\ journal' = [journal EXCEPT ![audit.nextSlot] = "allocated"]
    /\ audit' = [audit EXCEPT
        !.usedActions = @ \cup {a},
        !.nextSlot = @ + 1
        ]
    /\ UNCHANGED <<publication, storeHealthy, chronology, controls, workflow, service>>

Next ==
    \/ PersistEpisodeSnapshot
    \/ PersistTypedEvent
    \/ PersistHashChainedCommit
    \/ PublishConversationHead
    \/ IsolateCorruptConversation
    \/ IssueTurnContract
    \/ \E t \in RequestIds, m \in Models : AdmitPlannerTurn(t, m)
    \/ \E t \in RequestIds : RejectStaleOrDuplicateTurn(t)
    \/ IssueControlView
    \/ \E a \in RequestIds : ApproveExactPlan(a)
    \/ \E a \in RequestIds, m \in Models : AdmitPlanRefinement(a, m)
    \/ \E a \in RequestIds, m \in Models : AdmitBuilder(a, m)
    \/ \E a \in RequestIds, m \in Models : AdmitRepair(a, m)
    \/ \E a \in RequestIds : RejectStaleOrDuplicateAction(a)
    \/ RunQueuedJob
    \/ PersistIntentAndDispatch
    \/ \E opaque \in BOOLEAN : PersistExactProviderResponse(opaque)
    \/ PersistToolBoundary
    \/ PersistUnconfirmedToolIntent
    \/ PersistTerminalJournal
    \/ PersistProviderFailure
    \/ PublishAnswer
    \/ PublishClarification
    \/ PublishPlan
    \/ PublishBuiltChangeSet
    \/ PublishRepair
    \/ \E a \in RequestIds : AuthorizeExactApply(a)
    \/ PerformAuthorizedStudioEffect
    \/ RestartService
    \/ StartForegroundService
    \/ \E a \in RequestIds : CreatorConsumesPersistedResponse(a)
    \/ \E a \in RequestIds, m \in Models : CreatorStartsFreshRecoveryRun(a, m)

Spec == Init /\ [][Next]_vars

\* Immutable conversation publication.
HeadNeverOutrunsPersistedCommit ==
    /\ chronology.head <= chronology.commit
    /\ chronology.commit <= chronology.event
    /\ chronology.event <= chronology.snapshot

PublishedHeadHasCompleteOrderedEvidence ==
    publication = "idle" /\ chronology.head # 0 =>
        /\ chronology.head = chronology.snapshot
        /\ chronology.head = chronology.event
        /\ chronology.head = chronology.commit
        /\ chronology.headParent = chronology.head - 1

InterruptedPublicationCannotAdvanceHead ==
    publication \in {"snapshot_persisted", "event_persisted", "commit_persisted"} =>
        chronology.head < chronology.pending

IsolatedConversationCannotPublish ==
    publication = "isolated" => ~storeHealthy

\* Turn/action exactness and plan revision safety.
StaleOrDuplicateInputCannotStartWork ==
    /\ audit.staleTurnRejected => job.state \in JobStates
    /\ audit.staleActionRejected => job.state \in JobStates

ExactControlViewRequired ==
    workflow.applyAuthorized =>
        /\ service = "running"
        /\ storeHealthy
        /\ controls.view = chronology.head
        /\ workflow.approved = workflow.plan
        /\ workflow.builderComplete
        /\ ~workflow.refining

RefinementCannotInheritApproval ==
    workflow.refining =>
        /\ workflow.approved = 0
        /\ ~workflow.builderComplete
        /\ ~workflow.applyAuthorized

BuilderRequiresCurrentApproval ==
    job.purpose = "builder" =>
        /\ workflow.plan # 0
        /\ workflow.approved = workflow.plan
        /\ ~workflow.refining

\* Exact journal semantics for all three provider-bearing purposes.
JournalSlotMatchesActiveJob ==
    job.slot = 2 \/ journal[job.slot] # "unallocated"

ProviderOutcomeMatchesJournal ==
    /\ job.outcome = "intent_persisted" => journal[job.slot] = "intent_persisted"
    /\ job.outcome = "response_persisted" =>
        journal[job.slot] \in {
            "response_persisted", "tool_boundary_persisted", "tool_outcome_unknown",
            "terminal_persisted"
            }
    /\ job.outcome = "failure_persisted" => journal[job.slot] = "failure_persisted"
    /\ job.outcome = "never_dispatched" => journal[job.slot] = "allocated"
    /\ job.outcome = "outcome_unknown" => journal[job.slot] = "intent_persisted"

NoModelFallback ==
    job.responseModel # "none" => job.responseModel = job.model /\ job.model \in Models

OnlyTerminalJournalPublishesAgentResult ==
    job.result # "none" => journal[job.slot] = "terminal_persisted"

NonterminalJournalCannotPublishAgentResult ==
    job.slot \in SlotIds /\ journal[job.slot] \in {
        "allocated", "intent_persisted", "response_persisted", "tool_boundary_persisted",
        "tool_outcome_unknown"
    } => job.result = "none"

\* The only dispatcher requires an unused, freshly allocated slot. Same-
\* journal response consumption is not a provider dispatch, and neither
\* restart nor resume can resend a persisted request.
PersistedJournalNeverRedispatchesProvider ==
    job.slot \in SlotIds /\ journal[job.slot] \in {
        "intent_persisted", "response_persisted", "tool_boundary_persisted",
        "terminal_persisted", "failure_persisted"
    } => ~ENABLED PersistIntentAndDispatch

OpaqueResponseCannotConsumeSameJournal ==
    job.state = "failed" /\ job.outcome = "response_persisted" /\
    job.opaqueContinuation =>
        ~ (\E a \in RequestIds : ENABLED CreatorConsumesPersistedResponse(a))

RepairIsProviderBound ==
    job.purpose = "repair" /\ job.state \in {"queued", "running", "awaiting_external", "completed"} =>
        job.slot \in SlotIds /\ journal[job.slot] # "unallocated"

\* Restart/recovery never performs external effects.
RestartNeverDispatchesProvider ==
    [] [(RestartService => UNCHANGED <<journal, audit.providerDispatches>>)]_vars

RestartNeverMutatesStudio ==
    [] [(RestartService => UNCHANGED audit.studioEffects)]_vars

SameJournalResponseResumeNeverDispatchesProvider ==
    [] [(\E a \in RequestIds : CreatorConsumesPersistedResponse(a) =>
        UNCHANGED <<journal, audit.providerDispatches>>)]_vars

StaleTurnNeverDispatches ==
    [] [(\E t \in RequestIds : RejectStaleOrDuplicateTurn(t) =>
        UNCHANGED <<job, journal, audit.providerDispatches, audit.studioEffects>>)]_vars

StaleActionNeverMutates ==
    [] [(\E a \in RequestIds : RejectStaleOrDuplicateAction(a) =>
        UNCHANGED <<workflow, audit.studioEffects>>)]_vars

=============================================================================
