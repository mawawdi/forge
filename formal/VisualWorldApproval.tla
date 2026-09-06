-------------------------- MODULE VisualWorldApproval --------------------------
EXTENDS Naturals

\* The visual workflow has three creator decisions with disjoint authority:
\* proposal acceptance permits compilation, bundle approval permits a later
\* upload decision, and native-plan approval permits one Studio application.

VARIABLES phase, proposalAccepted, bundleApproved, uploadAuthorized,
          nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts

vars == <<phase, proposalAccepted, bundleApproved, uploadAuthorized,
          nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>

Terminal == {"reconciled", "rejected", "incomplete", "superseded"}

TypeOK ==
    /\ phase \in {"draft", "proposed", "accepted", "compiling", "bundle_review",
                    "upload_authorization", "asset_processing", "native_inspection",
                    "native_plan_review", "building", "awaiting_studio_apply"} \cup Terminal
    /\ proposalAccepted \in BOOLEAN
    /\ bundleApproved \in BOOLEAN
    /\ uploadAuthorized \in BOOLEAN
    /\ nativePlanApproved \in BOOLEAN
    /\ compileCount \in 0..1
    /\ uploadCount \in 0..1
    /\ studioWriteCount \in 0..1
    /\ restarts \in 0..2

Init ==
    /\ phase = "draft"
    /\ proposalAccepted = FALSE
    /\ bundleApproved = FALSE
    /\ uploadAuthorized = FALSE
    /\ nativePlanApproved = FALSE
    /\ compileCount = 0
    /\ uploadCount = 0
    /\ studioWriteCount = 0
    /\ restarts = 0

Propose == /\ phase = "draft" /\ phase' = "proposed" /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
AcceptProposal == /\ phase = "proposed" /\ phase' = "accepted" /\ proposalAccepted' = TRUE /\ UNCHANGED <<bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
Compile == /\ phase = "accepted" /\ proposalAccepted /\ compileCount = 0 /\ phase' = "compiling" /\ compileCount' = 1 /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, uploadCount, studioWriteCount, restarts>>
PresentBundle == /\ phase = "compiling" /\ phase' = "bundle_review" /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
ApproveBundle == /\ phase = "bundle_review" /\ phase' = "upload_authorization" /\ bundleApproved' = TRUE /\ UNCHANGED <<proposalAccepted, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
AuthorizeUpload == /\ phase = "upload_authorization" /\ bundleApproved /\ phase' = "asset_processing" /\ uploadAuthorized' = TRUE /\ uploadCount' = uploadCount + 1 /\ UNCHANGED <<proposalAccepted, bundleApproved, nativePlanApproved, compileCount, studioWriteCount, restarts>>
Inspect == /\ phase = "asset_processing" /\ uploadAuthorized /\ phase' = "native_inspection" /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
PresentNativePlan == /\ phase = "native_inspection" /\ phase' = "native_plan_review" /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
ApproveNativePlan == /\ phase = "native_plan_review" /\ phase' = "building" /\ nativePlanApproved' = TRUE /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, compileCount, uploadCount, studioWriteCount, restarts>>
Build == /\ phase = "building" /\ phase' = "awaiting_studio_apply" /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
Apply == /\ phase = "awaiting_studio_apply" /\ nativePlanApproved /\ studioWriteCount = 0 /\ phase' = "reconciled" /\ studioWriteCount' = 1 /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, restarts>>
Stop == /\ phase \notin Terminal /\ phase' \in {"rejected", "incomplete", "superseded"} /\ UNCHANGED <<proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount, restarts>>
Restart == /\ phase \notin Terminal /\ restarts < 2 /\ restarts' = restarts + 1 /\ UNCHANGED <<phase, proposalAccepted, bundleApproved, uploadAuthorized, nativePlanApproved, compileCount, uploadCount, studioWriteCount>>

Next == Propose \/ AcceptProposal \/ Compile \/ PresentBundle \/ ApproveBundle \/ AuthorizeUpload \/ Inspect \/ PresentNativePlan \/ ApproveNativePlan \/ Build \/ Apply \/ Stop \/ Restart
Spec == Init /\ [][Next]_vars

CompilationRequiresProposalAcceptance == compileCount = 1 => proposalAccepted
UploadRequiresSeparateAuthority == uploadCount = 1 => proposalAccepted /\ bundleApproved /\ uploadAuthorized
StudioWriteRequiresNativePlanApproval == studioWriteCount = 1 => nativePlanApproved /\ uploadAuthorized
AtMostOnceEffects == compileCount <= 1 /\ uploadCount <= 1 /\ studioWriteCount <= 1
RestartAddsNoEffect == [] [(Restart => UNCHANGED <<compileCount, uploadCount, studioWriteCount>>)]_vars
NoUnexpectedDeadlock == phase \in Terminal \/ ENABLED Next

===============================================================================
